import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DEFAULTS, clampInput, emptyDetail, health, parsePrefs, type Detail, type HealthSection, type HistoryRec, type Input, type PartitionRec } from "../src/model";
import { historySection, loadSection, pendingSection, realtimeSection, restoreSection, staleForecast, stalenessSection, subpartitionsSection } from "../src/model/health/table";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/collect-${name}.txt`, import.meta.url), "utf8");
const load = (name: string) => {
  const r = parsePrefs(fixture(name));
  return { input: clampInput({ ...DEFAULTS, ...r.values }).input, detail: r.detail! };
};
const ctx = (input: Input, detail: Detail) => ({ input, detail, prov: null });
/** A context from a form override and a Detail override. */
const synth = (over: Partial<Detail>, inp: Partial<Input> = {}) => ctx(clampInput({ ...DEFAULTS, ...inp }).input, { ...emptyDetail(), ...over });
const text = (s: HealthSection | null) => (s ? s.findings.map((f) => f.text).join("\n") : "");
const fixes = (s: HealthSection | null) => (s ? s.findings.flatMap((f) => f.fix ?? []).join("\n") : "");
const levels = (s: HealthSection | null) => (s ? s.findings.map((f) => f.level) : []);
const find = (s: HealthSection | null, re: RegExp) => s?.findings.find((f) => re.test(f.text));

const hist = (over: Partial<HistoryRec>): HistoryRec => ({ opid: 1, operation: "gather_table_stats", startTime: "2026-10-01 02:00:00", endTime: "2026-10-01 02:00:10", status: "COMPLETED", jobName: null, targetType: "TABLE", partitionsGathered: 0, globalGathered: true, indexesGathered: 0, targetSize: 100, histogramColumns: [], ...over });

// ---------------------------------------------------------------- real 19.27 fixtures
describe("health table sections on the lab fixtures", () => {
  const sales = load("stats_lab-sales");

  test("SALES: no section prints NaN, undefined or Infinity", () => {
    for (const n of ["stats_lab-sales", "stats_lab-c1", "orastats_test-orders", "orastats_test-expr_pred", "stats_lab-cg1"]) {
      const { input, detail } = load(n);
      const r = health(input, detail, null);
      const all = JSON.stringify(r.sections);
      expect(all).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  test("SALES: the history lists the 12 operations and reads the schema-level gathers", () => {
    const s = historySection(ctx(sales.input, sales.detail))!;
    expect(s.id).toBe("history");
    expect(s.rows!.body).toHaveLength(12);
    expect(s.rows!.head).toEqual(["When", "Operation", "By", "Duration", "Status", "Partitions", "Global", "Indexes", "Target size (blocks)", "Histogram columns"]);
    expect(s.rows!.body[0]).toEqual(["2026-10-05 10:58", "gather_table_stats", "call", "0m 0s", "COMPLETED", "0", "Y", "0", "11,978", "SALE_DATE, PRODUCT_ID, CUSTOMER_ID +2"]);
    expect(find(s, /schema-level gathers?/)).toBeTruthy(); // partitions gathered, global not (lab G6/G7)
    expect(levels(s)).not.toContain("bad");
  });

  test("SALES: the forecast has no rate (nothing changed), the window comes from the fixture, partitions are checked", () => {
    const s = stalenessSection(ctx(sales.input, sales.detail))!;
    expect(s.id).toBe("staleness");
    expect(text(s)).toMatch(/No DML counted since the last gather \(2026-10-05 10:58\)/);
    expect(s.summary).toMatch(/no DML since the gather; STALE_STATS NO/);
    expect(text(s)).toMatch(/SUNDAY_WINDOW is open now \(started 2026-10-11 06:00, 20h 0m long\)/); // the lab's Sunday window (06:00, 20 h) is open at 08:14
    expect(text(s)).toMatch(/None of the 54 partitions has DML/);
    expect(text(s)).not.toMatch(/ORIGIN AUTO_TASK|all SUCCEEDED/); // database-wide task runs that went well are not a finding about this table
    expect(levels(s)).toContain("good");
    expect(s.summary).not.toMatch(/NaN/);
  });

  test("SALES: partitions with DML are named, top ten, with the INCREMENTAL staleness rule", () => {
    const d: Detail = { ...sales.detail, partitions: sales.detail.partitions.map((p, i) => (i === 3 ? { ...p, rowsChanged: 3600 } : i === 7 ? { ...p, rowsChanged: 5 } : p)) };
    const s = stalenessSection(ctx(sales.input, d))!; // S_2024_04 has 34,800 rows: 3,600 is 10.3%
    expect(s.rows!.body.map((r) => r[0])).toEqual(["S_2024_04", "S_2024_08"]);
    const f = find(s, /2 partitions of 54 have DML/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/1 is at or past STALE_PERCENT 10%: S_2024_04 \(10%\)/);
    expect(f.text).toMatch(/default staleness: any DML makes a partition stale/);
    expect(f.text).toMatch(/re-reads 2 partitions/);
    const usp = stalenessSection(ctx({ ...sales.input, useStalePercent: true }, d))!;
    expect(find(usp, /2 partitions of 54 have DML/)!.text).toMatch(/re-reads 1 partition .*USE_STALE_PERCENT/);
  });

  test("C1: 24 subpartitions, none with statistics, granularity AUTO", () => {
    const { input, detail } = load("stats_lab-c1");
    const s = subpartitionsSection(ctx(input, detail))!;
    expect(s.summary).toBe("24 subpartitions, 0 with statistics");
    expect(s.findings[0]!.text).toMatch(/24 subpartitions, 0 with statistics/);
    expect(text(s)).toMatch(/GRANULARITY AUTO gathers no subpartition statistics, which matches/);
    expect(text(s)).toMatch(/the whole partition is stale, so a gather rereads the whole partition|makes the whole partition stale, so a gather rereads the whole partition/); // incremental, lab J
    expect(text(s)).toMatch(/keep GRANULARITY AUTO/); // GRANULARITY ALL is not offered on an INCREMENTAL table
    expect(fixes(s)).toMatch(/dba_tab_subpartitions/);
    expect(fixes(s)).not.toMatch(/GRANULARITY', 'ALL'/);
    // the DML counters caveat lives in the staleness section only
    expect(text(s)).not.toMatch(/SUBPARTITION_NAME/);
    const st = stalenessSection(ctx(input, detail))!;
    expect(text(st)).toMatch(/composite: DBA_TAB_MODIFICATIONS can hold DML on subpartition rows only/);
    expect(fixes(st)).toMatch(/subpartition_name IS NOT NULL/);
    expect(levels(stalenessSection(ctx(input, detail)))).not.toContain("good"); // 0 changed rows on a composite table proves nothing
  });

  test("subpartitions: null for a partitioned table without subpartitions and for a plain one", () => {
    expect(subpartitionsSection(ctx(sales.input, sales.detail))).toBeNull(); // SUBPARTITIONING = NONE
    const orders = load("orastats_test-orders");
    expect(subpartitionsSection(ctx(orders.input, orders.detail))).toBeNull();
  });

  test("ORDERS: pending is clean, restore shows retention 31, load and real-time say off", () => {
    const { input, detail } = load("orastats_test-orders");
    const p = pendingSection(ctx(input, detail))!;
    expect(levels(p)).toEqual(["good"]);
    const r = restoreSection(ctx(input, detail))!;
    expect(r.summary).toBe("retention 31 days");
    expect(r.rows!.body[0]).toEqual(["Retention", "31 days"]);
    expect(r.rows!.body).toContainEqual(["Versions of this table (rows)", "15"]);
    expect(fixes(r)).toMatch(/DIFF_TABLE_STATS_IN_HISTORY\('ORASTATS_TEST', 'ORDERS'|DIFF_TABLE_STATS_IN_HISTORY\('OWNER', 'TABLE'/);
    expect(fixes(r)).not.toMatch(/^EXEC DBMS_STATS.PURGE_STATS/m); // never a bare purge
    const l = loadSection(ctx(input, detail))!;
    expect(levels(l)).toEqual(["good"]);
    const rt = realtimeSection(ctx(input, detail))!;
    expect(text(rt)).toMatch(/OPTIMIZER_REAL_TIME_STATISTICS is FALSE/);
    expect(text(rt)).toMatch(/OPTIMIZER_ADAPTIVE_STATISTICS is FALSE/);
  });

  test("EXPR_PRED: dry runs in the history are not failures", () => {
    const { input, detail } = load("orastats_test-expr_pred");
    const s = historySection(ctx(input, detail))!;
    expect(levels(s)).not.toContain("bad");
    expect(text(s)).toMatch(/3 operations are dry runs/);
    expect(find(s, /dry runs/)!.basis).toMatch(/all 5 .*reporting mode.* rows .* have STATUS FAILED/);
  });

  test("health(): the seven table sections come with the report, the sections that do not apply are skipped", () => {
    const r = health(sales.input, sales.detail, null);
    const ids = r.sections.map((s) => s.id);
    for (const id of ["staleness", "history", "pending", "restore", "load", "realtime"]) expect(ids).toContain(id);
    expect(r.skipped.some((x) => x.startsWith("subpartitions"))).toBe(true);
  });
});

// ---------------------------------------------------------------- staleness
describe("staleness: the forecast arithmetic", () => {
  test("staleForecast: threshold, rate, days left", () => {
    const f = staleForecast(40_000, 1_000_000, 10, 10);
    expect(f.threshold).toBe(100_000);
    expect(f.rate).toBe(4000);
    expect(f.remaining).toBe(60_000);
    expect(f.daysLeft).toBe(15);
    expect(f.crossedAfterDays).toBe(25);
    expect(staleForecast(150_000, 1_000_000, 10, 10)).toMatchObject({ daysLeft: 0, crossedAfterDays: 100_000 / 15_000 });
    expect(staleForecast(0, 1_000_000, 10, 10).daysLeft).toBeNull();
  });

  const base = { lastAnalyzed: "2026-10-01 00:00:00", collectedAt: "2026-10-11 00:00:00", autotaskStatus: "ENABLED", windows: [{ name: "MONDAY_WINDOW", repeatInterval: null, duration: "+000 04:00:00", enabled: true, nextStart: "2026-10-12 22:00:00" }] };

  test("40,000 of 1,000,000 rows in 10 days: 4,000 rows per day, 15 days to 10%, the first window after that", () => {
    const s = stalenessSection(synth({ ...base, rowsChanged: 40_000, staleStats: false }, { numRows: 1_000_000, stalePercent: 10 }))!;
    const f = find(s, /rows per day/)!;
    expect(f.text).toMatch(/pace since the last gather \(4,000 rows per day: 40,000 changes over 10 days\)/);
    expect(f.text).toMatch(/in about 15 days, around 2026-10-26 00:00/);
    expect(f.text).toMatch(/spread evenly/);
    const w = find(s, /Next window with the task: MONDAY_WINDOW at 2026-10-12 22:00 \(4h 0m long\)/)!;
    expect(w.text).toMatch(/stale around 2026-10-26 00:00; the first window after that is MONDAY_WINDOW at 2026-10-26 22:00 \(0\.9 days later/);
    expect(s.summary).toMatch(/threshold in ~15 days/);
  });

  test("the rate runs to the collection, not to the modification timestamp; the last change is named", () => {
    const s = stalenessSection(synth({ ...base, rowsChanged: 40_000, modsTimestamp: "2026-10-06 00:00:00" }, { numRows: 1_000_000, stalePercent: 10 }))!;
    const f = find(s, /rows per day/)!;
    expect(f.text).toMatch(/\(4,000 rows per day: 40,000 changes over 10 days\)/);
    expect(f.text).toMatch(/in about 15 days, around 2026-10-26 00:00/);
    expect(f.text).toMatch(/The last change was counted at 2026-10-06 00:00 \(5 days before the collection\)/);
  });

  test("SOE.ORDER_ITEMS: a month without a counted change gives no pace, A1: 3 quiet days still do", () => {
    // 388,529 changes within 3.5 hours of the gather on 2026-09-10, collected 2026-10-11: the old rate was 2.6 million rows per day
    const idle = stalenessSection(synth({ ...base, lastAnalyzed: "2026-09-10 09:49:20", modsTimestamp: "2026-09-10 13:19:38", collectedAt: "2026-10-11 08:46:20", rowsChanged: 388_529, staleStats: false }, { numRows: 7_287_755, stalePercent: 10 }))!;
    expect(text(idle)).not.toMatch(/rows per day/);
    expect(find(idle, /none counted since 2026-09-10 13:19 \(31 days before the collection\): the table is quiet, so there is no current pace/)).toBeTruthy();
    expect(idle.summary).not.toMatch(/threshold in/);
    const a1 = stalenessSection(synth({ ...base, lastAnalyzed: "2026-10-05 10:59:03", modsTimestamp: "2026-10-08 05:00:03", collectedAt: "2026-10-11 08:46:20", rowsChanged: 12_003, staleStats: false }, { numRows: 172_000, stalePercent: 10 }))!;
    const f = find(a1, /rows per day/)!;
    expect(f.text).toMatch(/\(2,032 rows per day: 12,003 changes over 5\.9 days\)/);
    expect(f.text).toMatch(/in about 2\.6 days, around 2026-10-13 22:09/);
    expect(f.text).toMatch(/The last change was counted at 2026-10-08 05:00 \(3\.2 days before the collection\)/);
  });

  test("already past STALE_PERCENT: warn, says when it was crossed, and the next run gathers it", () => {
    const s = stalenessSection(synth({ ...base, rowsChanged: 150_000, staleStats: true }, { numRows: 1_000_000, stalePercent: 10 }))!;
    const f = s.findings[0]!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/15% of the 1,000,000 rows/);
    expect(f.text).toMatch(/so the table is past it\. STALE_STATS = YES/);
    expect(text(s)).not.toMatch(/rows per day/); // already past: no forecast
    expect(find(s, /The table is stale, so the next run of the task gathers it/)).toBeTruthy();
    expect(s.findings.filter((x) => /STALE_STATS = YES/.test(x.text))).toHaveLength(1); // the verdict is said once
    expect(levels(s)).not.toContain("good");
  });

  test("a truncated table: a warning that does not claim the documentation says it is stale", () => {
    const s = stalenessSection(synth({ rowsChanged: 0, rowsTruncated: true, staleStats: true, lastAnalyzed: "2026-10-01 00:00:00" }, { owner: "CHAOS", tableName: "FILL", numRows: 1000 }))!;
    const f = find(s, /truncated/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/unless the table was reloaded to the same size/);
    expect(f.fix).toEqual(["EXEC DBMS_STATS.GATHER_TABLE_STATS('CHAOS', 'FILL')"]);
    expect(f.basis).toMatch(/truncated since the most recent statistics collection/);
    expect(f.basis).toMatch(/does not say a truncate makes STALE_STATS YES/);
    expect(find(s, /STALE_STATS = YES although only 0%/)!.text).toMatch(/may have marked it/);
  });

  test("AUTOSTATS_TARGET ORACLE: the job skips user tables", () => {
    const s = stalenessSection(synth({ autostatsTarget: "ORACLE", rowsChanged: 0, lastAnalyzed: "2026-10-01 00:00:00" }, { owner: "APP", tableName: "T", numRows: 100 }))!;
    const f = find(s, /AUTOSTATS_TARGET is ORACLE/)!;
    expect(f.level).toBe("bad");
    expect(f.fix).toEqual(["EXEC DBMS_STATS.SET_GLOBAL_PREFS('AUTOSTATS_TARGET', 'AUTO')"]);
    expect(s.summary).toMatch(/AUTOSTATS_TARGET ORACLE/);
    // ORACLE is right for Oracle's own schemas
    expect(find(stalenessSection(synth({ autostatsTarget: "ORACLE", rowsChanged: 0, lastAnalyzed: "2026-10-01 00:00:00" }, { owner: "SYS", numRows: 100 })), /AUTOSTATS_TARGET is ORACLE/)).toBeUndefined();
  });

  test("the nightly task disabled", () => {
    const f = find(stalenessSection(synth({ autotaskStatus: "DISABLED", rowsChanged: 5, lastAnalyzed: "2026-10-01 00:00:00" }, { numRows: 1000 })), /DISABLED/)!;
    expect(f.level).toBe("warn"); // the table is not stale: a risk, not harm now
    expect(find(stalenessSection(synth({ autotaskStatus: "DISABLED", rowsChanged: 500, lastAnalyzed: "2026-10-01 00:00:00" }, { numRows: 1000 })), /DISABLED/)!.level).toBe("bad");
    expect(f.fix![0]).toMatch(/DBMS_AUTO_TASK_ADMIN.ENABLE\(client_name => 'auto optimizer stats collection'/);
  });

  test("a run that hit the window end is flagged, the task resumes in the next window", () => {
    const d = { ...base, rowsChanged: 1, autoruns: [{ windowName: "MONDAY_WINDOW", windowStart: "2026-10-05 22:00:00", jobStatus: "STOPPED", jobDuration: "+000 03:59:58", jobInfo: "REASON=Stop job called because associated window was closed" }, { windowName: "TUESDAY_WINDOW", windowStart: "2026-10-06 22:00:00", jobStatus: "SUCCEEDED", jobDuration: "+000 00:20:00", jobInfo: null }] };
    const s = stalenessSection(synth(d, { numRows: 1000 }))!;
    const f = find(s, /did not finish cleanly or ran to the end of the window/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/^1 of the last 2 runs of the task did not finish cleanly/);
    expect(f.text).toMatch(/MONDAY_WINDOW 2026-10-05 22:00: STOPPED, 3h 59m/);
    expect(f.text).toMatch(/keep their old statistics until a later run/);
    expect(f.text).not.toMatch(/candidates again|gathered late/); // the retry is not documented
    expect(f.basis).toMatch(/TIMED OUT: Maintenance window was not enough/);
  });

  test("the high-frequency task: ON with its own runs, ON without any, and the nightly rows in the same view", () => {
    const hf = (origin: string, extra: object = {}) => ({ opid: 9, startTime: "2026-10-10 10:00:00", endTime: "2026-10-10 10:00:20", status: "COMPLETED", completed: 4, failed: 0, timedOut: 0, origin, ...extra });
    const on = synth({ autoTaskStatus: "ON", autoTaskInterval: 900, autoTaskMaxRunTime: 3600, rowsChanged: 0, lastAnalyzed: "2026-10-01 00:00:00", hfruns: [hf("HIGH_FREQ_AUTO_TASK"), hf("HIGH_FREQ_AUTO_TASK", { status: "TIMED OUT", timedOut: 2 }), hf("AUTO_TASK", { completed: 70, failed: 1 })] }, { numRows: 1000 });
    const s = stalenessSection(on)!;
    expect(find(s, /high-frequency task is ON: every 900 s, at most 3,600 s/)).toBeTruthy();
    const runs = find(s, /Last 2 high-frequency runs/)!;
    expect(runs.level).toBe("warn");
    expect(runs.text).toMatch(/1 completed, 1 timed out; objects: 8 completed, 0 failed, 2 timed out/);
    expect(find(s, /nightly run/)).toBeUndefined(); // nightly runs without a timeout are database-wide noise
    const none = stalenessSection(synth({ autoTaskStatus: "ON", rowsChanged: 0, lastAnalyzed: "2026-10-01 00:00:00", hfruns: [hf("AUTO_TASK")] }, { numRows: 1000 }))!;
    expect(find(none, /none of the last 1 row/)!.level).toBe("warn");
  });

  test("partitions with no statistics; zero-row partitions that took inserts belong to the quality section only", () => {
    const parts: PartitionRec[] = ["P1", "P2"].map((name, i) => ({ name, position: i + 1, numRows: i ? null : 0, blocks: null, lastAnalyzed: i ? null : "2026-10-01 00:00:00", staleStats: null, locked: null, rowsChanged: 0, synopsis: null }));
    const s = stalenessSection(synth({ partitions: parts, zeroRowPartitionsWithDml: 1, rowsChanged: 0, lastAnalyzed: "2026-10-01 00:00:00" }, { numRows: 100, partitioned: true, partitions: 2 }))!;
    expect(find(s, /1 partition has no statistics .*: P2/)).toBeTruthy();
    expect(find(s, /statistics that say 0 rows/)).toBeUndefined();
  });

  test("locked partitions with DML on an INCREMENTAL table", () => {
    const mk = (name: string, locked: boolean, rowsChanged: number): PartitionRec => ({ name, position: 1, numRows: 1000, blocks: 10, lastAnalyzed: "2026-10-01 00:00:00", staleStats: null, locked, rowsChanged, synopsis: "HLL" });
    const s = stalenessSection(synth({ partitions: [mk("P1", true, 300), mk("P2", false, 0)], rowsChanged: 300, lastAnalyzed: "2026-10-01 00:00:00" }, { numRows: 2000, partitioned: true, partitions: 2, incremental: "TRUE" }))!;
    const f = find(s, /1 locked partition has DML/)!;
    expect(f.level).toBe("warn");
    expect(f.basis).toMatch(/lab C1/);
    // USE_LOCKED_STATS: not stale (lab C2); USE_STALE_PERCENT alone: not tested
    const locked = stalenessSection(synth({ partitions: [mk("P1", true, 300), mk("P2", false, 0)], rowsChanged: 300, lastAnalyzed: "2026-10-01 00:00:00" }, { numRows: 2000, partitioned: true, partitions: 2, incremental: "TRUE", useLockedStats: true, useStalePercent: true }))!;
    expect(find(locked, /1 locked partition has DML/)!.level).toBe("info");
    expect(find(locked, /1 locked partition has DML/)!.text).toMatch(/USE_LOCKED_STATS, so it counts as not stale/);
    const sp = stalenessSection(synth({ partitions: [mk("P1", true, 300), mk("P2", false, 0)], rowsChanged: 300, lastAnalyzed: "2026-10-01 00:00:00" }, { numRows: 2000, partitioned: true, partitions: 2, incremental: "TRUE", useStalePercent: true }))!;
    expect(find(sp, /1 locked partition has DML/)!.text).toMatch(/was not tested/);
  });

  test("A1: two locked partitions past STALE_PERCENT are skipped by the job, not regathered", () => {
    const mk = (name: string, locked: boolean, rowsChanged: number): PartitionRec => ({ name, position: 1, numRows: 1000, blocks: 10, lastAnalyzed: "2026-10-01 00:00:00", staleStats: null, locked, rowsChanged, synopsis: "HLL" });
    const s = stalenessSection(synth({ partitions: [mk("P1", true, 2000), mk("P2", true, 200), mk("P3", false, 150), mk("P4", false, 5)], rowsChanged: 2355, lastAnalyzed: "2026-10-01 00:00:00" }, { numRows: 4000, partitioned: true, partitions: 4, incremental: "TRUE", useStalePercent: true, useLockedStats: true }))!;
    const f = find(s, /4 partitions of 4 have DML/)!;
    expect(f.text).toMatch(/3 are at or past STALE_PERCENT 10%: P1 \(200%\), P2 \(20%\), P3 \(15%\)/);
    expect(f.text).toMatch(/The automatic task regathers 1 partition at its next run .* and skips the 2 locked/);
    expect(f.text).toMatch(/re-reads 1 partition .*not the locked ones/);
    const all = stalenessSection(synth({ partitions: [mk("P1", true, 2000), mk("P2", true, 200)], rowsChanged: 2200, lastAnalyzed: "2026-10-01 00:00:00" }, { numRows: 2000, partitioned: true, partitions: 2, incremental: "TRUE", useStalePercent: true, useLockedStats: true }))!;
    expect(find(all, /2 partitions of 2 have DML/)!.text).toMatch(/All are locked, and the automatic task skips locked partitions/);
    expect(find(all, /2 partitions of 2 have DML/)!.text).not.toMatch(/regathers 0/);
    expect(find(all, /2 partitions of 2 have DML/)!.level).toBe("info");
  });

  test("nothing collected: null", () => {
    expect(stalenessSection(synth({}))).toBeNull();
  });
});

// ---------------------------------------------------------------- history
describe("history: findings", () => {
  test("a failed operation is bad and points at REPORT_SINGLE_STATS_OPERATION with the opid", () => {
    const s = historySection(synth({ lastAnalyzed: "2026-10-01 00:00:00", history: [hist({ opid: 77, status: "FAILED" }), hist({ opid: 70 })] }, { owner: "APP", tableName: "T" }))!;
    const f = s.findings[0]!;
    expect(f.level).toBe("bad");
    expect(f.text).toMatch(/opid 77 gather_table_stats at 2026-10-01 02:00 FAILED/);
    expect(f.fix).toContain("SELECT DBMS_STATS.REPORT_SINGLE_STATS_OPERATION(opid => 77, detail_level => 'ALL', format => 'TEXT') FROM dual;");
    expect(s.summary).toMatch(/1 failed/);
    const t = historySection(synth({ lastAnalyzed: "2026-10-01 00:00:00", history: [hist({ opid: 78, status: "TIMED OUT", jobName: "ORA$AT_OS_OPT_SY_5" })] }))!;
    expect(t.findings[0]!.level).toBe("bad");
    expect(t.rows!.body[0]![2]).toBe("auto job");
  });

  test("the duration trend: the newest gather over twice the median of the earlier ones", () => {
    const mk = (opid: number, secs: number) => hist({ opid, startTime: `2026-10-0${opid}T00:00:00`.replace("T", " "), endTime: `2026-10-0${opid} 00:${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}` });
    const slow = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [mk(6, 120), mk(5, 30), mk(4, 28), mk(3, 32), mk(2, 31)] }))!;
    const f = find(slow, /took 2m 0s, more than twice the median 0m 31s of the 4 before/)!;
    expect(f.level).toBe("info"); // a trend over a handful of runs is a hint
    const steady = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [mk(6, 40), mk(5, 30), mk(4, 28), mk(3, 32), mk(2, 31)] }))!;
    expect(find(steady, /more than twice/)).toBeUndefined();
    // four points are too few, and seconds-long gathers are noise
    expect(find(historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [mk(5, 120), mk(4, 30), mk(3, 28), mk(2, 32)] }))!, /more than twice/)).toBeUndefined();
    expect(find(historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [mk(6, 20), mk(5, 3), mk(4, 2), mk(3, 3), mk(2, 3)] }))!, /more than twice/)).toBeUndefined();
  });

  test("an INCREMENTAL table whose recent gathers read every partition does not behave incrementally", () => {
    const inc = { incremental: "TRUE" as const, partitioned: true, partitions: 24 };
    const all = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [hist({ opid: 4, partitionsGathered: 24 }), hist({ opid: 3, partitionsGathered: 24 }), hist({ opid: 2, partitionsGathered: 23 })] }, inc))!;
    const f = find(all, /does not behave incrementally/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/read 24, 24, 23 partitions of 24/);
    expect(f.basis).toMatch(/lab T1b/);
    expect(f.fix!.join("\n")).toMatch(/REPORT_GATHER_TABLE_STATS\('OWNER', 'TABLE'\)/);
    const ok = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [hist({ opid: 4, partitionsGathered: 1 }), hist({ opid: 3, partitionsGathered: 1 }), hist({ opid: 2, partitionsGathered: 24 })] }, inc))!;
    expect(find(ok, /does not behave incrementally/)).toBeUndefined();
    // a table that is not INCREMENTAL reads every partition by design
    const plain = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [hist({ opid: 4, partitionsGathered: 24 }), hist({ opid: 3, partitionsGathered: 24 }), hist({ opid: 2, partitionsGathered: 24 })] }, { partitioned: true, partitions: 24 }))!;
    expect(find(plain, /does not behave incrementally/)).toBeUndefined();
  });

  test("the automatic job gathered partitions but not the global statistics", () => {
    const s = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [hist({ opid: 9, jobName: "ORA$AT_OS_OPT_SY_9", targetType: "AUTO", partitionsGathered: 1, globalGathered: false })] }, { partitioned: true, partitions: 12, incremental: "TRUE" }))!;
    const f = find(s, /automatic job gathered 1 partition of this table .*but not the global statistics/)!;
    expect(f.level).toBe("warn");
    expect(f.basis).toMatch(/lab G6, G7/);
    expect(f.fix!.join("\n")).toMatch(/PREFERENCE_OVERRIDES_PARAMETER', 'TRUE'/);
  });

  test("histogram columns that change between gathers, and what not to pin", () => {
    const h = (opid: number, cols: string[]) => hist({ opid, histogramColumns: cols });
    const s = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [h(3, ["A", "B", "C"]), h(2, ["A", "B"]), h(1, ["A", "B"])] }, { incremental: "TRUE", partitioned: true, partitions: 10 }))!;
    const f = find(s, /histogram columns differ between recent gathers: the newest added C and dropped none/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/re-reads every partition/);
    expect(f.text).toMatch(/METHOD_OPT is not SIZE AUTO now|Under SIZE AUTO the recorded column usage decides/);
    expect(f.fix!.join("\n")).toMatch(/HIST_FOR_INCREM_STATS/);
    expect(find(historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [h(3, ["A", "B"]), h(2, ["B", "A"])] })), /histogram columns differ/)).toBeUndefined();
  });

  test("no gather in the history although statistics exist: purged, or not a gather", () => {
    const s = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [] }))!;
    expect(s.findings[0]!.level).toBe("info");
    expect(s.findings[0]!.text).toMatch(/No gather appears in the history/);
    expect(s.findings[0]!.fix![1]).toMatch(/REPORT_STATS_OPERATIONS\(detail_level => 'TYPICAL', format => 'TEXT', latestn => 10\)/);
    expect(historySection(synth({}))).toBeNull();
  });
});

// ---------------------------------------------------------------- pending
describe("pending statistics", () => {
  const pend = { pendingRows: 3, pendingSince: "2026-09-20 00:00:00", collectedAt: "2026-10-11 00:00:00", optimizerUsePendingStatistics: false };

  test("rows exist: the recipe with the table named", () => {
    const s = pendingSection(synth(pend, { owner: "APP", tableName: "ORD", publish: "FALSE" }))!;
    const f = s.findings[0]!;
    expect(f.level).toBe("info");
    expect(f.text).toMatch(/3 rows of pending statistics wait in DBA_TAB_PENDING_STATS \(oldest 2026-09-20 00:00\)/);
    const fix = f.fix!.join("\n");
    expect(fix).toMatch(/ALTER SESSION SET OPTIMIZER_USE_PENDING_STATISTICS = TRUE;/);
    expect(fix).toMatch(/DIFF_TABLE_STATS_IN_PENDING\('APP', 'ORD', NULL, 10\)/);
    expect(fix).toMatch(/-- 3a\. publish: {2}EXEC DBMS_STATS\.PUBLISH_PENDING_STATS\('APP', 'ORD'\)/);
    expect(fix).toMatch(/-- 3b\. or discard: {2}EXEC DBMS_STATS\.DELETE_PENDING_STATS\('APP', 'ORD'\)/);
    expect(text(s)).toMatch(/PUBLISH is FALSE and the oldest pending row is 21 days old/);
  });

  test("under INCREMENTAL, the lab re-read every partition after a manual publish: delete instead", () => {
    const s = pendingSection(synth(pend, { incremental: "TRUE", partitioned: true, partitions: 12 }))!;
    const f = find(s, /after pending statistics were published by hand, the next gather re-read every partition/)!;
    expect(f.level).toBe("warn");
    expect(f.basis).toMatch(/lab G1, G1b.*G1c.*Tf/);
    expect(f.fix![0]).toMatch(/DELETE_PENDING_STATS/);
    // PUBLISH TRUE in force and old rows: forgotten leftovers
    const left = find(s, /leftovers of an earlier PUBLISH FALSE gather, 21 days old/)!;
    expect(left.level).toBe("warn");
    expect(left.text).toMatch(/Publishing them now would replace the current statistics with old ones/);
  });

  test("young leftovers under PUBLISH TRUE are info", () => {
    const s = pendingSection(synth({ ...pend, pendingSince: "2026-10-10 00:00:00" }))!;
    expect(find(s, /leftovers/)!.level).toBe("info");
  });

  test("OPTIMIZER_USE_PENDING_STATISTICS TRUE: V$PARAMETER shows the session value, so the instance is checked separately", () => {
    const s = pendingSection(synth({ pendingRows: 0, optimizerUsePendingStatistics: true }))!;
    const f = find(s, /OPTIMIZER_USE_PENDING_STATISTICS is TRUE in the collector's session/)!;
    expect(f.level).toBe("info"); // no pending rows: nothing is affected
    expect(f.fix![0]).toMatch(/v\$system_parameter/);
    expect(find(pendingSection(synth({ ...pend, optimizerUsePendingStatistics: true }))!, /collector's session/)!.level).toBe("warn");
    expect(levels(s)).not.toContain("good");
    expect(pendingSection(synth({}))).toBeNull();
  });
});

// ---------------------------------------------------------------- restore
describe("restore and retention", () => {
  const h = { historyAvailableSince: "2026-09-10 05:29:21", historyRows: 15, historyOldest: "2026-09-23 16:32:20", historyNewest: "2026-09-26 14:54:47", sysauxOptstatMb: 150.7, collectedAt: "2026-10-11 08:00:00" };

  test("the recipe: versions, compare, restore", () => {
    const s = restoreSection(synth({ ...h, retentionDays: 31 }, { owner: "APP", tableName: "T" }))!;
    const fix = s.findings[0]!.fix!.join("\n");
    expect(s.findings[0]!.text).toMatch(/restored to any time after 2026-09-10 05:29/);
    expect(s.findings.some((f) => /SM\/OPTSTAT/.test(f.text))).toBe(false); // 150 MB of database-wide history is not a finding
    expect(fix).toMatch(/FROM dba_tab_stats_history WHERE owner = 'APP' AND table_name = 'T'/);
    expect(fix).toMatch(/DIFF_TABLE_STATS_IN_HISTORY\('APP', 'T', SYSTIMESTAMP - INTERVAL '1' DAY, SYSTIMESTAMP, 10\)/);
    expect(fix).toMatch(/-- EXEC DBMS_STATS\.RESTORE_TABLE_STATS\('APP', 'T', as_of_timestamp => TIMESTAMP/);
    expect(levels(s)).toContain("good");
  });

  test("retention -1 is never purged, 0 saves nothing, a few days is short", () => {
    const never = restoreSection(synth({ ...h, retentionDays: -1 }))!;
    expect(find(never, /retention is -1/)!.level).toBe("info");
    expect(find(never, /retention is -1/)!.text).toMatch(/grows without limit \(150\.7 MB now\)/);
    expect(never.rows!.body[0]).toEqual(["Retention", "-1 (never purged)"]);
    const zero = restoreSection(synth({ ...h, retentionDays: 0 }))!;
    expect(find(zero, /retention is 0/)!.level).toBe("bad");
    expect(find(zero, /retention is 0/)!.basis).toMatch(/Old statistics are never saved/);
    const short = restoreSection(synth({ ...h, retentionDays: 2 }))!;
    expect(find(short, /2 days, short of the default 31/)!.level).toBe("warn");
    expect(levels(restoreSection(synth({ ...h, retentionDays: 7 }))!)).not.toContain("warn"); // a week is a choice
  });

  test("retention shorter than the gather interval", () => {
    const g = (opid: number, day: string) => hist({ opid, startTime: `${day} 02:00:00`, endTime: `${day} 02:01:00` });
    const s = restoreSection(synth({ ...h, retentionDays: 14, history: [g(3, "2026-10-01"), g(2, "2026-09-01"), g(1, "2026-08-01")] }))!;
    expect(find(s, /14 days but this table is gathered only every 3[01] days/)!.level).toBe("warn");
    expect(levels(restoreSection(synth({ ...h, retentionDays: 40, history: [g(3, "2026-10-01"), g(2, "2026-09-01"), g(1, "2026-08-01")] }))!)).not.toContain("warn");
  });

  test("PURGE_STATS is only ever a comment, and only for a large SM/OPTSTAT", () => {
    const s = restoreSection(synth({ ...h, sysauxOptstatMb: 3000, retentionDays: 31 }))!;
    for (const line of fixes(s).split("\n")) expect(line).not.toMatch(/^\s*EXEC DBMS_STATS\.PURGE_STATS/);
    expect(fixes(s)).toMatch(/-- EXEC DBMS_STATS\.PURGE_STATS/);
    expect(find(s, /SM\/OPTSTAT occupies 2\.9 GB/)).toBeTruthy();
  });

  test("restore operations already in the history; not collected is null", () => {
    const s = restoreSection(synth({ ...h, retentionDays: 31, history: [hist({ opid: 5, operation: "restore_table_stats" })] }))!;
    expect(find(s, /1 restore operation in the history: opid 5 restore_table_stats/)).toBeTruthy();
    expect(restoreSection(synth({}))).toBeNull();
  });
});

// ---------------------------------------------------------------- load
describe("statistics from a bulk load", () => {
  test("STATS_ON_LOAD: what is missing, and GATHER AUTO fills the gaps", () => {
    const s = loadSection(synth({ statsOnLoad: true }, { owner: "APP", tableName: "STG" }))!;
    expect(text(s)).toMatch(/NOTES = STATS_ON_LOAD/);
    const f = find(s, /Fill the gaps/)!;
    expect(f.fix).toEqual(["EXEC DBMS_STATS.GATHER_TABLE_STATS('APP', 'STG', options => 'GATHER AUTO')"]);
    expect(f.basis).toMatch(/does not gather table and basic column statistics collected during the bulk load/);
    expect(fixes(s)).toMatch(/notes LIKE '%STATS_ON_LOAD%'/);
  });

  test("the index statistics the load left out are counted from the dictionary", () => {
    const ix = (name: string, lastAnalyzed: string | null) => ({ name, uniqueness: null, indexType: null, partitioned: null, locality: null, columns: [], blevel: null, leafBlocks: null, distinctKeys: null, clusteringFactor: null, numRows: null, lastAnalyzed, staleStats: null, locked: null, status: null, visibility: null, totalAccessCount: null, totalExecCount: null, lastUsed: null });
    const s = loadSection(synth({ statsOnLoad: true, indexes: [ix("I1", null), ix("I2", null), ix("I3", "2026-10-01 00:00:00")] }))!;
    expect(s.summary).toMatch(/2 of 3 indexes without statistics/);
  });

  test("a locked table: ORA-20005 and force; INCREMENTAL: GATHER AUTO is for tables without INCREMENTAL", () => {
    const s = loadSection(synth({ statsOnLoad: true }, { tableLocked: true, incremental: "TRUE", partitioned: true, partitions: 4 }))!;
    const l = find(s, /statistics are locked/)!;
    expect(l.level).toBe("warn");
    expect(l.text).toMatch(/ORA-20005/);
    expect(l.fix![0]).toBe("EXEC DBMS_STATS.GATHER_TABLE_STATS('OWNER', 'TABLE', force => TRUE)");
    expect(l.basis).toMatch(/lab D1.*D3/);
    expect(find(s, /which the DBMS_STATS reference limits to tables without INCREMENTAL/)!.level).toBe("info");
    expect(find(s, /Fill the gaps/)).toBeUndefined();
  });

  test("not collected is null; false is one good line", () => {
    expect(loadSection(synth({}))).toBeNull();
    const s = loadSection(synth({ statsOnLoad: false }))!;
    expect(s.findings).toHaveLength(1);
    expect(s.findings[0]!.level).toBe("good");
  });
});

// ---------------------------------------------------------------- real-time
describe("real-time and adaptive statistics", () => {
  test("parameter TRUE: what it keeps, the hint, the note", () => {
    const s = realtimeSection(synth({ realtimeStatsParam: true, realtimeStatsNotes: true, optimizerAdaptiveStatistics: true }, { partitioned: true, partitions: 4 }))!;
    expect(text(s)).toMatch(/Real-time statistics are on/);
    expect(text(s)).toMatch(/NO_GATHER_OPTIMIZER_STATISTICS hint/);
    expect(text(s)).toMatch(/partitions of this table get none/);
    expect(text(s)).toMatch(/STATS_ON_CONVENTIONAL_DML/);
    expect(find(s, /inferred/i)).toBeTruthy(); // the supersession by a gather is marked inferred
    expect(text(s)).toMatch(/SQL plan directives are created and used/);
  });

  test("parameter FALSE with the licence row; adaptive FALSE points at SEED_COL_USAGE", () => {
    const s = realtimeSection(synth({ realtimeStatsParam: false, optimizerAdaptiveStatistics: false, dbVersion: "19.27.0.0.0" }))!;
    const f = s.findings[0]!;
    expect(f.text).toMatch(/so conventional DML moves only the DML counters/);
    expect(f.basis).toMatch(/EE-ES and ExaDB \('EE-ES : Available on Exadata/);
    const ad = find(s, /OPTIMIZER_ADAPTIVE_STATISTICS is FALSE/)!;
    expect(ad.text).toMatch(/SQL plan directives can still be created, but they are not used to refine plans with dynamic sampling/);
    expect(ad.text).toMatch(/SEED_COL_USAGE/);
    // the Reference sentence, quoted whole
    expect(ad.basis).toMatch(/does not control the creation of SQL plan directives\. SQL plan directives will be created even if this parameter is false, but they will not be used to refine SQL execution plans with dynamic sampling/);
    expect(find(s, /OPTIMIZER_ADAPTIVE_STATISTICS is FALSE/)!.basis).toMatch(/CG1/);
    expect(realtimeSection(synth({}))).toBeNull();
  });
});

// ---------------------------------------------------------------- subpartitions
describe("subpartitions", () => {
  const comp = { subpartitioning: "HASH", subpartitions: 24, subpartitionsWithStats: 0 };

  test("GRANULARITY ALL should have gathered them", () => {
    const s = subpartitionsSection(synth(comp, { granularity: "ALL", partitioned: true, subpartitioned: true }))!;
    expect(find(s, /should gather the subpartitions, yet 24 of 24 have no statistics/)!.level).toBe("warn");
    expect(subpartitionsSection(synth({ ...comp, subpartitionsWithStats: 24 }, { granularity: "ALL" }))!.findings[1]!.text).toMatch(/all 24 subpartitions have statistics/);
  });

  test("statistics from an earlier ALL gather under AUTO: not refreshed, used only when pruning reaches one subpartition", () => {
    const s = subpartitionsSection(synth({ ...comp, subpartitionsWithStats: 24 }, { granularity: "AUTO" }))!;
    const f = find(s, /24 subpartitions carry statistics although GRANULARITY AUTO does not gather that level/)!;
    expect(f.text).toMatch(/single subpartition \(inferred\)/);
  });

  test("a call granularity overrides the preference, unless the preference overrides the call", () => {
    const called = subpartitionsSection(synth(comp, { granularity: "AUTO", callGranularity: "SUBPARTITION" }))!;
    expect(find(called, /GRANULARITY SUBPARTITION should gather/)).toBeTruthy();
    const ignored = subpartitionsSection(synth(comp, { granularity: "AUTO", callGranularity: "SUBPARTITION", overrides: "TRUE" }))!;
    expect(find(ignored, /GRANULARITY AUTO gathers no subpartition statistics/)).toBeTruthy();
  });

  test("counts missing: a single info line", () => {
    const s = subpartitionsSection(synth({ subpartitioning: "LIST" }))!;
    expect(s.findings).toHaveLength(1);
    expect(s.summary).toMatch(/not collected/);
  });
});

// ---------------------------------------------------------------- SQL*Plus and formats
describe("generated SQL is valid SQL*Plus; durations read in hours", () => {
  // SQL*Plus sends a trailing -- comment to the server: EXEC x -- c ends in BEGIN x -- c; END; and SELECT ...; -- c fails (checked on 19.27)
  test("no fix line of the table sections carries a trailing comment", () => {
    const lint = (sec: HealthSection | null, where: string) => {
      for (const f of sec?.findings ?? []) for (const line of f.fix ?? []) expect(line.startsWith("--") || !/\s--\s/.test(line), `${where}: ${line}`).toBe(true);
    };
    for (const n of ["stats_lab-sales", "stats_lab-c1", "orastats_test-orders", "orastats_test-expr_pred", "stats_lab-cg1"]) {
      const { input, detail } = load(n);
      const r = health(input, detail, null);
      for (const sec of r.sections) lint(sec, n);
    }
    // the branches the fixtures do not reach
    const base = { lastAnalyzed: "2026-10-01 00:00:00", collectedAt: "2026-10-11 00:00:00" };
    lint(historySection(synth({ ...base, history: [hist({ opid: 9, jobName: "ORA$AT_OS_OPT_SY_9", targetType: "AUTO", partitionsGathered: 1, globalGathered: false }), hist({ opid: 8, status: "FAILED" })] }, { partitioned: true, partitions: 12, incremental: "TRUE" })), "history");
    lint(restoreSection(synth({ ...base, retentionDays: 0, historyAvailableSince: "2026-09-10 00:00:00", sysauxOptstatMb: 5000 })), "restore");
    lint(pendingSection(synth({ ...base, pendingRows: 2, pendingSince: "2026-09-01 00:00:00", optimizerUsePendingStatistics: true }, { incremental: "TRUE", partitioned: true, partitions: 4 })), "pending");
    lint(loadSection(synth({ statsOnLoad: true }, { tableLocked: true })), "load");
    lint(realtimeSection(synth({ realtimeStatsParam: true, realtimeStatsNotes: true })), "realtime");
    lint(subpartitionsSection(synth({ subpartitioning: "HASH", subpartitions: 4, subpartitionsWithStats: 0 }, { granularity: "AUTO" })), "subpartitions");
  });

  test("a 20 hour window reads 20h 0m, not 1200m 0s", () => {
    const d = { lastAnalyzed: "2026-10-01 00:00:00", collectedAt: "2026-10-11 08:00:00", rowsChanged: 0, autotaskStatus: "ENABLED", windows: [{ name: "SUNDAY_WINDOW", repeatInterval: "freq=daily;byday=SUN;byhour=6", duration: "+000 20:00:00", enabled: true, nextStart: "2026-10-11 06:00:00" }] };
    const t = text(stalenessSection(synth(d, { numRows: 1000 })));
    expect(t).toMatch(/SUNDAY_WINDOW is open now \(started 2026-10-11 06:00, 20h 0m long\)/);
    expect(t).not.toMatch(/1200m/);
  });

  test("a daily window without BYDAY recurs every day, a predefined weekday window every week", () => {
    const mk = (repeatInterval: string) => ({ lastAnalyzed: "2026-10-01 00:00:00", collectedAt: "2026-10-11 00:00:00", rowsChanged: 40_000, autotaskStatus: "ENABLED", windows: [{ name: "W", repeatInterval, duration: "+000 01:00:00", enabled: true, nextStart: "2026-10-11 22:00:00" }] });
    const input = { numRows: 1_000_000, stalePercent: 10 };
    // stale at 2026-10-26 00:00: a daily window starts again at 22:00 that day, the Sunday window on 2026-11-01
    expect(text(stalenessSection(synth(mk("freq=daily;byhour=22"), input)))).toMatch(/the first window after that is W at 2026-10-26 22:00/);
    expect(text(stalenessSection(synth(mk("freq=daily;byday=SUN;byhour=22"), input)))).toMatch(/the first window after that is W at 2026-11-01 22:00/);
  });

  test("a dry-run fix is a statement of its own, the comment a line before it", () => {
    const inc = { incremental: "TRUE" as const, partitioned: true, partitions: 24 };
    const s = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [hist({ opid: 4, partitionsGathered: 24 }), hist({ opid: 3, partitionsGathered: 24 }), hist({ opid: 2, partitionsGathered: 24 })] }, inc))!;
    const fix = find(s, /does not behave incrementally/)!.fix!;
    expect(fix).toContain("-- a dry run: lists what the next gather would read");
    expect(fix).toContain("SELECT DBMS_STATS.REPORT_GATHER_TABLE_STATS('OWNER', 'TABLE') FROM dual;");
  });
});
