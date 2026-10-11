// The input of the advisor: every field, its allowed values and Oracle's defaults.
// Pure data, no DOM.

export const GRANULARITIES = ["AUTO", "GLOBAL", "PARTITION", "GLOBAL AND PARTITION", "APPROX_GLOBAL AND PARTITION", "ALL", "SUBPARTITION"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const METHOD_OPTS = ["auto", "skewonly", "repeat", "pinned", "size1"] as const;
export type MethodOpt = (typeof METHOD_OPTS)[number];

/** Allowed values of every choice field. Number, checkbox and text fields are listed below. */
export const OPTIONS = {
  incremental: ["TRUE", "FALSE"],
  incrementalLevel: ["PARTITION", "TABLE"],
  publish: ["TRUE", "FALSE"],
  granularity: GRANULARITIES,
  methodOpt: METHOD_OPTS,
  cascade: ["AUTO_CASCADE", "TRUE", "FALSE"],
  noInvalidate: ["AUTO_INVALIDATE", "FALSE", "TRUE"],
  options: ["GATHER", "GATHER AUTO"],
  overrides: ["TRUE", "FALSE"],
  ndvAlgorithm: ["REPEAT OR HYPERLOGLOG", "ADAPTIVE SAMPLING", "HYPERLOGLOG"],
  runBy: ["call", "auto", "hf"],
  partname: ["none", "new", "changed"],
  callGranularity: ["none", ...GRANULARITIES],
  callMethodOpt: ["none", ...METHOD_OPTS],
  callCascade: ["none", "AUTO_CASCADE", "TRUE", "FALSE"],
  callNoInvalidate: ["none", "AUTO_INVALIDATE", "FALSE", "TRUE"],
  callOptions: ["none", "GATHER", "GATHER AUTO"],
  synopses: ["all", "none", "stale"],
  tableStats: ["gathered", "none", "load"],
  columnChange: ["none", "usage", "group", "histogram"],
  autoStatExtensions: ["OFF", "ON"],
  subpartitionType: ["HASH", "LIST", "RANGE"],
  hfTask: ["OFF", "ON"],
} as const;
export type OptionKey = keyof typeof OPTIONS;

export const NUMBERS = [
  "partitions", "blocksPerPartition", "numRows", "columnCount", "indexCount", "localIndexCount",
  "stalePercent", "changePercent", "tableChangePercent", "newPartitions", "changedPartitions", "lockedPartitions", "lockedChanged", "oldFormatPartitions",
  "columnGroups", "columnGroupCandidates", "subpartitionsPerPartition", "hfInterval", "hfMaxRunTime",
] as const;
export type NumberKey = (typeof NUMBERS)[number];

export const BOOLS = [
  "partitioned", "histogramsPresent", "columnUsageRecorded", "useTableChangePercent",
  "useStalePercent", "useLockedStats", "allowMixedFormat", "force", "callBlockSample", "lockedNoSynopsis", "tableLocked",
  "subpartitioned", "exchanged", "exchangeTargetGathered", "exchangeStageSynopsis", "exchangeHistogramsMatch", "realTimeStats", "pendingStats",
] as const;
export type BoolKey = (typeof BOOLS)[number];

/** Free text: the names that replace OWNER, TABLE, NEW_PARTITION, CHANGED_PARTITION and LOCKED_PARTITION in the statements, and DEGREE. */
export const STRINGS = ["owner", "tableName", "newPartitionName", "changedPartitionName", "lockedPartitionName", "degree"] as const;
export type StringKey = (typeof STRINGS)[number];
export const NAME_MAX = 128;

export type Percent = "auto" | number;
export type CallPercent = "none" | number;

export interface Input {
  owner: string;
  tableName: string;
  newPartitionName: string;
  changedPartitionName: string;
  lockedPartitionName: string;
  // the table
  partitioned: boolean;
  partitions: number;
  blocksPerPartition: number;
  numRows: number;
  columnCount: number;
  indexCount: number;
  localIndexCount: number;
  histogramsPresent: boolean;
  columnUsageRecorded: boolean;
  /** Column groups (extended statistics) the table has today. */
  columnGroups: number;
  /** Column sets with no group yet that a group would help: a SQL plan directive with equality predicates only, or a group SEED_COL_USAGE recorded. */
  columnGroupCandidates: number;
  /** A composite (subpartitioned) table: every partition has `subpartitionsPerPartition` subpartitions of `subpartitionType`. */
  subpartitioned: boolean;
  subpartitionType: "HASH" | "LIST" | "RANGE";
  subpartitionsPerPartition: number;
  // preferences in force
  incremental: "TRUE" | "FALSE";
  incrementalLevel: "PARTITION" | "TABLE";
  useStalePercent: boolean;
  useLockedStats: boolean;
  allowMixedFormat: boolean;
  ndvAlgorithm: "REPEAT OR HYPERLOGLOG" | "ADAPTIVE SAMPLING" | "HYPERLOGLOG";
  publish: "TRUE" | "FALSE";
  estimatePercent: Percent;
  granularity: Granularity;
  methodOpt: MethodOpt;
  cascade: "AUTO_CASCADE" | "TRUE" | "FALSE";
  noInvalidate: "AUTO_INVALIDATE" | "FALSE" | "TRUE";
  options: "GATHER" | "GATHER AUTO";
  degree: string;
  stalePercent: number;
  overrides: "TRUE" | "FALSE";
  autoStatExtensions: "OFF" | "ON";
  /** Global preferences of the high-frequency automatic task: AUTO_TASK_STATUS, AUTO_TASK_INTERVAL and AUTO_TASK_MAX_RUN_TIME, in seconds. */
  hfTask: "OFF" | "ON";
  hfInterval: number;
  hfMaxRunTime: number;
  /** optimizer_real_time_statistics is TRUE (licensed for Exadata and Exadata Cloud only in 19c). */
  realTimeStats: boolean;
  // the call
  runBy: "call" | "auto" | "hf";
  partname: "none" | "new" | "changed";
  callGranularity: "none" | Granularity;
  callEstimatePercent: CallPercent;
  callMethodOpt: "none" | MethodOpt;
  callCascade: "none" | "AUTO_CASCADE" | "TRUE" | "FALSE";
  callNoInvalidate: "none" | "AUTO_INVALIDATE" | "FALSE" | "TRUE";
  callOptions: "none" | "GATHER" | "GATHER AUTO";
  callBlockSample: boolean;
  force: boolean;
  // since the last gather
  synopses: "all" | "none" | "stale";
  tableStats: "gathered" | "none" | "load";
  tableChangePercent: number;
  useTableChangePercent: boolean;
  newPartitions: number;
  changedPartitions: number;
  changePercent: number;
  lockedPartitions: number;
  lockedChanged: number;
  lockedNoSynopsis: boolean;
  oldFormatPartitions: number;
  tableLocked: boolean;
  columnChange: "none" | "usage" | "group" | "histogram";
  /** A partition was exchanged in since the last gather, and what was prepared before the exchange. */
  exchanged: boolean;
  exchangeTargetGathered: boolean;
  exchangeStageSynopsis: boolean;
  exchangeHistogramsMatch: boolean;
  /** Rows exist in DBA_TAB_PENDING_STATS for the table. */
  pendingStats: boolean;
}

/** Oracle's global defaults, so the page first shows what an untouched table does. The table is the explainer's SHOP.SALES. */
export const DEFAULTS: Readonly<Input> = Object.freeze({
  owner: "",
  tableName: "",
  newPartitionName: "",
  changedPartitionName: "",
  lockedPartitionName: "",
  partitioned: true,
  partitions: 24,
  blocksPerPartition: 850,
  numRows: 2040080,
  columnCount: 6,
  indexCount: 2,
  localIndexCount: 1,
  histogramsPresent: true,
  columnUsageRecorded: true,
  columnGroups: 0,
  columnGroupCandidates: 0,
  subpartitioned: false,
  subpartitionType: "HASH",
  subpartitionsPerPartition: 4,
  incremental: "FALSE",
  incrementalLevel: "PARTITION",
  useStalePercent: false,
  useLockedStats: false,
  allowMixedFormat: true,
  ndvAlgorithm: "REPEAT OR HYPERLOGLOG",
  publish: "TRUE",
  estimatePercent: "auto",
  granularity: "AUTO",
  methodOpt: "auto",
  cascade: "AUTO_CASCADE",
  noInvalidate: "AUTO_INVALIDATE",
  options: "GATHER",
  degree: "NULL",
  stalePercent: 10,
  overrides: "FALSE",
  autoStatExtensions: "OFF",
  hfTask: "OFF",
  hfInterval: 900,
  hfMaxRunTime: 3600,
  realTimeStats: false,
  runBy: "call",
  partname: "none",
  callGranularity: "none",
  callEstimatePercent: "none",
  callMethodOpt: "none",
  callCascade: "none",
  callNoInvalidate: "none",
  callOptions: "none",
  callBlockSample: false,
  force: false,
  synopses: "none",
  tableStats: "gathered",
  tableChangePercent: 0,
  useTableChangePercent: false,
  newPartitions: 1,
  changedPartitions: 0,
  changePercent: 1,
  lockedPartitions: 0,
  lockedChanged: 0,
  lockedNoSynopsis: false,
  oldFormatPartitions: 0,
  tableLocked: false,
  columnChange: "none",
  exchanged: false,
  exchangeTargetGathered: false,
  exchangeStageSynopsis: false,
  exchangeHistogramsMatch: false,
  pendingStats: false,
});

/** The setup of the explainer's chapter 8, example 1: the append-only table. Applied on top of the current form. */
export const RECOMMENDED: Readonly<Partial<Input>> = Object.freeze({
  incremental: "TRUE",
  incrementalLevel: "PARTITION",
  publish: "TRUE",
  estimatePercent: "auto",
  granularity: "AUTO",
  useStalePercent: true,
  useLockedStats: true,
  allowMixedFormat: true,
  methodOpt: "pinned",
  overrides: "TRUE",
  autoStatExtensions: "OFF",
  synopses: "all",
});

/** Oracle's documented default of each preference, for the "where each setting came from" table. */
export const PREF_DEFAULTS = {
  ESTIMATE_PERCENT: "DBMS_STATS.AUTO_SAMPLE_SIZE",
  METHOD_OPT: "FOR ALL COLUMNS SIZE AUTO",
  GRANULARITY: "AUTO",
  CASCADE: "DBMS_STATS.AUTO_CASCADE",
  DEGREE: "NULL",
  NO_INVALIDATE: "DBMS_STATS.AUTO_INVALIDATE",
  OPTIONS: "GATHER",
  PUBLISH: "TRUE",
  STALE_PERCENT: "10",
  INCREMENTAL: "FALSE",
  INCREMENTAL_LEVEL: "PARTITION",
  INCREMENTAL_STALENESS: "ALLOW_MIXED_FORMAT",
  APPROXIMATE_NDV_ALGORITHM: "REPEAT OR HYPERLOGLOG",
  PREFERENCE_OVERRIDES_PARAMETER: "FALSE",
  AUTO_STAT_EXTENSIONS: "OFF",
} as const;

export const METHOD_OPT_TEXT: Record<MethodOpt, string> = {
  auto: "FOR ALL COLUMNS SIZE AUTO",
  skewonly: "FOR ALL COLUMNS SIZE SKEWONLY",
  repeat: "FOR ALL COLUMNS SIZE REPEAT",
  pinned: "FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 <column>",
  size1: "FOR ALL COLUMNS SIZE 1",
};

export const FIELD_LABELS: Record<keyof Input, string> = {
  owner: "Owner", tableName: "Table", newPartitionName: "New partition name", changedPartitionName: "Changed partition name", lockedPartitionName: "Locked partition name",
  partitioned: "Partitioned", partitions: "Partitions", blocksPerPartition: "Blocks per partition", numRows: "Rows", columnCount: "Columns",
  indexCount: "Indexes", localIndexCount: "Local indexes", histogramsPresent: "Histograms exist today", columnUsageRecorded: "Column usage recorded",
  columnGroups: "Column groups", columnGroupCandidates: "Column group candidates", autoStatExtensions: "AUTO_STAT_EXTENSIONS",
  subpartitioned: "Subpartitioned (composite)", subpartitionType: "Subpartition type", subpartitionsPerPartition: "Subpartitions per partition",
  hfTask: "AUTO_TASK_STATUS", hfInterval: "AUTO_TASK_INTERVAL (s)", hfMaxRunTime: "AUTO_TASK_MAX_RUN_TIME (s)", realTimeStats: "Real-time statistics",
  exchanged: "A partition was exchanged in since the last gather", exchangeTargetGathered: "The empty target partition was gathered before the exchange",
  exchangeStageSynopsis: "The staging table had a table-level synopsis", exchangeHistogramsMatch: "The histograms match on both sides", pendingStats: "Pending statistics",
  incremental: "INCREMENTAL", incrementalLevel: "INCREMENTAL_LEVEL", useStalePercent: "USE_STALE_PERCENT", useLockedStats: "USE_LOCKED_STATS",
  allowMixedFormat: "ALLOW_MIXED_FORMAT", ndvAlgorithm: "APPROXIMATE_NDV_ALGORITHM", publish: "PUBLISH", estimatePercent: "ESTIMATE_PERCENT", granularity: "GRANULARITY", methodOpt: "METHOD_OPT",
  cascade: "CASCADE", noInvalidate: "NO_INVALIDATE", options: "OPTIONS", degree: "DEGREE", stalePercent: "STALE_PERCENT", overrides: "PREFERENCE_OVERRIDES_PARAMETER",
  runBy: "Run by", partname: "partname", callGranularity: "granularity", callEstimatePercent: "estimate_percent", callMethodOpt: "method_opt",
  callCascade: "cascade", callNoInvalidate: "no_invalidate", callOptions: "options", callBlockSample: "block_sample => TRUE", force: "force => TRUE",
  synopses: "Synopses", tableStats: "Statistics today", tableChangePercent: "Rows changed since the last gather", useTableChangePercent: "Use measured table change", newPartitions: "New partitions", changedPartitions: "Changed partitions",
  changePercent: "Change per partition", lockedPartitions: "Locked partitions", lockedChanged: "Locked partitions with DML",
  lockedNoSynopsis: "Locked partition without synopsis", oldFormatPartitions: "Partitions with an old-format synopsis", tableLocked: "LOCK_TABLE_STATS", columnChange: "Column change",
};

/** Ready-made situations. Each is applied on top of DEFAULTS. */
export interface Preset { id: string; label: string; blurb: string; values: Partial<Input> }
export const PRESETS: readonly Preset[] = [
  { id: "untouched", label: "Untouched partitioned table", blurb: "Oracle's defaults on a 24-partition table after one new month was loaded.", values: {} },
  { id: "recommended", label: "Chapter 8 recommended setup", blurb: "INCREMENTAL, staleness by percent, pinned histograms, the override on; every partition has a synopsis.", values: { ...RECOMMENDED } },
  { id: "flat", label: "Plain (non-partitioned) table", blurb: "A 1,000,000-row table of 18,000 blocks, four indexes' worth of work left to CASCADE.", values: { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, columnCount: 9, indexCount: 4, localIndexCount: 0, newPartitions: 0, tableChangePercent: 0.4 } },
  { id: "legacy", label: "A 10g-era script on a plain table", blurb: "estimate_percent => 10, FOR ALL COLUMNS SIZE 1, cascade => TRUE.", values: { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, columnCount: 9, indexCount: 4, localIndexCount: 0, newPartitions: 0, callEstimatePercent: 10, callMethodOpt: "size1", callCascade: "TRUE" } },
  { id: "firstinc", label: "First incremental gather", blurb: "INCREMENTAL just switched on: no synopses exist yet.", values: { incremental: "TRUE", synopses: "none", newPartitions: 0 } },
  { id: "locked", label: "Locked month with late DML", blurb: "One closed month locked, then corrected; default staleness.", values: { ...RECOMMENDED, useLockedStats: false, overrides: "FALSE", lockedPartitions: 1, lockedChanged: 1 } },
  { id: "autojob", label: "Left to the automatic job", blurb: "The nightly job finds the new month on an incremental table.", values: { incremental: "TRUE", synopses: "all", runBy: "auto" } },
  { id: "newcolumn", label: "A new predicate under SIZE AUTO", blurb: "A report filters on a column for the first time; METHOD_OPT is the default.", values: { incremental: "TRUE", synopses: "all", newPartitions: 0, columnChange: "usage" } },
  { id: "staged", label: "Build synopses one partition per night", blurb: "partname + granularity PARTITION on a table without synopses (example 5).", values: { incremental: "TRUE", synopses: "none", partname: "new", callGranularity: "PARTITION" } },
  { id: "colgroup", label: "A column group the optimizer asked for", blurb: "A plain table with a SQL plan directive on two correlated columns (equality predicates) and no column group yet.", values: { partitioned: false, blocksPerPartition: 1200, numRows: 200000, columnCount: 7, indexCount: 0, localIndexCount: 0, newPartitions: 0, columnGroupCandidates: 1 } },
  { id: "onload", label: "After a direct-path load", blurb: "A plain table with STATS_ON_LOAD statistics and OPTIONS GATHER AUTO: histograms and indexes only.", values: { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, columnCount: 9, indexCount: 2, localIndexCount: 0, newPartitions: 0, tableStats: "load", callOptions: "GATHER AUTO" } },
  { id: "composite", label: "Composite table: range-hash", blurb: "Six range partitions with four hash subpartitions each (lab J), GRANULARITY AUTO: no subpartition statistics, and DML in one subpartition rereads the whole partition.", values: { incremental: "TRUE", synopses: "all", partitions: 6, blocksPerPartition: 4000, numRows: 600000, subpartitioned: true, subpartitionType: "HASH", subpartitionsPerPartition: 4, newPartitions: 0, changedPartitions: 1, changePercent: 2 } },
  { id: "exchange-bad", label: "Partition exchange, not prepared", blurb: "A staged month was exchanged in: the staging table has a table-level synopsis, but the empty target partition was not gathered and the histograms differ (lab H2, H6).", values: { incremental: "TRUE", synopses: "all", exchanged: true, exchangeStageSynopsis: true, exchangeTargetGathered: false, exchangeHistogramsMatch: false } },
  { id: "exchange-ok", label: "Partition exchange, prepared", blurb: "The V3 recipe: same METHOD_OPT on both tables, the empty target gathered, the stage gathered with a table-level synopsis. The gather reads nothing (lab H5, V3).", values: { incremental: "TRUE", synopses: "all", exchanged: true, exchangeStageSynopsis: true, exchangeTargetGathered: true, exchangeHistogramsMatch: true } },
  { id: "realtime", label: "Real-time statistics on a busy table", blurb: "A plain table that takes inserts all day with optimizer_real_time_statistics on (licensed for Exadata and Exadata Cloud only in 19c): the gather is unchanged.", values: { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, columnCount: 9, indexCount: 2, localIndexCount: 0, newPartitions: 0, tableChangePercent: 6, realTimeStats: true } },
  { id: "hftask", label: "The high-frequency task", blurb: "A plain table found stale by the task that runs every 15 minutes (licensed for Exadata and Exadata Cloud only in 19c).", values: { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, columnCount: 9, indexCount: 2, localIndexCount: 0, newPartitions: 0, tableChangePercent: 12, runBy: "hf", hfTask: "ON" } },
  { id: "pending", label: "Gather into pending, test, publish", blurb: "PUBLISH FALSE on a plain table: the recipe with OPTIMIZER_USE_PENDING_STATISTICS, DIFF_TABLE_STATS_IN_PENDING and PUBLISH_PENDING_STATS.", values: { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, columnCount: 9, indexCount: 2, localIndexCount: 0, newPartitions: 0, publish: "FALSE" } },
  { id: "pending-left", label: "Pending statistics left behind", blurb: "PUBLISH is TRUE again, but the pending rows of an earlier test remain on an incremental table (lab G1, Tf).", values: { incremental: "TRUE", synopses: "all", pendingStats: true } },
];
