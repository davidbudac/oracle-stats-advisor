// Table-level sections of the health check (WP3): staleness, history, pending, restore, load, realtime, subpartitions.
//
// Each rule reads the dictionary facts of the collector's DETAIL block (`ctx.detail`) next to the form values the
// INPUT block filled (`ctx.input`). "Now" is `detail.collectedAt`. A finding's `basis` names the 19c page, a lab id
// (docs/lab-observations.md) or says "inferred"; the quotes are from the 19c pages fetched on 2026-10-11:
//   tgsql = SQL Tuning Guide, arpls = PL/SQL Packages and Types Reference (DBMS_STATS), refrn = Database Reference,
//   admin = Administrator's Guide, dblic = Licensing Information User Manual.
// The WP5 rules in advise.ts (subpartition granularity, real-time, high-frequency, PUBLISH FALSE, bulk-load notes) are not
// repeated; the health check adds what the dictionary shows.

import type { Input } from "../defaults";
import { toTime, type HistoryRec, type PartitionRec, type WindowRec } from "../detail";
import { fmt, pct, plural } from "../format";
import type { Level } from "../types";
import type { HealthContext, HealthFinding, HealthSection } from "./index";

const DAY = 86_400_000;
const GUIDE = "19c SQL Tuning Guide";
const REF = "19c DBMS_STATS reference";

// ---------------------------------------------------------------- shared helpers

const quote = (v: string, placeholder: string) => `'${(v || placeholder).replace(/'/g, "''")}'`;
/** `'OWNER', 'TABLE'` with the names the reader gave, else the placeholders. */
const ownerTable = (i: Input) => `${quote(i.owner, "OWNER")}, ${quote(i.tableName, "TABLE")}`;
const when = (s: string | null): string => (s ? s.slice(0, 16) : "–");
const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
/** `Xm Ys`, or `Xh Ym` from one hour on (a 20 hour window is `20h 0m`). */
const dur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const days = (n: number): string => `${fmt(n, n < 10 ? 1 : 0)} ${Math.abs(n - 1) < 0.05 ? "day" : "days"}`;
/** `+000 00:01:34` as milliseconds. */
function intervalMs(s: string | null): number | null {
  const m = s?.match(/^([+-]?\d+) (\d+):(\d+):(\d+)/);
  return m ? (((+m[1]! * 24 + +m[2]!) * 60 + +m[3]!) * 60 + +m[4]!) * 1000 : null;
}
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), k = s.length >> 1;
  return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2;
};

function section(id: string, title: string, summary: string, findings: HealthFinding[], rows?: HealthSection["rows"]): HealthSection {
  const out: HealthSection = { id, title, summary, findings };
  if (rows && rows.body.length) out.rows = rows;
  return out;
}
const clean = (fs: HealthFinding[]) => !fs.some((f) => f.level === "bad" || f.level === "warn");

// ---------------------------------------------------------------- 1. staleness: the forecast

/** The linear forecast of STALE_PERCENT: rows per day since the last gather and the days left (0 when already past). Pure arithmetic, exported for the tests. */
export function staleForecast(rowsChanged: number, numRows: number, stalePercent: number, elapsedDays: number) {
  const threshold = (numRows * stalePercent) / 100;
  const rate = elapsedDays > 0 ? rowsChanged / elapsedDays : 0;
  const remaining = threshold - rowsChanged;
  return {
    threshold, rate, remaining,
    /** Days from now until the threshold is crossed; 0 when it is crossed; null when there is no rate. */
    daysLeft: remaining <= 0 ? 0 : rate > 0 ? remaining / rate : null,
    /** Days after the last gather at which the threshold is (was) crossed at this rate. */
    crossedAfterDays: rate > 0 ? threshold / rate : null,
  };
}

/** How often a window recurs: the predefined ones are `freq=daily;byday=XXX` (weekly); a daily window without BYDAY recurs every day. */
const periodMs = (w: WindowRec): number => (/freq=daily/i.test(w.repeatInterval ?? "") && !/byday=/i.test(w.repeatInterval ?? "") ? DAY : 7 * DAY);

/** The first maintenance window starting at or after `at` (one that is open at `at` counts as starting then). */
function windowAfter(windows: WindowRec[], at: number): { w: WindowRec; start: number; open: boolean } | null {
  let best: { w: WindowRec; start: number; open: boolean } | null = null;
  for (const w of windows) {
    if (w.enabled === false) continue;
    let t = toTime(w.nextStart), open = false;
    if (t == null) continue;
    if (t < at) {
      const len = intervalMs(w.duration), per = periodMs(w);
      if (len != null && at < t + len) { t = at; open = true; } else t += Math.ceil((at - t) / per) * per;
    }
    if (!best || t < best.start) best = { w, start: t, open };
  }
  return best;
}

interface PartStat { p: PartitionRec; frac: number | null }

export function stalenessSection({ input, detail: d }: HealthContext): HealthSection | null {
  if (d.rowsChanged == null && d.staleStats == null && d.rowsTruncated == null && d.lastAnalyzed == null && !d.partitions.length) return null;
  const OT = ownerTable(input), own = quote(input.owner, "OWNER"), tab = quote(input.tableName, "TABLE");
  const f: HealthFinding[] = [];
  const add = (level: Level, text: string, basis: string, fix?: string[]) => f.push(fix ? { level, text, basis, fix } : { level, text, basis });
  const now = toTime(d.collectedAt), last = toTime(d.lastAnalyzed), mods = toTime(d.modsTimestamp);
  const numRows = input.numRows, sp = input.stalePercent;
  const rc = d.rowsChanged;
  const thr = (numRows * sp) / 100;
  const over = rc != null && numRows > 0 ? rc > thr : rc != null && rc > 0; // no rows in the statistics: any change is past the threshold (inferred)
  const stale = over || d.staleStats === true || d.rowsTruncated === true;
  const summary: string[] = [];

  // -- change so far, against STALE_PERCENT, and the dictionary's own verdict
  const verdictWord = d.staleStats == null ? "" : ` STALE_STATS = ${d.staleStats ? "YES" : "NO"}.`;
  const agrees = d.staleStats == null || d.staleStats === over;
  const staleBasis = `${GUIDE}, Determining When Optimizer Statistics Are Stale (STALE_STATS 'is based on data in the DBA_TAB_MODIFICATIONS view and the STALE_PERCENT preference for DBMS_STATS'); ${REF}, STALE_PERCENT ('The default value is 10, which means that a table having more than 10% of changes is considered stale')`;
  if (rc != null) {
    if (numRows > 0) {
      if (rc > 0) add(over ? "warn" : "info", `${fmt(rc)} rows changed since the last gather: ${pct(rc / numRows)} of the ${fmt(numRows)} rows in the statistics. STALE_PERCENT is ${fmt(sp, 4)}% (${fmt(thr)} rows)${over ? ", so the table is past it" : ""}.${agrees ? verdictWord : ""}`, staleBasis);
      summary.push(rc > 0 ? `${pct(rc / numRows)} changed of ${fmt(sp, 4)}%` : "no DML since the gather");
    } else if (rc > 0) {
      add("warn", `${fmt(rc)} rows changed since the last gather and the statistics say the table has no rows, so any change passes STALE_PERCENT (inferred).${agrees ? verdictWord : ""}`, "inferred from the STALE_PERCENT definition; DBA_TAB_MODIFICATIONS");
      summary.push(`${fmt(rc)} rows changed, statistics say 0 rows`);
    } else summary.push("no DML since the gather");
  }
  if (d.staleStats != null) {
    const verdictFix = [
      "-- The dictionary's verdict and the counters behind it",
      "SELECT stale_stats, num_rows, last_analyzed FROM dba_tab_statistics",
      `WHERE  owner = ${own} AND table_name = ${tab} AND partition_name IS NULL;`,
      "SELECT inserts, updates, deletes, truncated, drop_segments, timestamp FROM dba_tab_modifications",
      `WHERE  table_owner = ${own} AND table_name = ${tab} AND partition_name IS NULL AND subpartition_name IS NULL;`,
    ];
    const note = "The counters are approximate; since 12.2 the views read memory and disk, so FLUSH_DATABASE_MONITORING_INFO is not needed to see current numbers.";
    const basis = `${GUIDE}, Determining When Optimizer Statistics Are Stale ('The statistics shown in the DBA_TAB_STATISTICS, DBA_IND_STATISTICS, and DBA_TAB_MODIFICATIONS views are obtained from both disk and memory'); 19c Reference, ALL_TAB_MODIFICATIONS ('Approximate number of inserts since the last time statistics were gathered')`;
    if (d.staleStats && !agrees) add("warn", `STALE_STATS = YES although ${rc != null && numRows > 0 ? `only ${pct(rc / numRows)} of the rows changed, below STALE_PERCENT` : "the change counters are below STALE_PERCENT"}. Something else the monitoring tracks may have marked it (a truncate, dropped partition segments), or the counters moved after the collector read them. ${note}`, basis, verdictFix);
    else if (!d.staleStats && !agrees) add("info", `STALE_STATS says NO although the counters are past STALE_PERCENT. ${note}`, basis, verdictFix);
    summary.push(`STALE_STATS ${d.staleStats ? "YES" : "NO"}`);
  }

  // -- a truncate
  if (d.rowsTruncated) {
    add("warn", "The table was truncated since the last gather (DBA_TAB_MODIFICATIONS.TRUNCATED = YES), so the statistics describe rows that are gone unless the table was reloaded to the same size. Gather after the reload.",
      `${GUIDE}, Determining When Optimizer Statistics Are Stale ('Monitoring tracks the approximate number of DML operations on a table and whether the table has been truncated since the most recent statistics collection'); 19c Reference, ALL_TAB_MODIFICATIONS.TRUNCATED. The documentation does not say a truncate makes STALE_STATS YES; on the lab table CHAOS.FILL (queried 2026-10-11, not in lab-observations.md) the truncate was also counted as 600 deletes of 600 rows, so the change counters were past STALE_PERCENT on their own`,
      [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
    summary.push("truncated");
  }

  // -- the pace and the forecast: the counters are cumulative since the last gather, so the pace is changes / (collection time - last gather)
  const idle = mods != null && now != null ? (now - mods) / DAY : null; // days since the last change was counted
  let daysLeft: number | null = null;
  if (rc != null && rc > 0 && last != null && now != null && numRows > 0 && !over) {
    const elapsed = (now - last) / DAY;
    const lastChange = mods != null && mods > last ? ` The last change was counted at ${when(d.modsTimestamp)}${idle != null ? ` (${days(idle)} before the collection)` : ""}.` : "";
    if (elapsed < 1 / 24) add("info", `The ${fmt(rc)} changes came within an hour of the last gather (${when(d.lastAnalyzed)}); too short a span to extrapolate a pace.`, "inferred");
    else if (idle != null && idle >= 7 && idle > 0.5 * elapsed) add("info", `${fmt(rc)} changes since the last gather (${when(d.lastAnalyzed)}), but none counted since ${when(d.modsTimestamp)} (${days(idle)} before the collection): the table is quiet, so there is no current pace to extrapolate.`, "inferred from DBA_TAB_MODIFICATIONS.TIMESTAMP");
    else {
      const fc = staleForecast(rc, numRows, sp, elapsed);
      if (fc.daysLeft != null) {
        daysLeft = fc.daysLeft;
        add("info", `At the pace since the last gather (${fmt(fc.rate)} rows per day: ${fmt(rc)} changes over ${days(elapsed)}) the table reaches STALE_PERCENT (${fmt(fc.threshold)} rows) in about ${days(fc.daysLeft)}, around ${stamp(now + fc.daysLeft * DAY)}.${lastChange} Assumes the changes spread evenly; a load or purge in one night breaks the line.`, "inferred: linear extrapolation of DBA_TAB_MODIFICATIONS");
        summary.push(`threshold in ~${days(fc.daysLeft)}`);
      }
    }
  }

  // -- when it will actually be gathered: the nightly task
  const crossingAt = stale ? now : daysLeft != null && now != null ? now + daysLeft * DAY : null;
  if (d.autotaskStatus === "DISABLED") {
    add(stale ? "bad" : "warn", "The automatic optimizer statistics task is DISABLED (DBA_AUTOTASK_CLIENT): nothing gathers this table unless a job or a person does.",
      "19c Tuning Guide, About Automatic Optimizer Statistics Collection ('Oracle strongly recommends that you not disable automatic statistics gathering because it is critical for the optimizer to generate optimal plans')",
      ["EXEC DBMS_AUTO_TASK_ADMIN.ENABLE(client_name => 'auto optimizer stats collection', operation => NULL, window_name => NULL)"]);
    summary.push("auto task disabled");
  } else if (d.autotaskStatus === "ENABLED" && d.windows.length) {
    const nxt = windowAfter(d.windows, now ?? 0);
    if (!nxt) add("warn", "No maintenance window has the statistics task enabled (DBA_AUTOTASK_WINDOW_CLIENTS): the task never starts.", "19c Tuning Guide, About Automatic Optimizer Statistics Collection ('By default, the collection runs in all predefined maintenance windows')");
    else {
      const w = nxt.w, winLen = intervalMs(w.duration);
      const first = now != null ? (nxt.open ? `${w.name} is open now (started ${when(w.nextStart)}${winLen ? `, ${dur(winLen)} long` : ""}).` : `Next window with the task: ${w.name} at ${stamp(nxt.start)}${winLen ? ` (${dur(winLen)} long)` : ""}.`) : "";
      if (stale) add("info", `The table is stale, so the next run of the task gathers it, in a window that prioritizes objects without or with very old statistics. ${first}`.trim(), "19c Tuning Guide, About Automatic Optimizer Statistics Collection ('prioritizes objects that have no statistics or very old statistics'); 19c Administrator's Guide ('for which there are no statistics or only stale statistics')");
      else if (crossingAt != null && now != null) {
        const after = windowAfter(d.windows, crossingAt);
        add("info", `${first} At the forecast pace the table is stale around ${stamp(crossingAt)}${after ? (after.open ? `, inside ${after.w.name}` : `; the first window after that is ${after.w.name} at ${stamp(after.start)} (${days((after.start - crossingAt) / DAY)} later)`) : ""}. Until then the task skips it.`.trim(), "inferred: window starts from DBA_SCHEDULER_WINDOWS (recurrence from REPEAT_INTERVAL); 19c Reference, DBA_OPTSTAT_OPERATION_TASKS.STATUS ('SKIPPED ... its stats are not stale')");
      } else add("info", `Not stale, so the task skips the table at its next run. ${first}`.trim(), "19c Reference, DBA_OPTSTAT_OPERATION_TASKS.STATUS ('SKIPPED: Task has been skipped, as it does not exist any more, or its stats are not stale')");
      summary.push(nxt.open ? `${w.name} open now` : `next window ${stamp(nxt.start)}`);
    }
    // the last runs of the task
    const runs = d.autoruns;
    if (runs.length) {
      const bad = runs.filter((r) => r.jobStatus != null && r.jobStatus.toUpperCase() !== "SUCCEEDED");
      const winMs = new Map(d.windows.map((w) => [w.name, intervalMs(w.duration)] as const));
      const hitEnd = runs.filter((r) => { const win = winMs.get(r.windowName), jd = intervalMs(r.jobDuration); return win != null && jd != null && jd >= win * 0.98; });
      if (bad.length || hitEnd.length) {
        const list = [...new Set([...bad, ...hitEnd])].slice(0, 4).map((r) => `${r.windowName} ${when(r.windowStart)}: ${r.jobStatus ?? "?"}, ${dur(intervalMs(r.jobDuration) ?? 0)}${r.jobInfo ? ` (${r.jobInfo.slice(0, 80)})` : ""}`).join("; ");
        add("warn", `${fmt(new Set([...bad, ...hitEnd]).size)} of the last ${runs.length} runs of the task did not finish cleanly or ran to the end of the window: ${list}. Objects a run did not reach keep their old statistics until a later run.`,
          "19c Reference, DBA_OPTSTAT_OPERATIONS.STATUS ('TIMED OUT: Maintenance window was not enough to complete this operation'); 19c Tuning Guide ('prioritizes objects that have no statistics or very old statistics')",
          ["SELECT window_name, window_start_time, job_status, job_duration, job_info FROM dba_autotask_job_history WHERE client_name = 'auto optimizer stats collection' ORDER BY job_start_time DESC FETCH FIRST 10 ROWS ONLY;"]);
        summary.push("window overrun");
      }
    }
  }

  // -- the nightly task's target
  if (d.autostatsTarget === "ORACLE" && !/^(SYS|SYSTEM)$/i.test(input.owner)) {
    add("bad", "AUTOSTATS_TARGET is ORACLE: the automatic task collects statistics for Oracle-owned objects only and skips user tables like this one, however stale they are.",
      `${REF}, AUTOSTATS_TARGET ("'ORACLE' - Statistics collected for all Oracle owned objects ... This preference is applicable only for automatic statistics collection")`,
      ["EXEC DBMS_STATS.SET_GLOBAL_PREFS('AUTOSTATS_TARGET', 'AUTO')"]);
    summary.push("AUTOSTATS_TARGET ORACLE");
  }

  // -- the high-frequency task, and the nightly runs DBA_AUTO_STAT_EXECUTIONS lists too
  const hfRuns = d.hfruns.filter((r) => /HIGH_FREQ/i.test(r.origin ?? ""));
  const nightly = d.hfruns.filter((r) => /^AUTO_TASK$/i.test(r.origin ?? ""));
  const sumOf = (rs: typeof d.hfruns, k: "completed" | "failed" | "timedOut") => rs.reduce((a, r) => a + (r[k] ?? 0), 0);
  const runWord = (rs: typeof d.hfruns) => ["COMPLETED", "FAILED", "TIMED OUT"].map((st) => [st, rs.filter((r) => (r.status ?? "").toUpperCase() === st).length] as const).filter(([, n]) => n).map(([st, n]) => `${n} ${st.toLowerCase()}`).join(", ") || "no status";
  if (d.autoTaskStatus === "ON") {
    const iv = d.autoTaskInterval, mx = d.autoTaskMaxRunTime;
    add("info", `The high-frequency task is ON: every ${iv != null ? `${fmt(iv)} s` : "?"}, at most ${mx != null ? `${fmt(mx)} s` : "?"} per run. It gathers stale statistics only and does not start while the window's job is running.`,
      `${REF}, AUTO_TASK_STATUS / AUTO_TASK_INTERVAL / AUTO_TASK_MAX_RUN_TIME; ${GUIDE}, About High-Frequency Automatic Optimizer Statistics Collection ('The high-frequency task is lightweight and only gathers stale statistics'; 'it will not execute while the maintenance window auto stats gathering job is executing')`);
    if (!hfRuns.length) add("warn", `The task is ON but none of the last ${plural(d.hfruns.length, "row")} of DBA_AUTO_STAT_EXECUTIONS has ORIGIN HIGH_FREQ_AUTO_TASK. It may not run: check the licence (Exadata and EE-ES only) and the interval.`, "19c Reference, DBA_AUTO_STAT_EXECUTIONS.ORIGIN; 19c Licensing Information, 'High-Frequency Automatic Optimizer Statistics Collection' (EE-ES: Available on Exadata)", ["SELECT opid, origin, status, start_time, end_time, completed, failed, timed_out FROM dba_auto_stat_executions ORDER BY opid DESC FETCH FIRST 10 ROWS ONLY;"]);
    else {
      const lvl: Level = sumOf(hfRuns, "failed") || sumOf(hfRuns, "timedOut") ? "warn" : "info";
      add(lvl, `Last ${plural(hfRuns.length, "high-frequency run")}: ${runWord(hfRuns)}; objects: ${fmt(sumOf(hfRuns, "completed"))} completed, ${fmt(sumOf(hfRuns, "failed"))} failed, ${fmt(sumOf(hfRuns, "timedOut"))} timed out (whole database).`, "19c Reference, DBA_AUTO_STAT_EXECUTIONS (ORIGIN: AUTO_TASK or HIGH_FREQ_AUTO_TASK; STATUS: IN PROGRESS, COMPLETED, FAILED, TIMED OUT)");
    }
    summary.push("high-frequency task ON");
  } else if (d.autoTaskStatus === "OFF" && !stale && crossingAt != null && now != null && crossingAt - now < DAY) {
    add("info", "The table is forecast to go stale within a day and the high-frequency task is OFF (the default), so the first gather is the next nightly window. The task is available on Exadata and EE-ES only in 19c; otherwise gather after the load that changes the table.", "19c Licensing Information (High-Frequency Automatic Optimizer Statistics Collection: EE-ES, available on Exadata); inferred forecast");
  }
  if (nightly.length && sumOf(nightly, "timedOut") > 0) {
    const newest = nightly[0]!;
    add("warn", `${sumOf(nightly, "timedOut")} objects timed out in the last ${plural(nightly.length, "nightly run")} (ORIGIN AUTO_TASK in DBA_AUTO_STAT_EXECUTIONS; ${runWord(nightly)}): the window was too short for them. The counts cover the whole database, not this table.`,
      "19c Reference, DBA_AUTO_STAT_EXECUTIONS (STATUS: TIMED OUT; the view also lists the nightly task's runs, lab)",
      newest.opid != null ? [`SELECT DBMS_STATS.REPORT_SINGLE_STATS_OPERATION(opid => ${newest.opid}, detail_level => 'TYPICAL', format => 'TEXT') FROM dual;`] : undefined);
  }

  // -- partitions
  let rows: HealthSection["rows"] | undefined;
  if (d.partitionsOmitted != null) add("info", `The table has ${fmt(d.partitionsOmitted)} partitions; the collector lists none above 400, so the per-partition staleness is not checked here.`, "collector limit (400 partitions)");
  if (d.partitions.length) {
    const ps: PartStat[] = d.partitions.map((p) => ({ p, frac: p.rowsChanged != null && p.rowsChanged > 0 ? (p.numRows != null && p.numRows > 0 ? p.rowsChanged / p.numRows : Infinity) : p.rowsChanged === 0 ? 0 : null }));
    const withDml = ps.filter((x) => (x.frac ?? 0) > 0);
    const pastLimit = withDml.filter((x) => (x.frac ?? 0) > sp / 100 || (x.frac === Infinity));
    const lockedDml = withDml.filter((x) => x.p.locked === true);
    const names = (xs: PartStat[]) => [...xs].sort((a, b) => (b.frac ?? 0) - (a.frac ?? 0)).slice(0, 10).map((x) => `${x.p.name}${x.frac === Infinity ? " (no rows in statistics)" : ` (${pct(x.frac ?? 0)})`}`).join(", ");
    const inc = input.incremental === "TRUE";
    if (!withDml.length) add("info", `None of the ${plural(d.partitions.length, "partition")} has DML counted since its last gather.`, "DBA_TAB_MODIFICATIONS (partition rows)");
    else {
      const unlocked = (xs: PartStat[]) => xs.filter((x) => x.p.locked !== true);
      const manual = inc ? (input.useStalePercent ? pastLimit : withDml) : pastLimit;
      const pastOpen = unlocked(pastLimit), pastLocked = pastLimit.filter((x) => x.p.locked === true);
      const auto = !pastLimit.length ? "" : pastOpen.length
        ? ` The automatic task regathers ${plural(pastOpen.length, "partition")} at its next run (it applies STALE_PERCENT per partition)${pastLocked.length ? ` and skips the ${fmt(pastLocked.length)} locked` : ""}.`
        : ` ${pastLocked.length === 1 ? "It is" : "All are"} locked, and the automatic task skips locked partitions.`;
      const own2 = inc ? ` A gather you run yourself on this INCREMENTAL table re-reads ${plural(unlocked(manual).length, "partition")}${input.useStalePercent ? " (INCREMENTAL_STALENESS has USE_STALE_PERCENT: only those past the threshold)" : " (default staleness: any DML makes a partition stale)"}${input.useLockedStats ? ", and not the locked ones (USE_LOCKED_STATS)" : ""}${unlocked(manual).length ? ": " + names(unlocked(manual)) : ""}.` : "";
      add(pastOpen.length ? "warn" : "info",
        `${plural(withDml.length, "partition")} of ${d.partitions.length} ${withDml.length === 1 ? "has" : "have"} DML since the last gather; ${pastLimit.length ? `${fmt(pastLimit.length)} ${pastLimit.length === 1 ? "is" : "are"} at or past STALE_PERCENT ${fmt(sp, 4)}%: ${names(pastLimit)}` : `none is past STALE_PERCENT ${fmt(sp, 4)}% (largest ${pct(Math.max(...withDml.map((x) => (x.frac === Infinity ? 1 : x.frac ?? 0))))})`}.${auto}${own2}`,
        "lab B1 (default staleness: one updated row, that partition re-read), B2, B3, B3b (USE_STALE_PERCENT); lab G7 (a schema GATHER AUTO regathered a partition above STALE_PERCENT; the nightly task itself was not run in the lab); 19c DBMS_STATS reference, LOCK_TABLE_STATS ('Procedures that operates on multiple objects (such as GATHER_SCHEMA_STATS ) will skip modifying the statistics of an object if it is locked'); INCREMENTAL_STALENESS (USE_STALE_PERCENT)");
      if (inc && lockedDml.length) {
        const lk = `${plural(lockedDml.length, "locked partition")} ${lockedDml.length === 1 ? "has" : "have"} DML (${names(lockedDml)})`;
        const fixLk = [`SELECT partition_name, stattype_locked, stale_stats FROM dba_tab_statistics WHERE owner = ${own} AND table_name = ${tab} AND stattype_locked IS NOT NULL AND partition_name IS NOT NULL;`];
        if (input.useLockedStats) add("info", `${lk}. INCREMENTAL_STALENESS has USE_LOCKED_STATS, so ${lockedDml.length === 1 ? "it counts" : "they count"} as not stale and the global statistics leave the changed rows out.`, "lab C2 (USE_LOCKED_STATS: nothing read, global NUM_ROWS excludes the rows), V1.7; 19c DBMS_STATS reference, INCREMENTAL_STALENESS ('USE_LOCKED_STATS - Locked partitions or subpartitions statistics are never considered stale, regardless of DML changes')", fixLk);
        else if (!input.useStalePercent) add("warn", `${lk}. A locked partition is not regathered, and under default staleness this forces a full-table scan for the global statistics on every gather.`, "lab C1, C1b (locked partition with DML: one GLOBAL full-table statement, repeated), Tc", fixLk);
        else add("info", `${lk}. A locked partition is not regathered; with USE_STALE_PERCENT alone, whether the global statistics then need a full-table scan was not tested (lab C1 used default staleness).`, "lab C1, C1b (default staleness only)", fixLk);
      }
      rows = {
        head: ["Partition", "Rows in statistics", "Rows changed", "Changed", "Locked", "STALE_STATS"],
        body: [...withDml].sort((a, b) => (b.frac ?? 0) - (a.frac ?? 0)).slice(0, 10).map((x) => [x.p.name, fmt(x.p.numRows), fmt(x.p.rowsChanged), x.frac === Infinity ? "n/a" : pct(x.frac ?? 0), x.p.locked ? "yes" : "no", x.p.staleStats == null ? "–" : x.p.staleStats ? "YES" : "NO"]),
      };
    }
    const noStats = d.partitions.filter((p) => p.lastAnalyzed == null);
    if (noStats.length) add("warn", `${plural(noStats.length, "partition")} ${noStats.length === 1 ? "has" : "have"} no statistics (LAST_ANALYZED empty): ${noStats.slice(0, 10).map((p) => p.name).join(", ")}${noStats.length > 10 ? ", ..." : ""}. A gather reads them first.`, "DBA_TAB_STATISTICS (LAST_ANALYZED empty); the task gathers objects with no statistics");
  }
  if (d.subpartitioning && d.subpartitioning !== "NONE") add("info", "This table is composite: DBA_TAB_MODIFICATIONS can hold DML on subpartition rows only (STATS_LAB.C1 had 24 subpartition rows and none for the table or its partitions), so a table-level count of 0 does not prove that nothing changed. Read the subpartition rows.",
    "lab Q3 (STATS_LAB.C1: subpartition rows only; SOE.ORDER_ITEMS and STATS_LAB.A1 differ); 19c Reference, ALL_TAB_MODIFICATIONS (PARTITION_NAME and SUBPARTITION_NAME columns)",
    [`SELECT partition_name, subpartition_name, inserts, updates, deletes FROM dba_tab_modifications WHERE table_owner = ${own} AND table_name = ${tab} AND subpartition_name IS NOT NULL ORDER BY partition_name, subpartition_name;`]);

  const composite = d.subpartitioning != null && d.subpartitioning !== "NONE";
  if (clean(f) && !composite && rc === 0) add("good", `No DML counted since the last gather${d.lastAnalyzed ? ` (${when(d.lastAnalyzed)})`: ""}; the statistics are current by the dictionary's own measure.`, `${GUIDE}, Determining When Optimizer Statistics Are Stale`);
  return section("staleness", "Staleness and the next gather", summary.length ? summary.join("; ") : "no change counters collected", f, rows);
}

// ---------------------------------------------------------------- 2. history

const isAutoOp = (h: HistoryRec) => /^ORA\$AT_OS_OPT/i.test(h.jobName ?? "") || /\(auto\)/i.test(h.operation);
const isDryRun = (h: HistoryRec) => /reporting mode/i.test(h.operation);
const isGather = (h: HistoryRec) => /gather/i.test(h.operation) && !isDryRun(h);
const opMs = (h: HistoryRec): number | null => { const a = toTime(h.startTime), b = toTime(h.endTime); return a != null && b != null && b >= a ? b - a : null; };

export function historySection({ input, detail: d }: HealthContext): HealthSection | null {
  if (!d.history.length && d.historyRows == null && d.lastAnalyzed == null) return null;
  const OT = ownerTable(input);
  const f: HealthFinding[] = [];
  const add = (level: Level, text: string, basis: string, fix?: string[]) => f.push(fix ? { level, text, basis, fix } : { level, text, basis });
  const hist = d.history; // newest first
  const gathers = hist.filter(isGather);
  const reportFix = ["SET LONG 1000000 PAGESIZE 0 LINESIZE 200", "SELECT DBMS_STATS.REPORT_STATS_OPERATIONS(detail_level => 'TYPICAL', format => 'TEXT', latestn => 10) FROM dual;"];
  const dryFix = [`SELECT DBMS_STATS.REPORT_GATHER_TABLE_STATS(${OT}) FROM dual;`];
  const bits: string[] = [];

  // -- failures and timeouts
  const failed = gathers.filter((h) => h.status != null && !/^COMPLETED$/i.test(h.status) && !/^IN PROGRESS$/i.test(h.status));
  if (failed.length) {
    const h = failed[0]!;
    add("bad", `${plural(failed.length, "gather operation")} did not complete: ${failed.slice(0, 4).map((x) => `opid ${x.opid} ${x.operation} at ${when(x.startTime)} ${x.status}`).join("; ")}. A failed or timed-out gather leaves the statistics as they were; DBA_OPTSTAT_OPERATIONS.NOTES holds the failure message and the report names the objects that failed.`,
      `19c Reference, DBA_OPTSTAT_OPERATIONS.STATUS ('FAILED: Operation has failed', 'TIMED OUT: Maintenance window was not enough to complete this operation (applies only to automatic statistics gathering)'; NOTES: 'a failure message for operations with status FAILED'); ${REF}, REPORT_SINGLE_STATS_OPERATION (OPID, DETAIL_LEVEL, FORMAT, CONTAINER_ID)`,
      ["SET LONG 1000000 PAGESIZE 0 LINESIZE 200", `SELECT DBMS_STATS.REPORT_SINGLE_STATS_OPERATION(opid => ${h.opid}, detail_level => 'ALL', format => 'TEXT') FROM dual;`, `SELECT id, operation, status, notes FROM dba_optstat_operations WHERE id = ${h.opid};`]);
    bits.push(`${failed.length} failed`);
  }
  const dry = hist.filter(isDryRun);
  if (dry.length) add("info", `${plural(dry.length, "operation")} ${dry.length === 1 ? "is a dry run" : "are dry runs"} (gather_table_stats (reporting mode), from REPORT_GATHER_TABLE_STATS${dry.some((x) => x.status && !/^COMPLETED$/i.test(x.status)) ? ", listed with status " + [...new Set(dry.map((x) => x.status))].join("/") : ""}). Nothing was gathered; they are not counted as failures.`, "lab: all 5 'gather_table_stats (reporting mode)' rows in DBA_OPTSTAT_OPERATIONS of PDB1 have STATUS FAILED (queried 2026-10-11); why the status is FAILED is not documented");

  // -- who gathers, how often
  const byAuto = gathers.filter(isAutoOp).length;
  if (gathers.length) bits.push(`${plural(gathers.length, "gather operation")} listed, ${byAuto} by the auto job`);

  // -- duration trend (calls on this table)
  const timed = gathers.filter((h) => h.targetType === "TABLE").map((h) => ({ h, ms: opMs(h) })).filter((x): x is { h: HistoryRec; ms: number } => x.ms != null);
  if (timed.length >= 5) {
    const latest = timed[0]!, earlier = timed.slice(1).map((x) => x.ms), med = median(earlier)!;
    if (latest.ms > 2 * med && latest.ms >= 30_000) {
      add("info", `The newest gather (opid ${latest.h.opid}, ${when(latest.h.startTime)}) took ${dur(latest.ms)}, more than twice the median ${dur(med)} of the ${earlier.length} before. Look for a changed sample size, a new histogram column, a table that grew, or a lost incremental state.`, "inferred from DBA_OPTSTAT_OPERATIONS start and end times", reportFix);
      bits.push("last gather slow");
    }
  }

  // -- incremental behaviour: every recent gather reads every partition
  const N = input.partitions;
  if (input.incremental === "TRUE" && input.partitioned && N > 2) {
    const recent = gathers.filter((h) => h.partitionsGathered != null && h.partitionsGathered > 0).slice(0, 4);
    const all = recent.filter((h) => (h.partitionsGathered ?? 0) >= 0.9 * N);
    if (recent.length >= 3 && all.length === recent.length) {
      add("warn", `INCREMENTAL is TRUE, yet each of the last ${recent.length} gathers read ${recent.map((h) => fmt(h.partitionsGathered)).join(", ")} partitions of ${fmt(N)}: it does not behave incrementally. An incremental gather reads only new or stale partitions and merges the synopses. Usual causes: partitions without synopses or in the old format, a locked partition with DML (full scan of the table), a fixed ESTIMATE_PERCENT, PUBLISH FALSE toggled, or first-time column usage adding histograms.`,
        "lab T1b (nothing changed: nothing read), E1 and F0 (first-time column usage: every partition re-read), C1 (locked partition with DML), A8 (fixed ESTIMATE_PERCENT), Tf (PUBLISH toggled), L1 (INCREMENTAL toggled)",
        [...reportFix, "-- a dry run: lists what the next gather would read", ...dryFix]);
      bits.push("not incremental");
    }
  }

  // -- the global statistics left behind
  const left = gathers.filter((h) => (h.partitionsGathered ?? 0) > 0 && h.globalGathered === false && (h.targetType === "AUTO" || isAutoOp(h)));
  const leftSchema = gathers.filter((h) => (h.partitionsGathered ?? 0) > 0 && h.globalGathered === false && !(h.targetType === "AUTO" || isAutoOp(h)) && h.targetType === "SCHEMA");
  if (left.length) {
    add("warn", `The automatic job gathered ${plural(left[0]!.partitionsGathered ?? 0, "partition")} of this table (opid ${left[0]!.opid}, ${when(left[0]!.startTime)}) but not the global statistics: the table-level row count, NDV and the partition key's high value lag until the table as a whole passes STALE_PERCENT.`,
      "lab G6, G7, Tb1 (schema GATHER AUTO: partition gathered, global NOT updated); G8, Tb2 (STALE_PERCENT lowered or PREFERENCE_OVERRIDES_PARAMETER TRUE: global updated); the nightly task itself was not run in the lab",
      ["-- a plain call merges the synopses and reads nothing beyond the new partition", `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`, `-- or: EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'PREFERENCE_OVERRIDES_PARAMETER', 'TRUE')`, `-- or: EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'STALE_PERCENT', '1')`]);
    bits.push("global left behind");
  } else if (leftSchema.length) {
    add("info", `${plural(leftSchema.length, "schema-level gather")} (e.g. opid ${leftSchema[0]!.opid}, ${when(leftSchema[0]!.startTime)}) gathered partitions of this table without the global statistics. That is what GATHER AUTO does when the table as a whole is below STALE_PERCENT, or with a PARTITION granularity. The nightly task works like GATHER AUTO.`, "lab G6, G7 (schema GATHER AUTO: global not updated); inferred for this particular call", ["-- a plain call also updates the global statistics", `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
  }

  // -- histogram columns changing between gathers
  const withHist = gathers.filter((h) => h.targetType === "TABLE" && h.histogramColumns.length).slice(0, 4);
  if (withHist.length >= 2) {
    const sets = withHist.map((h) => new Set(h.histogramColumns));
    const added = [...sets[0]!].filter((c) => !sets[1]!.has(c)), removed = [...sets[1]!].filter((c) => !sets[0]!.has(c));
    const anyChange = sets.some((s, i) => i > 0 && (s.size !== sets[0]!.size || [...s].some((c) => !sets[0]!.has(c))));
    if (anyChange) {
      const inc = input.incremental === "TRUE";
      add(inc ? "warn" : "info", `The histogram columns differ between recent gathers${added.length || removed.length ? `: the newest added ${added.join(", ") || "none"} and dropped ${removed.join(", ") || "none"}` : ""}. ${input.methodOpt === "auto" ? "Under SIZE AUTO the recorded column usage decides, so the set moves as queries arrive" : "METHOD_OPT is not SIZE AUTO now, so the preference or the call changed in between"}${inc ? ", and on an INCREMENTAL table a new histogram column re-reads every partition" : ""}.`,
        "lab F0, E1, E3i (first-time predicates: histograms appear and every partition is re-read); 19c Tuning Guide, Histograms (SIZE AUTO uses column usage)",
        ["-- the histograms in place now; pin METHOD_OPT to the ones you want (not those with NOTES HIST_FOR_INCREM_STATS: naming them makes them real, lab Td)", `SELECT column_name, histogram, notes FROM dba_tab_col_statistics WHERE owner = ${quote(input.owner, "OWNER")} AND table_name = ${quote(input.tableName, "TABLE")} AND histogram <> 'NONE';`]);
      bits.push("histogram set moves");
    }
  }

  // -- nothing in the history though statistics exist
  if (!gathers.length && d.lastAnalyzed != null)
    add("info", `No gather appears in the history, but the statistics date from ${when(d.lastAnalyzed)}. The operation log was purged with the statistics history (see retention), or the statistics did not come from a DBMS_STATS gather: online statistics from a bulk load, an import, or ANALYZE (old versions of statistics are not stored when ANALYZE is used).`,
      "19c Tuning Guide, Restrictions for Restoring Optimizer Statistics ('Old versions of statistics are not stored when the ANALYZE command has been used'); Online Statistics Gathering for Bulk Loads; the link to retention is inferred", reportFix);

  if (clean(f) && gathers.length) add("good", `${gathers.length === 1 ? "The listed gather operation" : `All ${fmt(gathers.length)} listed gather operations`} completed${byAuto ? ` (${byAuto} by the automatic job)` : ""}.`, "DBA_OPTSTAT_OPERATIONS");
  else if (!f.length) add("info", "No operations on this table are listed.", "DBA_OPTSTAT_OPERATIONS", reportFix);

  const rows: HealthSection["rows"] = {
    head: ["When", "Operation", "By", "Duration", "Status", "Partitions", "Global", "Indexes", "Target size (blocks)", "Histogram columns"],
    body: hist.map((h) => {
      const ms = opMs(h);
      const hc = h.histogramColumns;
      return [when(h.startTime), h.operation, isAutoOp(h) ? "auto job" : h.jobName ? `job ${h.jobName}` : "call", ms == null ? "–" : dur(ms), h.status ?? "–", h.partitionsGathered == null ? "–" : fmt(h.partitionsGathered), h.globalGathered == null ? "–" : h.globalGathered ? "Y" : "N", h.indexesGathered == null ? "–" : fmt(h.indexesGathered), h.targetSize == null ? "–" : fmt(h.targetSize), hc.length > 3 ? `${hc.slice(0, 3).join(", ")} +${hc.length - 3}` : hc.join(", ") || "–"];
    }),
  };
  return section("history", "Gather history", bits.length ? bits.join("; ") : `${plural(hist.length, "operation")} listed`, f, rows);
}

// ---------------------------------------------------------------- 3. pending

export function pendingSection({ input, detail: d }: HealthContext): HealthSection | null {
  if (d.pendingRows == null && d.optimizerUsePendingStatistics == null) return null;
  const OT = ownerTable(input);
  const f: HealthFinding[] = [];
  const add = (level: Level, text: string, basis: string, fix?: string[]) => f.push(fix ? { level, text, basis, fix } : { level, text, basis });
  const rows = d.pendingRows ?? 0;
  const now = toTime(d.collectedAt), since = toTime(d.pendingSince);
  const ageDays = now != null && since != null ? (now - since) / DAY : null;
  const publishOn = input.publish !== "FALSE";
  const sys = d.optimizerUsePendingStatistics;
  const bits: string[] = [];

  if (d.pendingRows != null && rows > 0) {
    bits.push(`${fmt(rows)} pending rows${ageDays != null ? `, ${days(ageDays)} old` : ""}`);
    add("info", `${plural(rows, "row")} of pending statistics wait in DBA_TAB_PENDING_STATS${d.pendingSince ? ` (oldest ${when(d.pendingSince)})` : ""}. The optimizer ignores them unless OPTIMIZER_USE_PENDING_STATISTICS is TRUE in the session. Test, compare, then publish or delete.`,
      `${GUIDE}, About Pending Optimizer Statistics ('By default, the optimizer uses published statistics. You can change the default behavior by setting the OPTIMIZER_USE_PENDING_STATISTICS initialization parameter to true'); ${REF}, DIFF_TABLE_STATS_IN_PENDING (a NULL timestamp 'compares the current statistics in the dictionary with the pending statistics'), PUBLISH_PENDING_STATS, DELETE_PENDING_STATS`,
      [
        "-- 1. test in one session: the optimizer then uses the pending statistics",
        "ALTER SESSION SET OPTIMIZER_USE_PENDING_STATISTICS = TRUE;",
        "-- 2. compare them with the published statistics (differences above 10 percent)",
        `SELECT * FROM TABLE(DBMS_STATS.DIFF_TABLE_STATS_IN_PENDING(${OT}, NULL, 10));`,
        `-- 3a. publish:  EXEC DBMS_STATS.PUBLISH_PENDING_STATS(${OT})`,
        `-- 3b. or discard:  EXEC DBMS_STATS.DELETE_PENDING_STATS(${OT})`,
      ]);
    if (input.incremental === "TRUE") add("warn", "The table is INCREMENTAL. In the lab, after pending statistics were published by hand, the next gather re-read every partition. Delete the pending rows and gather with PUBLISH TRUE instead.",
      "lab G1, G1b (PUBLISH FALSE: two passes every time), G1c (delete pending, PUBLISH back to default: only the new partition read), Tf (publish by hand, PUBLISH TRUE, gather: all partitions re-read)",
      [`EXEC DBMS_STATS.DELETE_PENDING_STATS(${OT})`, `EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'PUBLISH', 'TRUE')`, `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
    if (publishOn) {
      const old = ageDays != null && ageDays > 7;
      add(old ? "warn" : "info", `PUBLISH is TRUE, so today's gathers publish directly; these pending rows are leftovers of an earlier PUBLISH FALSE gather${ageDays != null ? `, ${days(ageDays)} old` : ""}. ${old ? "Publishing them now would replace the current statistics with old ones. Delete them unless that is the intent." : "Decide before they age."}`,
        "inferred from PUBLISH TRUE (19c Tuning Guide: PUBLISH 'true indicates that the statistics must be published when the database gathers them'); lab G1c (delete pending)", old ? [`-- EXEC DBMS_STATS.DELETE_PENDING_STATS(${OT})`] : undefined);
    } else if (ageDays != null && ageDays > 7) add("warn", `PUBLISH is FALSE and the oldest pending row is ${days(ageDays)} old: every gather since then went to pending, so the published statistics are at least that old.`, "19c Tuning Guide, Publishing Pending Optimizer Statistics; inferred from the age");
  } else if (d.pendingRows === 0) bits.push("no pending rows");

  if (sys === true) {
    add(rows > 0 ? "warn" : "info", `OPTIMIZER_USE_PENDING_STATISTICS is TRUE in the collector's session (V$PARAMETER shows the session value). If the instance has it too, every statement is optimised with the pending statistics of tables that have some.`, "19c Reference, OPTIMIZER_USE_PENDING_STATISTICS (default false; ALTER SESSION, ALTER SYSTEM); Tuning Guide, Publishing Pending Optimizer Statistics ('The best practice is to set this parameter at the session level rather than at the database level')", ["SELECT name, value, isdefault FROM v$system_parameter WHERE name = 'optimizer_use_pending_statistics';"]);
    bits.push("parameter TRUE");
  }
  if (clean(f) && d.pendingRows === 0 && sys !== true) add("good", "No pending statistics exist for this table and the optimizer is not told to use them.", "DBA_TAB_PENDING_STATS");
  else if (clean(f) && d.pendingRows == null && sys === false) add("good", "The optimizer uses published statistics only (OPTIMIZER_USE_PENDING_STATISTICS = FALSE).", "19c Reference, OPTIMIZER_USE_PENDING_STATISTICS");
  return section("pending", "Pending statistics", bits.join("; ") || "checked", f);
}

// ---------------------------------------------------------------- 4. restore

export function restoreSection({ input, detail: d }: HealthContext): HealthSection | null {
  if (d.retentionDays == null && d.historyAvailableSince == null && d.historyRows == null) return null;
  const OT = ownerTable(input), own = quote(input.owner, "OWNER"), tab = quote(input.tableName, "TABLE");
  const f: HealthFinding[] = [];
  const add = (level: Level, text: string, basis: string, fix?: string[]) => f.push(fix ? { level, text, basis, fix } : { level, text, basis });
  const now = toTime(d.collectedAt), avail = toTime(d.historyAvailableSince);
  const ret = d.retentionDays;
  const bits: string[] = [];

  // -- what can be restored
  const span = d.historyOldest && d.historyNewest ? ` The table's own versions run from ${when(d.historyOldest)} to ${when(d.historyNewest)}${d.historyRows != null ? ` (${fmt(d.historyRows)} entries in DBA_TAB_STATS_HISTORY)` : ""}.` : d.historyRows != null ? ` DBA_TAB_STATS_HISTORY holds ${fmt(d.historyRows)} entries for it.` : "";
  add("info", `Statistics can be restored to any time after ${d.historyAvailableSince ? when(d.historyAvailableSince) : "the oldest history timestamp (not collected)"}.${span} Old versions are saved whenever the statistics change; RESTORE_TABLE_STATS brings back the statistics of the table, its indexes and columns, and locks them if they were locked at that time.`,
    `${GUIDE}, Restoring Optimizer Statistics Using DBMS_STATS ('You can specify any date between 8/10 and 8/20 because DBMS_STATS restores statistics as of the specified time'); Obtaining Optimizer Statistics History ('Users cannot restore statistics to a time stamp older than the oldest time stamp'); ${REF}, RESTORE_TABLE_STATS, DIFF_TABLE_STATS_IN_HISTORY (OWNNAME, TABNAME, TIME1, TIME2, PCTTHRESHOLD; signature checked on 19.27)`,
    [
      "-- 1. the versions you can go back to",
      `SELECT stats_update_time FROM dba_tab_stats_history WHERE owner = ${own} AND table_name = ${tab} AND partition_name IS NULL ORDER BY stats_update_time DESC;`,
      "-- 2. compare the statistics a day ago with today's (differences above 10 percent)",
      `SELECT * FROM TABLE(DBMS_STATS.DIFF_TABLE_STATS_IN_HISTORY(${OT}, SYSTIMESTAMP - INTERVAL '1' DAY, SYSTIMESTAMP, 10));`,
      "-- 3. restore to a time from step 1 (locked statistics need force => TRUE)",
      `-- EXEC DBMS_STATS.RESTORE_TABLE_STATS(${OT}, as_of_timestamp => TIMESTAMP 'YYYY-MM-DD HH24:MI:SS')`,
    ]);
  if (d.historyAvailableSince && avail != null && now != null && ret != null && ret > 0 && avail > now - (ret - 2) * DAY)
    add("info", `The oldest restorable time (${when(d.historyAvailableSince)}) is only ${days((now - avail) / DAY)} back although the retention is ${days(ret)}: the history was purged by hand, or the instance is younger than the retention.`, "inferred from GET_STATS_HISTORY_AVAILABILITY and GET_STATS_HISTORY_RETENTION");

  // -- retention
  if (ret != null) {
    bits.push(ret === -1 ? "retention: never purged" : ret === 0 ? "retention 0: nothing saved" : `retention ${ret} days`);
    const gaps: number[] = [];
    const gt = (d.history.filter((h) => /gather/i.test(h.operation) && !/reporting mode/i.test(h.operation) && h.targetType === "TABLE").map((h) => toTime(h.startTime)).filter((x): x is number => x != null));
    for (let i = 0; i + 1 < gt.length; i++) if (gt[i]! - gt[i + 1]! > 60_000) gaps.push((gt[i]! - gt[i + 1]!) / DAY);
    const gapRaw = median(gaps), gap = gapRaw != null && gapRaw >= 1 ? gapRaw : null; // gathers minutes apart are a burst, not a rhythm
    if (ret === 0) add("bad", "The retention is 0: old statistics are never saved and the automatic purge deletes all history. There is nothing to restore after a bad gather.", `${REF}, ALTER_STATS_HISTORY_RETENTION ('0: Old statistics are never saved. The automatic purge will delete all statistics history')`, ["-- EXEC DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(31)  -- the default"]);
    else if (ret === -1) add("info", `The retention is -1: the automatic purge never removes history, so SM/OPTSTAT in SYSAUX grows without limit${d.sysauxOptstatMb != null ? ` (${fmt(d.sysauxOptstatMb, 1)} MB now)` : ""}. Plan for the space.`, `${REF}, ALTER_STATS_HISTORY_RETENTION ('-1: Statistics history is never purged by automatic purge')`, ["-- EXEC DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(31)  -- back to the default"]);
    else if (ret < 3) add("warn", `The retention is ${days(ret)}, short of the default 31: a bad gather noticed after a long weekend cannot be undone.${gap != null ? ` The listed gathers are about ${days(gap)} apart.` : ""}`, `${GUIDE}, Managing Optimizer Statistics Retention ('By default, the database retains optimizer statistics for 31 days'); ${REF}, ALTER_STATS_HISTORY_RETENTION ('retained for at least these many number of days')`, [`-- EXEC DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(31)`]);
    else if (gap != null && ret < gap) add("warn", `The retention is ${days(ret)} but this table is gathered only every ${days(gap)} or so (median of the listed gathers): the version before the current one is purged before the next gather replaces it, so there may be nothing to restore.`, `${REF}, ALTER_STATS_HISTORY_RETENTION ('The statistics history will be retained for at least these many number of days'); ${GUIDE}, Purging Optimizer Statistics ('purges all history older than the older of (current time - the ALTER_STATS_HISTORY_RETENTION setting) and (time of the most recent statistics gathering - 1)'); the comparison with the gather interval is inferred`, [`-- EXEC DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(${Math.ceil(gap * 3)})`]);
    else add(ret === 31 ? "good" : "info", `The retention is ${days(ret)}${ret === 31 ? ", the default" : ""}${gap != null ? `; this table is gathered about every ${days(gap)}, so the history covers ${fmt(Math.floor(ret / gap))} older version${Math.floor(ret / gap) === 1 ? "" : "s"}` : ""}.`, `${GUIDE}, Changing the Optimizer Statistics Retention Period ('The default is 31 days')`);
  }

  // -- space and the knobs
  if (d.sysauxOptstatMb != null && d.sysauxOptstatMb >= 1024) add("info", `SM/OPTSTAT occupies ${fmt(d.sysauxOptstatMb / 1024, 1)} GB of SYSAUX for the whole database. The knobs are ALTER_STATS_HISTORY_RETENTION (how long) and PURGE_STATS (delete now, and with it the ability to restore).`, `${GUIDE}, Purging Optimizer Statistics; ${REF}, PURGE_STATS (SYSDBA, or ANALYZE ANY DICTIONARY and ANALYZE ANY); V$SYSAUX_OCCUPANTS`, ["SELECT occupant_name, space_usage_kbytes FROM v$sysaux_occupants WHERE occupant_name = 'SM/OPTSTAT';", "-- deliberate only: history older than 31 days is gone for good", "-- EXEC DBMS_STATS.PURGE_STATS(SYSTIMESTAMP - INTERVAL '31' DAY)"]);

  // -- restore operations that already happened
  const restores = d.history.filter((h) => /restore/i.test(h.operation));
  if (restores.length) add("info", `${plural(restores.length, "restore operation")} in the history: ${restores.slice(0, 3).map((h) => `opid ${h.opid} ${h.operation} at ${when(h.startTime)}`).join("; ")}. A later gather overwrites restored statistics unless they are locked.`, "DBA_OPTSTAT_OPERATIONS; the overwrite by a later gather is inferred from the lock rule (19c DBMS_STATS reference, LOCK_TABLE_STATS)");

  const rows: HealthSection["rows"] = {
    head: ["Item", "Value"],
    body: ([
      ["Retention", ret == null ? "–" : ret === -1 ? "-1 (never purged)" : `${fmt(ret)} days`],
      ["Restorable since", when(d.historyAvailableSince)],
      ["Versions of this table (rows)", fmt(d.historyRows)],
      ["Oldest version", when(d.historyOldest)],
      ["Newest version", when(d.historyNewest)],
      ["SM/OPTSTAT (SYSAUX)", d.sysauxOptstatMb == null ? "–" : `${fmt(d.sysauxOptstatMb, 1)} MB`],
    ] as string[][]),
  };
  return section("restore", "Restoring and history retention", bits.join("; ") || "history collected", f, rows);
}

// ---------------------------------------------------------------- 5. load

export function loadSection({ input, detail: d }: HealthContext): HealthSection | null {
  if (d.statsOnLoad == null) return null;
  const OT = ownerTable(input), own = quote(input.owner, "OWNER"), tab = quote(input.tableName, "TABLE");
  const f: HealthFinding[] = [];
  const add = (level: Level, text: string, basis: string, fix?: string[]) => f.push(fix ? { level, text, basis, fix } : { level, text, basis });
  if (!d.statsOnLoad) {
    add("good", "No statistics note says STATS_ON_LOAD: the statistics did not come from an online gather during a bulk load.", "DBA_TAB_STATISTICS.NOTES, DBA_TAB_COL_STATISTICS.NOTES");
    if (input.tableStats === "load") add("info", "The form says the statistics come from a bulk load, but the notes in the dictionary do not show it.", "DBA_TAB_STATISTICS.NOTES");
    return section("load", "Statistics from a bulk load", "none", f);
  }
  const noIdx = d.indexes.filter((i) => i.lastAnalyzed == null);
  const histCols = d.columns.filter((c) => !c.isExtension && c.histogram != null && c.histogram !== "NONE" && !/HIST_FOR_INCREM_STATS/.test(c.notes ?? ""));
  const loadCols = d.columns.filter((c) => /STATS_ON_LOAD/.test(c.notes ?? ""));
  const gap = [
    `no histograms (${loadCols.length ? `${fmt(histCols.length)} of ${fmt(d.columns.filter((c) => !c.isExtension).length)} columns have one` : "none are created by the load"})`,
    d.indexes.length ? `${fmt(noIdx.length)} of ${fmt(d.indexes.length)} indexes without statistics` : "the guide says nothing about index statistics",
  ].join("; ");
  const fix = [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, options => 'GATHER AUTO')`];
  add("info", `The statistics come from online gathering during a bulk load (NOTES = STATS_ON_LOAD): table and basic column statistics are there, but ${gap}. Rows loaded since then count as DML against them.`,
    `${GUIDE}, Online Statistics Gathering for Bulk Loads ('After gathering online statistics, the database does not automatically create histograms'); the NOTES value is the one the advisor's collector reads, not in the 19c Reference pages; index statistics: the explainer saw none after a load`,
    [`SELECT column_name, histogram, notes FROM dba_tab_col_statistics WHERE owner = ${own} AND table_name = ${tab} AND notes LIKE '%STATS_ON_LOAD%';`]);
  if (input.incremental === "TRUE") add("info", "The Tuning Guide fills the gaps with GATHER AUTO, which the DBMS_STATS reference limits to tables without INCREMENTAL. For this table use a plain GATHER_TABLE_STATS.", "19c DBMS_STATS reference, options GATHER AUTO ('This option is only applicable to tables that do not have INCREMENTAL enabled'; lab-observations.md, documentation quotes)", [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
  else add("info", "Fill the gaps without re-reading what the load collected: GATHER_TABLE_STATS with options => 'GATHER AUTO' gathers only missing or stale statistics, so histograms are added and the load's table and basic column statistics stay.", `${GUIDE}, Histogram Creation After Bulk Loads ('The preceding PL/SQL program only gathers missing or stale statistics. The database does not gather table and basic column statistics collected during the bulk load')`, fix);
  if (d.staleStats === true) add("info", "The load statistics are already stale (STALE_STATS = YES). A later bulk load into the now non-empty table gathers nothing online.", "Online Statistics Gathering for Bulk Loads, Restrictions ('Bulk loads only gather online statistics automatically when the object is empty')");
  if (input.tableLocked) add("warn", "The table's statistics are locked. A bulk load gathers nothing online into a locked table, and a gather raises ORA-20005 (object statistics are locked) unless force => TRUE is given; the lock stays.", "19c Tuning Guide, Restrictions for Online Statistics Gathering for Bulk Loads ('Its statistics are locked'); lab D1 (ORA-20005), D3 (force => TRUE gathered, lock remained)", [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, force => TRUE)`, `-- or unlock first: EXEC DBMS_STATS.UNLOCK_TABLE_STATS(${OT})`]);
  if (input.publish === "FALSE") add("warn", "PUBLISH is FALSE on the table: a bulk load does not gather statistics online into it.", "19c Tuning Guide, Restrictions for Online Statistics Gathering for Bulk Loads ('It has a PUBLISH preference set to FALSE')");
  return section("load", "Statistics from a bulk load", `STATS_ON_LOAD; ${gap}`, f);
}

// ---------------------------------------------------------------- 6. real-time statistics and adaptive statistics

export function realtimeSection({ input, detail: d }: HealthContext): HealthSection | null {
  if (d.realtimeStatsParam == null && d.optimizerAdaptiveStatistics == null) return null;
  const f: HealthFinding[] = [];
  const add = (level: Level, text: string, basis: string, fix?: string[]) => f.push(fix ? { level, text, basis, fix } : { level, text, basis });
  const own = quote(input.owner, "OWNER"), tab = quote(input.tableName, "TABLE");
  const bits: string[] = [];
  const licence = "19c Licensing Information, Table 1-8: Real-Time Statistics and High-Frequency Automatic Optimizer Statistics Collection are N for SE2 and EE, Y for EE-ES and ExaDB ('EE-ES : Available on Exadata. Not available on Oracle Database Appliance.')";
  const notesSql = [`SELECT table_name, partition_name, num_rows, TRIM(notes) AS notes FROM dba_tab_statistics WHERE owner = ${own} AND table_name = ${tab} AND notes LIKE '%STATS_ON_CONVENTIONAL%';`];
  if (d.realtimeStatsParam === false) {
    add("info", `OPTIMIZER_REAL_TIME_STATISTICS is FALSE (the default), so conventional DML moves only the DML counters. In 19c the feature is licensed for Exadata only; the parameter exists from 19.10.`,
      `19c Reference, OPTIMIZER_REAL_TIME_STATISTICS ('The default setting is false, which means real-time statistics are disabled'; 'available starting with Oracle Database 19c, Release Update 19.10'); ${licence}`);
    if (d.realtimeStatsNotes) add("info", "The statistics notes still show STATS_ON_CONVENTIONAL_DML: real-time statistics were collected earlier, or by a session or instance with another setting (the parameter can differ per session, per RAC instance and per PDB; the collector read its own value).", "19c Tuning Guide, Real-Time Statistics ('indicated by STATS_ON_CONVENTIONAL_DML in the NOTES column'); 19c Reference, OPTIMIZER_REAL_TIME_STATISTICS (modifiable per session; RAC: different values per instance)", notesSql);
    bits.push("real-time statistics off");
  } else if (d.realtimeStatsParam === true) {
    add("info", `Real-time statistics are on: conventional DML keeps the most essential statistics current between gathers (the guide's example shows the table row count and the column low and high values). They are table-level only${input.partitioned ? ", so the partitions of this table get none" : ""}, and they augment the gathered statistics, so keep gathering. A statement with the NO_GATHER_OPTIMIZER_STATISTICS hint does not collect them.`,
      "19c Tuning Guide, Real-Time Statistics ('dynamically computes values for the most essential statistics'; 'real-time statistics augment rather than replace traditional statistics. For this reason, you must continue to gather statistics regularly'; 'Note that partition-level statistics are not supported'; 'The NO_GATHER_OPTIMIZER_STATISTICS hint prevents the collection of real-time statistics'); which statistics are covered beyond the guide's example is inferred");
    if (d.realtimeStatsNotes) add("info", "The table carries real-time statistics now (NOTES = STATS_ON_CONVENTIONAL_DML). The next gather supersedes them (inferred; the guide does not say when the note goes).", "19c Tuning Guide, Real-Time Statistics ('indicated by STATS_ON_CONVENTIONAL_DML in the NOTES column and SHARED in the SCOPE column'); the supersession is inferred, not observed", notesSql);
    else add("info", "No real-time rows on the table now; they appear after conventional DML between gathers. The Tuning Guide spells the NOTES value STATS_ON_CONVENTIONAL_DML and the Reference STATS_ON_CONVENTIONAL_LOAD; the collector tests the first, so a table that shows the second would read as none.", "19c Tuning Guide, Real-Time Statistics (STATS_ON_CONVENTIONAL_DML) against 19c Reference, ALL_TAB_STATISTICS.NOTES and ALL_TAB_COL_STATISTICS.NOTES (STATS_ON_CONVENTIONAL_LOAD): the two pages differ", notesSql);
    bits.push("real-time statistics on");
  }
  if (d.autoTaskStatus != null) add("info", `The high-frequency statistics task is ${d.autoTaskStatus}${d.autoTaskStatus === "OFF" ? " (the default)" : ""}${d.autoTaskInterval != null ? `, interval ${fmt(d.autoTaskInterval)} s` : ""}. Like real-time statistics, it is licensed for Exadata only in 19c.`, `${REF}, AUTO_TASK_STATUS (OFF is the default); ${licence}`);
  if (d.optimizerAdaptiveStatistics === false) {
    add("info", "OPTIMIZER_ADAPTIVE_STATISTICS is FALSE (the 19c default): SQL plan directives can still be created, but they are not used to refine plans with dynamic sampling. A column-group candidate that comes from a directive is a recorded misestimate, not yet an effect; SEED_COL_USAGE is the firmer source.",
      "19c Reference, OPTIMIZER_ADAPTIVE_STATISTICS ('Setting this parameter to false disables the following adaptive features: SQL plan directives'; 'OPTIMIZER_ADAPTIVE_STATISTICS does not control the creation of SQL plan directives. SQL plan directives will be created even if this parameter is false, but they will not be used to refine SQL execution plans with dynamic sampling.'); lab-observations.md, Column groups (CG1: no directive created with FALSE, one USABLE directive with TRUE after the flush); a directive candidate also appears in the collector output of ORASTATS_TEST.EXPR_PRED, 2026-10-11");
    bits.push("adaptive statistics off");
  } else if (d.optimizerAdaptiveStatistics === true) add("info", "OPTIMIZER_ADAPTIVE_STATISTICS is TRUE: SQL plan directives are created and used, so column-group candidates can come from directives (equality predicates only help a group) as well as from SEED_COL_USAGE.", "19c Reference, OPTIMIZER_ADAPTIVE_STATISTICS; lab CG1 (one USABLE DYNAMIC_SAMPLING directive with TRUE)");
  return section("realtime", "Real-time and adaptive statistics", bits.join("; ") || "checked", f);
}

// ---------------------------------------------------------------- 7. subpartitions

export function subpartitionsSection({ input, detail: d }: HealthContext): HealthSection | null {
  if (d.subpartitioning == null || d.subpartitioning === "NONE") return null;
  const f: HealthFinding[] = [];
  const add = (level: Level, text: string, basis: string, fix?: string[]) => f.push(fix ? { level, text, basis, fix } : { level, text, basis });
  const own = quote(input.owner, "OWNER"), tab = quote(input.tableName, "TABLE");
  const OT = ownerTable(input);
  const n = d.subpartitions, w = d.subpartitionsWithStats;
  const type = d.subpartitioning;
  const gran = input.callGranularity !== "none" && input.overrides !== "TRUE" ? input.callGranularity : input.granularity;
  const subLevel = gran === "ALL" || gran === "SUBPARTITION";
  const inc = input.partitioned && input.incremental === "TRUE";
  const survey = [`SELECT COUNT(*) AS subpartitions, COUNT(last_analyzed) AS with_statistics FROM dba_tab_subpartitions WHERE table_owner = ${own} AND table_name = ${tab};`];
  if (n == null || w == null) return section("subpartitions", "Subpartition statistics", "subpartition counts not collected", [{ level: "info", text: `The table is subpartitioned by ${type}; the collector did not count its subpartitions.`, basis: "DBA_PART_TABLES.SUBPARTITIONING_TYPE", fix: survey }]);
  add("info", `The table is composite (subpartitioned by ${type}): ${plural(n, "subpartition")}, ${fmt(w)} with statistics${n ? ` (${pct(w / n)})` : ""}.`, "DBA_TAB_SUBPARTITIONS.LAST_ANALYZED", survey);
  if (!subLevel && w === 0) add("info", `GRANULARITY ${gran} gathers no subpartition statistics${type === "HASH" ? ", which matches: none exist" : ` on a HASH-subpartitioned table (lab); for ${type} subpartitions that was not tested, but none exist here`}. The optimizer works from partition and global statistics.${inc ? " DML in one subpartition makes the whole partition stale, so a gather rereads the whole partition (lab J: 500 rows into one hash subpartition, one PART SYN statement over the partition)." : ""}`,
    `${REF}, granularity ('AUTO - Determines the granularity based on the partitioning type'; 'GLOBAL AND PARTITION - ... No subpartition level statistics are gathered even if it is a composite partitioned object'); lab J, Q4 (HASH subpartitions, AUTO: partition statistics, no subpartition statistics)${type === "HASH" ? "" : "; for " + type + " subpartitions this is inferred"}`);
  else if (subLevel && w < n) add("warn", `GRANULARITY ${gran} should gather the subpartitions, yet ${fmt(n - w)} of ${fmt(n)} have no statistics. Either no gather has run since the setting changed, or those subpartitions were skipped (locked, or no data change under incremental maintenance).`,
    `${REF}, granularity ('ALL' gathers all; 'SUBPARTITION - Gathers subpartition-level statistics'); 19c Tuning Guide, Considerations for Incremental Statistics Maintenance ('the database only gathers statistics for modified subpartitions')`, [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, granularity => 'ALL')`]);
  else if (!subLevel && w > 0) add("info", `${fmt(w)} subpartitions carry statistics although GRANULARITY ${gran} does not gather that level, so they date from an earlier ALL or SUBPARTITION gather. They are not refreshed, so they fall behind the partition statistics; the optimizer can use them when pruning leaves a single subpartition (inferred).`,
    `${REF}, granularity; which level the optimizer uses is inferred, not found in the Tuning Guide pages read`, [`SELECT subpartition_name, num_rows, last_analyzed FROM dba_tab_subpartitions WHERE table_owner = ${own} AND table_name = ${tab} ORDER BY last_analyzed NULLS FIRST;`]);
  else add("info", `GRANULARITY ${gran} gathers the subpartition level and all ${fmt(n)} subpartitions have statistics.`, REF);
  if (!subLevel) add("info", inc
    ? "Subpartition statistics would help only if pruning often reaches a single subpartition, and they cost a read of every subpartition at each gather. On this INCREMENTAL table keep GRANULARITY AUTO: the Tuning Guide lists it among the conditions for incremental statistics (lab A6 saw ALL work on a table without subpartitions; a composite table was not tested)."
    : "Subpartition statistics help the optimizer when pruning often reaches a single subpartition, at the price of reading every subpartition at each gather. The table preference GRANULARITY ALL does that; the default AUTO does not.",
    `${REF}, granularity; 19c Tuning Guide, Guideline for Partitioned Objects ('The ALL setting gathers statistics for all types'), Considerations for Incremental Statistics Maintenance ('AUTO for GRANULARITY'); lab A6; the cost is inferred`,
    inc ? undefined : ["-- an option, not a recommendation", `-- EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'GRANULARITY', 'ALL')`]);
  return section("subpartitions", "Subpartition statistics", `${fmt(n)} subpartitions, ${fmt(w)} with statistics`, f);
}
