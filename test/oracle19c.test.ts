import { describe, expect, test } from "vitest";
import { DEFAULTS, advise, clampInput, decodeInput, encodeInput, parsePrefs, setupScripts, type Input } from "../src/model";

const run = (input: Partial<Input>) => advise({ ...DEFAULTS, ...input });
const job: Partial<Input> = { runBy: "auto", incremental: "TRUE", synopses: "all", newPartitions: 0 };

describe("Oracle 19c documented semantics and collector integration", () => {
  test("literal NULL staleness survives parsing and rollback without enabling mixed formats", () => {
    for (const text of [
      "TABLE_PREFS = INCREMENTAL_STALENESS\nINCREMENTAL_STALENESS = NULL",
      "EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP','SALES','INCREMENTAL_STALENESS','NULL')",
    ]) {
      const parsed = parsePrefs(text);
      expect(parsed.values.allowMixedFormat).toBe(false);
      const before = { ...DEFAULTS, ...parsed.values, owner: "SHOP", tableName: "SALES" };
      expect(setupScripts(before, parsed.provenance).rollback).toContain("'INCREMENTAL_STALENESS', 'NULL')");
    }
    const reset = parsePrefs("EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP','SALES','INCREMENTAL_STALENESS',NULL)");
    expect(reset.values.allowMixedFormat).toBe(true);
  });

  test("one partition and percentages above 100 are valid", () => {
    const parsed = parsePrefs("PARTITIONS = 1\nSTALE_PERCENT = 200\nCHANGE_PERCENT = 500\nTABLE_CHANGE_PERCENT = 1500");
    expect(parsed.ignored).toEqual([]);
    const { input } = clampInput(parsed.values);
    expect([input.partitions, input.stalePercent, input.changePercent, input.tableChangePercent]).toEqual([1, 200, 500, 1500]);
  });

  test("collected global DML counters decide staleness independently of partition counts", () => {
    const stale = run({ ...job, ...parsePrefs("TABLE_CHANGE_PERCENT = 15").values });
    expect(stale.auto.stale).toBe(true);
    expect(stale.global).toBe("merged");
    const fresh = run({ ...job, newPartitions: 5, ...parsePrefs("TABLE_CHANGE_PERCENT = 0.01").values });
    expect(fresh.auto.stale).toBe(false);
    expect(fresh.global).toBe("untouched");
    expect(fresh.next!.input.tableChangePercent).toBe(0.01);
    expect(decodeInput(encodeInput(fresh.input))).toMatchObject({ useTableChangePercent: true, tableChangePercent: 0.01 });
  });

  test("an automatic no-op neither gathers indexes nor publishes statistics, even with the override", () => {
    for (const incremental of ["TRUE", "FALSE"] as const) {
      for (const overrides of ["TRUE", "FALSE"] as const) {
        const o = run({ ...job, incremental, overrides });
        expect(o.blocks).toBe(0);
        expect(o.indexes.fullScans).toBe(0);
        expect(o.write.destination).toBe("nothing");
        expect(o.resolved.find((r) => r.param === "options")!.value).toBe("GATHER AUTO");
      }
    }
  });

  test("a first incremental global refresh builds unlocked synopses and merges without a second full scan", () => {
    const o = run({ ...job, synopses: "none", tableStats: "none" });
    expect(o.partitionsRead).toBe(DEFAULTS.partitions);
    expect(o.read.globalScan).toBe(0);
    expect(o.global).toBe("merged");
    expect(o.next!.write.destination).toBe("nothing");
  });

  test("pending gathers do not make published statistics fresh for the next automatic job", () => {
    const o = run({ partitioned: false, runBy: "auto", publish: "FALSE", tableChangePercent: 20 });
    expect(o.next!.input.tableChangePercent).toBe(20);
    expect(o.next!.write.destination).toBe("pending");
    const missing = run({ partitioned: false, runBy: "auto", publish: "FALSE", tableStats: "none" });
    expect(missing.next!.input.tableStats).toBe("none");
  });

  test("GATHER AUTO must refresh basic load statistics if subsequent DML made them stale", () => {
    const o = run({ partitioned: false, tableStats: "load", tableChangePercent: 20, callOptions: "GATHER AUTO" });
    expect(o.blocks).toBe(DEFAULTS.blocksPerPartition);
    expect(o.columns.basic).not.toMatch(/^Kept/);
  });

  test("100 percent is full computation; fixed estimates and pending gathers do not build staging synopses", () => {
    const full = run({ partitioned: false, callEstimatePercent: 100 });
    expect(full.scan.kind).toBe("full");
    expect(full.columns.ndv).toMatch(/all rows/);
    expect(full.columns.ndv).not.toMatch(/Scaled up/);
    for (const overrides of [{ estimatePercent: 10 }, { publish: "FALSE" }] as Partial<Input>[]) {
      const stage = run({ partitioned: false, incremental: "TRUE", incrementalLevel: "TABLE", ...overrides });
      expect(stage.synopsesAfter).not.toBe("table");
    }
  });

  test("non-incremental GLOBAL granularity scans the table without gathering each partition", () => {
    const o = run({ granularity: "GLOBAL" });
    expect(o.partitionsRead).toBe(0);
    expect(o.read.globalScan).toBe(DEFAULTS.partitions);
    expect(o.blocks).toBe(DEFAULTS.partitions * DEFAULTS.blocksPerPartition);
  });

  test("long calls use a PL/SQL block and the report preserves supported parameters", () => {
    const o = run({ owner: "SHOP", tableName: "SALES", partname: "new", newPartitionName: "P_2026",
      callGranularity: "PARTITION", callEstimatePercent: 10, callBlockSample: true, callCascade: "FALSE",
      callNoInvalidate: "FALSE", force: true, callOptions: "GATHER AUTO" });
    expect(o.sql).toMatch(/^BEGIN\n  DBMS_STATS.GATHER_TABLE_STATS/);
    expect(o.sql).toMatch(/\);\nEND;\n\/$/);
    for (const arg of ["partname => 'P_2026'", "granularity => 'PARTITION'", "estimate_percent => 10", "block_sample => TRUE", "cascade => FALSE", "no_invalidate => FALSE", "force => TRUE"]) {
      expect(o.dryRun).toContain(arg);
    }
    expect(o.dryRun).toContain("VARIABLE advisor_report CLOB");
    expect(o.dryRun).toContain("no OPTIONS parameter");
    expect(o.dryRun).not.toContain("options =>");
  });
});
