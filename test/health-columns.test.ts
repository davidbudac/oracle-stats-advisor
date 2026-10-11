import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DEFAULTS, clampInput, emptyDetail, emptyProvenance, parsePrefs, type ColumnRec, type Detail, type ExtensionRec, type IndexRec, type Input, type Provenance } from "../src/model";
import { extendedSection, histogramsSection, indexesSection, pinnedColumns, qualitySection } from "../src/model/health/columns";
import type { HealthContext, HealthSection } from "../src/model/health";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/collect-${name}.txt`, import.meta.url), "utf8");
/** A real collector output as the page reads it: the form values over the defaults, the DETAIL block and the provenance. */
function load(name: string, override: Partial<Input> = {}): HealthContext {
  const p = parsePrefs(fixture(name));
  expect(p.detail).not.toBeNull();
  return { input: clampInput({ ...p.values, ...override }).input, detail: p.detail!, prov: p.provenance };
}
const texts = (s: HealthSection | null, level?: string) => (s?.findings ?? []).filter((f) => !level || f.level === level).map((f) => f.text);
const find = (s: HealthSection | null, re: RegExp) => (s?.findings ?? []).find((f) => re.test(f.text));
const levels = (s: HealthSection | null) => (s?.findings ?? []).map((f) => f.level);

// ---- synthetic rows
const col = (name: string, o: Partial<ColumnRec> = {}): ColumnRec => ({
  name, dataType: "NUMBER", nullable: true, numDistinct: 100, numNulls: 0, numBuckets: 1, histogram: "NONE", sampleSize: 1000, density: 0.01, avgColLen: 4,
  lastAnalyzed: "2026-10-01 12:00:00", notes: null, low: null, high: null, usage: [], inIndex: false, isExtension: false, ...o,
});
const idx = (name: string, o: Partial<IndexRec> = {}): IndexRec => ({
  name, uniqueness: "NONUNIQUE", indexType: "NORMAL", partitioned: false, locality: null, columns: ["A"], blevel: 2, leafBlocks: 100, distinctKeys: 1000, clusteringFactor: 400,
  numRows: 1000, lastAnalyzed: "2026-10-01 00:00:00", staleStats: false, locked: false, status: "VALID", visibility: "VISIBLE", totalAccessCount: 5, totalExecCount: 5, lastUsed: "2026-10-05 10:00:00", ...o,
});
const ext = (name: string, text: string, o: Partial<ExtensionRec> = {}): ExtensionRec => ({
  name, text, kind: /^\(\s*"[^"]+"(\s*,\s*"[^"]+")+\s*\)$/.test(text) ? "group" : "expression", hasStats: true, numDistinct: 50, histogram: "NONE", used: true, ...o,
});
/** A 1,000-row plain table with the given detail parts; usage was collected unless told otherwise. */
function ctx(d: Partial<Detail> = {}, i: Partial<Input> = {}, prov: Provenance | null = null): HealthContext {
  const detail: Detail = { ...emptyDetail(), columnUsageCollected: true, lastAnalyzed: "2026-10-01 12:00:00", rowsChanged: 0, ...d };
  const input = clampInput({ ...DEFAULTS, partitioned: false, partitions: 1, numRows: 1000, blocksPerPartition: 50, columnCount: 6, indexCount: detail.indexes.length, owner: "APP", tableName: "T", methodOpt: "auto", cascade: "AUTO_CASCADE", incremental: "FALSE", ...i }).input;
  return { input, detail, prov };
}

describe("not collected: every section says so", () => {
  test("an empty detail returns null", () => {
    const c = ctx({ columns: [] }, { indexCount: 3 });
    expect(histogramsSection(c)).toBeNull();
    expect(extendedSection(c)).toBeNull();
    expect(qualitySection(c)).toBeNull();
    expect(indexesSection(c)).toBeNull(); // the form says 3 indexes, the block carries none
  });
  test("a table without indexes is a section of its own", () => {
    expect(indexesSection(ctx({ columns: [col("A")] }, { indexCount: 0 }))?.summary).toMatch(/no indexes/);
  });
});

describe("ORASTATS_TEST.ORDERS (plain, METHOD_OPT SIZE 1, four indexes)", () => {
  const c = load("orastats_test-orders");
  test("histograms: the CHANNEL histogram nobody uses goes at the next gather; used columns get no histogram under SIZE 1", () => {
    const s = histogramsSection(c)!;
    expect(s.rows!.body).toHaveLength(1);
    expect(s.rows!.body[0]).toEqual(["CHANNEL", "FREQUENCY", "3", "3", "600,000 (100%)", "none recorded"]);
    const f = find(s, /CHANNEL has a histogram but no recorded filter or join/)!;
    expect(f.level).toBe("info");
    expect(f.text).toMatch(/METHOD_OPT is SIZE 1, so the next gather deletes it\.$/);
    expect(find(s, /CUSTOMER_ID, STATUS.*no histogram.*METHOD_OPT is SIZE 1/)).toBeDefined();
    expect(levels(s)).not.toContain("warn");
  });
  test("indexes: ORDERS_CUSTOMER_IX is scattered (clustering factor 599,338 of 600,000 rows)", () => {
    const s = indexesSection(c)!;
    expect(s.rows!.body.map((r) => r[0])).toEqual(["ORDERS_CUSTOMER_IX", "ORDERS_ORDER_DATE_IX", "ORDERS_PK", "ORDERS_STATUS_IX"]);
    expect(s.rows!.body[0]![4]).toBe("599,338 (scattered)");
    expect(s.rows!.body[1]![4]).toBe("5,364 (well ordered)");
    const f = find(s, /ORDERS_CUSTOMER_IX \(clustering factor 599,338 of 600,000 rows/)!;
    expect(f.level).toBe("info");
    expect(f.basis).toMatch(/close to the number of rows indicates that the rows are scattered/);
    expect(find(s, /ORDERS_ORDER_DATE_IX/ )).toBeDefined();
  });
  test("indexes: TABLE_CACHED_BLOCKS is part of the scattered finding, for the index that is used, and states no range", () => {
    const s = indexesSection(c)!;
    const f = find(s, /TABLE_CACHED_BLOCKS/)!;
    expect(f.text).toMatch(/^ORDERS_CUSTOMER_IX \(clustering factor 599,338/);
    expect(f.text).toMatch(/TABLE_CACHED_BLOCKS \(now 1\) is the number of blocks the gather assumes cached/);
    expect(f.text).not.toMatch(/\b255\b|0\.\.|range of|AUTO value/); // the 19c page names no range or default
    expect(f.fix).toContain("EXEC DBMS_STATS.SET_TABLE_PREFS('ORASTATS_TEST', 'ORDERS', 'TABLE_CACHED_BLOCKS', '16')");
    expect(f.basis).toMatch(/Specifies the average number of blocks assumed to be cached/);
    expect(f.basis).toMatch(/gives no range or default/);
    expect(s.findings.filter((x) => /ORDERS_CUSTOMER_IX/.test(x.text))).toHaveLength(1); // one finding per index, not two
  });
  test("indexes: no recorded use is context, never a drop; the primary key is only mentioned", () => {
    const f = find(indexesSection(c)!, /^No recorded use/)!;
    expect(f.level).toBe("info"); // DBA_INDEX_USAGE is sampled
    expect(f.text).toMatch(/ORDERS_ORDER_DATE_IX, ORDERS_STATUS_IX\./);
    expect(f.text).toMatch(/ORDERS_PK is unique and serves a constraint/);
    expect(f.text).toMatch(/sampled by default and flushed every 15 minutes/);
    expect(f.fix).toEqual([
      "ALTER INDEX ORASTATS_TEST.ORDERS_ORDER_DATE_IX INVISIBLE;", "-- undo: ALTER INDEX ORASTATS_TEST.ORDERS_ORDER_DATE_IX VISIBLE;",
      "ALTER INDEX ORASTATS_TEST.ORDERS_STATUS_IX INVISIBLE;", "-- undo: ALTER INDEX ORASTATS_TEST.ORDERS_STATUS_IX VISIBLE;",
    ]);
    expect(f.fix!.join("\n")).not.toMatch(/DROP INDEX/i);
  });
  test("indexes: AUTO_CASCADE gathers all four, 7,085 leaf blocks against about 6,272 table blocks", () => {
    const f = find(indexesSection(c)!, /CASCADE is AUTO_CASCADE/)!;
    expect(f.level).toBe("info");
    expect(f.text).toMatch(/also gathers 4 indexes: 7,085 leaf blocks against about 6,272 table blocks/);
    expect(f.basis).toMatch(/enable the database to determine whether index statistics need to be collected/);
  });
  test("extended: the column set a directive and SEED_COL_USAGE both named is evidence, not a second CREATE", () => {
    const s = extendedSection(c)!;
    const f = find(s, /^\(SHIP_CITY, SHIP_COUNTRY\)/)!;
    expect(f.text).toMatch(/directive.*SEED_COL_USAGE/);
    expect(f.text).toMatch(/multiply to 2,000.*between 200 .* and 2,000/);
    expect(f.fix).toBeUndefined();
    expect(s.rows!.body).toEqual([["(SHIP_CITY, SHIP_COUNTRY)", "group, proposed", "–", "–", "–", "directive + usage"]]);
  });
  test("quality: nothing wrong", () => {
    expect(levels(qualitySection(c))).toEqual(["good"]);
  });
});

describe("ORASTATS_TEST.EXPR_PRED (six expression extensions)", () => {
  const p = parsePrefs(fixture("orastats_test-expr_pred"));
  test("the collector no longer counts expressions as column groups", () => {
    expect(p.values.columnGroups).toBe(0);
    expect(p.provenance.columnGroups).toEqual([]);
  });
  const c = load("orastats_test-expr_pred");
  test("extended: the expressions are listed by their text and none is flagged", () => {
    const s = extendedSection(c)!;
    expect(s.rows!.body.map((r) => r[0]).sort()).toEqual(['(SUBSTR("C_E",1,2))', '(SUBSTR("C_H",1,2))', '(TRUNC("D_E"))', '(TRUNC("D_H"))', '(UPPER("T_E"))', '(UPPER("T_H"))']);
    expect(s.rows!.body.every((r) => r[1] === "expression" && r[2] === "yes" && r[5] === "yes")).toBe(true);
    expect(levels(s)).not.toContain("warn");
    expect(levels(s)).toContain("good");
    expect(s.summary).toMatch(/0 column groups, 6 expression extensions/);
    // groups never appear: no usage-recorded column group, so the SEED_COL_USAGE recipe is offered
    expect(find(s, /SEED_COL_USAGE/)!.fix).toContain("EXEC DBMS_STATS.SEED_COL_USAGE(NULL, NULL, 900)");
  });
  test("histograms: expression histograms carry the extension text", () => {
    const s = histogramsSection(c)!;
    expect(s.rows!.body.map((r) => r[0]).sort()).toEqual(['(SUBSTR("C_H",1,2))', '(TRUNC("D_H"))', '(UPPER("T_H"))']);
    expect(find(s, /FREQUENCY histogram from all rows, one bucket per value/)!.level).toBe("good");
  });
});

describe("STATS_LAB.CG1 (plain, two column groups, one without statistics)", () => {
  const c = load("stats_lab-cg1");
  test("the group without statistics is reported; the correlated one is explained by its NDV", () => {
    const s = extendedSection(c)!;
    expect(s.rows!.body.find((r) => r[0] === "(PRODUCT_ID, STATUS)")!.slice(1)).toEqual(["group", "none yet", "–", "–", "yes"]);
    const f = find(s, /^\(PRODUCT_ID, STATUS\) has no statistics yet/)!;
    expect(f.level).toBe("info"); // plain table: nothing is reread
    expect(f.text).toMatch(/the next gather computes it/);
    expect(find(s, /^\(CITY, COUNTRY\): 50 distinct combinations against 500 for independent columns \(10 times fewer\)/)).toBeDefined();
    const cand = find(s, /^\(CITY, COUNTRY, STATUS\)/)!;
    expect(cand.text).toMatch(/SEED_COL_USAGE recorded them filtered together/);
    expect(cand.text).toMatch(/between 50 .* and 1,000/);
    expect(levels(s)).not.toContain("warn");
    expect(find(s, /SEED_COL_USAGE records the column groups/)).toBeUndefined(); // usage evidence exists: no recipe
  });
});

describe("STATS_LAB.SALES (partitioned, incremental, one group, two indexes)", () => {
  const c = load("stats_lab-sales");
  test("histograms: four HIST_FOR_INCREM_STATS histograms are left alone, nothing is called unused", () => {
    const s = histogramsSection(c)!;
    const f = find(s, /only supports the global statistics/)!;
    expect(f.level).toBe("info");
    expect(f.text).toMatch(/^SALE_DATE, PRODUCT_ID, CUSTOMER_ID, AMOUNT have a histogram/);
    expect(f.text).toMatch(/naming them makes them real histograms and rereads every partition/);
    // the NOTES value is documented on the partition-column page of the Reference, not on the table-column page
    expect(f.basis).toMatch(/ALL_PART_COL_STATISTICS\.NOTES.*A histogram used to support incremental statistics has been created and it is not used for optimization/);
    expect(s.rows!.body[0]![1]).toBe("HYBRID (support only)");
    expect(levels(s)).not.toContain("warn");
  });
  test("extended: the group's NDV is within 2.4% of the independent product: one finding, not two", () => {
    const s = extendedSection(c)!;
    expect(find(s, /is not in REPORT_COL_USAGE/)).toBeUndefined(); // folded into the finding below
    const dup = find(s, /^\(STATUS, PRODUCT_ID\): 19,815 distinct combinations against 19,340 for the columns alone/)!;
    expect(dup.level).toBe("warn");
    expect(dup.text).toMatch(/Both NDVs are approximate/);
    expect(dup.text).toMatch(/Confirm with SEED_COL_USAGE before dropping it/);
    expect(dup.fix).toContain("EXEC DBMS_STATS.DROP_EXTENDED_STATS('STATS_LAB', 'SALES', '(\"STATUS\",\"PRODUCT_ID\")')");
    expect(find(s, /^\(SALE_DATE, STATUS\).*not with equality predicates only/)).toBeDefined();
  });
  test("indexes: CASCADE is FALSE here, so the stale global index is refreshed by hand", () => {
    const s = indexesSection(c)!;
    const f = find(s, /flagged stale/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/SALES_ID_IX counts 1,085,700 rows against the table's 1,630,200/);
    expect(f.fix).toContain("EXEC DBMS_STATS.GATHER_INDEX_STATS('STATS_LAB', 'SALES_ID_IX')");
    expect(find(s, /CASCADE is FALSE, so a gather of the table does no index work/)).toBeDefined();
  });
  test("indexes: with AUTO_CASCADE the local and the global index are both named", () => {
    const s = indexesSection(load("stats_lab-sales", { cascade: "AUTO_CASCADE" }))!;
    const f = find(s, /CASCADE is AUTO_CASCADE/)!;
    expect(f.text).toMatch(/also gathers 2 indexes: 6,690 leaf blocks against about 13,824 table blocks/);
    expect(f.text).toMatch(/On an incremental table a global index needs a full index scan \(SALES_ID_IX\)/);
    expect(f.text).toMatch(/SALES_PROD_IX is local: the modified index partitions are scanned and, in the lab, the whole local index too/);
    expect(f.basis).toMatch(/lab F2, F3/);
    expect(f.level).toBe("info");
  });
  test("indexes: the local index is scattered; the estimate of table blocks is partitions x blocks per partition", () => {
    const s = indexesSection(c)!;
    expect(s.rows!.body.find((r) => r[0] === "SALES_PROD_IX")![1]).toBe("non-unique, local");
    expect(find(s, /SALES_PROD_IX \(clustering factor 1,547,028 of 1,600,200 rows, 13,824 table blocks\)/)).toBeDefined();
  });
});

describe("STATS_LAB.C1 (no usage recorded, no indexes)", () => {
  const c = load("stats_lab-c1");
  test("no histograms and no usage: SIZE AUTO builds none", () => {
    const s = histogramsSection(c)!;
    expect(s.summary).toBe("No histograms.");
    expect(find(s, /No column has a recorded predicate use, so SIZE AUTO builds no histogram/)).toBeDefined();
    expect(s.rows).toBeUndefined();
  });
  test("the SEED_COL_USAGE recipe uses the table's owner and name", () => {
    const f = find(extendedSection(c)!, /SEED_COL_USAGE records the column groups/)!;
    expect(f.fix).toContain("SELECT DBMS_STATS.REPORT_COL_USAGE('STATS_LAB', 'C1') FROM dual;");
    expect(f.fix!.some((l) => l.startsWith("SELECT DBMS_STATS.CREATE_EXTENDED_STATS('STATS_LAB', 'C1') FROM dual;"))).toBe(true);
    expect(f.basis).toMatch(/second form of this function creates statistics extensions based on the column group usage recorded/);
  });
});

describe("histograms: edge rules", () => {
  const unusedHist = [col("FLAG", { histogram: "FREQUENCY", numBuckets: 2, numDistinct: 2, usage: [] }), col("OTHER", { usage: ["EQ"] })];
  test("a histogram nobody filters on: warn with a REPEAT / SIZE 1 call", () => {
    const f = find(histogramsSection(ctx({ columns: unusedHist }))!, /^FLAG has a histogram but no recorded filter or join uses it/)!;
    expect(f.level).toBe("warn");
    expect(f.fix).toEqual(["-- REPEAT keeps the other histograms, SIZE 1 deletes this one", "EXEC DBMS_STATS.GATHER_TABLE_STATS('APP', 'T', method_opt => 'FOR ALL COLUMNS SIZE REPEAT FOR COLUMNS SIZE 1 FLAG')"]);
    expect(f.basis).toMatch(/do not query the table, then the database does not create histograms/);
  });
  test("SKEWONLY would bring it back: the fix changes the preference", () => {
    const f = find(histogramsSection(ctx({ columns: unusedHist }, { methodOpt: "skewonly" }))!, /FLAG has a histogram/)!;
    expect(f.level).toBe("warn");
    expect(f.fix![0]).toBe("EXEC DBMS_STATS.SET_TABLE_PREFS('APP', 'T', 'METHOD_OPT', 'FOR ALL COLUMNS SIZE AUTO')");
  });
  test("a pinned list may have chosen it on purpose: info", () => {
    expect(find(histogramsSection(ctx({ columns: unusedHist }, { methodOpt: "pinned" }))!, /FLAG has a histogram/)!.level).toBe("info");
  });
  test("a support histogram is never called unused", () => {
    const s = histogramsSection(ctx({ columns: [col("P", { histogram: "HYBRID", numBuckets: 254, numDistinct: 900, notes: "INCREMENTAL HIST_FOR_INCREM_STATS" })] }, { partitioned: true, partitions: 4, incremental: "TRUE" }))!;
    expect(texts(s, "warn")).toEqual([]);
    expect(texts(s, "info")[0]).toMatch(/P has a histogram that only supports/);
  });
  test("usage that was not collected is said, and no histogram is judged", () => {
    const s = histogramsSection(ctx({ columnUsageCollected: false, columns: unusedHist }))!;
    expect(find(s, /REPORT_COL_USAGE was not readable/)!.basis).toMatch(/SYSDBA administrative privilege or both ANALYZE ANY DICTIONARY and ANALYZE ANY/);
    expect(find(s, /FLAG has a histogram but/)).toBeUndefined();
  });
  test("HEIGHT BALANCED is legacy: warn, and AUTO_SAMPLE_SIZE is the fix when the preference is a fixed percent", () => {
    const columns = [col("D", { histogram: "HEIGHT BALANCED", numBuckets: 254, numDistinct: 5000, usage: ["RANGE"] })];
    const fixed = find(histogramsSection(ctx({ columns }, { estimatePercent: 10 }))!, /HEIGHT BALANCED/)!;
    expect(fixed.level).toBe("warn");
    expect(fixed.text).toMatch(/ESTIMATE_PERCENT is 10 percent here/);
    expect(fixed.fix).toEqual(["EXEC DBMS_STATS.SET_TABLE_PREFS('APP', 'T', 'ESTIMATE_PERCENT', 'DBMS_STATS.AUTO_SAMPLE_SIZE')"]);
    expect(fixed.basis).toMatch(/set to AUTO_SAMPLE_SIZE/);
    const auto = find(histogramsSection(ctx({ columns }, { estimatePercent: "auto" }))!, /HEIGHT BALANCED/)!;
    expect(auto.fix).toBeUndefined();
    expect(auto.text).toMatch(/already is AUTO_SAMPLE_SIZE/);
  });
  test("a HYBRID histogram from a sample is normal under AUTO_SAMPLE_SIZE: shown in the table, not a finding", () => {
    const columns = [col("H", { histogram: "HYBRID", numBuckets: 254, numDistinct: 5000, sampleSize: 300, usage: ["EQ"] })];
    const s = histogramsSection(ctx({ columns }))!;
    expect(find(s, /sample/)).toBeUndefined();
    expect(s.rows!.body[0]![4]).toBe("300 (30%)");
  });
  test("254 buckets for more distinct values and equality use: SIZE 2048 is an option, written as a comment", () => {
    const columns = [col("K", { histogram: "HYBRID", numBuckets: 254, numDistinct: 4000, usage: ["EQ"] })];
    const f = find(histogramsSection(ctx({ columns }))!, /more distinct values than buckets/)!;
    expect(f.level).toBe("info");
    expect(f.fix).toEqual(["-- an option, not a recommendation", "-- EXEC DBMS_STATS.SET_TABLE_PREFS('APP', 'T', 'METHOD_OPT', 'FOR ALL COLUMNS SIZE AUTO FOR COLUMNS SIZE 2048 K')"]);
    expect(f.basis).toMatch(/Must be in the range \[1,2048\]/);
  });
  test("a frequency histogram with one bucket per value is exact", () => {
    const f = find(histogramsSection(ctx({ columns: [col("S", { histogram: "FREQUENCY", numBuckets: 4, numDistinct: 4, usage: ["EQ"] })] }))!, /one bucket per value/)!;
    expect(f.level).toBe("good");
    // built from a sample (a fixed ESTIMATE_PERCENT earlier): not exact
    expect(find(histogramsSection(ctx({ columns: [col("S", { histogram: "FREQUENCY", numBuckets: 4, numDistinct: 4, sampleSize: 100, usage: ["EQ"] })] }))!, /one bucket per value/)).toBeUndefined();
  });
  test("a used column without a histogram: the next SIZE AUTO gather may build one, and on an incremental table it rereads", () => {
    const columns = [col("C", { usage: ["EQ"], numDistinct: 40 })];
    expect(find(histogramsSection(ctx({ columns }))!, /^C is filtered on/)!.text).not.toMatch(/rereads every partition/);
    const inc = find(histogramsSection(ctx({ columns }, { partitioned: true, partitions: 8, incremental: "TRUE" }))!, /^C is filtered on/)!;
    expect(inc.text).toMatch(/rereads every partition/);
    expect(inc.basis).toMatch(/lab E1, E3i/);
    // unique or constant columns are not candidates
    expect(histogramsSection(ctx({ columns: [col("U", { usage: ["EQ"], numDistinct: 1000 }), col("Z", { usage: ["EQ"], numDistinct: 1 })] }))!.findings.some((f) => /filtered on/.test(f.text))).toBe(false);
  });
  test("SIZE 1 deletes a histogram the workload uses; a pinned list that leaves one out does the same", () => {
    const columns = [col("USED", { histogram: "FREQUENCY", numBuckets: 3, numDistinct: 3, usage: ["EQ"] })];
    const one = find(histogramsSection(ctx({ columns }, { methodOpt: "size1" }, { ...emptyProvenance(), histogramColumns: ["USED"] }))!, /METHOD_OPT is FOR ALL COLUMNS SIZE 1, but USED/)!;
    expect(one.level).toBe("warn");
    expect(one.fix).toEqual(["EXEC DBMS_STATS.SET_TABLE_PREFS('APP', 'T', 'METHOD_OPT', 'FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 USED')"]);
    const prov = { ...emptyProvenance(), raw: { METHOD_OPT: "FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 STATUS, CHANNEL" } };
    const pinned = find(histogramsSection(ctx({ columns }, { methodOpt: "pinned" }, prov))!, /METHOD_OPT pins STATUS, CHANNEL, but USED/)!;
    expect(pinned.level).toBe("warn");
    expect(pinned.basis).toMatch(/lab E6/);
    expect(find(histogramsSection(ctx({ columns }, { methodOpt: "pinned" }, { ...emptyProvenance(), raw: { METHOD_OPT: "FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 USED" } }))!, /METHOD_OPT pins/)).toBeUndefined();
  });
  test("pinnedColumns reads FOR COLUMNS clauses", () => {
    expect(pinnedColumns("FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 STATUS, \"channel\"")).toEqual(["STATUS", "CHANNEL"]);
    expect(pinnedColumns("FOR ALL COLUMNS SIZE AUTO")).toBeNull();
    expect(pinnedColumns("FOR COLUMNS A SIZE 10 B SIZE AUTO")).toEqual(["A", "B"]);
  });
  test("owner and table fall back to placeholders and quotes are doubled", () => {
    const f = find(histogramsSection(ctx({ columns: unusedHist }, { owner: "", tableName: "" }))!, /FLAG has a histogram/)!;
    expect(f.fix![1]).toContain("GATHER_TABLE_STATS('OWNER', 'TABLE'");
    const q = find(histogramsSection(ctx({ columns: unusedHist }, { owner: "O'NEIL" }))!, /FLAG has a histogram/)!;
    expect(q.fix![1]).toContain("GATHER_TABLE_STATS('O''NEIL', 'T'");
  });
});

describe("extended statistics: edge rules", () => {
  const base = [col("A"), col("B")];
  const group = (o: Partial<ExtensionRec> = {}) => ext("SYS_STU1", '("A","B")', o);
  test("a group no recorded SEED_COL_USAGE run mentions is only an info; with other groups recorded it is a warning and a drop", () => {
    const quiet = extendedSection(ctx({ columns: base, extensions: [group({ used: false })] }))!;
    expect(find(quiet, /is not in REPORT_COL_USAGE/)!.level).toBe("info");
    const seeded = extendedSection(ctx({ columns: base, extensions: [group({ used: false }), ext("SYS_STU2", '("A","C")', { used: true }), ext("SYS_STU3", '("B","C")', { used: true })] }))!;
    const f = find(seeded, /^\(A, B\): no recorded use/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/confirm over a representative workload before dropping it/);
    expect(f.fix).toContain("EXEC DBMS_STATS.DROP_EXTENDED_STATS('APP', 'T', '(\"A\",\"B\")')");
    expect(f.basis).toMatch(/This procedure deletes the recorded column \(group\) usage information/);
  });
  test("a group without statistics on an incremental table is a warning: it rereads every partition", () => {
    const c = ctx({ columns: base, extensions: [group({ hasStats: false, numDistinct: null })] }, { partitioned: true, partitions: 6, incremental: "TRUE" });
    const f = find(extendedSection(c)!, /has no statistics yet/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/rereads every unlocked partition/);
  });
  test("an expression extension no predicate uses is a warning; one a function-based index already carries is redundant", () => {
    const e1 = ext("SYS_STU4", '(UPPER("T_N"))', { used: false });
    const e2 = ext("SYS_STU5", '(LOWER("T_N"))', { used: true });
    const s = extendedSection(ctx({ columns: base, extensions: [e1, e2], fbiExpressions: ['LOWER("T_N")'] }))!;
    const unusedExpr = find(s, /^\(UPPER\("T_N"\)\): no predicate on this expression/)!;
    expect(unusedExpr.level).toBe("info"); // no timestamp: the extension may be younger than the workload
    expect(unusedExpr.fix![0]).toMatch(/SEED_COL_USAGE does not record expressions/);
    const red = find(s, /^\(LOWER\("T_N"\)\) may be redundant/)!;
    expect(red.level).toBe("info");
    expect(red.basis).toMatch(/unless a function-based index exists/);
    expect(red.fix).toEqual(["EXEC DBMS_STATS.DROP_EXTENDED_STATS('APP', 'T', '(LOWER(\"T_N\"))')"]);
  });
  test("expression candidates: CREATE_EXTENDED_STATS per new one, none for an existing extension or index expression", () => {
    const c = ctx({
      columns: base, extensions: [ext("SYS_STU6", '(UPPER("T_N"))')], fbiExpressions: ['TRUNC("D")'],
      expressionCandidates: ['UPPER("T_N")', ' trunc( "D" ) ', 'SUBSTR("C",1,2)', "TO_CHAR(\"D\",'YYYY')"],
    });
    const s = extendedSection(c)!;
    const f = find(s, /expressions in cached plans filter on/)!;
    expect(f.level).toBe("info");
    expect(f.text).toMatch(/weak evidence/);
    expect(f.text).toMatch(/Each counts toward the limit of 20/);
    expect(f.fix).toEqual([
      "SELECT DBMS_STATS.CREATE_EXTENDED_STATS('APP', 'T', '(SUBSTR(\"C\",1,2))') FROM dual;",
      "SELECT DBMS_STATS.CREATE_EXTENDED_STATS('APP', 'T', '(TO_CHAR(\"D\",''YYYY''))') FROM dual;",
    ]);
    expect(s.rows!.body.filter((r) => r[1] === "expression, proposed")).toHaveLength(2);
  });
  test("a column group candidate with a range directive is not a group case", () => {
    const prov: Provenance = { ...emptyProvenance(), columnGroupCandidates: [{ columns: ["A", "B"], sources: ["directive"], equality: false, ndvProduct: 10000 }] };
    const s = extendedSection(ctx({ columns: base }, {}, prov))!;
    expect(find(s, /not with equality predicates only/)!.level).toBe("info");
    expect(s.rows).toBeUndefined();
  });
  test("the limit: the greater of 20 and 10% of the columns, counting existing plus proposed", () => {
    const exts = Array.from({ length: 18 }, (_, i) => ext(`SYS_STUX${i}`, `("A","C${i}")`, { used: true }));
    const prov: Provenance = { ...emptyProvenance(), columnGroupCandidates: Array.from({ length: 3 }, (_, i) => ({ columns: ["A", `Z${i}`], sources: ["usage" as const], equality: true, ndvProduct: 50 })) };
    const over = extendedSection(ctx({ columns: base, extensions: exts }, { columnCount: 6 }, prov))!;
    const f = find(over, /against a limit of 20/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/18 extensions and 3 more are proposed.*greater of 20 and 10% of its 6 columns/);
    expect(f.basis).toMatch(/maximum of \(20, 10% of number of non-virtual columns in the table\)/);
    // 400 columns raise the limit to 40
    expect(find(extendedSection(ctx({ columns: base, extensions: exts }, { columnCount: 400 }, prov))!, /against a limit/)).toBeUndefined();
    // already at the limit
    const full = extendedSection(ctx({ columns: base, extensions: [...exts, ext("S1", '("A","Q1")'), ext("S2", '("A","Q2")')] }))!;
    expect(find(full, /the limit of 20/)!.level).toBe("warn");
  });
  test("usage that was not collected: the recipe names the privilege and the REPORT_COL_USAGE call", () => {
    const f = find(extendedSection(ctx({ columnUsageCollected: false, columns: base }))!, /REPORT_COL_USAGE was not readable/)!;
    expect(f.fix![0]).toMatch(/SET LONG/);
    expect(f.basis).toMatch(/ANALYZE ANY and ANALYZE ANY DICTIONARY/);
  });
});

describe("indexes: edge rules", () => {
  const cols = [col("A"), col("B")];
  test("an unusable index is bad; one without statistics warns; invisible and locked are context", () => {
    const s = indexesSection(ctx({ columns: cols, indexes: [
      idx("IX_BAD", { status: "UNUSABLE" }),
      idx("IX_NEW", { numRows: null, lastAnalyzed: null, clusteringFactor: null, leafBlocks: null }),
      idx("IX_HID", { visibility: "INVISIBLE" }),
      idx("IX_LOCK", { locked: true }),
    ] }))!;
    expect(find(s, /^IX_BAD is UNUSABLE/)!.level).toBe("bad");
    expect(find(s, /^IX_BAD is UNUSABLE/)!.fix).toEqual(["ALTER INDEX APP.IX_BAD REBUILD;"]);
    expect(find(s, /^IX_NEW has no statistics/)!.level).toBe("warn");
    expect(find(s, /^IX_HID is INVISIBLE/)!.level).toBe("info");
    expect(find(s, /^IX_LOCK has locked statistics/)!.level).toBe("info");
  });
  test("a unique index with no use is not a candidate; a table of nothing but those gets an info line", () => {
    const s = indexesSection(ctx({ columns: cols, indexes: [idx("PK", { uniqueness: "UNIQUE", totalAccessCount: null, totalExecCount: null, lastUsed: null }), idx("IX", { totalAccessCount: 0, totalExecCount: 0, lastUsed: null })] }))!;
    expect(find(s, /^No recorded use: IX\./)!.level).toBe("info");
    expect(find(s, /^No recorded use/)!.text).toMatch(/PK is unique and serves a constraint/);
    // an index with a last-used date counts as used even when the access counter says 0
    expect(find(indexesSection(ctx({ columns: cols, indexes: [idx("IX", { totalAccessCount: 0, totalExecCount: 12, lastUsed: "2026-09-26 14:56:54" })] }))!, /No recorded use/)).toBeUndefined();
  });
  test("no usage row anywhere is weaker evidence: info", () => {
    const none = { totalAccessCount: null, totalExecCount: null, lastUsed: null };
    const f = find(indexesSection(ctx({ columns: cols, indexes: [idx("I1", none), idx("I2", none)] }))!, /DBA_INDEX_USAGE has no row for any index/)!;
    expect(f.level).toBe("info");
  });
  test("a clustering factor in between or well ordered is not flagged; a unique scattered index is not either", () => {
    const s = indexesSection(ctx({ columns: cols, indexes: [idx("OK", { clusteringFactor: 60 }), idx("MID", { clusteringFactor: 500 }), idx("UQ", { uniqueness: "UNIQUE", clusteringFactor: 999 })] }, { blocksPerPartition: 50 }))!;
    expect(find(s, /clustering factor/)).toBeUndefined();
    expect(s.rows!.body.map((r) => r[4])).toEqual(["60 (well ordered)", "500 (in between)", "999 (scattered)"]);
  });
  test("TABLE_CACHED_BLOCKS is not offered for an index no query used", () => {
    const s = indexesSection(ctx({ columns: cols, indexes: [idx("IX", { clusteringFactor: 990, totalAccessCount: null, totalExecCount: null, lastUsed: null })] }))!;
    expect(find(s, /TABLE_CACHED_BLOCKS/)).toBeUndefined();
  });
  test("a leading prefix of a longer index is noted", () => {
    const s = indexesSection(ctx({ columns: cols, indexes: [idx("IX_A", { columns: ["A"] }), idx("IX_AB", { columns: ["A", "B"] })] }))!;
    expect(find(s, /^IX_A \(A\) is a leading prefix of IX_AB \(A, B\)/)).toBeDefined();
  });
  test("CASCADE TRUE says the same as AUTO_CASCADE; FALSE does no index work", () => {
    const indexes = [idx("IX", { leafBlocks: 10 })];
    expect(find(indexesSection(ctx({ columns: cols, indexes }, { cascade: "TRUE" }))!, /CASCADE is TRUE, so a gather of the table also gathers 1 index/)).toBeDefined();
    expect(find(indexesSection(ctx({ columns: cols, indexes }, { cascade: "FALSE" }))!, /CASCADE is FALSE/)!.level).toBe("info");
    expect(find(indexesSection(ctx({ columns: cols, indexes }, { cascade: "AUTO_CASCADE" }))!, /AUTO_CASCADE/)!.level).toBe("info"); // 10 leaf blocks against 50 table blocks
  });
  test("everything fine and a cheap gather: no warning", () => {
    const s = indexesSection(ctx({ columns: cols, indexes: [idx("IX", { leafBlocks: 5 })] }))!;
    expect(levels(s)).not.toContain("warn");
    expect(levels(s)).toContain("good");
  });
});

describe("statistics quality: edge rules", () => {
  test("a unique column whose NDV is off by more than 10% is flagged", () => {
    const columns = [col("ID", { numDistinct: 600, numNulls: 0 }), col("OK", { numDistinct: 980 })];
    const c = ctx({ columns, uniqueColumns: ["ID", "OK"], rowsChanged: 400 });
    const f = find(qualitySection(c)!, /^ID \(NDV 600, 1,000 non-null rows\)/)!;
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/400 rows changed since the gather/);
    expect(f.text).not.toMatch(/OK \(/);
    expect(f.fix).toEqual(["EXEC DBMS_STATS.GATHER_TABLE_STATS('APP', 'T')"]);
  });
  test("more nulls than rows, or more values than rows, are impossible", () => {
    const s = qualitySection(ctx({ columns: [col("N", { numNulls: 1500 }), col("V", { numDistinct: 5000 })] }))!;
    expect(find(s, /^N \(1,500 nulls\): more nulls than the table has rows/)!.level).toBe("bad");
    expect(find(s, /^V \(NDV 5,000\): more distinct values than non-null rows/)!.level).toBe("warn"); // NDVs are approximate
  });
  test("density has to be 1/NDV without a histogram", () => {
    const s = qualitySection(ctx({ columns: [col("D", { numDistinct: 100, density: 0.05 }), col("H", { numDistinct: 100, density: 0.5, histogram: "FREQUENCY" })] }))!;
    const f = find(s, /without a histogram the density equals 1\/NDV/)!;
    expect(f.text).toMatch(/^D \(density 0.0500, 1\/NDV 0.0100\)/);
    expect(f.text).not.toMatch(/H \(/);
    expect(f.basis).toMatch(/1 \/ NUM_DISTINCT/);
  });
  test("partitions whose statistics say 0 rows but took DML are bad, and named", () => {
    const partitions = [
      { name: "P1", position: 1, numRows: 500, blocks: 5, lastAnalyzed: null, staleStats: false, locked: false, rowsChanged: 0, synopsis: "HLL" as const },
      { name: "P2", position: 2, numRows: 0, blocks: 0, lastAnalyzed: null, staleStats: false, locked: false, rowsChanged: 300, synopsis: "HLL" as const },
    ];
    const f = find(qualitySection(ctx({ columns: [col("A")], zeroRowPartitionsWithDml: 1, partitions }, { partitioned: true, partitions: 2, incremental: "TRUE" }))!, /statistics that say 0 rows/)!;
    expect(f.level).toBe("bad");
    expect(f.text).toMatch(/P2 \(300 rows changed\)/);
    expect(f.text).toMatch(/COPY_TABLE_STATS/);
    expect(f.fix![0]).toBe("EXEC DBMS_STATS.GATHER_TABLE_STATS('APP', 'T', partname => 'P2', granularity => 'PARTITION')");
    expect(f.fix!.join("\n")).toMatch(/plain gather: it reads nothing more/);
    // a plain table of the same kind: no partition list, a table gather
    const plain = find(qualitySection(ctx({ columns: [col("A")], zeroRowPartitionsWithDml: 2 }))!, /2 partitions have statistics/)!;
    expect(plain.fix).toEqual(["EXEC DBMS_STATS.GATHER_TABLE_STATS('APP', 'T')"]);
  });
  test("a date column whose high value is not later than the gather, with rows changed since, is out of range", () => {
    const d = col("ORDER_DATE", { dataType: "DATE", high: "2026-09-30 23:59:59", inIndex: true });
    const warn = find(qualitySection(ctx({ columns: [d], rowsChanged: 50 }))!, /^ORDER_DATE \(high value 2026-09-30\)/)!;
    expect(warn.level).toBe("info"); // 5% changed, the table is not stale
    expect(warn.text).toMatch(/above HIGH_VALUE/);
    expect(warn.basis).toMatch(/inferred/);
    expect(find(qualitySection(ctx({ columns: [d], rowsChanged: 200 }))!, /^ORDER_DATE \(high value/)!.level).toBe("warn"); // past STALE_PERCENT
    // a date that ends months before the gather is not an ever-growing column; under 1% changed is not worth a note
    expect(find(qualitySection(ctx({ columns: [col("ORDER_DATE", { dataType: "DATE", high: "2026-03-01 00:00:00", inIndex: true })], rowsChanged: 200 }))!, /high value/)).toBeUndefined();
    expect(find(qualitySection(ctx({ columns: [d], rowsChanged: 5 }))!, /high value/)).toBeUndefined();
    // no DML since: nothing to say; a high value in the future: nothing either
    expect(find(qualitySection(ctx({ columns: [d], rowsChanged: 0 }))!, /high value/)).toBeUndefined();
    expect(find(qualitySection(ctx({ columns: [col("ORDER_DATE", { dataType: "DATE", high: "2030-01-01 00:00:00", inIndex: true })], rowsChanged: 50 }))!, /high value/)).toBeUndefined();
    // a date column that is neither indexed nor named like a date is left alone
    expect(find(qualitySection(ctx({ columns: [col("X1", { dataType: "DATE", high: "2026-09-30 00:00:00", inIndex: false })], rowsChanged: 50 }))!, /high value/)).toBeUndefined();
  });
  test("an indexed near-unique key column gets a softer note", () => {
    const f = find(qualitySection(ctx({ columns: [col("ORDER_ID", { numDistinct: 1000, high: "1000", inIndex: true })], rowsChanged: 20 }))!, /^ORDER_ID \(high value 1000\)/)!;
    expect(f.level).toBe("info");
  });
  test("columns without statistics, and columns the last gather did not cover", () => {
    const s = qualitySection(ctx({ columns: [
      col("NEW", { lastAnalyzed: null, numDistinct: null, numNulls: null, density: null, sampleSize: null }),
      col("OLD", { lastAnalyzed: "2026-09-01 00:00:00" }),
      col("FRESH", { lastAnalyzed: "2026-10-01 11:59:00" }),
    ] }))!;
    expect(find(s, /^NEW has no column statistics/)!.level).toBe("warn");
    const old = find(s, /^OLD \(2026-09-01\)/)!;
    expect(old.level).toBe("info");
    expect(old.basis).toMatch(/lab E5/);
    expect(find(s, /FRESH \(/)).toBeUndefined();
  });
  test("a sample under half the rows although ESTIMATE_PERCENT is AUTO_SAMPLE_SIZE", () => {
    const f = find(qualitySection(ctx({ columns: [col("S", { sampleSize: 100 })] }, { estimatePercent: "auto" }))!, /^S \(100 of 1,000 rows\)/)!;
    expect(f.level).toBe("info");
    expect(find(qualitySection(ctx({ columns: [col("S", { sampleSize: 100 })] }, { estimatePercent: 10 }))!, /sampled on well under half/)).toBeUndefined();
  });
  test("a clean table gets one good finding", () => {
    expect(levels(qualitySection(ctx({ columns: [col("A", { numDistinct: 10, density: 0.1, sampleSize: 1000 })] }))!)).toEqual(["good"]);
  });
});

describe("ORASTATS_TEST.EXPR_PRED with a cached plan (first positive expression candidates and a directive candidate)", () => {
  const c = load("orastats_test-expr_pred-cached");
  test("the two expressions of the cached plan are proposed, as comments on weak evidence, with valid SQL*Plus", () => {
    expect(c.detail.expressionCandidates).toEqual(['SUBSTR("C_N",1,3)', 'UPPER("T_N")']);
    const s = extendedSection(c)!;
    const f = find(s, /expressions in cached plans filter on SUBSTR\("C_N",1,3\), UPPER\("T_N"\)/)!;
    expect(f.level).toBe("info");
    expect(f.text).toMatch(/One cached statement is weak evidence/);
    expect(f.fix).toEqual([
      "SELECT DBMS_STATS.CREATE_EXTENDED_STATS('ORASTATS_TEST', 'EXPR_PRED', '(SUBSTR(\"C_N\",1,3))') FROM dual;",
      "SELECT DBMS_STATS.CREATE_EXTENDED_STATS('ORASTATS_TEST', 'EXPR_PRED', '(UPPER(\"T_N\"))') FROM dual;",
    ]);
    expect(s.rows!.body.filter((r) => r[1] === "expression, proposed").map((r) => r[0])).toEqual(['(SUBSTR("C_N",1,3))', '(UPPER("T_N"))']);
    expect(s.summary).toMatch(/3 proposed/);
  });
  test("the directive candidate (C_N, T_N) is evidence only: nested to independent between 92,120 and 100,000", () => {
    const f = find(extendedSection(c)!, /^\(C_N, T_N\)/)!;
    expect(f.text).toMatch(/a SQL plan directive recorded a misestimate on them together, with equality predicates/);
    expect(f.text).toMatch(/multiply to 16,581,600; the true number of combinations lies between 92,120 \(nested columns\) and 100,000 \(independent columns\)/);
    expect(f.fix).toBeUndefined();
  });
});

describe("generated SQL is valid SQL*Plus", () => {
  // SQL*Plus passes a trailing -- comment on to the server: EXEC x -- c ends in BEGIN x -- c; END; and SELECT ...; -- c fails (checked on 19.27)
  test("no fix line carries a trailing comment, on any fixture", () => {
    for (const name of ["orastats_test-expr_pred", "orastats_test-expr_pred-cached", "orastats_test-orders", "stats_lab-c1", "stats_lab-cg1", "stats_lab-sales"]) {
      const c = load(name);
      for (const sec of [histogramsSection(c), extendedSection(c), indexesSection(c), qualitySection(c)]) {
        for (const f of sec?.findings ?? []) for (const line of f.fix ?? []) expect(line.startsWith("--") || !/\s--\s/.test(line), `${name}: ${line}`).toBe(true);
      }
    }
  });
});

describe("extended statistics: more rules", () => {
  const base = [col("A"), col("B")];
  test("a function-based index's hidden column (SYS_NC...) is neither an unused nor a redundant extension", () => {
    const hidden = ext("SYS_NC00017$", 'LOWER("A")', { used: false });
    const s = extendedSection(ctx({ columns: base, extensions: [hidden], fbiExpressions: ['LOWER("A")'] }))!;
    expect(s.summary).toMatch(/0 column groups, 0 expression extensions/);
    expect(find(s, /LOWER/)).toBeUndefined();
  });
  test("a group without statistics is never called independent; one with a ratio of 1.5 or more is correlated", () => {
    const nd = [col("A", { numDistinct: 10 }), col("B", { numDistinct: 10 })];
    const none = extendedSection(ctx({ columns: nd, extensions: [ext("SYS_STU1", '("A","B")', { hasStats: false, numDistinct: null })] }))!;
    expect(find(none, /independent/)).toBeUndefined();
    const indep = extendedSection(ctx({ columns: nd, extensions: [ext("SYS_STU1", '("A","B")', { numDistinct: 99 })] }, { numRows: 100000 }))!;
    expect(find(indep, /^\(A, B\): 99 distinct combinations against 100/)!.level).toBe("warn");
    const corr = extendedSection(ctx({ columns: nd, extensions: [ext("SYS_STU1", '("A","B")', { numDistinct: 20 })] }, { numRows: 100000 }))!;
    expect(find(corr, /^\(A, B\): 20 distinct combinations against 100 for independent columns \(5 times fewer\)/)!.level).toBe("info");
  });
});

describe("indexes: more rules", () => {
  const cols = [col("A"), col("B")];
  test("an index that is already invisible is not told to become invisible again", () => {
    const f = find(indexesSection(ctx({ columns: cols, indexes: [idx("IX", { visibility: "INVISIBLE", totalAccessCount: null, totalExecCount: null, lastUsed: null }), idx("IY", { totalAccessCount: null, totalExecCount: null, lastUsed: null })] }))!, /^DBA_INDEX_USAGE has no row/)!;
    expect(f.fix).toEqual(["ALTER INDEX APP.IY INVISIBLE;", "-- undo: ALTER INDEX APP.IY VISIBLE;"]);
    expect(f.text).toMatch(/IX is already invisible/);
  });
  test("a prefix is not reported across index kinds or localities", () => {
    const s = indexesSection(ctx({ columns: cols, indexes: [idx("IX_A", { columns: ["A"], locality: "LOCAL" }), idx("IX_AB", { columns: ["A", "B"], locality: "GLOBAL" })] }))!;
    expect(find(s, /leading prefix/)).toBeUndefined();
  });
  test("stale index statistics say 'while the table is not' only when the table's verdict is known", () => {
    const indexes = [idx("IX", { staleStats: true })];
    expect(find(indexesSection(ctx({ columns: cols, indexes, staleStats: false }))!, /flagged stale while the table is not/)).toBeDefined();
    expect(find(indexesSection(ctx({ columns: cols, indexes, staleStats: null }))!, /flagged stale\./)).toBeDefined();
  });
});

describe("statistics quality: more rules", () => {
  test("a LOB or XML column without statistics is not reported as missing", () => {
    const s = qualitySection(ctx({ columns: [col("DOC", { dataType: "CLOB", lastAnalyzed: null, numDistinct: null }), col("NEW", { lastAnalyzed: null, numDistinct: null })] }))!;
    expect(find(s, /^NEW has no column statistics/)).toBeDefined();
    expect(find(s, /DOC/)).toBeUndefined();
  });
});
