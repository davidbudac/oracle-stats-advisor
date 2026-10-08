import type { Granularity, Input, MethodOpt, Percent } from "./defaults";

export type Level = "good" | "warn" | "bad" | "info";

export interface Finding { level: Level; text: string; basis: string }

/** One step of the gather, in the order DBMS_STATS performs it. */
export interface Step {
  id: "resolve" | "locks" | "history" | "read" | "columns" | "global" | "indexes" | "write" | "after";
  title: string;
  status: "does" | "skips" | "stops" | "note";
  text: string;
  reads?: string;
  basis?: string;
}

export type Source = "call" | "preference" | "default" | "ignored" | "job";
/** Where one setting of the gather came from. */
export interface Resolved { param: string; value: string; source: Source; note?: string }

/** What is read, in units of one partition (B blocks). For a plain table N = 1. */
export interface Read { newParts: number; changedParts: number; otherParts: number; extraPass: number; globalScan: number }

export interface Effective {
  incremental: boolean;
  granularity: Granularity;
  estimatePercent: Percent;
  methodOpt: MethodOpt;
  cascade: "AUTO_CASCADE" | "TRUE" | "FALSE";
  noInvalidate: "AUTO_INVALIDATE" | "FALSE" | "TRUE";
  options: "GATHER" | "GATHER AUTO";
  blockSample: boolean;
  ignored: string[];
}

export interface ScanPlan {
  kind: "full" | "row-sample" | "block-sample" | "none";
  percent: number | null;
  passes: number;
  text: string;
}

export interface ColumnPlan {
  basic: string;
  ndv: string;
  rule: string;
  kinds: string[];
  extraSample: boolean;
  deleted: boolean;
  text: string;
}

export interface IndexPlan {
  mode: "AUTO_CASCADE" | "TRUE" | "FALSE";
  fullScans: number;
  partitionScans: number;
  text: string;
}

export interface WritePlan {
  destination: "dictionary" | "pending" | "nothing";
  history: string;
  invalidation: "rolling" | "immediate" | "never" | "none";
  text: string;
}

export interface AutoPlan {
  tableChangePercent: number;
  thresholdRows: number;
  stale: boolean;
  text: string;
}

/** Counts for the partition map: how many partitions of each kind are read now. */
export interface Cells {
  total: number;
  newRead: number; newLeft: number;
  changedRead: number; changedLeft: number;
  locked: number; lockedChanged: number;
  otherRead: number; otherLeft: number;
  extraPass: boolean;
  globalScan: boolean;
}

export interface Outcome {
  input: Input;
  error: string | null;
  read: Read;
  blocks: number;
  partitionsRead: number;
  global: "merged" | "fullscan" | "sample" | "untouched" | "pending" | "unchanged" | "na";
  globalNotes: string | null;
  synopsesAfter: "all" | "none" | "stale" | "table" | "partial" | "na";
  verdict: [Level, string];
  effective: Effective;
  resolved: Resolved[];
  findings: Finding[];
  fixes: string[];
  sql: string;
  dryRun: string;
  verify: string;
  steps: Step[];
  scan: ScanPlan;
  columns: ColumnPlan;
  indexes: IndexPlan;
  write: WritePlan;
  auto: AutoPlan;
  cells: Cells;
  left: { newParts: number; changedParts: number; lack: number };
  lockedNoSynopsisAfter: boolean;
  next: Outcome | null;
}
