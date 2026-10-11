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
    expect(text(s)).toMatch(/0 rows changed since the last gather \(no DML counted/);
    expect(text(s)).toMatch(/1,630,200 rows/);
    expect(text(s)).toMatch(/STALE_STATS = NO/);
    expect(text(s)).toMatch(/SUNDAY_WINDOW is open now|Next window with the task/); // the lab's Sunday window (06:00, 20 h) is open at 08:14
    expect(text(s)).toMatch(/None of the 54 partitions has DML/);
    expect(text(s)).toMatch(/ORIGIN AUTO_TASK/); // the lab view lists the nightly runs
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
    expect(text(s)).toMatch(/SUBPARTITION_NAME/); // the DML rollup caveat
    expect(fixes(s)).toMatch(/dba_tab_subpartitions/);
    expect(text(stalenessSection(ctx(input, detail)))).toMatch(/composite: DBA_TAB_MODIFICATIONS records DML on subpartition rows only/);
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
    expect(f.text).toMatch(/about 4,000 rows per day \(40,000 changes over 10 days, 2026-10-01 00:00 to 2026-10-11 00:00\)/);
    expect(f.text).toMatch(/in about 15 days, around 2026-10-26 00:00/);
    expect(f.text).toMatch(/linear/);
    const w = find(s, /Next window with the task: MONDAY_WINDOW at 2026-10-12 22:00 \(240m 0s long\)/)!;
    expect(w.text).toMatch(/stale around 2026-10-26 00:00; the first window after that is MONDAY_WINDOW at 2026-10-26 22:00 \(0\.9 days later/);
    expect(s.summary).toMatch(/threshold in ~15 days/);
  });

  test("the rate runs to the modification timestamp when there is one", () => {
    const s = stalenessSection(synth({ ...base, rowsChanged: 40_000, modsTimestamp: "2026-10-06 00:00:00" }, { numRows: 1_000_000, stalePercent: 10 }))!;
    expect(find(s, /rows per day/)!.text).toMatch(/about 8,000 rows per day \(40,000 changes over 5 days/);
    expect(find(s, /rows per day/)!.text).toMatch(/in about 7\.5 days/);
  });

  test("already past STALE_PERCENT: warn, says when it was crossed, and the next run gathers it", () => {
    const s = stalenessSection(synth({ ...base, rowsChanged: 150_000, staleStats: true }, { numRows: 1_000_000, stalePercent: 10 }))!;
    const f = s.findings[0]!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/15% of the 1,000,000 rows/);
    expect(f.text).toMatch(/so the table is past it\. DBA_TAB_STATISTICS\.STALE_STATS = YES/);
    expect(find(s, /crossed STALE_PERCENT about 6\.7 days after the last gather/)).toBeTruthy();
    expect(find(s, /stale now, so the next run gathers it/)).toBeTruthy();
    expect(levels(s)).not.toContain("good");
  });

  test("a truncated table is stale whatever the counters say", () => {
    const s = stalenessSection(synth({ rowsChanged: 0, rowsTruncated: true, staleStats: true, lastAnalyzed: "2026-10-01 00:00:00" }, { owner: "CHAOS", tableName: "FILL", numRows: 1000 }))!;
    const f = find(s, /truncated/)!;
    expect(f.level).toBe("bad");
    expect(f.fix).toEqual(["EXEC DBMS_STATS.GATHER_TABLE_STATS('CHAOS', 'FILL')"]);
    expect(f.basis).toMatch(/truncated since the most recent statistics collection/);
    expect(find(s, /STALE_STATS = YES although only 0%/)).toBeTruthy();
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
    expect(f.level).toBe("bad");
    expect(f.fix![0]).toMatch(/DBMS_AUTO_TASK_ADMIN.ENABLE\(client_name => 'auto optimizer stats collection'/);
  });

  test("a run that hit the window end is flagged, the task resumes in the next window", () => {
    const d = { ...base, rowsChanged: 1, autoruns: [{ windowName: "MONDAY_WINDOW", windowStart: "2026-10-05 22:00:00", jobStatus: "STOPPED", jobDuration: "+000 03:59:58", jobInfo: "REASON=Stop job called because associated window was closed" }, { windowName: "TUESDAY_WINDOW", windowStart: "2026-10-06 22:00:00", jobStatus: "SUCCEEDED", jobDuration: "+000 00:20:00", jobInfo: null }] };
    const s = stalenessSection(synth(d, { numRows: 1000 }))!;
    const f = find(s, /did not finish cleanly or ran to the end of the window/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/MONDAY_WINDOW 2026-10-05 22:00: STOPPED, 239m 58s/);
    expect(f.text).toMatch(/candidates again in the next window/);
    expect(f.basis).toMatch(/TIMED OUT: Maintenance window was not enough/);
  });

  test("the high-frequency task: ON with its own runs, ON without any, and the nightly rows in the same view", () => {
    const hf = (origin: string, extra: object = {}) => ({ opid: 9, startTime: "2026-10-10 10:00:00", endTime: "2026-10-10 10:00:20", status: "COMPLETED", completed: 4, failed: 0, timedOut: 0, origin, ...extra });
    const on = synth({ autoTaskStatus: "ON", autoTaskInterval: 900, autoTaskMaxRunTime: 3600, rowsChanged: 0, lastAnalyzed: "2026-10-01 00:00:00", hfruns: [hf("HIGH_FREQ_AUTO_TASK"), hf("HIGH_FREQ_AUTO_TASK", { status: "TIMED OUT", timedOut: 2 }), hf("AUTO_TASK", { completed: 70, failed: 1 })] }, { numRows: 1000 });
    const s = stalenessSection(on)!;
    expect(find(s, /high-frequency task is ON: every 900 s, at most 3,600 s/)).toBeTruthy();
    const runs = find(s, /Last 2 high-frequency runs/)!;
    expect(runs.level).toBe("warn");
    expect(runs.text).toMatch(/2 \(1 completed, 1 timed out\); objects 8 completed, 0 failed, 2 timed out/);
    expect(find(s, /1 nightly run \(ORIGIN AUTO_TASK\)/)!.text).toMatch(/completed 70 objects, 1 failed/);
    const none = stalenessSection(synth({ autoTaskStatus: "ON", rowsChanged: 0, lastAnalyzed: "2026-10-01 00:00:00", hfruns: [hf("AUTO_TASK")] }, { numRows: 1000 }))!;
    expect(find(none, /none of the last 1 row/)!.level).toBe("warn");
  });

  test("partitions with no statistics and zero-row partitions that took inserts", () => {
    const parts: PartitionRec[] = ["P1", "P2"].map((name, i) => ({ name, position: i + 1, numRows: i ? null : 0, blocks: null, lastAnalyzed: i ? null : "2026-10-01 00:00:00", staleStats: null, locked: null, rowsChanged: 0, synopsis: null }));
    const s = stalenessSection(synth({ partitions: parts, zeroRowPartitionsWithDml: 1, rowsChanged: 0, lastAnalyzed: "2026-10-01 00:00:00" }, { numRows: 100, partitioned: true, partitions: 2 }))!;
    expect(find(s, /1 partition has no statistics .*: P2/)).toBeTruthy();
    expect(find(s, /statistics that say 0 rows although inserts/)!.fix![0]).toMatch(/num_rows = 0/);
  });

  test("locked partitions with DML on an INCREMENTAL table", () => {
    const mk = (name: string, locked: boolean, rowsChanged: number): PartitionRec => ({ name, position: 1, numRows: 1000, blocks: 10, lastAnalyzed: "2026-10-01 00:00:00", staleStats: null, locked, rowsChanged, synopsis: "HLL" });
    const s = stalenessSection(synth({ partitions: [mk("P1", true, 300), mk("P2", false, 0)], rowsChanged: 300, lastAnalyzed: "2026-10-01 00:00:00" }, { numRows: 2000, partitioned: true, partitions: 2, incremental: "TRUE" }))!;
    const f = find(s, /1 locked partition has DML/)!;
    expect(f.level).toBe("warn");
    expect(f.basis).toMatch(/lab C1/);
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
    const slow = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [mk(5, 120), mk(4, 30), mk(3, 28), mk(2, 32)] }))!;
    const f = find(slow, /took 2m 0s, more than twice the median 0m 30s of the 3 before/)!;
    expect(f.level).toBe("warn");
    const steady = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [mk(5, 40), mk(4, 30), mk(3, 28), mk(2, 32)] }))!;
    expect(find(steady, /more than twice/)).toBeUndefined();
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

  test("histogram columns that change between gathers, and the warning not to pin the printed list", () => {
    const h = (opid: number, cols: string[]) => hist({ opid, histogramColumns: cols });
    const s = historySection(synth({ lastAnalyzed: "2026-10-05 00:00:00", history: [h(3, ["A", "B", "C"]), h(2, ["A", "B"]), h(1, ["A", "B"])] }, { incremental: "TRUE", partitioned: true, partitions: 10 }))!;
    const f = find(s, /histogram columns differ between recent gathers: the newest added C and dropped none/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/re-reads every partition/);
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

  test("under INCREMENTAL, publishing leaves the synopses out of step: delete instead", () => {
    const s = pendingSection(synth(pend, { incremental: "TRUE", partitioned: true, partitions: 12 }))!;
    const f = find(s, /Publishing pending statistics leaves the synopses out of step/)!;
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

  test("OPTIMIZER_USE_PENDING_STATISTICS TRUE for the instance", () => {
    const s = pendingSection(synth({ pendingRows: 0, optimizerUsePendingStatistics: true }))!;
    const f = find(s, /testing pending statistics/)!;
    expect(f.level).toBe("warn");
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
    expect(fix).toMatch(/FROM dba_tab_stats_history WHERE owner = 'APP' AND table_name = 'T'/);
    expect(fix).toMatch(/DIFF_TABLE_STATS_IN_HISTORY\('APP', 'T', SYSTIMESTAMP - INTERVAL '1' DAY, SYSTIMESTAMP, 10\)/);
    expect(fix).toMatch(/-- 3\. .*RESTORE_TABLE_STATS\('APP', 'T', as_of_timestamp => TIMESTAMP/);
    expect(levels(s)).toContain("good");
  });

  test("retention -1 is never purged, 0 saves nothing, a few days is short", () => {
    const never = restoreSection(synth({ ...h, retentionDays: -1 }))!;
    expect(find(never, /retention is -1/)!.level).toBe("warn");
    expect(find(never, /retention is -1/)!.text).toMatch(/grows without limit \(150\.7 MB now\)/);
    expect(never.rows!.body[0]).toEqual(["Retention", "-1 (never purged)"]);
    const zero = restoreSection(synth({ ...h, retentionDays: 0 }))!;
    expect(find(zero, /retention is 0/)!.level).toBe("bad");
    expect(find(zero, /retention is 0/)!.basis).toMatch(/Old statistics are never saved/);
    const short = restoreSection(synth({ ...h, retentionDays: 3 }))!;
    expect(find(short, /3 days, short of the default 31/)!.level).toBe("warn");
  });

  test("retention shorter than twice the gather interval", () => {
    const g = (opid: number, day: string) => hist({ opid, startTime: `${day} 02:00:00`, endTime: `${day} 02:01:00` });
    const s = restoreSection(synth({ ...h, retentionDays: 14, history: [g(3, "2026-10-01"), g(2, "2026-09-01"), g(1, "2026-08-01")] }))!;
    expect(find(s, /14 days but this table is gathered only every 3[01] days/)!.level).toBe("warn");
  });

  test("PURGE_STATS is only ever a comment", () => {
    const s = restoreSection(synth({ ...h, retentionDays: 31 }))!;
    for (const line of fixes(s).split("\n")) expect(line).not.toMatch(/^\s*EXEC DBMS_STATS\.PURGE_STATS/);
    expect(fixes(s)).toMatch(/-- Deliberate only: EXEC DBMS_STATS\.PURGE_STATS/);
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

  test("a locked table: ORA-20005 and force; INCREMENTAL: GATHER AUTO does not apply", () => {
    const s = loadSection(synth({ statsOnLoad: true }, { tableLocked: true, incremental: "TRUE", partitioned: true, partitions: 4 }))!;
    const l = find(s, /statistics are locked/)!;
    expect(l.level).toBe("warn");
    expect(l.text).toMatch(/ORA-20005/);
    expect(l.fix![0]).toBe("EXEC DBMS_STATS.GATHER_TABLE_STATS('OWNER', 'TABLE', force => TRUE)");
    expect(l.basis).toMatch(/lab D1.*D3/);
    expect(find(s, /GATHER AUTO is not applicable to a table with INCREMENTAL/)!.level).toBe("warn");
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
    expect(find(s, /inferred/i)).toBeTruthy(); // the 'not NDV, histograms, synopses' list is marked inferred
    expect(text(s)).toMatch(/SQL plan directives are created and used/);
  });

  test("parameter FALSE with the licence row; adaptive FALSE points at SEED_COL_USAGE", () => {
    const s = realtimeSection(synth({ realtimeStatsParam: false, optimizerAdaptiveStatistics: false, dbVersion: "19.27.0.0.0" }))!;
    const f = s.findings[0]!;
    expect(f.text).toMatch(/not in effect, and conventional DML moves only the DML counters/);
    expect(f.basis).toMatch(/EE-ES Y, ExaDB Y; EE-ES: Available on Exadata/);
    expect(find(s, /OPTIMIZER_ADAPTIVE_STATISTICS is FALSE/)!.text).toMatch(/SEED_COL_USAGE/);
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
