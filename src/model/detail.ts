// Detail: the typed rows of the collector's second block (ADVISOR DETAIL BEGIN to END), the input of the
// health check. The format is fixed in docs/design-health.md; sql/collect.sql prints it.
//
//   KEY = value                 a scalar
//   KIND = f1|f2|f3|...         one row of a repeating record, fields in the documented order
//
// Rules: a missing field is empty and empty means unknown (null), never zero; numbers use "." (a
// comma decimal is accepted); dates are "YYYY-MM-DD HH24:MI:SS" and stay strings (see `toTime`);
// flags are Y/N. A line the parser cannot read goes to `ignored` with a reason; nothing throws.
// A key that is absent leaves its field null (not collected). An empty record array is ambiguous
// (no rows, or the statement failed): compare with the INPUT counts (indexCount, columns) where it matters.

export interface ColumnRec {
  name: string;
  /** Empty for an extension (column group or expression statistics). */
  dataType: string | null;
  nullable: boolean | null;
  numDistinct: number | null;
  numNulls: number | null;
  numBuckets: number | null;
  /** As the view prints it: NONE, FREQUENCY, TOP-FREQUENCY, HEIGHT BALANCED, HYBRID. */
  histogram: string | null;
  sampleSize: number | null;
  density: number | null;
  avgColLen: number | null;
  lastAnalyzed: string | null;
  notes: string | null;
  /** Decoded low and high value: numbers as text, dates as YYYY-MM-DD HH24:MI:SS, text cut at 30 characters; null for other types. */
  low: string | null;
  high: string | null;
  /** Usage flags of REPORT_COL_USAGE (EQ, RANGE, LIKE, NULL, EQUIJOIN, NONEQUIJOIN, also FILTER, JOIN, GROUP_BY). Empty: not used, or `Detail.columnUsageCollected` is false. */
  usage: string[];
  /** True when the column is the leading column of some index. */
  inIndex: boolean | null;
  /** The name is an extension (SYS_STU...), not a table column. */
  isExtension: boolean;
}

export interface IndexRec {
  name: string;
  uniqueness: string | null;
  indexType: string | null;
  partitioned: boolean | null;
  /** LOCAL, GLOBAL or null. */
  locality: string | null;
  /** In position order; an expression column is its SYS_NC name. */
  columns: string[];
  blevel: number | null;
  leafBlocks: number | null;
  distinctKeys: number | null;
  clusteringFactor: number | null;
  numRows: number | null;
  lastAnalyzed: string | null;
  staleStats: boolean | null;
  locked: boolean | null;
  status: string | null;
  visibility: string | null;
  totalAccessCount: number | null;
  totalExecCount: number | null;
  lastUsed: string | null;
}

export interface ExtensionRec {
  name: string;
  text: string | null;
  kind: "group" | "expression" | null;
  hasStats: boolean | null;
  numDistinct: number | null;
  histogram: string | null;
  /** True when REPORT_COL_USAGE listed it; null when usage was not collected. */
  used: boolean | null;
}

export interface HistoryRec {
  opid: number;
  operation: string;
  startTime: string | null;
  endTime: string | null;
  status: string | null;
  /** The scheduler job; ORA$AT_OS_OPT_SY_... is the nightly task. */
  jobName: string | null;
  /** Scope of the call: TABLE, INDEX, SCHEMA, AUTO or null. */
  targetType: string | null;
  /** Null for an operation without tasks on this table (restore, delete, lock ...). */
  partitionsGathered: number | null;
  globalGathered: boolean | null;
  indexesGathered: number | null;
  targetSize: number | null;
  histogramColumns: string[];
}

export interface WindowRec { name: string; repeatInterval: string | null; duration: string | null; enabled: boolean | null; nextStart: string | null }
export interface AutorunRec { windowName: string; windowStart: string | null; jobStatus: string | null; jobDuration: string | null; jobInfo: string | null }
export interface HfrunRec { opid: number | null; startTime: string | null; endTime: string | null; status: string | null; completed: number | null; failed: number | null; timedOut: number | null; origin: string | null }

export interface PartitionRec {
  name: string;
  position: number | null;
  numRows: number | null;
  blocks: number | null;
  lastAnalyzed: string | null;
  staleStats: boolean | null;
  locked: boolean | null;
  rowsChanged: number | null;
  /** HLL (current), OLD (11g adaptive sampling) or NONE. */
  synopsis: "HLL" | "OLD" | "NONE" | null;
}

export interface Detail {
  version: number | null;
  collectedAt: string | null;
  dbVersion: string | null;
  lastAnalyzed: string | null;
  modsTimestamp: string | null;
  rowsChanged: number | null;
  rowsTruncated: boolean | null;
  /** DBA_TAB_STATISTICS.STALE_STATS of the table row: true = YES. */
  staleStats: boolean | null;
  /** NONE, HASH, LIST, RANGE; null for a plain table or when not collected. */
  subpartitioning: string | null;
  subpartitions: number | null;
  subpartitionsWithStats: number | null;
  zeroRowPartitionsWithDml: number | null;
  /** Set (the partition count) instead of PARTITION records above 400 partitions. */
  partitionsOmitted: number | null;
  pendingRows: number | null;
  pendingSince: string | null;
  optimizerUsePendingStatistics: boolean | null;
  retentionDays: number | null;
  historyAvailableSince: string | null;
  historyRows: number | null;
  historyOldest: string | null;
  historyNewest: string | null;
  sysauxOptstatMb: number | null;
  realtimeStatsParam: boolean | null;
  realtimeStatsNotes: boolean | null;
  statsOnLoad: boolean | null;
  /** The high-frequency task: ON/OFF, seconds, seconds. */
  autoTaskStatus: string | null;
  autoTaskInterval: number | null;
  autoTaskMaxRunTime: number | null;
  autostatsTarget: string | null;
  /** The nightly task: ENABLED or DISABLED. */
  autotaskStatus: string | null;
  tableCachedBlocks: number | null;
  optimizerAdaptiveStatistics: boolean | null;
  /** Columns that alone make up a unique index or an enabled unique/primary key. Null: not collected. */
  uniqueColumns: string[] | null;
  /** Function-based index expressions (they already have a virtual column). Null: not collected. */
  fbiExpressions: string[] | null;
  /** Expressions around a column in cached plans' predicates that have no extension yet. Null: not collected. */
  expressionCandidates: string[] | null;
  /** True when REPORT_COL_USAGE was readable; then an empty `usage` means the column was never used. */
  columnUsageCollected: boolean | null;
  columns: ColumnRec[];
  indexes: IndexRec[];
  extensions: ExtensionRec[];
  history: HistoryRec[];
  windows: WindowRec[];
  autoruns: AutorunRec[];
  hfruns: HfrunRec[];
  partitions: PartitionRec[];
}

export const emptyDetail = (): Detail => ({
  version: null, collectedAt: null, dbVersion: null, lastAnalyzed: null, modsTimestamp: null, rowsChanged: null, rowsTruncated: null, staleStats: null,
  subpartitioning: null, subpartitions: null, subpartitionsWithStats: null, zeroRowPartitionsWithDml: null, partitionsOmitted: null,
  pendingRows: null, pendingSince: null, optimizerUsePendingStatistics: null, retentionDays: null, historyAvailableSince: null,
  historyRows: null, historyOldest: null, historyNewest: null, sysauxOptstatMb: null, realtimeStatsParam: null, realtimeStatsNotes: null, statsOnLoad: null,
  autoTaskStatus: null, autoTaskInterval: null, autoTaskMaxRunTime: null, autostatsTarget: null, autotaskStatus: null, tableCachedBlocks: null,
  optimizerAdaptiveStatistics: null, uniqueColumns: null, fbiExpressions: null, expressionCandidates: null, columnUsageCollected: null,
  columns: [], indexes: [], extensions: [], history: [], windows: [], autoruns: [], hfruns: [], partitions: [],
});

/** A collector timestamp (YYYY-MM-DD HH24:MI:SS) as milliseconds since the epoch, read as UTC so differences are right whatever the zone; null when empty or malformed. */
export function toTime(s: string | null): number | null {
  const m = s?.match(/^(\d{4})-(\d\d)-(\d\d)(?: (\d\d):(\d\d):(\d\d))?$/);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

type Cell = string;
type Num = number | null;
class Bad extends Error {}

const text = (v: Cell): string | null => (v === "" ? null : v);
const num = (v: Cell, what: string): Num => {
  if (v === "") return null;
  const n = Number(/^[+-]?\d*,\d+$/.test(v) ? v.replace(",", ".") : v);
  if (!Number.isFinite(n)) throw new Bad(`${what} is not a number`);
  return n;
};
const flag = (v: Cell, what: string): boolean | null => {
  if (v === "") return null;
  const u = v.toUpperCase();
  if (["Y", "YES", "TRUE", "1"].includes(u)) return true;
  if (["N", "NO", "FALSE", "0"].includes(u)) return false;
  throw new Bad(`${what} is not Y or N`);
};
const list = (v: Cell, sep: RegExp): string[] => v.split(sep).map((x) => x.trim()).filter(Boolean);

/** A record kind: its field count and how to turn the cells into a typed row. */
interface Kind<T> { fields: number; push(d: Detail, row: T): void; make(c: Cell[]): T }
const required = (v: Cell, what: string): string => { if (v === "") throw new Bad(`${what} is empty`); return v; };

const KINDS: Record<string, Kind<any>> = {
  COLUMN: {
    fields: 16, push: (d, r: ColumnRec) => d.columns.push(r),
    make: (c): ColumnRec => ({
      name: required(c[0]!, "name"), dataType: text(c[1]!), nullable: flag(c[2]!, "nullable"), numDistinct: num(c[3]!, "num_distinct"), numNulls: num(c[4]!, "num_nulls"),
      numBuckets: num(c[5]!, "num_buckets"), histogram: text(c[6]!), sampleSize: num(c[7]!, "sample_size"), density: num(c[8]!, "density"), avgColLen: num(c[9]!, "avg_col_len"),
      lastAnalyzed: text(c[10]!), notes: text(c[11]!), low: text(c[12]!), high: text(c[13]!), usage: list(c[14]!, /\//), inIndex: flag(c[15]!, "in_index"),
      isExtension: c[1]! === "" || /^SYS_STU/.test(c[0]!),
    }),
  },
  INDEX: {
    fields: 19, push: (d, r: IndexRec) => d.indexes.push(r),
    make: (c): IndexRec => ({
      name: required(c[0]!, "name"), uniqueness: text(c[1]!), indexType: text(c[2]!), partitioned: flag(c[3]!, "partitioned"), locality: text(c[4]!), columns: list(c[5]!, /,/),
      blevel: num(c[6]!, "blevel"), leafBlocks: num(c[7]!, "leaf_blocks"), distinctKeys: num(c[8]!, "distinct_keys"), clusteringFactor: num(c[9]!, "clustering_factor"),
      numRows: num(c[10]!, "num_rows"), lastAnalyzed: text(c[11]!), staleStats: flag(c[12]!, "stale_stats"), locked: flag(c[13]!, "locked"), status: text(c[14]!), visibility: text(c[15]!),
      totalAccessCount: num(c[16]!, "total_access_count"), totalExecCount: num(c[17]!, "total_exec_count"), lastUsed: text(c[18]!),
    }),
  },
  EXTENSION: {
    fields: 7, push: (d, r: ExtensionRec) => d.extensions.push(r),
    make: (c): ExtensionRec => {
      const kind = c[2]!.toLowerCase();
      if (kind !== "" && kind !== "group" && kind !== "expression") throw new Bad("kind is not group or expression");
      return { name: required(c[0]!, "name"), text: text(c[1]!), kind: kind === "" ? null : kind, hasStats: flag(c[3]!, "has_stats"), numDistinct: num(c[4]!, "num_distinct"), histogram: text(c[5]!), used: flag(c[6]!, "used") };
    },
  },
  HISTORY: {
    fields: 12, push: (d, r: HistoryRec) => d.history.push(r),
    make: (c): HistoryRec => ({
      opid: num(required(c[0]!, "opid"), "opid")!, operation: required(c[1]!, "operation"), startTime: text(c[2]!), endTime: text(c[3]!), status: text(c[4]!), jobName: text(c[5]!), targetType: text(c[6]!),
      partitionsGathered: num(c[7]!, "partitions_gathered"), globalGathered: flag(c[8]!, "global_gathered"), indexesGathered: num(c[9]!, "indexes_gathered"), targetSize: num(c[10]!, "target_size"),
      histogramColumns: list(c[11]!, /;/),
    }),
  },
  WINDOW: {
    fields: 5, push: (d, r: WindowRec) => d.windows.push(r),
    make: (c): WindowRec => ({ name: required(c[0]!, "name"), repeatInterval: text(c[1]!), duration: text(c[2]!), enabled: flag(c[3]!, "enabled"), nextStart: text(c[4]!) }),
  },
  AUTORUN: {
    fields: 5, push: (d, r: AutorunRec) => d.autoruns.push(r),
    make: (c): AutorunRec => ({ windowName: required(c[0]!, "window_name"), windowStart: text(c[1]!), jobStatus: text(c[2]!), jobDuration: text(c[3]!), jobInfo: text(c[4]!) }),
  },
  HFRUN: {
    fields: 8, push: (d, r: HfrunRec) => d.hfruns.push(r),
    make: (c): HfrunRec => ({ opid: num(c[0]!, "opid"), startTime: text(c[1]!), endTime: text(c[2]!), status: text(c[3]!), completed: num(c[4]!, "completed"), failed: num(c[5]!, "failed"), timedOut: num(c[6]!, "timed_out"), origin: text(c[7]!) }),
  },
  PARTITION: {
    fields: 9, push: (d, r: PartitionRec) => d.partitions.push(r),
    make: (c): PartitionRec => {
      const syn = c[8]!.toUpperCase();
      if (syn !== "" && syn !== "HLL" && syn !== "OLD" && syn !== "NONE") throw new Bad("synopsis is not HLL, OLD or NONE");
      return {
        name: required(c[0]!, "name"), position: num(c[1]!, "position"), numRows: num(c[2]!, "num_rows"), blocks: num(c[3]!, "blocks"), lastAnalyzed: text(c[4]!),
        staleStats: flag(c[5]!, "stale_stats"), locked: flag(c[6]!, "locked"), rowsChanged: num(c[7]!, "rows_changed"), synopsis: syn === "" ? null : syn,
      };
    },
  },
};

/** Scalar keys: how each is read into the Detail. */
const SCALARS: Record<string, (d: Detail, v: Cell) => void> = {
  DETAIL_VERSION: (d, v) => { d.version = num(v, "value"); },
  COLLECTED_AT: (d, v) => { d.collectedAt = text(v); },
  DB_VERSION: (d, v) => { d.dbVersion = text(v); },
  LAST_ANALYZED: (d, v) => { d.lastAnalyzed = text(v); },
  MODS_TIMESTAMP: (d, v) => { d.modsTimestamp = text(v); },
  ROWS_CHANGED: (d, v) => { d.rowsChanged = num(v, "value"); },
  ROWS_TRUNCATED: (d, v) => { d.rowsTruncated = flag(v, "value"); },
  STALE_STATS: (d, v) => { d.staleStats = flag(v, "value"); },
  SUBPARTITIONING: (d, v) => { d.subpartitioning = text(v.toUpperCase()); },
  SUBPARTITIONS: (d, v) => { d.subpartitions = num(v, "value"); },
  SUBPARTITIONS_WITH_STATS: (d, v) => { d.subpartitionsWithStats = num(v, "value"); },
  ZERO_ROW_PARTITIONS_WITH_DML: (d, v) => { d.zeroRowPartitionsWithDml = num(v, "value"); },
  PARTITIONS_OMITTED: (d, v) => { d.partitionsOmitted = num(v, "value"); },
  PENDING_ROWS: (d, v) => { d.pendingRows = num(v, "value"); },
  PENDING_SINCE: (d, v) => { d.pendingSince = text(v); },
  OPTIMIZER_USE_PENDING_STATISTICS: (d, v) => { d.optimizerUsePendingStatistics = flag(v, "value"); },
  RETENTION_DAYS: (d, v) => { d.retentionDays = num(v, "value"); },
  HISTORY_AVAILABLE_SINCE: (d, v) => { d.historyAvailableSince = text(v); },
  HISTORY_ROWS: (d, v) => { d.historyRows = num(v, "value"); },
  HISTORY_OLDEST: (d, v) => { d.historyOldest = text(v); },
  HISTORY_NEWEST: (d, v) => { d.historyNewest = text(v); },
  SYSAUX_OPTSTAT_MB: (d, v) => { d.sysauxOptstatMb = num(v, "value"); },
  REALTIME_STATS_PARAM: (d, v) => { d.realtimeStatsParam = flag(v, "value"); },
  REALTIME_STATS_NOTES: (d, v) => { d.realtimeStatsNotes = flag(v, "value"); },
  STATS_ON_LOAD: (d, v) => { d.statsOnLoad = flag(v, "value"); },
  AUTO_TASK_STATUS: (d, v) => { d.autoTaskStatus = text(v.toUpperCase()); },
  AUTO_TASK_INTERVAL: (d, v) => { d.autoTaskInterval = num(v, "value"); },
  AUTO_TASK_MAX_RUN_TIME: (d, v) => { d.autoTaskMaxRunTime = num(v, "value"); },
  AUTOSTATS_TARGET: (d, v) => { d.autostatsTarget = text(v.toUpperCase()); },
  AUTOTASK_STATUS: (d, v) => { d.autotaskStatus = text(v.toUpperCase()); },
  TABLE_CACHED_BLOCKS: (d, v) => { d.tableCachedBlocks = num(v, "value"); },
  OPTIMIZER_ADAPTIVE_STATISTICS: (d, v) => { d.optimizerAdaptiveStatistics = flag(v, "value"); },
  UNIQUE_COLUMNS: (d, v) => { d.uniqueColumns = list(v, /,/); },
  FBI_EXPRESSIONS: (d, v) => { d.fbiExpressions = list(v, /;/); },
  EXPRESSION_CANDIDATES: (d, v) => { d.expressionCandidates = list(v, /;/); },
  COLUMN_USAGE_COLLECTED: (d, v) => { d.columnUsageCollected = flag(v, "value"); },
};

// Lines SQL*Plus adds around the data: errors of a skipped statement, prompts, the echo of a failed statement.
const NOISE = /^(SQL>|PL\/SQL procedure|Session altered|\d+ rows? selected|no rows selected|Elapsed:|\/$|BEGIN$|END;?$|ORA-\d+|SP2-\d+|PLS-\d+|ERROR at line|ERROR:|\*$|\(?(SELECT|FROM|WHERE|WITH|JOIN|LEFT|CONNECT|GROUP|ORDER|AND|ON)\s)/i;

/**
 * Read the ADVISOR DETAIL block out of the collector's output (lines of the whole paste are fine).
 * `detail` is null when the paste has no DETAIL BEGIN line. Without an END line the block runs to the end.
 */
export function parseDetail(lines: string[]): { detail: Detail | null; ignored: { line: string; reason: string }[] } {
  const ignored: { line: string; reason: string }[] = [];
  const begin = lines.findIndex((l) => /ADVISOR DETAIL BEGIN/i.test(l));
  if (begin < 0) return { detail: null, ignored };
  const detail = emptyDetail();
  const reject = (raw: string, reason: string) => ignored.push({ line: raw.trim().replace(/\s+/g, " ").slice(0, 300), reason });
  for (let i = begin + 1; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const t = raw.trim();
    if (/ADVISOR DETAIL END/i.test(t)) break;
    if (!t || t.startsWith("--") || NOISE.test(t)) continue;
    const m = t.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) { reject(t, "not a KEY = value line"); continue; }
    const key = m[1]!, value = m[2]!.trim();
    try {
      const kind = Object.hasOwn(KINDS, key) ? KINDS[key]! : null;
      if (kind) {
        const cells = value.split("|").map((c) => c.trim());
        if (cells.length !== kind.fields) { reject(t, `expected ${kind.fields} fields, found ${cells.length}`); continue; }
        kind.push(detail, kind.make(cells));
      } else if (Object.hasOwn(SCALARS, key)) SCALARS[key]!(detail, value);
      else reject(t, "unknown key");
    } catch (e) {
      reject(t, e instanceof Bad ? e.message : "could not be read");
    }
  }
  return { detail, ignored };
}
