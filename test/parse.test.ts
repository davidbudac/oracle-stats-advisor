import { describe, expect, test } from "vitest";
import { DEFAULTS, decodeInput, encodeInput, parsePrefs } from "../src/model";

describe("parsePrefs", () => {
  test("reads calls, rows, NAME = VALUE lines and GET_PREFS output", () => {
    const calls = parsePrefs(`BEGIN
  DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'INCREMENTAL', 'TRUE');
  dbms_stats.set_table_prefs('SHOP','SALES','ESTIMATE_PERCENT','DBMS_STATS.AUTO_SAMPLE_SIZE');
  exec dbms_stats.set_table_prefs('SHOP','SALES','INCREMENTAL_STALENESS','USE_STALE_PERCENT,USE_LOCKED_STATS');
  DBMS_STATS.SET_GLOBAL_PREFS('GRANULARITY', 'PARTITION');
  DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'CASCADE', 'FALSE');
  DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'TABLE_CACHED_BLOCKS', '16');
END;`);
    expect(calls.values).toEqual({ incremental: "TRUE", estimatePercent: "auto", useStalePercent: true, useLockedStats: true, allowMixedFormat: false, granularity: "PARTITION", cascade: "FALSE" });
    expect(calls.ignored.some((l) => /TABLE_CACHED_BLOCKS/.test(l))).toBe(true);
    expect(calls.recognised).toEqual(["INCREMENTAL", "ESTIMATE_PERCENT", "INCREMENTAL_STALENESS", "GRANULARITY", "CASCADE"]);
    const rows = parsePrefs(`OWNER  TABLE_NAME  PREFERENCE_NAME      PREFERENCE_VALUE
-----  ----------  -------------------  ----------------
SHOP   SALES       INCREMENTAL          TRUE
SHOP   SALES       PUBLISH              FALSE
SHOP   SALES       METHOD_OPT           FOR ALL COLUMNS SIZE REPEAT
SHOP   SALES       STALE_PERCENT        5
SHOP   SALES       DEGREE               4
SHOP   SALES       NO_INVALIDATE        FALSE
SHOP   SALES       AUTOSTATS_TARGET     ALL`);
    expect(rows.values).toEqual({ incremental: "TRUE", publish: "FALSE", methodOpt: "repeat", stalePercent: 5, degree: "4", noInvalidate: "FALSE" });
    expect(rows.ignoredDetail).toEqual([{ line: "SHOP SALES AUTOSTATS_TARGET ALL", reason: "not modelled" }]);
    const eq = parsePrefs("INCREMENTAL_LEVEL = TABLE\nPREFERENCE_OVERRIDES_PARAMETER: TRUE\nMETHOD_OPT = FOR ALL COLUMNS SIZE AUTO\nGRANULARITY = APPROX_GLOBAL AND PARTITION\nINCREMENTAL_STALENESS = NULL\nOPTIONS = GATHER AUTO");
    expect(eq.values).toEqual({ incrementalLevel: "TABLE", overrides: "TRUE", methodOpt: "auto", granularity: "APPROX_GLOBAL AND PARTITION", useStalePercent: false, useLockedStats: false, allowMixedFormat: true, options: "GATHER AUTO" });
    const cols = [["INCREMENTAL", "TRUE"], ["INCR_LEVEL", "PARTITION"], ["INCR_STALENESS", "USE_STALE_PERCENT"], ["PUBLISH", "TRUE"], ["ESTIMATE_PERCENT", "DBMS_STATS.AUTO_SAMPLE_SIZE"],
      ["GRANULARITY", "AUTO"], ["METHOD_OPT", "FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 ID"], ["OVERRIDES", "FALSE"]] as const;
    const width = (c: readonly string[]) => Math.max(...c.map((x) => x.length));
    const sqlplus = [0, 1].map((r) => cols.map((c) => c[r]!.padEnd(width(c))).join(" "));
    const get = parsePrefs([sqlplus[0]!, cols.map((c) => "-".repeat(width(c))).join(" "), sqlplus[1]!].join("\n"));
    expect(get.values).toEqual({ incremental: "TRUE", incrementalLevel: "PARTITION", useStalePercent: true, useLockedStats: false, allowMixedFormat: false, publish: "TRUE", estimatePercent: "auto", granularity: "AUTO", methodOpt: "pinned", overrides: "FALSE" });
    expect(parsePrefs("SIZE SKEWONLY nonsense").recognised.length).toBe(0);
    expect(parsePrefs("METHOD_OPT = FOR ALL COLUMNS SIZE SKEWONLY").values.methodOpt).toBe("skewonly");
    expect(parsePrefs("METHOD_OPT = FOR ALL COLUMNS SIZE 1").values.methodOpt).toBe("size1");
    expect(parsePrefs("METHOD_OPT = FOR ALL COLUMNS SIZE 254").values.methodOpt).toBe("pinned");
    expect(parsePrefs("CASCADE = DBMS_STATS.AUTO_CASCADE\nNO_INVALIDATE = DBMS_STATS.AUTO_INVALIDATE").values).toEqual({ cascade: "AUTO_CASCADE", noInvalidate: "AUTO_INVALIDATE" });
  });

  const BLOCK = `-- Statistics advisor input for STATS_LAB.SALES
-- collected 2026-10-06 14:02:11 on Oracle 19.27.0.0.0
-- ADVISOR INPUT BEGIN
OWNER = STATS_LAB
TABLE_NAME = SALES
PARTITIONED = YES
PARTITIONS = 24
BLOCKS_PER_PARTITION = 850
NUM_ROWS = 720000
COLUMNS = 6
INDEXES = 2
LOCAL_INDEXES = 1
HISTOGRAMS = 1
COLUMN_USAGE = 1
INCREMENTAL = TRUE
INCREMENTAL_LEVEL = PARTITION
INCREMENTAL_STALENESS = USE_STALE_PERCENT,ALLOW_MIXED_FORMAT
PUBLISH = TRUE
ESTIMATE_PERCENT = DBMS_STATS.AUTO_SAMPLE_SIZE
GRANULARITY = AUTO
METHOD_OPT = FOR ALL COLUMNS SIZE AUTO
CASCADE = DBMS_STATS.AUTO_CASCADE
NO_INVALIDATE = DBMS_STATS.AUTO_INVALIDATE
OPTIONS = GATHER
DEGREE = NULL
STALE_PERCENT = 10
PREFERENCE_OVERRIDES_PARAMETER = FALSE
SYNOPSES = all
NEW_PARTITIONS = 1
NEW_PARTITION = SALES_2025_12
CHANGED_PARTITIONS = 2
CHANGED_PARTITION = SALES_2025_11
CHANGE_PERCENT = 1.4
TABLE_CHANGE_PERCENT = 4.2
LOCKED_PARTITIONS = 3
LOCKED_CHANGED = 1
LOCKED_PARTITION = SALES_2024_01
LOCKED_NO_SYNOPSIS = 0
TABLE_LOCKED = NO
COLUMN_CHANGE = none
-- ADVISOR INPUT END
-- Detail (not parsed)
PARTITION_NAME   NUM_ROWS  LAST_ANALYZED
---------------  --------  -------------------
SALES_2025_12    0
-- Dry run: REPORT_GATHER_TABLE_STATS
Granularity : PARTITION
Incremental : FALSE
Estimate Percent : 5
OWNER = SOMEONE_ELSE
`;
  test("reads the collector block and nothing around it", () => {
    const r = parsePrefs(BLOCK);
    expect(r.values).toEqual({
      owner: "STATS_LAB", tableName: "SALES", partitioned: true, partitions: 24, blocksPerPartition: 850, numRows: 720000, columnCount: 6, indexCount: 2, localIndexCount: 1,
      histogramsPresent: true, columnUsageRecorded: true,
      incremental: "TRUE", incrementalLevel: "PARTITION", useStalePercent: true, useLockedStats: false, allowMixedFormat: true,
      publish: "TRUE", estimatePercent: "auto", granularity: "AUTO", methodOpt: "auto", cascade: "AUTO_CASCADE", noInvalidate: "AUTO_INVALIDATE", options: "GATHER", degree: "NULL",
      stalePercent: 10, overrides: "FALSE",
      synopses: "all", newPartitions: 1, newPartitionName: "SALES_2025_12", changedPartitions: 2, changedPartitionName: "SALES_2025_11", changePercent: 1.4, tableChangePercent: 4.2,
      lockedPartitions: 3, lockedChanged: 1, lockedPartitionName: "SALES_2024_01", lockedNoSynopsis: false, tableLocked: false, columnChange: "none",
    });
    expect(r.ignored).toEqual([]);
    expect(parsePrefs(BLOCK.split("-- ADVISOR INPUT BEGIN")[0]).recognised).toEqual([]);
    const bare = parsePrefs("-- a comment\nPARTITIONS = 12\nLOCKED_NO_SYNOPSIS = yes\nTABLE_LOCKED = 1\nLOCKED_PARTITION =\nCOLUMN_CHANGE = Group\nCHANGE_PERCENT = 2,5\nSYNOPSES = sometimes\nPARTITIONS_X = 3");
    expect(bare.values).toEqual({ partitions: 12, lockedNoSynopsis: true, tableLocked: true, lockedPartitionName: "", columnChange: "group", changePercent: 2.5 });
    expect(bare.ignoredDetail.map((d) => d.line)).toEqual(["SYNOPSES = sometimes", "PARTITIONS_X = 3"]);
    expect(bare.ignoredDetail[0]!.reason).toMatch(/expected all, none, stale/);
  });
  test("INCREMENTAL_STALENESS NULL means the default flags", () => {
    const nul = parsePrefs("INCREMENTAL_STALENESS = NULL");
    expect(nul.values).toEqual({ useStalePercent: false, useLockedStats: false, allowMixedFormat: true });
    expect(parsePrefs("-- ADVISOR INPUT BEGIN\nINCREMENTAL_STALENESS =\n-- ADVISOR INPUT END").values).toEqual(nul.values);
  });
});

describe("the URL hash", () => {
  test("round-trips the names and skips the defaults", () => {
    const names = { owner: "SHOP", tableName: "Sales Data", newPartitionName: "P_2025_12", changedPartitionName: "P_2025_11", lockedPartitionName: "P_2024_01" };
    expect(decodeInput(encodeInput({ ...DEFAULTS, ...names }))).toEqual(names);
    expect(encodeInput(DEFAULTS)).toBe("");
    expect(encodeInput({ ...DEFAULTS, owner: "SHOP", partitioned: false, callEstimatePercent: 5 })).toBe("owner=SHOP&partitioned=0&callEstimatePercent=5");
    expect(decodeInput("owner=%20shop%20&tableName=&partitioned=0&runBy=auto&bogus=1&methodOpt=nope")).toEqual({ owner: "shop", partitioned: false, runBy: "auto" });
  });
});
