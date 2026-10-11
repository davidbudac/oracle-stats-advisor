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
/** `Xm Ys` (no hours: 4 hours are 240m 0s). */
const dur = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}m ${s % 60}s`; };
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

/** The first maintenance window starting at or after `at` (one that is open at `at` counts as starting then), assuming each window recurs weekly. */
function windowAfter(windows: WindowRec[], at: number): { w: WindowRec; start: number; open: boolean } | null {
  let best: { w: WindowRec; start: number; open: boolean } | null = null;
  for (const w of windows) {
    if (w.enabled === false) continue;
    let t = toTime(w.nextStart), open = false;
    if (t == null) continue;
    if (t < at) {
      const len = intervalMs(w.duration);
      if (len != null && at < t + len) { t = at; open = true; } else t += Math.ceil((at - t) / (7 * DAY)) * 7 * DAY;
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
  const verdictWord = d.staleStats == null ? "" : ` DBA_TAB_STATISTICS.STALE_STATS = ${d.staleStats ? "YES" : "NO"}.`;
  const agrees = d.staleStats == null || d.staleStats === over;
  if (rc != null) {
    if (numRows > 0) {
      add(over ? "warn" : "info",
        `${fmt(rc)} rows changed since the last gather${rc === 0 ? " (no DML counted, so there is no rate to extrapolate)" : ""}: ${pct(rc / numRows)} of the ${fmt(numRows)} rows in the statistics. STALE_PERCENT is ${fmt(sp, 4)}%, which is ${fmt(thr)} rows${over ? ", so the table is past it" : ""}.${agrees ? verdictWord : ""}`,
        `${GUIDE}, Determining When Optimizer Statistics Are Stale (STALE_STATS 'is based on data in the DBA_TAB_MODIFICATIONS view and the STALE_PERCENT preference for DBMS_STATS'); ${REF}, STALE_PERCENT ('the percentage of rows in a table that have to change before the statistics on that table are deemed stale')`);
      summary.push(`${pct(rc / numRows)} changed of ${fmt(sp, 4)}%`);
    } else if (rc > 0) {
      add("warn", `${fmt(rc)} rows changed since the last gather, and the statistics say the table has no rows, so STALE_PERCENT of nothing is nothing: any change makes it stale (inferred).${agrees ? verdictWord : ""}`, "inferred from the STALE_PERCENT definition; DBA_TAB_MODIFICATIONS");
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
    const note = "The counters are approximate ('Approximate number of inserts since the last time statistics were gathered'). Since 12.2 the views read memory and disk, so DBMS_STATS.FLUSH_DATABASE_MONITORING_INFO is not needed to see current numbers.";
    const basis = `${GUIDE}, Determining When Optimizer Statistics Are Stale ('The statistics shown in the DBA_TAB_STATISTICS, DBA_IND_STATISTICS, and DBA_TAB_MODIFICATIONS views are obtained from both disk and memory'); 19c Reference, ALL_TAB_MODIFICATIONS`;
    if (d.staleStats && agrees) add("warn", "The dictionary itself calls the statistics stale (STALE_STATS = YES).", basis);
    else if (d.staleStats) add("warn", `STALE_STATS = YES although ${rc != null && numRows > 0 ? `only ${pct(rc / numRows)} of the rows changed, below STALE_PERCENT` : "the change counters are below STALE_PERCENT"}: the cause is something else the monitoring tracks (a truncate, dropped partition segments) or counters that moved after the collector read them. ${note}`, basis, verdictFix);
    else if (!agrees) add("info", `STALE_STATS says NO although the counters are past STALE_PERCENT. ${note}`, basis, verdictFix);
    summary.push(`STALE_STATS ${d.staleStats ? "YES" : "NO"}`);
  }

  // -- a truncate
  if (d.rowsTruncated) {
    add("bad", "The table was truncated since the last gather (DBA_TAB_MODIFICATIONS.TRUNCATED = YES). The statistics describe rows that are gone, so treat them as stale whatever the change percentage says.",
      `${GUIDE}, Determining When Optimizer Statistics Are Stale ('Monitoring tracks the approximate number of DML operations on a table and whether the table has been truncated since the most recent statistics collection'); 19c Reference, ALL_TAB_MODIFICATIONS.TRUNCATED. That STALE_STATS turns YES on a truncate is inferred (the text does not say) and was seen on the lab table CHAOS.FILL`,
      [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
    summary.push("truncated");
  }

  // -- the rate and the forecast
  const end = mods != null && last != null && mods > last ? mods : now;
  if (rc != null && rc > 0 && last != null && end != null && numRows > 0) {
    const elapsed = (end - last) / DAY;
    if (elapsed < 1 / 24) add("info", `The ${fmt(rc)} changes came within an hour of the last gather (${when(d.lastAnalyzed)}); too short a span to extrapolate a rate.`, "inferred");
    else {
      const fc = staleForecast(rc, numRows, sp, elapsed);
      const base = now ?? end;
      const span = `${when(d.lastAnalyzed)} to ${stamp(end)}`;
      if (fc.daysLeft === 0) {
        add("info", `At that pace (${fmt(fc.rate)} rows per day over ${days(elapsed)}, ${span}) the table crossed STALE_PERCENT about ${days(fc.crossedAfterDays ?? 0)} after the last gather, around ${stamp(last + (fc.crossedAfterDays ?? 0) * DAY)}. Assumption: changes spread evenly, linear since the last gather.`, "inferred: linear extrapolation of DBA_TAB_MODIFICATIONS");
      } else if (fc.daysLeft != null) {
        const cross = base + fc.daysLeft * DAY;
        add("info", `At about ${fmt(fc.rate)} rows per day (${fmt(rc)} changes over ${days(elapsed)}, ${span}) the table reaches STALE_PERCENT (${fmt(fc.threshold)} rows) in about ${days(fc.daysLeft)}, around ${stamp(cross)}. Assumption: changes spread evenly, linear since the last gather; a load or purge in one night breaks the line.`, "inferred: linear extrapolation of DBA_TAB_MODIFICATIONS");
        summary.push(`threshold in ~${days(fc.daysLeft)}`);
      }
    }
  }

  // -- when it will actually be gathered: the nightly task
  const crossingAt = (() => {
    if (stale) return now; // already stale: the next run
    if (rc != null && rc > 0 && last != null && end != null && numRows > 0 && end - last >= DAY / 24) {
      const fc = staleForecast(rc, numRows, sp, (end - last) / DAY);
      return fc.daysLeft != null ? (now ?? end) + fc.daysLeft * DAY : null;
    }
    return null;
  })();
  if (d.autotaskStatus === "DISABLED") {
    add("bad", "The automatic optimizer statistics task is DISABLED (DBA_AUTOTASK_CLIENT): nothing gathers this table unless a job or a person does.",
      "19c Tuning Guide, About Automatic Optimizer Statistics Collection ('Oracle strongly recommends that you not disable automatic statistics gathering because it is critical for the optimizer to generate optimal plans')",
      ["EXEC DBMS_AUTO_TASK_ADMIN.ENABLE(client_name => 'auto optimizer stats collection', operation => NULL, window_name => NULL)"]);
    summary.push("auto task disabled");
  } else if (d.autotaskStatus === "ENABLED" && d.windows.length) {
    const nxt = windowAfter(d.windows, now ?? 0);
    if (!nxt) add("warn", "No maintenance window has the statistics task enabled (DBA_AUTOTASK_WINDOW_CLIENTS): the task never starts.", "19c Tuning Guide, About Automatic Optimizer Statistics Collection ('By default, the collection runs in all predefined maintenance windows')");
    else {
      const w = nxt.w, winLen = intervalMs(w.duration);
      const first = now != null ? (nxt.open ? ` ${w.name} is open now (it started ${when(w.nextStart)}${winLen ? `, ${dur(winLen)} long` : ""}).` : ` Next window with the task: ${w.name} at ${stamp(nxt.start)}${winLen ? ` (${dur(winLen)} long)` : ""}.`) : "";
      if (stale) add("info", `The table is stale now, so the next run gathers it, neediest objects first, until the window closes.${first}`, "19c Tuning Guide, About Automatic Optimizer Statistics Collection ('Automatic statistics collection ... prioritizes objects that have no statistics or very old statistics'); the task gathers only missing and stale statistics");
      else if (crossingAt != null && now != null) {
        const after = windowAfter(d.windows, crossingAt);
        add("info", `${first.trim() || ""} At the forecast pace the table is stale around ${stamp(crossingAt)}${after ? `; the first window after that is ${after.w.name} at ${stamp(after.start)} (${days((after.start - crossingAt) / DAY)} later, windows assumed weekly)` : ""}. Until then the statistics stay as they are.`.trim(), "inferred: next window start from DBA_SCHEDULER_WINDOWS; the task gathers only stale statistics");
      } else add("info", `Not stale, so the task skips the table at its next run.${first}`, "19c Tuning Guide (the automatic task gathers only missing and stale statistics)");
      summary.push(nxt.open ? `${w.name} open now` : `next window ${stamp(nxt.start)}`);
    }
    // the last runs of the task
    const runs = d.autoruns;
    if (runs.length) {
      const bad = runs.filter((r) => r.jobStatus != null && r.jobStatus.toUpperCase() !== "SUCCEEDED");
      const longest = Math.max(...runs.map((r) => intervalMs(r.jobDuration) ?? 0));
      const winMs = new Map(d.windows.map((w) => [w.name, intervalMs(w.duration)] as const));
      const hitEnd = runs.filter((r) => { const win = winMs.get(r.windowName), jd = intervalMs(r.jobDuration); return win != null && jd != null && jd >= win * 0.98; });
      if (bad.length || hitEnd.length) {
        const list = [...new Set([...bad, ...hitEnd])].slice(0, 4).map((r) => `${r.windowName} ${when(r.windowStart)}: ${r.jobStatus ?? "?"}, ${dur(intervalMs(r.jobDuration) ?? 0)}${r.jobInfo ? ` (${r.jobInfo.slice(0, 80)})` : ""}`).join("; ");
        add("warn", `${plural(Math.max(bad.length, hitEnd.length), "of the last " + runs.length + " runs")} did not finish cleanly or ran to the end of the window: ${list}. Objects the run did not reach stay stale and are candidates again in the next window; the statistics are gathered late, not skipped.`,
          "19c Reference, DBA_OPTSTAT_OPERATIONS.STATUS ('TIMED OUT: Maintenance window was not enough to complete this operation'); Tuning Guide ('prioritizes objects that have no statistics or very old statistics'); the resumption in the next window is inferred",
          ["SELECT window_name, window_start_time, job_status, job_duration, job_info FROM dba_autotask_job_history WHERE client_name = 'auto optimizer stats collection' ORDER BY job_start_time DESC FETCH FIRST 10 ROWS ONLY;"]);
        summary.push("window overrun");
      } else add("info", `The last ${plural(runs.length, "run")} of the task all SUCCEEDED (longest ${dur(longest)}), none to the end of its window.`, "DBA_AUTOTASK_JOB_HISTORY");
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
  const runWord = (rs: typeof d.hfruns) => `${rs.length} (${["COMPLETED", "FAILED", "TIMED OUT"].map((s) => [s, rs.filter((r) => (r.status ?? "").toUpperCase() === s).length] as const).filter(([, n]) => n).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ") || "no status"})`;
  if (d.autoTaskStatus === "ON") {
    const iv = d.autoTaskInterval, mx = d.autoTaskMaxRunTime;
    add("info", `The high-frequency task is ON: every ${iv != null ? `${fmt(iv)} s` : "?"}, at most ${mx != null ? `${fmt(mx)} s` : "?"} per run. It gathers stale statistics only, does nothing else the nightly job does, and does not start while the window's job is running.`,
      `${REF}, AUTO_TASK_STATUS / AUTO_TASK_INTERVAL / AUTO_TASK_MAX_RUN_TIME; ${GUIDE}, About High-Frequency Automatic Optimizer Statistics Collection ('The high-frequency task is lightweight and only gathers stale statistics'; 'it will not execute while the maintenance window auto stats gathering job is executing')`);
    if (!hfRuns.length) add("warn", `The task is ON but none of the last ${plural(d.hfruns.length, "row")} of DBA_AUTO_STAT_EXECUTIONS has ORIGIN HIGH_FREQ_AUTO_TASK. It may not run: check the licence (Exadata and EE-ES only) and the interval.`, "19c Reference, DBA_AUTO_STAT_EXECUTIONS.ORIGIN; 19c Licensing Information, 'High-Frequency Automatic Optimizer Statistics Collection' (EE-ES: Available on Exadata)", ["SELECT opid, origin, status, start_time, end_time, completed, failed, timed_out FROM dba_auto_stat_executions ORDER BY opid DESC FETCH FIRST 10 ROWS ONLY;"]);
    else {
      const lvl: Level = sumOf(hfRuns, "failed") || sumOf(hfRuns, "timedOut") ? "warn" : "info";
      add(lvl, `Last ${plural(hfRuns.length, "high-frequency run")}: ${runWord(hfRuns)}; objects ${fmt(sumOf(hfRuns, "completed"))} completed, ${fmt(sumOf(hfRuns, "failed"))} failed, ${fmt(sumOf(hfRuns, "timedOut"))} timed out. The view also lists the nightly runs (ORIGIN AUTO_TASK${nightly.length ? `, ${nightly.length} of the rows read` : ""}).`, "19c Reference, DBA_AUTO_STAT_EXECUTIONS (ORIGIN: AUTO_TASK or HIGH_FREQ_AUTO_TASK; STATUS: IN PROGRESS, COMPLETED, FAILED, TIMED OUT)");
    }
    summary.push("high-frequency task ON");
  } else if (d.autoTaskStatus === "OFF" && stale === false && crossingAt != null && now != null && crossingAt - now < DAY) {
    add("info", "The table is forecast to go stale within a day and the high-frequency task is OFF (the default), so the first gather is the next nightly window. The task is Exadata and EE-ES only in 19c; otherwise gather after the load that changes the table.", "19c Licensing Information (High-Frequency Automatic Optimizer Statistics Collection: EE-ES, available on Exadata); inferred forecast");
  }
  if (nightly.length) {
    const lvl: Level = sumOf(nightly, "timedOut") ? "warn" : "info";
    const newest = nightly[0]!;
    add(lvl, `DBA_AUTO_STAT_EXECUTIONS lists ${plural(nightly.length, "nightly run")} (ORIGIN AUTO_TASK): ${runWord(nightly)}. The newest, opid ${newest.opid ?? "?"} at ${when(newest.startTime)}, completed ${fmt(newest.completed)} objects, ${fmt(newest.failed)} failed, ${fmt(newest.timedOut)} timed out; the counts cover the whole database, not this table.`,
      "19c Reference, DBA_AUTO_STAT_EXECUTIONS; the lab view lists the nightly task's runs with ORIGIN AUTO_TASK (fixtures)",
      newest.opid != null && (newest.failed ?? 0) + (newest.timedOut ?? 0) > 0 ? [`SELECT DBMS_STATS.REPORT_SINGLE_STATS_OPERATION(opid => ${newest.opid}, detail_level => 'TYPICAL', format => 'TEXT') FROM dual;`] : undefined);
  }

  // -- partitions
  let rows: HealthSection["rows"] | undefined;
  if (d.partitionsOmitted != null) add("info", `The table has ${fmt(d.partitionsOmitted)} partitions; the collector lists none above 400, so the per-partition staleness is not checked here.`, "collector limit (400 partitions)");
  if (d.partitions.length) {
    const ps: PartStat[] = d.partitions.map((p) => ({ p, frac: p.rowsChanged != null && p.rowsChanged > 0 ? (p.numRows != null && p.numRows > 0 ? p.rowsChanged / p.numRows : Infinity) : p.rowsChanged === 0 ? 0 : null }));
    const withDml = ps.filter((x) => (x.frac ?? 0) > 0);
    const pastLimit = withDml.filter((x) => (x.frac ?? 0) > sp / 100 || (x.frac === Infinity));
    const lockedDml = withDml.filter((x) => x.p.locked === true);
    const names = (xs: PartStat[]) => xs.sort((a, b) => (b.frac ?? 0) - (a.frac ?? 0)).slice(0, 10).map((x) => `${x.p.name}${x.frac === Infinity ? " (no rows in statistics)" : ` (${pct(x.frac ?? 0)})`}`).join(", ");
    const inc = input.incremental === "TRUE";
    if (!withDml.length) add("info", `None of the ${plural(d.partitions.length, "partition")} has DML counted since its last gather.`, "DBA_TAB_MODIFICATIONS (partition rows)");
    else {
      const manual = inc ? (input.useStalePercent ? pastLimit : withDml) : pastLimit;
      const unlocked = (xs: PartStat[]) => xs.filter((x) => x.p.locked !== true);
      add(pastLimit.length ? "warn" : "info",
        `${plural(withDml.length, "partition")} of ${d.partitions.length} ${withDml.length === 1 ? "has" : "have"} DML since the last gather; ${pastLimit.length} ${pastLimit.length === 1 ? "is" : "are"} at or past STALE_PERCENT ${fmt(sp, 4)}%${pastLimit.length ? ": " + names(pastLimit) : ""}. The automatic task regathers ${plural(unlocked(pastLimit).length, "partition")} at its next run (it applies STALE_PERCENT per partition).${inc ? ` A gather you run yourself on this INCREMENTAL table re-reads ${plural(unlocked(manual).length, "partition")}${input.useStalePercent ? " (INCREMENTAL_STALENESS has USE_STALE_PERCENT: only those past the threshold)" : " (default staleness: any DML makes a partition stale)"}${unlocked(manual).length ? ": " + names(unlocked(manual)) : ""}.` : ""}`,
        "lab B1 (default staleness: one updated row, that partition re-read), B2, B3, B3b (USE_STALE_PERCENT); lab G7 (the job regathered a partition above STALE_PERCENT); 19c Reference, INCREMENTAL_STALENESS (USE_STALE_PERCENT)");
      if (inc && lockedDml.length) add("warn", `${plural(lockedDml.length, "locked partition")} ${lockedDml.length === 1 ? "has" : "have"} DML (${names(lockedDml)}). A locked partition is not regathered, and under default staleness this forces a full-table scan for the global statistics on every gather.`, "lab C1, C1b (locked partition with DML: one GLOBAL full-table statement, repeated), Tc",
        [`SELECT partition_name, stattype_locked, stale_stats FROM dba_tab_statistics WHERE owner = ${own} AND table_name = ${tab} AND stattype_locked IS NOT NULL AND partition_name IS NOT NULL;`]);
      rows = {
        head: ["Partition", "Rows in statistics", "Rows changed", "Changed", "Locked", "STALE_STATS"],
        body: [...withDml].sort((a, b) => (b.frac ?? 0) - (a.frac ?? 0)).slice(0, 10).map((x) => [x.p.name, fmt(x.p.numRows), fmt(x.p.rowsChanged), x.frac === Infinity ? "n/a" : pct(x.frac ?? 0), x.p.locked ? "yes" : "no", x.p.staleStats == null ? "–" : x.p.staleStats ? "YES" : "NO"]),
      };
    }
    const noStats = d.partitions.filter((p) => p.lastAnalyzed == null);
    if (noStats.length) add("warn", `${plural(noStats.length, "partition")} ${noStats.length === 1 ? "has" : "have"} no statistics (LAST_ANALYZED empty): ${noStats.slice(0, 10).map((p) => p.name).join(", ")}${noStats.length > 10 ? ", ..." : ""}. A gather reads them first.`, "DBA_TAB_STATISTICS (LAST_ANALYZED empty); the task gathers objects with no statistics");
    if (d.subpartitioning && d.subpartitioning !== "NONE") add("info", "This table is composite: DBA_TAB_MODIFICATIONS records DML on subpartition rows only, so the table and partition counters above can read zero while subpartitions took DML (lab C1: 24 subpartition rows, none for the table). See the subpartitions section.", "lab: STATS_LAB.C1 (see the subpartitions section)");
  }
  if (d.zeroRowPartitionsWithDml != null && d.zeroRowPartitionsWithDml > 0)
    add("warn", `${plural(d.zeroRowPartitionsWithDml, "partition")} ${d.zeroRowPartitionsWithDml === 1 ? "has" : "have"} statistics that say 0 rows although inserts were counted since: the optimizer sees an empty partition.`, "DBA_TAB_STATISTICS.NUM_ROWS against DBA_TAB_MODIFICATIONS.INSERTS; lab K1, Tj, Tl (copied or empty-gathered partition statistics)", [`SELECT partition_name, num_rows, last_analyzed FROM dba_tab_statistics WHERE owner = ${own} AND table_name = ${tab} AND partition_name IS NOT NULL AND num_rows = 0;`]);

  const composite = d.subpartitioning != null && d.subpartitioning !== "NONE";
  if (clean(f) && !composite) add("good", `The statistics are current by the dictionary's own measure${rc != null && numRows > 0 ? ` (${pct(rc / numRows)} changed against ${fmt(sp, 4)}%)` : ""}.`, `${GUIDE}, Determining When Optimizer Statistics Are Stale`);
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
  if (dry.length) add("info", `${plural(dry.length, "operation")} ${dry.length === 1 ? "is a" : "are"} dry run${dry.length === 1 ? "" : "s"} (gather_table_stats (reporting mode), from REPORT_GATHER_TABLE_STATS${dry.some((x) => x.status && !/^COMPLETED$/i.test(x.status)) ? ", listed with status " + [...new Set(dry.map((x) => x.status))].join("/") : ""}); nothing was gathered and they are not counted as failures.`, "lab (the advisor's own dry run appears with status FAILED in the fixtures); inferred that the status reflects the unrun gather");

  // -- who gathers, how often
  const byAuto = gathers.filter(isAutoOp).length;
  if (gathers.length) bits.push(`${plural(gathers.length, "gather operation")} listed, ${byAuto} by the auto job`);

  // -- duration trend (calls on this table)
  const timed = gathers.filter((h) => h.targetType === "TABLE").map((h) => ({ h, ms: opMs(h) })).filter((x): x is { h: HistoryRec; ms: number } => x.ms != null);
  if (timed.length >= 4) {
    const latest = timed[0]!, earlier = timed.slice(1).map((x) => x.ms), med = median(earlier)!;
    if (latest.ms > 2 * med && latest.ms >= 5000) {
      add("warn", `The newest gather (opid ${latest.h.opid}, ${when(latest.h.startTime)}) took ${dur(latest.ms)}, more than twice the median ${dur(med)} of the ${earlier.length} before. Look for a changed sample size, a new histogram column, a table that grew, or a lost incremental state.`, "inferred from DBA_OPTSTAT_OPERATIONS start and end times", reportFix);
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
        [...reportFix, `SELECT DBMS_STATS.REPORT_GATHER_TABLE_STATS(${OT}) FROM dual; -- a dry run: lists what the next gather would read`]);
      bits.push("not incremental");
    }
  }

  // -- the global statistics left behind
  const left = gathers.filter((h) => (h.partitionsGathered ?? 0) > 0 && h.globalGathered === false && (h.targetType === "AUTO" || isAutoOp(h)));
  const leftSchema = gathers.filter((h) => (h.partitionsGathered ?? 0) > 0 && h.globalGathered === false && !(h.targetType === "AUTO" || isAutoOp(h)) && h.targetType === "SCHEMA");
  if (left.length) {
    add("warn", `The automatic job gathered ${plural(left[0]!.partitionsGathered ?? 0, "partition")} of this table (opid ${left[0]!.opid}, ${when(left[0]!.startTime)}) but not the global statistics: the table-level row count, NDV and the partition key's high value lag until the table as a whole passes STALE_PERCENT.`,
      "lab G6, G7, Tb1 (schema GATHER AUTO: partition gathered, global NOT updated); G8, Tb2 (STALE_PERCENT lowered or PREFERENCE_OVERRIDES_PARAMETER TRUE: global updated); the nightly task itself was not run in the lab",
      [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}) -- a plain call merges the synopses and reads nothing beyond the new partition`, `-- or: EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'PREFERENCE_OVERRIDES_PARAMETER', 'TRUE')`, `-- or: EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'STALE_PERCENT', '1')`]);
    bits.push("global left behind");
  } else if (leftSchema.length) {
    add("info", `${plural(leftSchema.length, "schema-level gather")} (e.g. opid ${leftSchema[0]!.opid}, ${when(leftSchema[0]!.startTime)}) gathered partitions of this table without the global statistics. That is what GATHER AUTO does when the table as a whole is below STALE_PERCENT, or a PARTITION granularity; the automatic job behaves the same way.`, "lab G6, G7 (schema GATHER AUTO: global not updated); inferred for this particular call", [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}) -- a plain call also updates the global statistics`]);
  }

  // -- histogram columns changing between gathers
  const withHist = gathers.filter((h) => h.targetType === "TABLE" && h.histogramColumns.length).slice(0, 4);
  if (withHist.length >= 2) {
    const sets = withHist.map((h) => new Set(h.histogramColumns));
    const added = [...sets[0]!].filter((c) => !sets[1]!.has(c)), removed = [...sets[1]!].filter((c) => !sets[0]!.has(c));
    const anyChange = sets.some((s, i) => i > 0 && (s.size !== sets[0]!.size || [...s].some((c) => !sets[0]!.has(c))));
    if (anyChange) {
      const inc = input.incremental === "TRUE";
      add(inc ? "warn" : "info", `The histogram columns differ between recent gathers${added.length || removed.length ? `: the newest added ${added.join(", ") || "none"} and dropped ${removed.join(", ") || "none"}` : ""}. Under SIZE AUTO the column usage decides which columns get histograms, so the set moves as queries arrive${inc ? ", and on an INCREMENTAL table a new histogram column re-reads every partition" : ""}.`,
        "lab F0, E1, E3i (first-time predicates: histograms appear and every partition is re-read); 19c Tuning Guide, Histograms (SIZE AUTO uses column usage)",
        ["-- Pin METHOD_OPT to the histograms you want (see the advisor's pinned-list template). Do not pin the list this report prints: it includes columns whose histograms only support incremental statistics (HIST_FOR_INCREM_STATS), and pinning those makes them real (lab Td).", `SELECT column_name, histogram, notes FROM dba_tab_col_statistics WHERE owner = ${quote(input.owner, "OWNER")} AND table_name = ${quote(input.tableName, "TABLE")} AND histogram <> 'NONE';`]);
      bits.push("histogram set moves");
    }
  }

  // -- nothing in the history though statistics exist
  if (!gathers.length && d.lastAnalyzed != null)
    add("info", `No gather appears in the history, but the statistics date from ${when(d.lastAnalyzed)}. The operation log was purged with the statistics history (see retention), or the statistics did not come from a DBMS_STATS gather: online statistics from a bulk load, an import, or ANALYZE (old versions of statistics are not stored when ANALYZE is used).`,
      "19c Tuning Guide, Restrictions for Restoring Optimizer Statistics ('Old versions of statistics are not stored when the ANALYZE command has been used'); Online Statistics Gathering for Bulk Loads; the link to retention is inferred", reportFix);

  if (clean(f) && gathers.length) add("good", `The last ${plural(gathers.length, "gather operation")} completed${byAuto ? ` (${byAuto} by the automatic job)` : ""} and show no sign of trouble in this history.`, "DBA_OPTSTAT_OPERATIONS");
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
    if (input.incremental === "TRUE") add("warn", "The table is INCREMENTAL. Publishing pending statistics leaves the synopses out of step with the published ones, and the next gather re-reads every partition. Delete the pending rows and gather with PUBLISH TRUE instead.",
      "lab G1, G1b (PUBLISH FALSE: two passes every time), G1c (delete pending, PUBLISH back to default: only the new partition read), Tf (publish by hand, PUBLISH TRUE, gather: all partitions re-read)",
      [`EXEC DBMS_STATS.DELETE_PENDING_STATS(${OT})`, `EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'PUBLISH', 'TRUE')`, `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
    if (publishOn) {
      const old = ageDays != null && ageDays > 7;
      add(old ? "warn" : "info", `PUBLISH is TRUE, so today's gathers publish directly; these pending rows are leftovers of an earlier PUBLISH FALSE gather${ageDays != null ? `, ${days(ageDays)} old` : ""}. ${old ? "Publishing them now would replace the current statistics with old ones. Delete them unless that is the intent." : "Decide before they age."}`,
        "inferred from PUBLISH TRUE (19c Tuning Guide: PUBLISH 'true indicates that the statistics must be published when the database gathers them'); lab G1c (delete pending)", old ? [`-- EXEC DBMS_STATS.DELETE_PENDING_STATS(${OT})`] : undefined);
    } else if (ageDays != null && ageDays > 7) add("warn", `PUBLISH is FALSE and the oldest pending row is ${days(ageDays)} old: every gather since then went to pending, so the published statistics are that old.`, "19c Tuning Guide, Publishing Pending Optimizer Statistics; inferred from the age");
  } else if (d.pendingRows === 0) bits.push("no pending rows");

  if (sys === true) {
    add("warn", `OPTIMIZER_USE_PENDING_STATISTICS is TRUE in the collector's session or instance: this instance is testing pending statistics, and every table that has pending rows is optimised with them for everyone.`, "19c Reference, OPTIMIZER_USE_PENDING_STATISTICS (default false; ALTER SESSION, ALTER SYSTEM); Tuning Guide, About Pending Optimizer Statistics", ["SELECT name, value, isdefault FROM v$parameter WHERE name = 'optimizer_use_pending_statistics';", "-- ALTER SYSTEM SET OPTIMIZER_USE_PENDING_STATISTICS = FALSE"]);
    bits.push("parameter TRUE");
  }
  if (clean(f) && d.pendingRows === 0) add("good", "No pending statistics exist for this table and the optimizer is not told to use them.", "DBA_TAB_PENDING_STATS");
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
  add("info", `Statistics can be restored to any time after ${d.historyAvailableSince ? when(d.historyAvailableSince) : "the oldest history timestamp (not collected)"}.${span} After a bad gather: compare the statistics before and after, then restore. Old versions are saved whenever the statistics change; RESTORE_TABLE_STATS also restores the statistics of the table's indexes and columns, and locks them if they were locked at that time.`,
    `${GUIDE}, Restoring Optimizer Statistics Using DBMS_STATS ('You can specify any date between 8/10 and 8/20 because DBMS_STATS restores statistics as of the specified time'); Obtaining Optimizer Statistics History ('Users cannot restore statistics to a time stamp older than the oldest time stamp'); ${REF}, RESTORE_TABLE_STATS, DIFF_TABLE_STATS_IN_HISTORY (OWNNAME, TABNAME, TIME1, TIME2, PCTTHRESHOLD; signature checked on 19.27)`,
    [
      "-- 1. the versions you can go back to",
      `SELECT stats_update_time FROM dba_tab_stats_history WHERE owner = ${own} AND table_name = ${tab} AND partition_name IS NULL ORDER BY stats_update_time DESC;`,
      "-- 2. compare the statistics a day ago with today's (differences above 10 percent)",
      `SELECT * FROM TABLE(DBMS_STATS.DIFF_TABLE_STATS_IN_HISTORY(${OT}, SYSTIMESTAMP - INTERVAL '1' DAY, SYSTIMESTAMP, 10));`,
      `-- 3. restore to a time from step 1 (locked statistics need force => TRUE):  EXEC DBMS_STATS.RESTORE_TABLE_STATS(${OT}, as_of_timestamp => TIMESTAMP 'YYYY-MM-DD HH24:MI:SS')`,
    ]);
  if (input.incremental === "TRUE") add("info", "The reference says a restore brings back the table, index and column statistics; it does not mention synopses. After a restore on this INCREMENTAL table the next gather may rebuild them (not verified in the lab).", `${REF}, RESTORE_TABLE_STATS; inferred, not observed`);
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
    else if (ret === -1) add("warn", `The retention is -1: the automatic purge never removes history, so SM/OPTSTAT in SYSAUX grows without limit${d.sysauxOptstatMb != null ? ` (${fmt(d.sysauxOptstatMb, 1)} MB now)` : ""}. Fine when you want it, but plan for the space.`, `${REF}, ALTER_STATS_HISTORY_RETENTION ('-1: Statistics history is never purged by automatic purge')`, ["-- EXEC DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(31)  -- back to the default"]);
    else if (ret < 7) add("warn", `The retention is ${days(ret)}, short of the default 31: a bad gather that is noticed after a long weekend cannot be undone.${gap != null ? ` The listed gathers are about ${days(gap)} apart.` : ""}`, `${GUIDE}, Managing Optimizer Statistics Retention ('By default, the database retains optimizer statistics for 31 days'); ${REF}, ALTER_STATS_HISTORY_RETENTION ('retained for at least these many number of days')`, [`-- EXEC DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(31)`]);
    else if (gap != null && ret < 2 * gap) add("warn", `The retention is ${days(ret)} but this table is gathered only every ${days(gap)} or so (median of the listed gathers): the history holds hardly a version besides the current one. The purge keeps everything newer than the older of the retention and the latest gather minus a day.`, `${GUIDE}, Purging Optimizer Statistics ('purges all history older than the older of (current time - the ALTER_STATS_HISTORY_RETENTION setting) and (time of the most recent statistics gathering - 1)'); the comparison with the gather interval is inferred`, [`-- EXEC DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(${Math.ceil(gap * 3)})`]);
    else add(ret === 31 ? "good" : "info", `The retention is ${days(ret)}${ret === 31 ? ", the default" : ""}${gap != null ? `; this table is gathered about every ${days(gap)}, so the history covers ${fmt(Math.floor(ret / gap))} older version${Math.floor(ret / gap) === 1 ? "" : "s"}` : ""}.`, `${GUIDE}, Changing the Optimizer Statistics Retention Period ('The default is 31 days')`);
  }

  // -- space and the knobs
  if (d.sysauxOptstatMb != null) add("info", `SM/OPTSTAT occupies ${fmt(d.sysauxOptstatMb, 1)} MB of SYSAUX for the whole database (statistics history, synopses, operation log). The knobs are ALTER_STATS_HISTORY_RETENTION (how long) and PURGE_STATS (delete now). A purge removes the ability to restore; use it deliberately.`, `${GUIDE}, Purging Optimizer Statistics; ${REF}, PURGE_STATS (SYSDBA, or ANALYZE ANY DICTIONARY and ANALYZE ANY)`, ["SELECT occupant_name, space_usage_kbytes FROM v$sysaux_occupants WHERE occupant_name = 'SM/OPTSTAT';", "-- Deliberate only: EXEC DBMS_STATS.PURGE_STATS(SYSTIMESTAMP - INTERVAL '31' DAY)   -- history older than 31 days is gone for good"]);

  // -- restore operations that already happened
  const restores = d.history.filter((h) => /restore/i.test(h.operation));
  if (restores.length) add("info", `${plural(restores.length, "restore operation")} in the history: ${restores.slice(0, 3).map((h) => `opid ${h.opid} ${h.operation} at ${when(h.startTime)}`).join("; ")}. A later gather overwrites restored statistics unless they are locked.`, "DBA_OPTSTAT_OPERATIONS; the overwrite by a later gather is inferred (a restore of locked statistics re-locks them: RESTORE_TABLE_STATS)");

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
    d.indexes.length ? `${fmt(noIdx.length)} of ${fmt(d.indexes.length)} indexes without statistics` : "index statistics not collected by the load (the guide does not mention them)",
  ].join("; ");
  const fix = [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, options => 'GATHER AUTO')`];
  add("info", `The statistics come from online gathering during a bulk load (NOTES = STATS_ON_LOAD): table and basic column statistics are there. What the load does not give: ${gap}. Rows loaded since then count as DML against the new statistics.`,
    `${GUIDE}, Online Statistics Gathering for Bulk Loads ('After gathering online statistics, the database does not automatically create histograms'); the NOTES value is the one the advisor's collector reads, not in the 19c Reference pages; index statistics: the explainer saw none after a load`,
    [`SELECT column_name, histogram, notes FROM dba_tab_col_statistics WHERE owner = ${own} AND table_name = ${tab} AND notes LIKE '%STATS_ON_LOAD%';`]);
  if (input.incremental === "TRUE") add("warn", "GATHER AUTO is not applicable to a table with INCREMENTAL enabled, so the Tuning Guide's fill-the-gaps call does not fit this table. Use a plain GATHER_TABLE_STATS.", "19c DBMS_STATS reference, options GATHER AUTO ('This option is only applicable to tables that do not have INCREMENTAL enabled'; lab-observations.md, documentation quotes)", [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
  else add("info", "Fill the gaps without re-reading what the load collected: GATHER_TABLE_STATS with options => 'GATHER AUTO'. It gathers only missing or stale statistics, so histograms and index statistics are added and the load's table and basic column statistics stay.", `${GUIDE}, Histogram Creation After Bulk Loads ('The preceding PL/SQL program only gathers missing or stale statistics. The database does not gather table and basic column statistics collected during the bulk load')`, fix);
  if (d.staleStats === true) add("warn", "The load statistics are already stale (STALE_STATS = YES): rows changed since the load pass STALE_PERCENT, and a later load into the now non-empty table gathers nothing online.", "Online Statistics Gathering for Bulk Loads, Restrictions ('Bulk loads only gather online statistics automatically when the object is empty')");
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
  const licence = "19c Licensing Information, Table 1-8 row 'Real-Time Statistics: SE2 N, EE N, EE-ES Y, ExaDB Y; EE-ES: Available on Exadata. Not available on Oracle Database Appliance.'";
  if (d.realtimeStatsParam === false) {
    add("info", `OPTIMIZER_REAL_TIME_STATISTICS is FALSE (the default): real-time statistics are not in effect, and conventional DML moves only the DML counters in DBA_TAB_MODIFICATIONS. In 19c the feature is licensed for Exadata and EE-ES only (this database is ${d.dbVersion ?? "19c"}); the parameter exists from 19.10.`,
      `19c Reference, OPTIMIZER_REAL_TIME_STATISTICS ('The default setting is false, which means real-time statistics are disabled'; available starting with 19.10); ${licence}`);
    if (d.realtimeStatsNotes) add("info", "The statistics notes still show STATS_ON_CONVENTIONAL_DML: real-time statistics were collected earlier or by sessions or instances with a different setting (the parameter can differ per session, per RAC instance and per PDB); the collector read its own value.", "19c Tuning Guide, Real-Time Statistics ('indicated by STATS_ON_CONVENTIONAL_DML in the NOTES column'); 19c Reference (modifiable per session; RAC: different values per instance)");
    bits.push("real-time statistics off");
  } else if (d.realtimeStatsParam === true) {
    add("info", `Real-time statistics are on: conventional DML keeps the most essential table statistics current between gathers (the guide names the row count; rows, blocks and the column low and high values are the usual set, NDV, histograms and synopses are not part of it: inferred). They are table-level only: 'partition-level statistics are not supported'${input.partitioned ? ", so the partitions of this table get none" : ""}. They augment the gathered statistics; you still gather regularly. A statement with the NO_GATHER_OPTIMIZER_STATISTICS hint does not collect them.`,
      "19c Tuning Guide, How Real-Time Statistics Work, Purpose ('real-time statistics augment rather than replace traditional statistics. For this reason, you must continue to gather statistics regularly'), Views ('Note that partition-level statistics are not supported'), Hints ('The NO_GATHER_OPTIMIZER_STATISTICS hint prevents the collection of real-time statistics'); which statistics are covered is inferred");
    if (d.realtimeStatsNotes) add("info", "The table carries real-time statistics now (NOTES = STATS_ON_CONVENTIONAL_DML). A gather supersedes them with the gathered statistics (inferred; the guide does not say when the note goes).", "19c Tuning Guide, Real-Time Statistics ('indicated by STATS_ON_CONVENTIONAL_DML in the NOTES column and SHARED in the SCOPE column'); the supersession is inferred, not observed",
      [`SELECT column_name, notes FROM dba_tab_col_statistics WHERE owner = ${own} AND table_name = ${tab} AND notes LIKE '%STATS_ON_CONVENTIONAL%';`]);
    else add("info", "No real-time rows on the table now: they appear after conventional DML on the table, between gathers. The Reference spells the NOTES value STATS_ON_CONVENTIONAL_LOAD and the Tuning Guide STATS_ON_CONVENTIONAL_DML; the collector tests the second, so a table that shows the first would read as none.", "19c Reference, ALL_TAB_STATISTICS.NOTES vs Tuning Guide, Real-Time Statistics (the two pages differ)", ["SELECT table_name, partition_name, num_rows, TRIM(notes) AS notes FROM dba_tab_statistics WHERE owner = " + own + " AND table_name = " + tab + " AND notes LIKE '%STATS_ON_CONVENTIONAL%';"]);
    bits.push("real-time statistics on");
  }
  if (d.autoTaskStatus != null) add("info", `The high-frequency statistics task is ${d.autoTaskStatus} (AUTO_TASK_STATUS${d.autoTaskInterval != null ? `, interval ${fmt(d.autoTaskInterval)} s` : ""}). Same licence row as real-time statistics: Exadata and EE-ES in 19c.`, `${REF}, AUTO_TASK_STATUS (OFF is the default); 19c Licensing Information, 'High-Frequency Automatic Optimizer Statistics Collection' (EE-ES: Available on Exadata)`);
  if (d.optimizerAdaptiveStatistics === false) {
    add("info", "OPTIMIZER_ADAPTIVE_STATISTICS is FALSE (the 19c default): SQL plan directives are not used to refine plans with dynamic sampling. In the lab (CG1) the test queries created no directive with this setting, so column-group candidates born from directives are few or none here; the Reference says the parameter does 'not control the creation' of directives, so some can exist. The firm source of candidates is SEED_COL_USAGE (the INPUT block's usage list).",
      "19c Reference, OPTIMIZER_ADAPTIVE_STATISTICS (default false; 'Setting this parameter to false disables ... SQL plan directives'; 'does not control the creation of SQL plan directives'); lab-observations.md, Column groups 2026-10-11 (CG1: no directive created with FALSE, one USABLE directive with TRUE after the flush)");
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
  const survey = [`SELECT COUNT(*) AS subpartitions, COUNT(last_analyzed) AS with_statistics FROM dba_tab_subpartitions WHERE table_owner = ${own} AND table_name = ${tab};`];
  if (n == null || w == null) return section("subpartitions", "Subpartition statistics", "subpartition counts not collected", [{ level: "info", text: `The table is subpartitioned by ${type}; the collector did not count its subpartitions.`, basis: "DBA_PART_TABLES.SUBPARTITIONING_TYPE", fix: survey }]);
  add("info", `The table is composite (subpartitioned by ${type}): ${plural(n, "subpartition")}, ${fmt(w)} with statistics${n ? ` (${pct(w / n)})` : ""}.`, "DBA_TAB_SUBPARTITIONS.LAST_ANALYZED; STATS_LAB.C1 collector run (24 subpartitions, none with statistics)", survey);
  if (!subLevel && w === 0) add("info", `GRANULARITY ${gran} gathers no subpartition statistics, which matches: none exist. The optimizer works from partition and global statistics. DML in one subpartition makes the whole parent partition stale, so the whole partition is re-read, all ${type === "HASH" ? "its hash subpartitions" : "its subpartitions"} (lab J: 500 rows into one hash subpartition, one PART SYN statement over the partition).`,
    `${REF}, granularity ('GLOBAL AND PARTITION - Gathers the global and partition level statistics. No subpartition level statistics are gathered even if it is a composite partitioned object'; 'AUTO - Determines the granularity based on the partitioning type'); lab J (HASH subpartitions, AUTO: partition statistics, no subpartition statistics)${type === "HASH" ? "" : "; for " + type + " subpartitions this is inferred"}`);
  else if (subLevel && w < n) add("warn", `GRANULARITY ${gran} should gather the subpartitions, yet ${fmt(n - w)} of ${fmt(n)} have no statistics. Either no gather has run since the setting changed, or those subpartitions were skipped (locked, or no data change under incremental maintenance).`,
    `${REF}, granularity ('ALL' gathers all; 'SUBPARTITION - Gathers subpartition-level statistics'); 19c Tuning Guide, Considerations for Incremental Statistics Maintenance ('the database only gathers statistics for modified subpartitions')`, [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, granularity => 'ALL')`]);
  else if (!subLevel && w > 0) add("info", `${fmt(w)} subpartitions carry statistics although GRANULARITY ${gran} does not gather that level, so they date from an earlier ALL or SUBPARTITION gather. They are not refreshed, so they fall behind the partition statistics, and the optimizer uses them only when pruning leaves a single subpartition (inferred).`,
    `${REF}, granularity; which level the optimizer uses is inferred, not found in the Tuning Guide pages read`, [`SELECT subpartition_name, num_rows, last_analyzed FROM dba_tab_subpartitions WHERE table_owner = ${own} AND table_name = ${tab} ORDER BY last_analyzed NULLS FIRST;`]);
  else add("info", `GRANULARITY ${gran} gathers the subpartition level and all ${fmt(n)} subpartitions have statistics.`, REF);
  add("info", `DML counters live at subpartition level only: DBA_TAB_MODIFICATIONS has one row per subpartition (SUBPARTITION_NAME set) and no row for the table or its partitions. On STATS_LAB.C1 it lists 24 rows for the 24 subpartitions, about 5,000 inserts each, while the collector's table and partition counters read 0 and STALE_STATS says NO: the statistics already include those rows, so the subpartition counters were not reset by the partition-level gathers (inferred). A ROWS_CHANGED of 0 on a composite table is therefore no evidence that nothing changed; sum the subpartition rows instead, and read them against the rows of their partition.`,
    "lab: STATS_LAB.C1 on 19.27 (DBA_TAB_MODIFICATIONS: 24 subpartition rows, no partition or table row; checked 2026-10-11); 19c Reference, ALL_TAB_MODIFICATIONS (PARTITION_NAME and SUBPARTITION_NAME columns); the counters surviving a partition-level gather is inferred",
    [`SELECT partition_name, subpartition_name, inserts, updates, deletes FROM dba_tab_modifications WHERE table_owner = ${own} AND table_name = ${tab} AND subpartition_name IS NOT NULL ORDER BY partition_name, subpartition_name;`]);
  if (!subLevel) add("info", `If pruning often reaches a single subpartition, subpartition statistics help the optimizer, at the price of reading every subpartition at each gather. Setting the table preference GRANULARITY to ALL does that; the default AUTO does not.`, `${REF}, granularity ('The ALL setting gathers statistics for all types' in the Tuning Guide, Guideline for Partitioned Objects); the cost is inferred`, [`-- EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'GRANULARITY', 'ALL')`]);
  return section("subpartitions", "Subpartition statistics", `${fmt(n)} subpartitions, ${fmt(w)} with statistics`, f);
}
