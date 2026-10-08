import { BOOLS, DEFAULTS, FIELD_LABELS, NAME_MAX, OPTIONS, STRINGS, type Input, type NumberKey } from "./defaults";
import { fmt } from "./format";

const isTrue = (v: unknown): boolean => v === true || String(v).toUpperCase() === "TRUE";

/**
 * Normalise an input: fill defaults, coerce types, clamp numbers, and keep
 * newPartitions + changedPartitions + lockedPartitions <= partitions. `keep` names the field the
 * reader is editing: it is reduced last. Returns { input, notes }, with a note for every number
 * that had to change, so the form can show it instead of silently computing with other numbers.
 */
export function clampInput(raw: Partial<Record<keyof Input, unknown>> | null | undefined, keep?: keyof Input): { input: Input; notes: string[] } {
  const p: Record<string, unknown> = { ...DEFAULTS, ...(raw ?? {}) };
  const notes: string[] = [];
  const num = (k: NumberKey, lo: number, hi: number, int = true) => {
    const given = Number(p[k]);
    let v = Number.isFinite(given) ? given : DEFAULTS[k];
    if (int) v = Math.round(v);
    v = Math.min(hi, Math.max(lo, v));
    if (Number.isFinite(given) && given !== v) notes.push(`${FIELD_LABELS[k]} changed from ${fmt(given, 6)} to ${fmt(v, 6)} (allowed ${fmt(lo)} to ${fmt(hi)}).`);
    p[k] = v;
  };
  for (const k of BOOLS) p[k] = isTrue(p[k]);
  if (!p.partitioned) p.partitions = 1;
  num("partitions", p.partitioned ? 2 : 1, 100000);
  num("blocksPerPartition", 1, 1e9);
  num("numRows", 0, 1e13);
  num("columnCount", 1, 1000);
  num("indexCount", 0, 500);
  num("localIndexCount", 0, Number(p.indexCount));
  if (!p.partitioned) p.localIndexCount = 0;
  num("stalePercent", 0, 100, false);
  num("changePercent", 0, 100, false);
  num("tableChangePercent", 0, 1000, false);
  const N = Number(p.partitions);
  for (const k of ["newPartitions", "changedPartitions", "lockedPartitions"] as const) num(k, 0, N);
  const order: NumberKey[] = ["lockedPartitions", "newPartitions", "changedPartitions"];
  if (keep && (order as string[]).includes(keep)) order.splice(0, 0, ...order.splice(order.indexOf(keep as NumberKey), 1));
  let room = N;
  for (const k of order) {
    const v = Number(p[k]);
    if (v > room) {
      notes.push(`${FIELD_LABELS[k]} changed from ${fmt(v)} to ${fmt(room)}: new, changed and locked partitions together cannot exceed ${fmt(N)}.`);
      p[k] = room;
    }
    room -= Number(p[k]);
  }
  {
    const given = Number(p.lockedChanged);
    const v = Math.max(0, Math.min(Number(p.lockedPartitions), Number.isFinite(given) ? Math.round(given) : 0));
    if (Number.isFinite(given) && given !== v) notes.push(`${FIELD_LABELS.lockedChanged} changed from ${fmt(given)} to ${fmt(v)}: it cannot exceed the locked partitions.`);
    p.lockedChanged = v;
  }
  for (const k of ["incremental", "publish", "overrides"] as const) p[k] = isTrue(p[k]) ? "TRUE" : "FALSE";
  for (const [k, list] of Object.entries(OPTIONS)) {
    if (k === "incremental" || k === "publish" || k === "overrides") continue;
    if (!(list as readonly string[]).includes(String(p[k]))) p[k] = DEFAULTS[k as keyof Input];
  }
  const pctOf = <T extends string>(v: unknown, none: T): T | number => {
    const n = Number(v);
    return v === none || v == null || v === "" || !Number.isFinite(n) ? none : Math.min(100, Math.max(0.000001, n));
  };
  p.estimatePercent = pctOf(p.estimatePercent, "auto");
  p.callEstimatePercent = pctOf(p.callEstimatePercent, "none");
  for (const k of STRINGS) p[k] = String(p[k] ?? "").trim().slice(0, NAME_MAX);
  if (p.degree === "") p.degree = "NULL";
  if (!p.partitioned) {
    // partition-only fields have no meaning on a plain table
    Object.assign(p, { newPartitions: 0, changedPartitions: 0, lockedPartitions: 0, lockedChanged: 0, lockedNoSynopsis: false, partname: "none" });
  }
  return { input: p as unknown as Input, notes };
}
