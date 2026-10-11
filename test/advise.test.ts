import { describe, expect, test } from "vitest";
import { DEFAULTS, RECOMMENDED, advise, stepsOf, verifySql, type Input } from "../src/model";

const N = 24, B = 850, T = N * B;
const run = (over: Partial<Input>) => advise({ ...DEFAULTS, ...over });
const inc: Partial<Input> = { incremental: "TRUE", synopses: "all" };

// ---------------------------------------------------------------- partitioned: the 19.27 lab log
describe("partitioned table, GATHER_TABLE_STATS (lab rules)", () => {
  test("defaults: not incremental, two passes now and next", () => {
    const o = run({}); // lab T0
    expect([o.blocks, o.global, o.next!.blocks, o.verdict[0]]).toEqual([2 * T, "fullscan", 2 * T, "warn"]);
    expect(o.fixes.join("\n")).toMatch(/'INCREMENTAL', 'TRUE'/);
  });
  test("example 1: a plain call reads the new partition and merges", () => {
    const o = run(inc); // lab A1
    expect([o.partitionsRead, o.blocks, o.global, o.globalNotes, o.next!.blocks]).toEqual([1, B, "merged", "INCREMENTAL", 0]);
    expect(run({ ...inc, partname: "new" }).blocks).toBe(B); // lab A2
  });
  test("partition-only granularity leaves the global statistics behind", () => {
    const o = run({ ...inc, partname: "new", callGranularity: "PARTITION" }); // lab A3, A3b
    expect([o.partitionsRead, o.global, o.verdict[0]]).toEqual([1, "untouched", "warn"]);
    expect([o.next!.partitionsRead, o.next!.global]).toEqual([0, "merged"]);
    expect(run({ ...inc, granularity: "PARTITION" }).fixes.join("\n")).toMatch(/'GRANULARITY', 'AUTO'/); // lab G2b
  });
  test("a fixed estimate_percent forces two passes now and a rebuild later", () => {
    const o = run({ ...inc, callEstimatePercent: 10 }); // lab A8, A8b
    expect([o.blocks, o.synopsesAfter, o.global, o.verdict[0]]).toEqual([2 * T, "stale", "sample", "bad"]);
    expect([o.next!.blocks, o.next!.global]).toEqual([T, "merged"]);
    const ov = run({ ...inc, callEstimatePercent: 10, overrides: "TRUE" }); // lab G2
    expect([ov.partitionsRead, ov.blocks, ov.global]).toEqual([1, B, "merged"]);
    expect(ov.effective.ignored).toContain("estimate_percent");
    expect(run({ ...inc, estimatePercent: 10 }).next!.blocks).toBe(2 * T);
    expect(run({ ...inc, callEstimatePercent: 10, callBlockSample: true }).blocks).toBe(Math.ceil(2 * T * 0.1)); // a block sample reads a tenth
  });
  test("PUBLISH FALSE, INCREMENTAL_LEVEL TABLE and a table lock", () => {
    const pub = run({ ...inc, publish: "FALSE" }); // lab G1
    expect([pub.blocks, pub.next!.blocks, pub.global]).toEqual([2 * T, 2 * T, "pending"]);
    expect(pub.fixes.join("\n")).toMatch(/DELETE_PENDING_STATS/);
    expect(pub.write.destination).toBe("pending");
    const lvl = run({ ...inc, incrementalLevel: "TABLE" }); // lab N2, X4
    expect([lvl.blocks, lvl.next!.blocks, lvl.synopsesAfter, lvl.globalNotes]).toEqual([2 * T, 2 * T, "table", "HYPERLOGLOG"]);
    const locked = run({ ...inc, tableLocked: true }); // lab D1
    expect([locked.error, locked.blocks, locked.next!.error, locked.verdict[0]]).toEqual(["ORA-20005", 0, "ORA-20005", "bad"]);
    expect(locked.fixes.join("\n")).toMatch(/UNLOCK_TABLE_STATS/);
    expect(locked.indexes.fullScans).toBe(0);
    const forced = run({ ...inc, tableLocked: true, force: true }); // lab D3
    expect([forced.error, forced.partitionsRead, forced.blocks, forced.global]).toEqual([null, 1, B, "merged"]);
  });
  test("locked partitions with DML force a full scan until unlocked", () => {
    const lk = { ...inc, lockedPartitions: 1, lockedChanged: 1 };
    const o = run(lk); // lab C1, X1, C1b
    expect([o.blocks, o.global, o.globalNotes, o.next!.blocks]).toEqual([B + T, "fullscan", "", T]);
    expect(o.fixes.join("\n")).toMatch(/USE_LOCKED_STATS/);
    const ul = run({ ...lk, useLockedStats: true }); // lab C2
    expect([ul.blocks, ul.global]).toEqual([B, "merged"]);
    expect(ul.findings.some((f) => f.level === "warn" && /no statistic/.test(f.text))).toBe(true);
    expect(run({ ...inc, lockedPartitions: 1 }).blocks).toBe(B); // lab C4
    expect(run({ ...inc, lockedPartitions: 1, lockedNoSynopsis: true, useLockedStats: true }).global).toBe("fullscan"); // lab V2
  });
  test("staleness decides which changed partitions are read", () => {
    const ch = { ...inc, newPartitions: 0, changedPartitions: 2 };
    const stale = { ...ch, useStalePercent: true };
    expect([run({ ...stale, changePercent: 1 }).blocks, run({ ...stale, changePercent: 1 }).verdict[1]]).toEqual([0, "Nothing to read"]); // lab B2
    expect(run({ ...stale, changePercent: 15 }).partitionsRead).toBe(2); // lab B3
    expect(run({ ...stale, stalePercent: 1, changePercent: 2 }).partitionsRead).toBe(2); // lab B3b
    expect(run({ ...ch, changePercent: 0.01 }).partitionsRead).toBe(2); // lab B1
  });
  test("a new column costs a one-off reread unless METHOD_OPT is pinned", () => {
    const col = { ...inc, newPartitions: 0 };
    const usage = run({ ...col, columnChange: "usage" }); // lab E3i, E2
    expect([usage.blocks, usage.partitionsRead, usage.next!.blocks]).toEqual([2 * T, N, 0]);
    expect(run({ ...col, columnChange: "usage", methodOpt: "pinned" }).blocks).toBe(0); // lab E3ii, V1.6
    expect(run({ ...col, columnChange: "usage", methodOpt: "repeat" }).blocks).toBe(0);
    expect(run({ ...col, columnChange: "group" }).blocks).toBe(T); // lab E4
    expect(run({ ...col, columnChange: "histogram", methodOpt: "pinned" }).blocks).toBe(2 * T); // lab Td
    const lk = run({ ...col, columnChange: "usage", lockedPartitions: 1 }); // lab Tc
    expect([lk.read.globalScan, lk.next!.read.globalScan]).toEqual([N, N]);
    expect(usage.fixes.join("\n")).toMatch(/METHOD_OPT/);
  });
  test("synopses that are missing or out of step are rebuilt", () => {
    const none = run({ incremental: "TRUE", synopses: "none" }); // lab T1, T1b
    expect([none.partitionsRead, none.blocks, none.global, none.next!.blocks]).toEqual([N, T, "merged", 0]);
    expect(run({ incremental: "TRUE", synopses: "none", partname: "new" }).partitionsRead).toBe(N); // lab N1
    const build = run({ incremental: "TRUE", synopses: "none", partname: "new", callGranularity: "PARTITION" }); // example 5
    expect([build.partitionsRead, build.verdict[0], build.global, build.next!.partitionsRead]).toEqual([1, "good", "untouched", N - 1]);
    const stale = run({ incremental: "TRUE", synopses: "stale" }); // lab L1
    expect([stale.blocks, stale.next!.blocks]).toEqual([T, 0]);
    const off = run({ ...inc, incremental: "FALSE" }); // lab L1
    expect([off.synopsesAfter, off.next!.blocks]).toEqual(["stale", 2 * T]);
    expect(run({ partname: "new" }).blocks).toBe(B + T); // lab X2
  });
  test("the recommended setup survives the wrong parameters", () => {
    const o = run({ ...RECOMMENDED, callEstimatePercent: 10, callGranularity: "ALL", callMethodOpt: "size1", callCascade: "TRUE" }); // lab V1.5
    expect([o.partitionsRead, o.blocks, o.global, o.effective.ignored]).toEqual([1, B, "merged", ["granularity", "estimate_percent", "method_opt", "cascade"]]);
    expect(o.verdict[0]).toBe("good");
    expect(o.resolved.filter((r) => r.source === "ignored").map((r) => r.param)).toEqual(["estimate_percent", "method_opt", "granularity", "cascade"]);
    const wrong = run({ ...RECOMMENDED, overrides: "FALSE", callMethodOpt: "size1" }); // lab E6
    expect([wrong.blocks, wrong.verdict[0]]).toEqual([B, "bad"]);
    expect(wrong.fixes.some((f) => /GATHER_TABLE_STATS\('OWNER', 'TABLE'\)$/.test(f))).toBe(true);
    expect(wrong.dryRun).toContain("REPORT_GATHER_TABLE_STATS");
    expect(wrong.columns.deleted).toBe(true);
  });
  test("the names reach every statement, and the placeholders stay when they are empty", () => {
    const names = { owner: "SHOP", tableName: "SALES", newPartitionName: "SALES_2025_12", changedPartitionName: "SALES_2025_11", lockedPartitionName: "SALES_2024_01" };
    const o = run({ ...names, ...inc, partname: "new", callEstimatePercent: 5, lockedPartitions: 1, lockedChanged: 1, tableLocked: true });
    expect(o.sql).toMatch(/GATHER_TABLE_STATS\('SHOP', 'SALES',/);
    expect(o.sql).toMatch(/partname => 'SALES_2025_12'/);
    expect(o.dryRun).toMatch(/REPORT_GATHER_TABLE_STATS\('SHOP', 'SALES'/);
    expect(o.fixes.some((f) => /UNLOCK_TABLE_STATS\('SHOP', 'SALES'\)/.test(f))).toBe(true);
    const unlock = run({ ...names, ...inc, lockedPartitions: 2, lockedChanged: 1 });
    expect(unlock.fixes).toContain("EXEC DBMS_STATS.UNLOCK_PARTITION_STATS('SHOP', 'SALES', 'SALES_2024_01')");
    const changed = run({ ...names, ...inc, newPartitions: 0, changedPartitions: 1, partname: "changed" });
    expect(changed.sql).toMatch(/partname => 'SALES_2025_11'/);
    const blank = run({ ...inc, partname: "new", lockedPartitions: 1, lockedChanged: 1 });
    expect(blank.sql).toMatch(/\('OWNER', 'TABLE', partname => 'NEW_PARTITION'\)/);
    expect(run({ owner: "O'NEIL", tableName: "T", ...inc }).sql).toMatch(/\('O''NEIL', 'T'\)/);
    expect(verifySql(run({ ...names, ...inc }))).toMatch(/owner = 'SHOP' AND table_name = 'SALES'/);
  });
  test("indexes are scanned in full on every gather unless CASCADE is FALSE", () => {
    const o = run({ ...inc, indexCount: 2, localIndexCount: 1 }); // lab F2
    expect([o.indexes.fullScans, o.indexes.partitionScans]).toEqual([2, 1]);
    expect(run({ ...inc, cascade: "FALSE" }).indexes.fullScans).toBe(0); // lab F4
    expect(run({ ...inc, callCascade: "FALSE" }).indexes.fullScans).toBe(0);
    expect(run({ ...inc, callCascade: "FALSE", overrides: "TRUE" }).indexes.fullScans).toBe(2); // the override drops cascade too (V1.5)
    const po = run({ ...inc, partname: "new", callGranularity: "PARTITION", indexCount: 2, localIndexCount: 2 }); // lab F5
    expect([po.indexes.fullScans, po.indexes.partitionScans]).toEqual([0, 2]);
  });
});

// ---------------------------------------------------------------- the automatic job
describe("the automatic job (GATHER AUTO)", () => {
  const job: Partial<Input> = { ...inc, runBy: "auto" };
  test("one new month: the partition, with a synopsis; the global statistics wait", () => {
    const o = run(job); // lab G6
    expect([o.partitionsRead, o.blocks, o.global, o.verdict[0]]).toEqual([1, B, "untouched", "warn"]);
    expect(o.sql).toMatch(/GATHER AUTO/);
    expect(o.dryRun).toMatch(/REPORT_GATHER_AUTO_STATS/);
    expect(o.next!.blocks).toBe(0);
  });
  test("a stale table, a lower STALE_PERCENT or the override refresh the global statistics from synopses", () => {
    expect(run({ ...job, stalePercent: 1 }).global).toBe("merged"); // lab G8
    expect(run({ ...job, newPartitions: 5 }).global).toBe("merged"); // lab G9: 5 of 24 = 21%
    expect(run({ ...job, overrides: "TRUE" }).global).toBe("merged"); // lab Tb2
    const o = run({ ...job, newPartitions: 5 });
    expect([o.partitionsRead, o.read.globalScan]).toEqual([5, 0]);
  });
  test("a changed old month is regathered only above STALE_PERCENT; nothing else moves", () => {
    const o = run({ ...job, newPartitions: 0, changedPartitions: 1, changePercent: 15 }); // lab G7
    expect([o.partitionsRead, o.global]).toEqual([1, "untouched"]);
    expect(run({ ...job, newPartitions: 0, changedPartitions: 1, changePercent: 3 }).partitionsRead).toBe(0);
    expect(run({ ...job, newPartitions: 0 }).verdict[1]).toMatch(/Nothing stale/);
  });
  test("without INCREMENTAL the job gathers the stale partition and leaves the global statistics alone", () => {
    const o = run({ runBy: "auto", newPartitions: 0, changedPartitions: 1, changePercent: 20 }); // lab Ti
    expect([o.partitionsRead, o.read.globalScan, o.global]).toEqual([1, 0, "untouched"]);
    const whole = run({ runBy: "auto", newPartitions: 5 }); // stale as a whole: the old way
    expect([whole.read.globalScan, whole.global]).toEqual([N, "fullscan"]);
  });
  test("a locked table is skipped, not an error", () => {
    const o = run({ ...job, tableLocked: true });
    expect([o.error, o.blocks, o.verdict[0]]).toEqual([null, 0, "warn"]);
  });
  test("a plain table is gathered only when stale", () => {
    const flat: Partial<Input> = { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, runBy: "auto" };
    const fresh = run({ ...flat, tableChangePercent: 4 });
    expect([fresh.blocks, fresh.verdict[0], fresh.auto.thresholdRows, fresh.auto.stale]).toEqual([0, "good", 100000, false]);
    const stale = run({ ...flat, tableChangePercent: 12 });
    expect([stale.blocks, stale.auto.stale, stale.next!.blocks]).toEqual([18000, true, 0]);
    expect(run({ ...flat, tableStats: "none" }).blocks).toBe(18000);
    expect(run({ ...flat, tableChangePercent: 12, estimatePercent: 1 }).verdict[0]).toBe("bad");
  });
});

// ---------------------------------------------------------------- a plain table
describe("plain (non-partitioned) table", () => {
  const flat: Partial<Input> = { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, columnCount: 9, indexCount: 4 };
  test("the default call: one full scan, approximate NDV, every index read", () => {
    const o = run(flat);
    expect([o.blocks, o.partitionsRead, o.global, o.verdict[0], o.scan.kind]).toEqual([18000, 1, "na", "good", "full"]);
    expect(o.columns.kinds.join(" ")).toMatch(/HYBRID/);
    expect(o.columns.extraSample).toBe(true);
    expect([o.indexes.fullScans, o.indexes.partitionScans]).toEqual([4, 0]);
    expect([o.write.destination, o.write.invalidation]).toEqual(["dictionary", "rolling"]);
    expect(o.next!.blocks).toBe(18000); // a plain table has no incremental shortcut
    expect(o.sql).toBe("EXEC DBMS_STATS.GATHER_TABLE_STATS('OWNER', 'TABLE')");
  });
  test("the 10g-era script: sampled, histograms deleted, cascade forced", () => {
    const o = run({ ...flat, callEstimatePercent: 10, callMethodOpt: "size1", callCascade: "TRUE" });
    expect([o.blocks, o.scan.kind, o.verdict[0], o.columns.deleted]).toEqual([18000, "row-sample", "bad", true]);
    expect(o.columns.kinds).toEqual([]);
    expect(o.fixes).toContain("EXEC DBMS_STATS.GATHER_TABLE_STATS('OWNER', 'TABLE')");
    expect(o.sql).toMatch(/estimate_percent => 10/);
    expect(o.sql).toMatch(/cascade => TRUE/);
    const bs = run({ ...flat, callEstimatePercent: 10, callBlockSample: true });
    expect([bs.blocks, bs.scan.kind]).toEqual([1800, "block-sample"]);
    const ov = run({ ...flat, callEstimatePercent: 10, callMethodOpt: "size1", overrides: "TRUE" });
    expect([ov.verdict[0], ov.effective.ignored]).toEqual(["good", ["estimate_percent", "method_opt"]]);
  });
  test("METHOD_OPT rules", () => {
    expect(run({ ...flat, columnUsageRecorded: false }).columns.kinds).toEqual([]);
    expect(run({ ...flat, methodOpt: "repeat", histogramsPresent: false }).columns.kinds).toEqual([]);
    expect(run({ ...flat, methodOpt: "skewonly", columnUsageRecorded: false }).columns.kinds.length).toBe(2);
    expect(run({ ...flat, methodOpt: "size1", histogramsPresent: false }).verdict[0]).toBe("good");
    expect(run({ ...flat, methodOpt: "size1" }).fixes.join("\n")).toMatch(/SET_TABLE_PREFS\('OWNER', 'TABLE', 'METHOD_OPT', 'FOR ALL COLUMNS SIZE AUTO'\)/);
  });
  test("PUBLISH, NO_INVALIDATE, CASCADE and locks", () => {
    const pend = run({ ...flat, publish: "FALSE" });
    expect([pend.write.destination, pend.write.invalidation, pend.verdict[0]]).toEqual(["pending", "none", "warn"]);
    expect(run({ ...flat, callNoInvalidate: "FALSE" }).write.invalidation).toBe("immediate");
    expect(run({ ...flat, noInvalidate: "TRUE" }).write.invalidation).toBe("never");
    expect(run({ ...flat, cascade: "FALSE" }).indexes.fullScans).toBe(0);
    const locked = run({ ...flat, tableLocked: true });
    expect([locked.error, locked.blocks, locked.write.destination]).toEqual(["ORA-20005", 0, "nothing"]);
    expect(run({ ...flat, tableLocked: true, force: true }).blocks).toBe(18000);
  });
  test("GATHER AUTO: nothing when fresh, gaps only after a load, everything when stale", () => {
    expect(run({ ...flat, callOptions: "GATHER AUTO" }).blocks).toBe(0);
    const load = run({ ...flat, tableStats: "load", callOptions: "GATHER AUTO" });
    expect([load.blocks, load.columns.basic.startsWith("Kept"), load.indexes.fullScans, load.verdict[0]]).toEqual([0, true, 4, "good"]);
    expect(load.next!.input.tableStats).toBe("gathered");
    expect(run({ ...flat, tableChangePercent: 20, options: "GATHER AUTO" }).blocks).toBe(18000);
    expect(run({ ...flat, tableStats: "none", callOptions: "GATHER AUTO" }).blocks).toBe(18000);
  });
  test("a staging table gets a table-level synopsis with INCREMENTAL_LEVEL TABLE", () => {
    const o = run({ ...flat, incremental: "TRUE", incrementalLevel: "TABLE" });
    expect([o.synopsesAfter, o.globalNotes]).toEqual(["table", "HYPERLOGLOG"]);
    expect(run({ ...flat, incremental: "TRUE" }).findings.some((f) => /does nothing on a non-partitioned/.test(f.text))).toBe(true);
  });
});

// ---------------------------------------------------------------- the step list
describe("steps", () => {
  test("every outcome has the nine steps in order, eight on a plain table", () => {
    const ids = stepsOf(run(inc)).map((s) => s.id);
    expect(ids).toEqual(["resolve", "locks", "history", "read", "columns", "global", "indexes", "write", "after"]);
    expect(stepsOf(run({ partitioned: false })).map((s) => s.id)).not.toContain("global");
    const locked = stepsOf(run({ ...inc, tableLocked: true }));
    expect(locked.find((s) => s.id === "locks")!.status).toBe("stops");
    expect(locked.find((s) => s.id === "read")!.status).toBe("skips");
  });
  test("the resolve step names the sources", () => {
    const s = stepsOf(run({ ...RECOMMENDED, callEstimatePercent: 10 })).find((x) => x.id === "resolve")!;
    expect(s.text).toMatch(/ignored.*estimate_percent/);
    expect(s.text).toMatch(/preferences that differ/);
  });
});

// ---------------------------------------------------------------- column groups (extended statistics)
describe("column groups: what the table has, what the workload asks for, what creating one costs", () => {
  const flat: Partial<Input> = { partitioned: false, blocksPerPartition: 1200, numRows: 200000, columnCount: 7, newPartitions: 0 };
  const prov = { tablePrefs: null, histogramColumns: [], raw: {}, columnGroups: [], columnGroupCandidates: [
    { columns: ["CITY", "COUNTRY"], sources: ["directive", "usage"] as ("directive" | "usage")[], equality: true, ndvProduct: 500 },
    { columns: ["SALE_DATE", "STATUS"], sources: ["directive"] as ("directive" | "usage")[], equality: false, ndvProduct: 6108 },
  ] };
  test("a plain table with a candidate: a warning, CREATE_EXTENDED_STATS as a SELECT, placeholders without a paste", () => {
    const o = run({ ...flat, columnGroupCandidates: 1 });
    expect(o.findings.find((f) => f.level === "warn")?.text).toMatch(/A column set the workload filters together has no column group\./);
    expect(o.fixes).toContain("SELECT DBMS_STATS.CREATE_EXTENDED_STATS('OWNER', 'TABLE', '(<column>, <column>)') FROM dual;");
    expect(o.verdict[0]).toBe("good"); // this gather reads the same either way
    expect(verifySql(o)).toMatch(/dba_sql_plan_directives/);
    expect(verifySql(run(flat))).not.toMatch(/dba_sql_plan_directives/);
  });
  test("with the paste: names, the NDV product, the range-only directive explained, the existing group noted", () => {
    const o = advise({ ...DEFAULTS, ...flat, owner: "STATS_LAB", tableName: "CG1", columnGroupCandidates: 1, columnGroups: 1 }, true, { ...prov, columnGroups: [["STATUS", "PRODUCT_ID"]] });
    const warn = o.findings.find((f) => f.level === "warn")!.text;
    expect(warn).toMatch(/\(CITY, COUNTRY\)/);
    expect(warn).toMatch(/500 distinct combinations, fewer only if the columns are correlated/);
    expect(warn).toMatch(/SQL plan directive records/);
    expect(warn).toMatch(/SEED_COL_USAGE recorded/);
    expect(o.fixes).toContain("SELECT DBMS_STATS.CREATE_EXTENDED_STATS('STATS_LAB', 'CG1', '(CITY, COUNTRY)') FROM dual;");
    expect(o.fixes.join("\n")).toMatch(/DROP_EXTENDED_STATS\('STATS_LAB', 'CG1', '\(CITY, COUNTRY\)'\)/);
    expect(o.findings.some((f) => /\(SALE_DATE, STATUS\), but its predicates are not all equalities/.test(f.text))).toBe(true);
    expect(o.findings.some((f) => /The table has 1 column group \(STATUS, PRODUCT_ID\)/.test(f.text))).toBe(true);
  });
  test("a partitioned incremental table: the reread at the next gather (lab E4); with a locked partition the permanent full scan (lab Tc)", () => {
    const o = run({ ...inc, columnGroupCandidates: 1 });
    expect(o.findings.some((f) => f.level === "info" && /one reread of every unlocked partition at the next gather/.test(f.text))).toBe(true);
    expect(o.blocks).toBe(B); // nothing changes for this gather
    const l = run({ ...inc, columnGroupCandidates: 1, lockedPartitions: 1, lockedPartitionName: "S_2024_05" });
    expect(l.findings.some((f) => f.level === "bad" && /create the group, unlock, gather, lock again/.test(f.text))).toBe(true);
    expect(l.fixes).toContain("EXEC DBMS_STATS.UNLOCK_PARTITION_STATS('OWNER', 'TABLE', 'S_2024_05')");
  });
  test("AUTO_STAT_EXTENSIONS ON: a warning and a fix on an incremental table, a note on a plain one", () => {
    const o = run({ ...inc, autoStatExtensions: "ON" });
    expect(o.findings.some((f) => f.level === "warn" && /AUTO_STAT_EXTENSIONS is ON/.test(f.text))).toBe(true);
    expect(o.fixes).toContain("EXEC DBMS_STATS.SET_TABLE_PREFS('OWNER', 'TABLE', 'AUTO_STAT_EXTENSIONS', 'OFF')");
    const f = run({ ...flat, autoStatExtensions: "ON" });
    expect(f.findings.some((x) => x.level === "info" && /AUTO_STAT_EXTENSIONS is ON/.test(x.text))).toBe(true);
    expect(f.fixes.join("\n")).not.toMatch(/AUTO_STAT_EXTENSIONS/);
  });
  test("the extension limit: the greater of 20 and 10% of the columns", () => {
    expect(run({ ...flat, columnGroups: 20, columnGroupCandidates: 1 }).findings.some((f) => /at most 20 extensions/.test(f.text))).toBe(true);
    expect(run({ ...flat, columnCount: 300, columnGroups: 20, columnGroupCandidates: 1 }).findings.some((f) => /at most \d+ extensions/.test(f.text))).toBe(false);
  });
  test("a plain table with a column change: notes only, nothing extra read", () => {
    const g = run({ ...flat, columnChange: "group" });
    expect(g.findings.some((f) => /A column group exists but has no statistics yet/.test(f.text))).toBe(true);
    expect(g.blocks).toBe(run(flat).blocks);
    expect(run({ ...flat, columnChange: "usage" }).findings.some((f) => /considers it for a histogram/.test(f.text))).toBe(true);
    expect(run({ ...flat, columnChange: "usage", methodOpt: "repeat" }).findings.some((f) => /does not choose histograms from column usage/.test(f.text))).toBe(true);
  });
});

// ---------------------------------------------------------------- composite (subpartitioned) tables
describe("composite tables (lab J)", () => {
  const comp: Partial<Input> = { ...inc, partitions: 6, subpartitioned: true, subpartitionType: "HASH", subpartitionsPerPartition: 4, newPartitions: 0, changedPartitions: 1 };
  test("GRANULARITY AUTO gathers no subpartition statistics: DML in one subpartition rereads the whole partition", () => {
    const o = run(comp); // lab J
    expect([o.partitionsRead, o.blocks, o.global]).toEqual([1, B, "merged"]);
    const f = o.findings.find((x) => /^Composite table \(RANGE-HASH, 4 subpartitions per partition\)/.test(x.text))!;
    expect(f.text).toMatch(/no subpartition statistics/);
    expect(f.text).toMatch(/all 4 of its subpartitions are read/);
    expect(f.basis).toMatch(/lab J/);
    expect(o.findings.some((x) => /partname with a subpartition name is out of scope/.test(x.text))).toBe(true);
    const step = stepsOf(o).find((s) => s.id === "read")!;
    expect(step.text).toMatch(/Composite table: a partition read here is all of its 4 HASH subpartitions/);
    expect(step.text).toMatch(/no subpartition statistics gathered/);
    expect(verifySql(o)).toMatch(/dba_tab_subpartitions/);
  });
  test("LIST and RANGE subpartitions under AUTO are an inference, not a lab result", () => {
    const hash = run(comp);
    expect(hash.findings.some((x) => /Determines the granularity based on the partitioning type/.test(x.text))).toBe(false);
    for (const subpartitionType of ["LIST", "RANGE"] as const) {
      const o = run({ ...comp, subpartitionType });
      const w = o.findings.find((x) => x.level === "warn" && /Determines the granularity based on the partitioning type/.test(x.text))!;
      expect(w.text).toMatch(new RegExp(`For ${subpartitionType} subpartitions the advisor assumes the same as for HASH, but this is inferred`));
      expect(w.basis).toMatch(/inferred for LIST and RANGE/);
      expect(o.blocks).toBe(hash.blocks); // the read model keeps partition units
    }
  });
  test("granularity ALL and SUBPARTITION gather subpartition statistics: more tasks, the same blocks", () => {
    const all = run({ ...comp, callGranularity: "ALL" });
    expect([all.blocks, all.global]).toEqual([B, "merged"]);
    const f = all.findings.find((x) => /also gathers subpartition statistics/.test(x.text))!;
    expect(f.text).toMatch(/1 partition read is 4 subpartition gathers/);
    expect(all.findings.some((x) => /only gathers statistics for modified subpartitions/.test(x.text))).toBe(true);
    expect(stepsOf(all).find((s) => s.id === "read")!.text).toMatch(/gathered as 4 subpartition tasks/);
    const sub = run({ ...comp, callGranularity: "SUBPARTITION" });
    expect(sub.global).toBe("untouched"); // like PARTITION: inferred, the level below the table only
    expect(sub.findings.some((x) => /SUBPARTITION gathers that level only/.test(x.text))).toBe(true);
    expect(sub.fixes.join("\n")).not.toMatch(/GRANULARITY/); // the call, not the preference, asked for it
    expect(run({ ...comp, granularity: "SUBPARTITION" }).fixes.join("\n")).toMatch(/'GRANULARITY', 'AUTO'/);
    expect(run({ ...comp, incremental: "FALSE", callGranularity: "ALL" }).findings.some((x) => /every subpartition of every partition is read/.test(x.text))).toBe(true);
  });
  test("a plain table, or an unticked box, gets no composite findings", () => {
    expect(run({ ...inc }).findings.some((x) => /Composite table/.test(x.text))).toBe(false);
    expect(run({ partitioned: false, subpartitioned: true }).input.subpartitioned).toBe(false);
  });
});

// ---------------------------------------------------------------- partition exchange (lab H1-H7, V3, V3b, Tg)
describe("a partition exchanged in since the last gather", () => {
  const ex = { ...inc, exchanged: true } as Partial<Input>;
  const all3 = { exchangeTargetGathered: true, exchangeStageSynopsis: true, exchangeHistogramsMatch: true };
  test("with all three conditions the gather reads nothing and merges the global statistics (lab H5, V3, Tg)", () => {
    const o = run({ ...ex, ...all3 });
    expect([o.partitionsRead, o.blocks, o.global, o.globalNotes, o.verdict[0]]).toEqual([0, 0, "merged", "INCREMENTAL", "good"]);
    expect(o.findings.some((f) => f.level === "good" && /The exchanged partition is not read/.test(f.text))).toBe(true);
    expect(o.findings.find((f) => /The exchanged partition is not read/.test(f.text))!.basis).toMatch(/lab H5, V3, V3b, Tg/);
    expect(o.fixes.join("\n")).not.toMatch(/Exchange recipe/);
    expect(o.next!.input.exchanged).toBe(false); // consumed
    // other new partitions are still read; only the exchanged one is free
    expect(run({ ...ex, ...all3, newPartitions: 3 }).partitionsRead).toBe(2);
    expect(run({ ...ex, ...all3, newPartitions: 0, changedPartitions: 2 }).partitionsRead).toBe(1);
  });
  test("each missing condition makes the exchanged partition a reread (lab H1, H3, H6, H7)", () => {
    for (const [key, id] of [["exchangeTargetGathered", /H1, H2, H3/], ["exchangeStageSynopsis", /H3, H4, H7/], ["exchangeHistogramsMatch", /H6/]] as const) {
      const o = run({ ...ex, ...all3, [key]: false });
      expect([o.partitionsRead, o.blocks, o.verdict[0]]).toEqual([1, B, "warn"]);
      const w = o.findings.find((f) => f.level === "warn" && /The exchanged partition is read again/.test(f.text))!;
      expect(w.text).toMatch(id);
      expect(w.text).toMatch(/The new partition must have a synopsis before the exchange/);
    }
    // nothing else counted: the exchanged partition itself is read like a new one
    expect(run({ ...ex, newPartitions: 0, changedPartitions: 0 }).partitionsRead).toBe(1);
  });
  test("the fix is the V3 recipe, in order, with the names filled in", () => {
    const o = run({ ...ex, owner: "SHOP", tableName: "SALES", newPartitionName: "SALES_2025_12", methodOpt: "auto" });
    const recipe = o.fixes.filter((f) => !/^-- Exchange recipe/.test(f));
    const at = (re: RegExp) => o.fixes.findIndex((f) => re.test(f));
    expect(o.fixes.some((f) => /^-- Exchange recipe/.test(f))).toBe(true);
    expect(recipe.length).toBeGreaterThan(6);
    const order = [
      /SET_TABLE_PREFS\('SHOP', 'SALES', 'METHOD_OPT', 'FOR ALL COLUMNS SIZE AUTO'\)/,
      /SET_TABLE_PREFS\('SHOP', 'STAGING_TABLE', 'METHOD_OPT', 'FOR ALL COLUMNS SIZE AUTO'\)/,
      /SET_TABLE_PREFS\('SHOP', 'STAGING_TABLE', 'INCREMENTAL', 'TRUE'\)/,
      /SET_TABLE_PREFS\('SHOP', 'STAGING_TABLE', 'INCREMENTAL_LEVEL', 'TABLE'\)/,
      /GATHER_TABLE_STATS\('SHOP', 'SALES', partname => 'SALES_2025_12', granularity => 'PARTITION'\)/,
      /GATHER_TABLE_STATS\('SHOP', 'STAGING_TABLE'\)/,
      /ALTER TABLE SHOP\.SALES EXCHANGE PARTITION SALES_2025_12 WITH TABLE STAGING_TABLE/,
      /GATHER_TABLE_STATS\('SHOP', 'SALES'\)  --/,
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  test("without INCREMENTAL the exchange is an ordinary new or changed partition", () => {
    const o = run({ exchanged: true, ...all3 });
    const f = o.findings.find((x) => /INCREMENTAL is FALSE: there are no synopses to carry over/.test(x.text))!;
    expect(f.text).toMatch(/simply makes the partition new or changed/);
    expect(o.blocks).toBe(run({}).blocks); // the same two passes as without the exchange
    expect(o.fixes.join("\n")).not.toMatch(/Exchange recipe/);
  });
  test("a gather that runs the old way saves nothing; the job treats the exchanged partition the same way", () => {
    const old = run({ ...ex, ...all3, callEstimatePercent: 10 });
    expect(old.findings.some((x) => /prepared correctly, but the gather runs the old way/.test(x.text))).toBe(true);
    expect(old.blocks).toBe(2 * T);
    const job = run({ ...ex, ...all3, runBy: "auto", tableChangePercent: 0.5, useTableChangePercent: true });
    expect(job.partitionsRead).toBe(0);
    const jobBad = run({ ...ex, runBy: "auto", tableChangePercent: 0.5, useTableChangePercent: true });
    expect(jobBad.partitionsRead).toBe(1);
    expect(run({ ...ex, ...all3, partitioned: false }).input.exchanged).toBe(false);
  });
});

// ---------------------------------------------------------------- real-time statistics
describe("real-time statistics", () => {
  const flat: Partial<Input> = { partitioned: false, blocksPerPartition: 18000, numRows: 1000000 };
  test("findings only: the gather reads what it read, the documentation is quoted, the licence is flagged", () => {
    const base = run(flat), rt = run({ ...flat, realTimeStats: true });
    expect([rt.blocks, rt.verdict[0], rt.fixes]).toEqual([base.blocks, base.verdict[0], base.fixes]);
    const f = rt.findings.find((x) => /STATS_ON_CONVENTIONAL_DML/.test(x.text))!;
    expect(f.text).toMatch(/augment rather than replace traditional statistics/);
    expect(f.text).toMatch(/no NDV, histogram, index statistics or synopsis/);
    expect(f.basis).toMatch(/Real-Time Statistics/);
    const lic = rt.findings.find((x) => x.level === "warn" && /Table 1-8 Performance/.test(x.text))!;
    expect(lic.text).toMatch(/Available on Exadata\. Not available on Oracle Database Appliance\./);
    expect(base.findings.some((x) => /STATS_ON_CONVENTIONAL_DML/.test(x.text))).toBe(false);
    expect(verifySql(rt)).toMatch(/optimizer_real_time_statistics/);
  });
  test("partitioned: partition rows and synopses are not touched", () => {
    const o = run({ ...inc, realTimeStats: true });
    expect(o.blocks).toBe(run(inc).blocks);
    expect(o.findings.find((x) => /STATS_ON_CONVENTIONAL_DML/.test(x.text))!.text).toMatch(/partition-level statistics are not supported/);
  });
});

// ---------------------------------------------------------------- the high-frequency automatic task
describe("the high-frequency automatic task", () => {
  const flat: Partial<Input> = { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, newPartitions: 0 };
  test("modelled like the nightly job: stale tables only, STALE_PERCENT", () => {
    const stale = run({ ...flat, runBy: "hf", hfTask: "ON", tableChangePercent: 12 });
    const night = run({ ...flat, runBy: "auto", tableChangePercent: 12 });
    expect([stale.blocks, stale.auto.stale, stale.verdict[0], stale.sql.startsWith("-- The high-frequency")]).toEqual([night.blocks, true, "good", true]);
    expect(stale.resolved.find((r) => r.param === "options")!.value).toBe("GATHER AUTO");
    const fresh = run({ ...flat, runBy: "hf", hfTask: "ON", tableChangePercent: 4 });
    expect([fresh.blocks, fresh.auto.stale]).toEqual([0, false]);
    // a partitioned table: the same "global left behind" behaviour as the nightly job (inferred)
    const part = run({ ...inc, runBy: "hf", hfTask: "ON" });
    expect([part.partitionsRead, part.global]).toEqual([1, "untouched"]);
    expect(stepsOf(stale).find((s) => s.id === "resolve")!.text).toMatch(/^The high-frequency task passes no parameters/);
  });
  test("interval, run time, licence and the inferred equivalence are stated", () => {
    const o = run({ ...flat, runBy: "hf", hfTask: "ON", hfInterval: 600, hfMaxRunTime: 1800, tableChangePercent: 12 });
    const f = o.findings.find((x) => /runs every 600 seconds/.test(x.text))!;
    expect(f.text).toMatch(/144 runs a day/);
    expect(f.text).toMatch(/each run lasts at most 1,800 seconds|each run lasts at most 1800 seconds/);
    expect(f.text).toMatch(/"lightweight" and "only gathers stale statistics"/);
    expect(f.text).toMatch(/it will not execute while the maintenance window auto stats gathering job is executing/);
    const inferred = o.findings.find((x) => /models a run like the nightly job/.test(x.text))!;
    expect(inferred.basis).toMatch(/^inferred, not observed/);
    expect(inferred.text).toMatch(/AUTOSTATS_TARGET/);
    const lic = o.findings.find((x) => x.level === "warn" && /High-Frequency Automatic Optimizer Statistics Collection/.test(x.text))!;
    expect(lic.text).toMatch(/Available on Exadata\. Not available on Oracle Database Appliance\./);
    expect(verifySql(o)).toMatch(/dba_auto_stat_executions/);
  });
  test("runBy hf with the task OFF: a warning and the SET_GLOBAL_PREFS fix; ON beside another run mode: a note", () => {
    const off = run({ ...flat, runBy: "hf", tableChangePercent: 12 });
    expect(off.verdict).toEqual(["warn", "The high-frequency task is switched off"]);
    expect(off.fixes).toContain("EXEC DBMS_STATS.SET_GLOBAL_PREFS('AUTO_TASK_STATUS', 'ON')");
    const beside = run({ ...flat, hfTask: "ON", tableChangePercent: 12 });
    expect(beside.blocks).toBe(run({ ...flat, tableChangePercent: 12 }).blocks);
    expect(beside.findings.some((x) => /high-frequency task is switched on/.test(x.text))).toBe(true);
    expect(run(flat).findings.some((x) => /high-frequency/.test(x.text))).toBe(false);
  });
});

// ---------------------------------------------------------------- pending statistics
describe("pending statistics workflow", () => {
  test("PUBLISH FALSE: the test-and-publish recipe, with the verified signatures", () => {
    const o = run({ partitioned: false, publish: "FALSE", owner: "SHOP", tableName: "SALES" });
    const fx = o.fixes.join("\n");
    expect(fx).toMatch(/ALTER SESSION SET OPTIMIZER_USE_PENDING_STATISTICS = TRUE/);
    expect(fx).toMatch(/SELECT \* FROM TABLE\(DBMS_STATS\.DIFF_TABLE_STATS_IN_PENDING\('SHOP', 'SALES', NULL, 10\)\)/);
    expect(fx).toMatch(/EXEC DBMS_STATS\.PUBLISH_PENDING_STATS\('SHOP', 'SALES'\)/);
    expect(fx).toMatch(/EXEC DBMS_STATS\.DELETE_PENDING_STATS\('SHOP', 'SALES'\)/);
    expect(fx).toMatch(/'PUBLISH', 'TRUE'/);
    expect(run({ partitioned: false }).fixes.join("\n")).not.toMatch(/PENDING_STATS/);
    expect(verifySql(o)).toMatch(/dba_tab_pending_stats/);
  });
  test("pending rows left behind under INCREMENTAL: published statistics leave the synopses out of step (lab G1, Tf)", () => {
    const o = run({ ...inc, pendingStats: true });
    const w = o.findings.find((x) => x.level === "warn" && /Pending statistics exist for the table/.test(x.text))!;
    expect(w.text).toMatch(/gathered without synopses/);
    expect(w.text).toMatch(/leaves the global NOTES blank and the next gather reads every partition again/);
    expect(w.basis).toMatch(/G1, G1c, Tf/);
    expect(o.fixes.join("\n")).toMatch(/DELETE_PENDING_STATS\('OWNER', 'TABLE'\)/);
    expect(o.verdict[0]).toBe("warn");
    expect(o.blocks).toBe(run(inc).blocks);
    const plain = run({ partitioned: false, pendingStats: true });
    expect(plain.findings.find((x) => /Pending statistics exist/.test(x.text))!.text).not.toMatch(/INCREMENTAL/);
    expect(verifySql(plain)).toMatch(/dba_tab_pending_stats/);
  });
});

// ---------------------------------------------------------------- statistics from a bulk load
describe("online statistics from a bulk load (STATS_ON_LOAD)", () => {
  const load: Partial<Input> = { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, indexCount: 2, localIndexCount: 0, tableStats: "load" };
  test("the restrictions are quoted and the gather-AUTO fix is offered after a plain gather", () => {
    const o = run(load);
    const f = o.findings.find((x) => /STATS_ON_LOAD/.test(x.text) && /online statistics gathering/.test(x.text))!;
    for (const q of ["INSERT INTO ... SELECT using a direct path insert, and CREATE TABLE AS SELECT", "Bulk loads only gather online statistics automatically when the object is empty", "has a PUBLISH preference set to FALSE", "Its statistics are locked", "the database does not automatically create histograms"]) expect(f.text).toContain(q);
    expect(f.basis).toMatch(/Online Statistics Gathering for Bulk Loads/);
    expect(o.blocks).toBe(18000); // a plain GATHER rereads the table
    expect(o.fixes).toContain("EXEC DBMS_STATS.GATHER_TABLE_STATS('OWNER', 'TABLE', options => 'GATHER AUTO')");
    expect(o.fixes).toContain("EXEC DBMS_STATS.SET_TABLE_PREFS('OWNER', 'TABLE', 'OPTIONS', 'GATHER AUTO')");
    expect(o.verdict[0]).toBe("good");
    const auto = run({ ...load, callOptions: "GATHER AUTO" });
    expect(auto.blocks).toBe(0);
    expect(auto.fixes.join("\n")).not.toMatch(/options => 'GATHER AUTO'/);
    expect(auto.findings.find((x) => /load left table and basic column statistics/.test(x.text))!.basis).toMatch(/does not gather table and basic column statistics collected during the bulk load/);
  });
  test("a locked table: ORA-20005 unless force, and no online statistics under a lock; PUBLISH FALSE gathers none either", () => {
    const o = run({ ...load, tableLocked: true });
    expect([o.error, o.blocks]).toEqual(["ORA-20005", 0]);
    expect(o.findings.some((x) => x.level === "warn" && /gathers no online statistics \(a documented restriction\)/.test(x.text))).toBe(true);
    expect(o.fixes.indexOf("EXEC DBMS_STATS.UNLOCK_TABLE_STATS('OWNER', 'TABLE')")).toBeLessThan(o.fixes.findIndex((f) => /options => 'GATHER AUTO'/.test(f)));
    expect(run({ ...load, tableLocked: true, force: true }).error).toBeNull();
    expect(run({ ...load, publish: "FALSE" }).findings.some((x) => /PUBLISH is FALSE, and a bulk load gathers no online statistics/.test(x.text))).toBe(true);
  });
  test("partitioned: global statistics from the insert, partition statistics and a synopsis with partition-extended syntax", () => {
    const o = run({ ...inc, tableStats: "load" });
    const f = o.findings.find((x) => /On a partitioned table/.test(x.text))!;
    expect(f.text).toMatch(/the database does not gather partition-level statistics/);
    expect(f.text).toMatch(/also gathers a synopsis/);
    expect(o.blocks).toBe(B); // not modelled: the read count is the form's
  });
});
