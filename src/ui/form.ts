// The form: built from a declarative list of groups and fields, with per-field visibility.
import { FIELD_LABELS, NAME_MAX, OPTIONS, type Input } from "../model/defaults";
import { el } from "./dom";

type Field =
  | { key: keyof Input; type: "text" | "number" | "select" | "check"; label?: string | ((i: Input) => string); min?: number; max?: number; step?: number | "any"; show?: (i: Input) => boolean; hint?: string }
  | { key: "staleness"; type: "checks"; label: string; keys: (keyof Input)[]; show?: (i: Input) => boolean }
  | { key: "estimatePercent" | "callEstimatePercent"; type: "percent"; label: string; none: "auto" | "none"; noneLabel: string; fixedLabel: string; show?: (i: Input) => boolean };

interface Group { id: string; legend: string; buttons?: boolean; fields: Field[] }

const isPart = (i: Input) => i.partitioned;
const isFlat = (i: Input) => !i.partitioned;
const isCall = (i: Input) => i.runBy === "call";
const isInc = (i: Input) => i.incremental === "TRUE";

export const LABELS: Partial<Record<keyof Input, Record<string, string>>> = {
  methodOpt: { auto: "FOR ALL COLUMNS SIZE AUTO", skewonly: "FOR ALL COLUMNS SIZE SKEWONLY", repeat: "FOR ALL COLUMNS SIZE REPEAT", pinned: "Pinned: explicit column list", size1: "FOR ALL COLUMNS SIZE 1" },
  callMethodOpt: { none: "Not passed", auto: "FOR ALL COLUMNS SIZE AUTO", skewonly: "FOR ALL COLUMNS SIZE SKEWONLY", repeat: "FOR ALL COLUMNS SIZE REPEAT", pinned: "Pinned: explicit column list", size1: "FOR ALL COLUMNS SIZE 1" },
  cascade: { AUTO_CASCADE: "AUTO_CASCADE: Oracle decides per index", TRUE: "TRUE: every index", FALSE: "FALSE: no index" },
  callCascade: { none: "Not passed", AUTO_CASCADE: "DBMS_STATS.AUTO_CASCADE", TRUE: "TRUE", FALSE: "FALSE" },
  noInvalidate: { AUTO_INVALIDATE: "AUTO_INVALIDATE: rolling, about 5 h", FALSE: "FALSE: at once", TRUE: "TRUE: never" },
  callNoInvalidate: { none: "Not passed", AUTO_INVALIDATE: "DBMS_STATS.AUTO_INVALIDATE", FALSE: "FALSE", TRUE: "TRUE" },
  options: { GATHER: "GATHER: everything", "GATHER AUTO": "GATHER AUTO: only what is missing or stale" },
  callOptions: { none: "Not passed", GATHER: "GATHER", "GATHER AUTO": "GATHER AUTO" },
  runBy: { call: "A GATHER_TABLE_STATS call", auto: "The automatic job (nightly, GATHER AUTO)" },
  partname: { none: "Not passed", new: "The new partition", changed: "A changed, unlocked partition" },
  callGranularity: { none: "Not passed" },
  synopses: { all: "Every partition has one that matches", none: "None yet", stale: "They exist but no longer match" },
  tableStats: { gathered: "Gathered before", none: "None yet", load: "From a direct-path load (STATS_ON_LOAD)" },
  columnChange: { none: "None", usage: "A first predicate on a column with no histogram", group: "A new column group", histogram: "One more histogram in the pinned METHOD_OPT" },
};

export const GROUPS: Group[] = [
  { id: "table", legend: "Your table", fields: [
    { key: "owner", type: "text", label: "Owner" },
    { key: "tableName", type: "text", label: "Table" },
    { key: "partitioned", type: "check", label: "Partitioned" },
    { key: "partitions", type: "number", label: "Partitions", min: 2, step: 1, show: isPart },
    { key: "blocksPerPartition", type: "number", label: (i) => (i.partitioned ? "Blocks per partition" : "Blocks"), min: 1, step: 1 },
    { key: "numRows", type: "number", label: "Rows (NUM_ROWS)", min: 0, step: 1, hint: "for the STALE_PERCENT threshold" },
    { key: "columnCount", type: "number", label: "Columns", min: 1, step: 1 },
    { key: "indexCount", type: "number", label: "Indexes", min: 0, step: 1 },
    { key: "localIndexCount", type: "number", label: "Of those, local", min: 0, step: 1, show: isPart },
    { key: "histogramsPresent", type: "check", label: "The table has histograms today" },
    { key: "columnUsageRecorded", type: "check", label: "Column usage has been recorded (queries filtered on its columns)" },
  ] },
  { id: "prefs", legend: "Preferences in force", buttons: true, fields: [
    { key: "incremental", type: "select", label: "INCREMENTAL" },
    { key: "incrementalLevel", type: "select", label: "INCREMENTAL_LEVEL", show: isInc },
    { key: "staleness", type: "checks", label: "INCREMENTAL_STALENESS", keys: ["useStalePercent", "useLockedStats", "allowMixedFormat"], show: (i) => isInc(i) && isPart(i) },
    { key: "publish", type: "select", label: "PUBLISH" },
    { key: "estimatePercent", type: "percent", label: "ESTIMATE_PERCENT", none: "auto", noneLabel: "AUTO_SAMPLE_SIZE", fixedLabel: "A fixed percentage" },
    { key: "granularity", type: "select", label: "GRANULARITY", show: isPart },
    { key: "methodOpt", type: "select", label: "METHOD_OPT" },
    { key: "cascade", type: "select", label: "CASCADE" },
    { key: "noInvalidate", type: "select", label: "NO_INVALIDATE" },
    { key: "options", type: "select", label: "OPTIONS" },
    { key: "degree", type: "text", label: "DEGREE (shown, not modelled)" },
    { key: "stalePercent", type: "number", label: "STALE_PERCENT", min: 0, max: 100, step: "any" },
    { key: "overrides", type: "select", label: "PREFERENCE_OVERRIDES_PARAMETER" },
  ] },
  { id: "call", legend: "The gather", fields: [
    { key: "runBy", type: "select", label: "Run by" },
    { key: "partname", type: "select", label: "partname", show: (i) => isCall(i) && isPart(i) },
    { key: "callGranularity", type: "select", label: "granularity", show: (i) => isCall(i) && isPart(i) },
    { key: "callEstimatePercent", type: "percent", label: "estimate_percent", none: "none", noneLabel: "Not passed", fixedLabel: "Passed", show: isCall },
    { key: "callBlockSample", type: "check", label: "block_sample => TRUE", show: (i) => isCall(i) && i.callEstimatePercent !== "none" },
    { key: "callMethodOpt", type: "select", label: "method_opt", show: isCall },
    { key: "callCascade", type: "select", label: "cascade", show: isCall },
    { key: "callNoInvalidate", type: "select", label: "no_invalidate", show: isCall },
    { key: "callOptions", type: "select", label: "options", show: isCall },
    { key: "force", type: "check", label: "force => TRUE", show: isCall },
  ] },
  { id: "since", legend: "Since the last gather", fields: [
    { key: "tableStats", type: "select", label: "Statistics today", show: isFlat },
    { key: "tableChangePercent", type: "number", label: "Rows changed since the last gather, % of NUM_ROWS", min: 0, max: 1000, step: "any", show: isFlat },
    { key: "synopses", type: "select", label: "Synopses", show: isPart },
    { key: "newPartitions", type: "number", label: "New partitions, loaded, no statistics yet", min: 0, step: 1, show: isPart },
    { key: "changedPartitions", type: "number", label: "Older, unlocked partitions with DML", min: 0, step: 1, show: isPart },
    { key: "changePercent", type: "number", label: "How much each of them changed, % of rows", min: 0, max: 100, step: "any", show: isPart },
    { key: "lockedPartitions", type: "number", label: "Partitions with LOCK_PARTITION_STATS", min: 0, step: 1, show: isPart },
    { key: "lockedChanged", type: "number", label: "Of those, with DML", min: 0, step: 1, show: (i) => isPart(i) && i.lockedPartitions > 0 },
    { key: "lockedNoSynopsis", type: "check", label: "A locked partition has no synopsis (statistics copied in, then locked)", show: (i) => isPart(i) && i.lockedPartitions > 0 },
    { key: "tableLocked", type: "check", label: "LOCK_TABLE_STATS on the table" },
    { key: "columnChange", type: "select", label: "Column change", show: isPart },
  ] },
];

export interface Control { nodes: HTMLElement[]; wrap: HTMLElement; get(): unknown; set(v: unknown): void }

/** Build the form into `host`; returns the controls by field key and a function that applies visibility and dynamic labels. */
export function buildForm(host: HTMLElement, onChange: (key: keyof Input) => void) {
  const ctl: Partial<Record<keyof Input, Control>> = {};
  const wraps: { wrap: HTMLElement; show?: (i: Input) => boolean; labelNode?: HTMLElement; label?: (i: Input) => string }[] = [];
  const optLabel = (key: keyof Input, v: string) => LABELS[key]?.[v] ?? v;

  const fieldNode = (f: Field): HTMLElement => {
    const id = `f-${f.key}`;
    let wrap: HTMLElement, labelNode: HTMLElement | undefined;
    if (f.type === "select") {
      const sel = el("select", { id }, (OPTIONS[f.key as keyof typeof OPTIONS] as readonly string[]).map((v) => el("option", { value: v }, optLabel(f.key, v))));
      labelNode = el("span", {}, typeof f.label === "function" ? "" : f.label ?? FIELD_LABELS[f.key]);
      wrap = el("label", { class: "ctl" }, [labelNode, sel]);
      ctl[f.key] = { nodes: [sel], wrap, get: () => sel.value, set: (v) => { sel.value = String(v); } };
    } else if (f.type === "text") {
      const inp = el("input", { id, type: "text", maxlength: NAME_MAX, spellcheck: "false", autocomplete: "off", autocapitalize: "off" });
      labelNode = el("span", {}, typeof f.label === "function" ? "" : f.label ?? FIELD_LABELS[f.key]);
      wrap = el("label", { class: "ctl" }, [labelNode, inp]);
      ctl[f.key] = { nodes: [inp], wrap, get: () => inp.value, set: (v) => { inp.value = String(v ?? ""); } };
    } else if (f.type === "number") {
      const inp = el("input", { id, type: "number", min: f.min, max: f.max, step: f.step, inputmode: "decimal" });
      labelNode = el("span", {}, typeof f.label === "function" ? "" : f.label ?? FIELD_LABELS[f.key]);
      wrap = el("label", { class: "ctl" }, [labelNode, inp, f.hint ? el("small", { class: "hint" }, f.hint) : null]);
      ctl[f.key] = { nodes: [inp], wrap, get: () => (inp.value.trim() === "" ? NaN : Number(inp.value)), set: (v) => { inp.value = String(v); } };
    } else if (f.type === "check") {
      const cb = el("input", { id, type: "checkbox" });
      wrap = el("label", { class: "ctl check" }, [cb, el("span", {}, typeof f.label === "function" ? "" : f.label ?? FIELD_LABELS[f.key])]);
      ctl[f.key] = { nodes: [cb], wrap, get: () => cb.checked, set: (v) => { cb.checked = !!v; } };
    } else if (f.type === "percent") {
      // a mode select and a number
      const mode = el("select", { id: `${id}-mode`, "aria-label": `${f.label}: how it is set` }, [el("option", { value: "none" }, f.noneLabel), el("option", { value: "fixed" }, f.fixedLabel)]);
      const inp = el("input", { id, type: "number", min: 0.000001, max: 100, step: "any", value: "10", "aria-label": `${f.label}: percent`, hidden: true });
      const sync = () => { inp.hidden = mode.value === "none"; };
      mode.addEventListener("change", sync);
      wrap = el("div", { class: "ctl" }, [el("label", { for: `${id}-mode` }, f.label), el("div", { class: "pair" }, [mode, inp])]);
      const none = f.none;
      ctl[f.key] = {
        nodes: [mode, inp], wrap,
        get: () => (mode.value === "none" ? none : inp.value.trim() === "" ? NaN : Number(inp.value)),
        set: (v) => { if (v === none) mode.value = "none"; else { mode.value = "fixed"; inp.value = String(v); } sync(); },
      };
    } else if (f.type === "checks") {
      const boxes = f.keys.map((k) => {
        const cb = el("input", { id: `f-${k}`, type: "checkbox" });
        const w = el("label", { class: "check" }, [cb, el("span", {}, FIELD_LABELS[k])]);
        ctl[k] = { nodes: [cb], wrap: w, get: () => cb.checked, set: (v) => { cb.checked = !!v; } };
        return w;
      });
      wrap = el("div", { class: "ctl", role: "group", "aria-label": f.label }, [el("span", {}, f.label), el("div", { class: "checks" }, boxes)]);
    } else {
      throw new Error("unknown field type");
    }
    wraps.push({ wrap, show: f.show, labelNode, label: typeof f.label === "function" ? f.label : undefined });
    return wrap;
  };

  for (const g of GROUPS) {
    const head: HTMLElement[] = [el("legend", {}, g.legend)];
    if (g.buttons) {
      head.push(el("div", { class: "btn-row" }, [
        el("button", { type: "button", class: "btn", id: "recommended" }, "Use the recommended setup"),
        el("button", { type: "button", class: "btn ghost", id: "reset" }, "Reset to Oracle defaults"),
      ]));
    }
    host.append(el("fieldset", { class: "set", id: `set-${g.id}` }, [...head, el("div", { class: "grid" }, g.fields.map(fieldNode))]));
  }
  for (const [key, c] of Object.entries(ctl) as [keyof Input, Control][]) for (const node of c.nodes) for (const ev of ["input", "change"]) node.addEventListener(ev, () => onChange(key));

  const applyVisibility = (input: Input) => {
    for (const w of wraps) {
      w.wrap.hidden = w.show ? !w.show(input) : false;
      if (w.label && w.labelNode) w.labelNode.textContent = w.label(input);
    }
  };
  return { ctl, applyVisibility };
}
