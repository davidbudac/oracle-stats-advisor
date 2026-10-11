import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { emptyDetail, parseDetail, parsePrefs, toTime, health } from "../src/model";
import { DEFAULTS } from "../src/model";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/collect-${name}.txt`, import.meta.url), "utf8");
const detailOf = (name: string) => {
  const p = parsePrefs(fixture(name));
  expect(p.detail).not.toBeNull();
  return { p, d: p.detail! };
};

// Real outputs of sql/collect.sql on the 19.27 lab (PDB1). The spot values were checked in the database with
// separate queries: clustering factors and leaf blocks in DBA_IND_STATISTICS, histogram types in
// DBA_TAB_COL_STATISTICS, DBA_TAB_STATS_HISTORY row count, partition counts in DBA_TAB_STATISTICS and
// DBA_TAB_SUBPARTITIONS, the DATE low value against DUMP(low_value) = 120,124,9,1,1,2,13.
describe("parseDetail: ORASTATS_TEST.ORDERS (plain table, four indexes)", () => {
  const { p, d } = detailOf("orastats_test-orders");

  test("scalars", () => {
    expect(d.version).toBe(1);
    expect(d.dbVersion).toBe("19.27.0.0.0");
    expect(d.lastAnalyzed).toBe("2026-09-26 14:54:46");
    expect(d.rowsChanged).toBe(0);
    expect(d.rowsTruncated).toBe(false);
    expect(d.staleStats).toBe(false);
    expect(d.subpartitioning).toBeNull();
    expect(d.historyRows).toBe(15); // SELECT COUNT(*) FROM dba_tab_stats_history
    expect(d.retentionDays).toBe(31);
    expect(d.optimizerUsePendingStatistics).toBe(false);
    expect(d.realtimeStatsParam).toBe(false);
    expect(d.autoTaskStatus).toBe("OFF");
    expect(d.autoTaskInterval).toBe(900);
    expect(d.autoTaskMaxRunTime).toBe(3600);
    expect(d.autostatsTarget).toBe("AUTO");
    expect(d.autotaskStatus).toBe("ENABLED");
    expect(d.uniqueColumns).toEqual(["ORDER_ID"]);
    expect(d.fbiExpressions).toEqual([]);
    expect(d.expressionCandidates).toEqual([]);
    expect(d.columnUsageCollected).toBe(true);
    expect(d.partitionsOmitted).toBeNull();
    expect(d.sysauxOptstatMb).toBeGreaterThan(0);
    expect(toTime(d.collectedAt)).not.toBeNull();
  });

  test("columns", () => {
    expect(d.columns).toHaveLength(11);
    const channel = d.columns.find((c) => c.name === "CHANNEL")!;
    expect(channel).toMatchObject({ dataType: "VARCHAR2", histogram: "FREQUENCY", numBuckets: 3, numDistinct: 3, nullable: false, inIndex: false, isExtension: false });
    const date = d.columns.find((c) => c.name === "ORDER_DATE")!;
    expect(date).toMatchObject({ dataType: "DATE", low: "2024-09-01 00:01:12", high: "2026-08-31 23:59:25", usage: ["RANGE"], inIndex: true });
    expect(d.columns.find((c) => c.name === "CUSTOMER_ID")!.usage).toEqual(["EQ", "EQUIJOIN"]);
    expect(d.columns.find((c) => c.name === "PROMO_CODE")).toMatchObject({ nullable: true, numNulls: 570252, usage: ["EQ", "NULL"] });
    expect(d.columns.find((c) => c.name === "AMOUNT")).toMatchObject({ low: "1.14", high: "5205.69" });
    expect(d.columns.find((c) => c.name === "STATUS")).toMatchObject({ low: "CANCELLED", high: "SHIPPED" });
    expect(d.columns.find((c) => c.name === "ORDER_ID")!.density).toBeCloseTo(1 / 600000, 12);
  });

  test("indexes", () => {
    expect(d.indexes.map((i) => i.name)).toEqual(["ORDERS_CUSTOMER_IX", "ORDERS_ORDER_DATE_IX", "ORDERS_PK", "ORDERS_STATUS_IX"]);
    expect(d.indexes[0]).toMatchObject({ clusteringFactor: 599338, leafBlocks: 2597, distinctKeys: 50532, blevel: 2, numRows: 600000, columns: ["CUSTOMER_ID"], uniqueness: "NONUNIQUE", partitioned: false, locality: null, staleStats: false, locked: false, status: "VALID", visibility: "VISIBLE", totalExecCount: 345 });
    expect(d.indexes[2]).toMatchObject({ name: "ORDERS_PK", uniqueness: "UNIQUE", clusteringFactor: 5356, totalAccessCount: null, lastUsed: null });
  });

  test("history, windows, runs", () => {
    expect(d.history).toHaveLength(12);
    const gather = d.history.find((h) => h.opid === 3163)!;
    expect(gather).toMatchObject({ operation: "gather_table_stats", status: "COMPLETED", targetType: "TABLE", partitionsGathered: 0, globalGathered: true, indexesGathered: 4, targetSize: 6166, histogramColumns: ["STATUS", "CHANNEL"] });
    expect(d.history.find((h) => h.opid === 3162)).toMatchObject({ operation: "create_extended_stats", partitionsGathered: null, globalGathered: null, indexesGathered: null });
    expect(d.history[0]!.opid).toBeGreaterThan(d.history[11]!.opid); // newest first
    expect(d.windows).toHaveLength(7);
    expect(d.windows[2]).toMatchObject({ name: "MONDAY_WINDOW", duration: "+000 04:00:00", enabled: true });
    expect(d.autoruns).toHaveLength(7);
    expect(d.autoruns[0]).toMatchObject({ jobStatus: "SUCCEEDED" });
    expect(d.hfruns).toHaveLength(7);
    expect(d.hfruns[0]).toMatchObject({ origin: "AUTO_TASK", status: "COMPLETED" });
    expect(d.partitions).toEqual([]);
  });

  test("nothing in the fixture is left unread", () => {
    expect(p.detailIgnored).toEqual([]);
    expect(p.ignored).toEqual([]);
  });

  test("the form side reads the new INPUT keys", () => {
    expect(p.values).toMatchObject({ subpartitioned: false, realTimeStats: false, pendingStats: false, hfTask: "OFF", hfInterval: 900, hfMaxRunTime: 3600 });
  });
});

describe("parseDetail: STATS_LAB.SALES (range partitioned, incremental, one column group)", () => {
  const { d } = detailOf("stats_lab-sales");
  test("partitions and extension", () => {
    expect(d.partitions).toHaveLength(54);
    expect(d.partitions[0]).toMatchObject({ position: 1, synopsis: "HLL", locked: false });
    expect(d.partitions.every((x) => x.rowsChanged === 0)).toBe(true);
    expect(d.subpartitioning).toBe("NONE");
    expect(d.extensions).toHaveLength(1);
    expect(d.extensions[0]).toMatchObject({ text: '("STATUS","PRODUCT_ID")', kind: "group", hasStats: true, numDistinct: 19815, used: false });
    const ext = d.columns.find((c) => c.isExtension)!;
    expect(ext).toMatchObject({ dataType: null, numDistinct: 19815, low: null, high: null });
    expect(d.columns.find((c) => c.name === "SALE_DATE")).toMatchObject({ histogram: "HYBRID", numBuckets: 254, notes: "INCREMENTAL HIST_FOR_INCREM_STATS", high: "2028-06-28 00:00:00" });
    const prod = d.indexes.find((i) => i.name === "SALES_PROD_IX")!;
    expect(prod).toMatchObject({ partitioned: true, locality: "LOCAL", status: "N/A", clusteringFactor: 1547028 });
    expect(d.indexes.find((i) => i.name === "SALES_ID_IX")!.staleStats).toBe(true);
    expect(d.history.some((h) => h.operation === "gather_table_stats" && h.globalGathered === true && h.histogramColumns.includes("SALE_DATE"))).toBe(true);
  });
});

describe("parseDetail: STATS_LAB.C1 (range-hash composite)", () => {
  const { p, d } = detailOf("stats_lab-c1");
  test("subpartition scalars", () => {
    expect(d.subpartitioning).toBe("HASH");
    expect(d.subpartitions).toBe(24); // COUNT(*) FROM dba_tab_subpartitions
    expect(d.partitions).toHaveLength(6);
    expect(d.columnUsageCollected).toBe(true);
    expect(d.columns.every((c) => c.usage.length === 0)).toBe(true); // no usage recorded: a report without column lines
  });
  test("DML on subpartitions is rolled up and the initial load is not counted", () => {
    // DBA_TAB_MODIFICATIONS has only subpartition rows for C1, all stamped no later than the gather
    expect(d.partitions.every((x) => x.rowsChanged === 0)).toBe(true);
    expect(d.rowsChanged).toBe(0);
    expect(p.values).toMatchObject({ subpartitioned: true, subpartitionType: "HASH", subpartitionsPerPartition: 4, partitions: 6, changedPartitions: 0, tableChangePercent: 0 });
  });
});

describe("parseDetail: STATS_LAB.CG1 (plain, column groups)", () => {
  const { d } = detailOf("stats_lab-cg1");
  test("groups, one of them new", () => {
    expect(d.extensions.map((e) => e.name)).toHaveLength(2);
    const fresh = d.extensions.find((e) => !e.hasStats)!;
    expect(fresh).toMatchObject({ text: '("PRODUCT_ID","STATUS")', kind: "group", numDistinct: null, histogram: null, used: true });
    expect(d.extensions.find((e) => e.hasStats)).toMatchObject({ text: '("CITY","COUNTRY")', numDistinct: 50, used: true });
    const row = d.columns.find((c) => c.name === fresh.name)!;
    expect(row.usage).toEqual(["FILTER"]);
    expect(d.columns.find((c) => c.name === "CITY")).toMatchObject({ histogram: "FREQUENCY", usage: ["EQ"] });
    expect(d.columns.find((c) => c.name === "SALE_DATE")).toMatchObject({ low: "2026-01-01 00:00:00", high: "2026-09-27 00:00:00", usage: ["RANGE"] });
  });
});

describe("parseDetail: ORASTATS_TEST.EXPR_PRED (expression statistics)", () => {
  const { d } = detailOf("orastats_test-expr_pred");
  test("six expression extensions", () => {
    expect(d.extensions).toHaveLength(6);
    expect(d.extensions.every((e) => e.kind === "expression" && e.hasStats && e.used === true)).toBe(true);
    expect(d.extensions.map((e) => e.text).sort()).toEqual(['(SUBSTR("C_E",1,2))', '(SUBSTR("C_H",1,2))', '(TRUNC("D_E"))', '(TRUNC("D_H"))', '(UPPER("T_E"))', '(UPPER("T_H"))']);
    const upper = d.extensions.find((e) => e.text === '(UPPER("T_H"))')!;
    expect(upper).toMatchObject({ histogram: "FREQUENCY", numDistinct: 60 });
    expect(d.columns.find((c) => c.name === upper.name)).toMatchObject({ dataType: null, numBuckets: 60, usage: ["EQ", "RANGE", "NULL"], low: "CITY01", high: "CITY60" });
    expect(d.columns.find((c) => c.name === "D_N")).toMatchObject({ usage: ["NULL"], high: "2025-06-29 23:59:11" });
  });
});

describe("parseDetail: robustness", () => {
  const block = (...body: string[]) => ["-- ADVISOR DETAIL BEGIN", ...body, "-- ADVISOR DETAIL END"];

  test("no block: null, and old pastes still parse", () => {
    expect(parseDetail(["OWNER = X"]).detail).toBeNull();
    const old = parsePrefs(readFileSync(new URL("./fixtures/collect-e1.txt", import.meta.url), "utf8"));
    expect(old.detail).toBeNull();
    expect(old.detailIgnored).toEqual([]);
    expect(old.values.owner).toBe("STATS_LAB");
  });

  test("malformed lines are ignored with a reason and the rest is read", () => {
    const r = parseDetail(block(
      "ROWS_CHANGED = twelve",
      "STALE_STATS = maybe",
      "COLUMN = A|NUMBER|N",
      "COLUMN = |NUMBER|N|1|0|1|NONE|1|.5|2||||||N",
      "COLUMN = B|NUMBER|N|many|0|1|NONE|1|.5|2||||||N",
      "INDEX = IX|UNIQUE|NORMAL|N||A|1|1|1|1|1||Y|N|VALID|VISIBLE|||",
      "PARTITION = P1|1|10|1||N|N|0|WEIRD",
      "NO_SUCH_KEY = 1",
      "just words",
      "RETENTION_DAYS = 31",
    ));
    expect(r.detail!.retentionDays).toBe(31);
    expect(r.detail!.indexes).toHaveLength(1);
    expect(r.detail!.columns).toEqual([]);
    expect(r.detail!.partitions).toEqual([]);
    expect(r.detail!.rowsChanged).toBeNull();
    expect(r.ignored.map((i) => i.reason)).toEqual([
      "value is not a number", "value is not Y or N", "expected 16 fields, found 3", "name is empty", "num_distinct is not a number",
      "synopsis is not HLL, OLD or NONE", "unknown key", "not a KEY = value line",
    ]);
  });

  test("SQL*Plus errors, comments, blanks and a comma decimal are tolerated", () => {
    const r = parseDetail(block(
      "ORA-00942: table or view does not exist",
      "ERROR at line 3:",
      "SELECT x",
      "",
      "-- a comment",
      "SYSAUX_OPTSTAT_MB = 150,7",
      "UNIQUE_COLUMNS = A,B",
      "FBI_EXPRESSIONS = UPPER(\"X\");SYS_EXTRACT_UTC(\"Y\")",
      "COLUMN_USAGE_COLLECTED = N",
    ));
    expect(r.ignored).toEqual([]);
    expect(r.detail).toMatchObject({ sysauxOptstatMb: 150.7, uniqueColumns: ["A", "B"], fbiExpressions: ['UPPER("X")', 'SYS_EXTRACT_UTC("Y")'], columnUsageCollected: false });
  });

  test("a missing END line reads to the end; empty fields mean unknown, not zero", () => {
    const r = parseDetail(["-- ADVISOR DETAIL BEGIN", "COLUMN = A|||||||||||||||", "HFRUN = |||||||"]);
    expect(r.ignored).toEqual([]);
    expect(r.detail!.columns[0]).toMatchObject({ name: "A", numDistinct: null, numNulls: null, usage: [], inIndex: null });
    expect(r.detail!.hfruns[0]).toMatchObject({ opid: null, completed: null });
  });

  test("garbage never throws", () => {
    const junk = ["-- ADVISOR DETAIL BEGIN", "=", "= =", "A=", "COLUMN =", "COLUMN = |||||||||||||||||||||||", "\u0000\u0001", "x".repeat(100000), "INDEX = " + "|".repeat(40)];
    expect(() => parseDetail(junk)).not.toThrow();
    expect(emptyDetail().columns).toEqual([]);
  });

  test("the form is not confused by the detail block", () => {
    const p = parsePrefs(["SOMETHING", ...block("COLUMN = A|NUMBER|N|1|0|1|NONE|1|.5|2||||||N", "INCREMENTAL = TRUE")].join("\n"));
    expect(p.values.incremental).toBeUndefined();
    expect(p.detail).not.toBeNull();
  });
});

describe("health scaffold", () => {
  test("every section id reports either a section or a skip reason", () => {
    const r = health({ ...DEFAULTS }, emptyDetail(), null);
    expect(r.sections.length + r.skipped.length).toBe(11);
    expect(r.collectedAt).toBeNull();
    for (const line of r.skipped) expect(line).toMatch(/^[a-z]+: .+/);
  });
});
