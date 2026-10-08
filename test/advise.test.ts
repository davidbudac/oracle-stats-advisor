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
