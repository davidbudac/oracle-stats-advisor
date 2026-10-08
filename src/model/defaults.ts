// The input of the advisor: every field, its allowed values and Oracle's defaults.
// Pure data, no DOM.

export const GRANULARITIES = ["AUTO", "GLOBAL", "PARTITION", "GLOBAL AND PARTITION", "APPROX_GLOBAL AND PARTITION", "ALL"] as const;
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
  runBy: ["call", "auto"],
  partname: ["none", "new", "changed"],
  callGranularity: ["none", ...GRANULARITIES],
  callMethodOpt: ["none", ...METHOD_OPTS],
  callCascade: ["none", "AUTO_CASCADE", "TRUE", "FALSE"],
  callNoInvalidate: ["none", "AUTO_INVALIDATE", "FALSE", "TRUE"],
  callOptions: ["none", "GATHER", "GATHER AUTO"],
  synopses: ["all", "none", "stale"],
  tableStats: ["gathered", "none", "load"],
  columnChange: ["none", "usage", "group", "histogram"],
} as const;
export type OptionKey = keyof typeof OPTIONS;

export const NUMBERS = [
  "partitions", "blocksPerPartition", "numRows", "columnCount", "indexCount", "localIndexCount",
  "stalePercent", "changePercent", "tableChangePercent", "newPartitions", "changedPartitions", "lockedPartitions", "lockedChanged",
] as const;
export type NumberKey = (typeof NUMBERS)[number];

export const BOOLS = [
  "partitioned", "histogramsPresent", "columnUsageRecorded",
  "useStalePercent", "useLockedStats", "allowMixedFormat", "force", "callBlockSample", "lockedNoSynopsis", "tableLocked",
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
  // preferences in force
  incremental: "TRUE" | "FALSE";
  incrementalLevel: "PARTITION" | "TABLE";
  useStalePercent: boolean;
  useLockedStats: boolean;
  allowMixedFormat: boolean;
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
  // the call
  runBy: "call" | "auto";
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
  newPartitions: number;
  changedPartitions: number;
  changePercent: number;
  lockedPartitions: number;
  lockedChanged: number;
  lockedNoSynopsis: boolean;
  tableLocked: boolean;
  columnChange: "none" | "usage" | "group" | "histogram";
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
  incremental: "FALSE",
  incrementalLevel: "PARTITION",
  useStalePercent: false,
  useLockedStats: false,
  allowMixedFormat: true,
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
  newPartitions: 1,
  changedPartitions: 0,
  changePercent: 1,
  lockedPartitions: 0,
  lockedChanged: 0,
  lockedNoSynopsis: false,
  tableLocked: false,
  columnChange: "none",
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
  PREFERENCE_OVERRIDES_PARAMETER: "FALSE",
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
  incremental: "INCREMENTAL", incrementalLevel: "INCREMENTAL_LEVEL", useStalePercent: "USE_STALE_PERCENT", useLockedStats: "USE_LOCKED_STATS",
  allowMixedFormat: "ALLOW_MIXED_FORMAT", publish: "PUBLISH", estimatePercent: "ESTIMATE_PERCENT", granularity: "GRANULARITY", methodOpt: "METHOD_OPT",
  cascade: "CASCADE", noInvalidate: "NO_INVALIDATE", options: "OPTIONS", degree: "DEGREE", stalePercent: "STALE_PERCENT", overrides: "PREFERENCE_OVERRIDES_PARAMETER",
  runBy: "Run by", partname: "partname", callGranularity: "granularity", callEstimatePercent: "estimate_percent", callMethodOpt: "method_opt",
  callCascade: "cascade", callNoInvalidate: "no_invalidate", callOptions: "options", callBlockSample: "block_sample => TRUE", force: "force => TRUE",
  synopses: "Synopses", tableStats: "Statistics today", tableChangePercent: "Rows changed since the last gather", newPartitions: "New partitions", changedPartitions: "Changed partitions",
  changePercent: "Change per partition", lockedPartitions: "Locked partitions", lockedChanged: "Locked partitions with DML",
  lockedNoSynopsis: "Locked partition without synopsis", tableLocked: "LOCK_TABLE_STATS", columnChange: "Column change",
};

/** Ready-made situations. Each is applied on top of DEFAULTS. */
export interface Preset { id: string; label: string; blurb: string; values: Partial<Input> }
export const PRESETS: readonly Preset[] = [
  { id: "untouched", label: "Untouched partitioned table", blurb: "Oracle's defaults on a 24-partition table after one new month was loaded.", values: {} },
  { id: "recommended", label: "Chapter 8 recommended setup", blurb: "INCREMENTAL, staleness by percent, pinned histograms, the override on; every partition has a synopsis.", values: { ...RECOMMENDED } },
  { id: "flat", label: "Plain (non-partitioned) table", blurb: "A 1,000,000-row table of 18,000 blocks, six indexes' worth of work left to CASCADE.", values: { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, columnCount: 9, indexCount: 4, localIndexCount: 0, newPartitions: 0, tableChangePercent: 0.4 } },
  { id: "legacy", label: "A 10g-era script on a plain table", blurb: "estimate_percent => 10, FOR ALL COLUMNS SIZE 1, cascade => TRUE.", values: { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, columnCount: 9, indexCount: 4, localIndexCount: 0, newPartitions: 0, callEstimatePercent: 10, callMethodOpt: "size1", callCascade: "TRUE" } },
  { id: "firstinc", label: "First incremental gather", blurb: "INCREMENTAL just switched on: no synopses exist yet.", values: { incremental: "TRUE", synopses: "none", newPartitions: 0 } },
  { id: "locked", label: "Locked month with late DML", blurb: "One closed month locked, then corrected; default staleness.", values: { ...RECOMMENDED, useLockedStats: false, overrides: "FALSE", lockedPartitions: 1, lockedChanged: 1 } },
  { id: "autojob", label: "Left to the automatic job", blurb: "The nightly job finds the new month on an incremental table.", values: { incremental: "TRUE", synopses: "all", runBy: "auto" } },
  { id: "newcolumn", label: "A new predicate under SIZE AUTO", blurb: "A report filters on a column for the first time; METHOD_OPT is the default.", values: { incremental: "TRUE", synopses: "all", newPartitions: 0, columnChange: "usage" } },
  { id: "staged", label: "Build synopses one partition per night", blurb: "partname + granularity PARTITION on a table without synopses (example 5).", values: { incremental: "TRUE", synopses: "none", partname: "new", callGranularity: "PARTITION" } },
  { id: "onload", label: "After a direct-path load", blurb: "A plain table with STATS_ON_LOAD statistics and OPTIONS GATHER AUTO: histograms and indexes only.", values: { partitioned: false, blocksPerPartition: 18000, numRows: 1000000, columnCount: 9, indexCount: 2, localIndexCount: 0, newPartitions: 0, tableStats: "load", callOptions: "GATHER AUTO" } },
];
