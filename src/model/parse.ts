// parsePrefs: read a form out of pasted text. The collector script's block (ADVISOR INPUT BEGIN to
// END: preferences, counts and names as NAME = VALUE lines), or just preferences as
// SET_TABLE_PREFS / SET_GLOBAL_PREFS calls, DBA_TAB_STAT_PREFS rows, NAME = VALUE lines or the
// one-row output of a GET_PREFS query. Beside the form it keeps what the setup scripts need: the
// pasted text of each preference, the TABLE_PREFS list (preferences the table sets itself) and the
// HISTOGRAM_COLUMNS list.

import { GRANULARITIES, NAME_MAX, OPTIONS, type Input } from "./defaults";
import { emptyProvenance, type Provenance } from "./setup";

const ALIASES: Record<string, string> = {
  incremental: "INCREMENTAL", incremental_level: "INCREMENTAL_LEVEL", incr_level: "INCREMENTAL_LEVEL",
  incremental_staleness: "INCREMENTAL_STALENESS", incr_staleness: "INCREMENTAL_STALENESS", publish: "PUBLISH",
  estimate_percent: "ESTIMATE_PERCENT", granularity: "GRANULARITY", method_opt: "METHOD_OPT",
  stale_percent: "STALE_PERCENT", preference_overrides_parameter: "PREFERENCE_OVERRIDES_PARAMETER", overrides: "PREFERENCE_OVERRIDES_PARAMETER",
  cascade: "CASCADE", no_invalidate: "NO_INVALIDATE", options: "OPTIONS", degree: "DEGREE",
  approximate_ndv_algorithm: "APPROXIMATE_NDV_ALGORITHM",
};
const UNMODELLED = new Set(["AUTOSTATS_TARGET", "TABLE_CACHED_BLOCKS", "AUTO_STAT_EXTENSIONS",
  "GLOBAL_TEMP_TABLE_STATS", "WAIT_TIME_TO_UPDATE_STATS", "ROOT_TRIGGER_PDB", "JOB_OVERHEAD", "JOB_OVERHEAD_PERC", "CONCURRENT", "AUTO_TASK_STATUS",
  "AUTO_TASK_MAX_RUN_TIME", "AUTO_TASK_INTERVAL", "INCREMENTAL_INTERNAL_CONTROL", "NDV_ALGORITHM", "SCAN_RATE", "MAXIMUM_AUTO_SAMPLE_PERCENT", "STAT_CATEGORY", "COORDINATOR_TRIGGER_SHARD"]);
const canonical = (name: string): string | null => ALIASES[String(name).trim().toLowerCase()] ?? null;

type Kind = "name" | "number" | "option" | "flag";
/** The non-preference keys of the collector's block: key -> form field and how to read the value. */
const FORM_KEYS: Record<string, [keyof Input, Kind]> = {
  OWNER: ["owner", "name"], TABLE_NAME: ["tableName", "name"], NEW_PARTITION: ["newPartitionName", "name"],
  CHANGED_PARTITION: ["changedPartitionName", "name"], LOCKED_PARTITION: ["lockedPartitionName", "name"],
  PARTITIONED: ["partitioned", "flag"],
  PARTITIONS: ["partitions", "number"], BLOCKS_PER_PARTITION: ["blocksPerPartition", "number"], BLOCKS: ["blocksPerPartition", "number"],
  NUM_ROWS: ["numRows", "number"], COLUMNS: ["columnCount", "number"], INDEXES: ["indexCount", "number"], LOCAL_INDEXES: ["localIndexCount", "number"],
  HISTOGRAMS: ["histogramsPresent", "flag"], COLUMN_USAGE: ["columnUsageRecorded", "flag"],
  NEW_PARTITIONS: ["newPartitions", "number"], CHANGED_PARTITIONS: ["changedPartitions", "number"], CHANGE_PERCENT: ["changePercent", "number"],
  TABLE_CHANGE_PERCENT: ["tableChangePercent", "number"], LOCKED_PARTITIONS: ["lockedPartitions", "number"],
  LOCKED_CHANGED: ["lockedChanged", "number"], SYNOPSES: ["synopses", "option"], TABLE_STATS: ["tableStats", "option"], COLUMN_CHANGE: ["columnChange", "option"],
  LOCKED_NO_SYNOPSIS: ["lockedNoSynopsis", "flag"], TABLE_LOCKED: ["tableLocked", "flag"], OLD_FORMAT_PARTITIONS: ["oldFormatPartitions", "number"],
};

type Values = Partial<Record<keyof Input, unknown>>;
type R = { ok: true } | { ok: false; reason: string };

function applyKey(name: string, raw: unknown, values: Values): R {
  const [field, kind] = FORM_KEYS[name]!;
  const v = String(raw ?? "").trim();
  if (kind === "name") { values[field] = v.replace(/^"(.*)"$/s, "$1").trim().slice(0, NAME_MAX); return { ok: true }; }
  if (kind === "number") {
    const n = Number(/^[+-]?\d+,\d+$/.test(v) ? v.replace(",", ".") : v); // a comma decimal from an NLS setting
    if (v === "" || !Number.isFinite(n) || n < 0) return { ok: false, reason: "expected a number" };
    values[field] = n;
    if (field === "tableChangePercent") values.useTableChangePercent = true;
    return { ok: true };
  }
  if (kind === "option") {
    const o = v.toLowerCase();
    const list = (OPTIONS as Record<string, readonly string[]>)[field] ?? [];
    if (!list.includes(o)) return { ok: false, reason: `expected ${list.join(", ")}` };
    values[field] = o;
    return { ok: true };
  }
  const u = v.toUpperCase();
  if (["1", "TRUE", "YES"].includes(u)) values[field] = true;
  else if (["0", "FALSE", "NO"].includes(u)) values[field] = false;
  else return { ok: false, reason: "expected 0, 1, TRUE, FALSE, YES or NO" };
  return { ok: true };
}

function applyPref(name: string, raw: unknown, values: Values, notes: string[]): R {
  const v = String(raw ?? "").trim().replace(/^'(.*)'$/s, "$1").trim();
  const u = v.toUpperCase();
  switch (name) {
    case "INCREMENTAL": values.incremental = u; break;
    case "PUBLISH": values.publish = u; break;
    case "PREFERENCE_OVERRIDES_PARAMETER": values.overrides = u; break;
    case "INCREMENTAL_LEVEL":
      if (u !== "PARTITION" && u !== "TABLE") return { ok: false, reason: "expected PARTITION or TABLE" };
      values.incrementalLevel = u;
      return { ok: true };
    case "INCREMENTAL_STALENESS": {
      if (u === "" || u === "NULL") { Object.assign(values, { useStalePercent: false, useLockedStats: false, allowMixedFormat: false }); return { ok: true }; }
      const t = u.split(/[\s,]+/).filter(Boolean);
      if (!t.some((x) => ["USE_STALE_PERCENT", "USE_LOCKED_STATS", "ALLOW_MIXED_FORMAT"].includes(x))) return { ok: false, reason: "no known staleness flag" };
      Object.assign(values, { useStalePercent: t.includes("USE_STALE_PERCENT"), useLockedStats: t.includes("USE_LOCKED_STATS"), allowMixedFormat: t.includes("ALLOW_MIXED_FORMAT") });
      return { ok: true };
    }
    case "ESTIMATE_PERCENT": {
      if (/AUTO_SAMPLE_SIZE/.test(u) || u === "0") { values.estimatePercent = "auto"; return { ok: true }; }
      const n = Number(u);
      if (!Number.isFinite(n) || n <= 0 || n > 100) return { ok: false, reason: "expected AUTO_SAMPLE_SIZE or a number up to 100" };
      values.estimatePercent = n;
      return { ok: true };
    }
    case "GRANULARITY": {
      const g = u.replace(/\s+/g, " ");
      if (!(GRANULARITIES as readonly string[]).includes(g)) return { ok: false, reason: "unknown GRANULARITY value" };
      values.granularity = g;
      return { ok: true };
    }
    case "METHOD_OPT":
      if (/SKEWONLY/.test(u)) { values.methodOpt = "skewonly"; notes.push("METHOD_OPT uses SIZE SKEWONLY: histograms are chosen from the data alone; the column-usage reread of an incremental table was not observed with it."); }
      else if (/FOR\s+COLUMNS/.test(u)) values.methodOpt = "pinned";
      else if (/SIZE\s+REPEAT/.test(u)) values.methodOpt = "repeat";
      else if (/SIZE\s+1\b/.test(u)) values.methodOpt = "size1";
      else if (/SIZE\s+AUTO/.test(u)) values.methodOpt = "auto";
      else if (/SIZE\s+\d+/.test(u)) values.methodOpt = "pinned";
      else values.methodOpt = "auto";
      return { ok: true };
    case "STALE_PERCENT": {
      const n = Number(u);
      if (!Number.isFinite(n) || n < 0) return { ok: false, reason: "expected a non-negative number" };
      values.stalePercent = n;
      return { ok: true };
    }
    case "CASCADE": {
      const c = /AUTO_CASCADE/.test(u) ? "AUTO_CASCADE" : u === "TRUE" || u === "FALSE" ? u : null;
      if (!c) return { ok: false, reason: "expected TRUE, FALSE or DBMS_STATS.AUTO_CASCADE" };
      values.cascade = c;
      return { ok: true };
    }
    case "NO_INVALIDATE": {
      const c = /AUTO_INVALIDATE/.test(u) ? "AUTO_INVALIDATE" : u === "TRUE" || u === "FALSE" ? u : null;
      if (!c) return { ok: false, reason: "expected TRUE, FALSE or DBMS_STATS.AUTO_INVALIDATE" };
      values.noInvalidate = c;
      return { ok: true };
    }
    case "OPTIONS": {
      const c = u.replace(/\s+/g, " ");
      if (c !== "GATHER" && c !== "GATHER AUTO") return { ok: false, reason: "expected GATHER or GATHER AUTO" };
      values.options = c;
      return { ok: true };
    }
    case "APPROXIMATE_NDV_ALGORITHM": {
      const a = /ADAPTIVE/.test(u) ? "ADAPTIVE SAMPLING" : /REPEAT/.test(u) ? "REPEAT OR HYPERLOGLOG" : /HYPERLOGLOG/.test(u) ? "HYPERLOGLOG" : null;
      if (!a) return { ok: false, reason: "expected REPEAT OR HYPERLOGLOG, ADAPTIVE SAMPLING or HYPERLOGLOG" };
      values.ndvAlgorithm = a;
      return { ok: true };
    }
    case "DEGREE":
      values.degree = v === "" ? "NULL" : v.slice(0, NAME_MAX);
      return { ok: true };
    default: return { ok: false, reason: "not modelled" };
  }
  if (u !== "TRUE" && u !== "FALSE") { delete values[name === "INCREMENTAL" ? "incremental" : name === "PUBLISH" ? "publish" : "overrides"]; return { ok: false, reason: "expected TRUE or FALSE" }; }
  return { ok: true };
}

export interface Parsed { values: Partial<Input>; recognised: string[]; ignored: string[]; ignoredDetail: { line: string; reason: string }[]; notes: string[]; provenance: Provenance }

/** The list keys of the collector's block, read into the provenance rather than the form. */
const LIST_KEYS: Record<string, "tablePrefs" | "histogramColumns"> = { TABLE_PREFS: "tablePrefs", HISTOGRAM_COLUMNS: "histogramColumns" };
const splitList = (v: string) => v.split(/[,\s]+/).map((x) => x.trim().replace(/^"(.*)"$/s, "$1")).filter(Boolean).map((x) => x.slice(0, NAME_MAX));

export function parsePrefs(text: string | null | undefined): Parsed {
  const values: Values = {}, recognised: string[] = [], ignored: string[] = [], ignoredDetail: { line: string; reason: string }[] = [], notes: string[] = [];
  const provenance = emptyProvenance();
  const reject = (raw: string, reason: string) => { const line = raw.trim().replace(/\s+/g, " "); ignored.push(line); ignoredDetail.push({ line, reason }); };
  const take = (name: string, value: string, line: string, tableLevel = false) => {
    const r = applyPref(name, value, values, notes);
    if (r.ok) {
      if (!recognised.includes(name)) recognised.push(name);
      provenance.raw[name] = String(value ?? "").trim().replace(/^'(.*)'$/s, "$1").trim();
      if (tableLevel) { provenance.tablePrefs ??= []; if (!provenance.tablePrefs.includes(name)) provenance.tablePrefs.push(name); }
    } else reject(line, r.reason);
  };
  const route = (name: string, value: string, line: string, tableLevel = false) => {
    const key = String(name).trim().toUpperCase();
    const c = canonical(name);
    if (Object.hasOwn(LIST_KEYS, key)) {
      provenance[LIST_KEYS[key]!] = splitList(String(value ?? "").trim().replace(/^\((.*)\)$/s, "$1"));
      if (!recognised.includes(key)) recognised.push(key);
    } else if (Object.hasOwn(FORM_KEYS, key)) {
      const r = applyKey(key, value, values);
      if (r.ok) { if (!recognised.includes(key)) recognised.push(key); } else reject(line, r.reason);
    } else if (c) take(c, value, line, tableLevel);
    else reject(line, UNMODELLED.has(key) ? "not modelled" : "not recognised");
  };

  let source = String(text ?? "");
  const begin = source.search(/ADVISOR INPUT BEGIN/i);
  if (begin >= 0) {
    source = source.slice(begin).replace(/^[^\n]*\n?/, "");
    const end = source.search(/ADVISOR INPUT END/i);
    if (end >= 0) source = source.slice(0, end);
  }
  const dashLine = /^\s*-{2,}(?:\s+-{2,})*\s*$/; // the rule under a SQL*Plus header is not a comment
  source = source.split(/\r?\n/).filter((l) => !/^\s*--/.test(l) || dashLine.test(l)).join("\n");

  // 1. SET_TABLE_PREFS('X', 'Y', 'NAME', 'VALUE'), SET_SCHEMA_PREFS(...), SET_GLOBAL_PREFS('NAME', 'VALUE')
  const rest = source.replace(/SET_(TABLE|SCHEMA|GLOBAL)_PREFS\s*\(((?:'(?:[^']|'')*'|[^')])*)\)/gi, (whole: string, kind: string, args: string) => {
    const q = [...args.matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] ?? "").replace(/''/g, "'"));
    const resetsDefault = /,\s*NULL\s*$/i.test(args);
    if (resetsDefault) q.push("NULL");
    const k = kind.toUpperCase();
    const [name, value] = k === "TABLE" ? [q[2], q[3]] : k === "SCHEMA" ? [q[1], q[2]] : [q[0], q[1]];
    const line = whole.replace(/\s+/g, " ").trim();
    if (name === undefined || value === undefined) reject(line, "could not read the arguments");
    // SQL NULL resets the preference; the string 'NULL' disables all staleness flags.
    else route(name, resetsDefault && canonical(name) === "INCREMENTAL_STALENESS" ? "ALLOW_MIXED_FORMAT" : value, line, k === "TABLE");
    return "\n";
  });

  const lines = rest.split(/\r?\n/);
  const noise = /^(SQL>|PL\/SQL procedure|\d+ rows? selected|no rows selected|Elapsed:|\/$|BEGIN$|END;?$|DECLARE$|--|ORA-\d+|ERROR at line|Enter value for|old\s+\d+:|new\s+\d+:|\*$|\(?(SELECT|FROM|WHERE|WITH|JOIN|LEFT|CONNECT|GROUP|ORDER|AND|ON)\s)/i; // the last group: the SQL line SQL*Plus echoes under an error
  const columns = (dl: string) => [...dl.matchAll(/-+/g)].map((m) => ({ start: m.index ?? 0 }));
  const slices = (cols: { start: number }[], line: string) => cols.map((c, i) => line.slice(c.start, i + 1 < cols.length ? cols[i + 1]!.start : undefined).trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (!t || noise.test(t) || dashLine.test(t) || /PREFERENCE_NAME/i.test(t)) continue;

    // 4. header, dashes, one row of values (SQL*Plus), or tab separated header and values
    const l1 = lines[i + 1], l2 = lines[i + 2];
    if (l1 !== undefined && dashLine.test(l1) && l2 !== undefined) {
      const cols = columns(l1);
      const names = slices(cols, line);
      if (names.filter((n) => canonical(n)).length >= 2) {
        const vals = slices(cols, l2);
        names.forEach((n, j) => route(n, vals[j] ?? "", `${n} = ${vals[j] ?? ""}`));
        i += 2;
        continue;
      }
    }
    if (t.includes("\t")) {
      const names = line.split("\t").map((s) => s.trim());
      if (names.filter((n) => canonical(n)).length >= 2 && l1 !== undefined) {
        const j0 = dashLine.test(l1.replace(/\t/g, " ")) ? i + 2 : i + 1;
        const vals = (lines[j0] ?? "").split("\t").map((s) => s.trim());
        names.forEach((n, j) => route(n, vals[j] ?? "", `${n} = ${vals[j] ?? ""}`));
        i = j0;
        continue;
      }
    }

    // 3. NAME = VALUE or NAME: VALUE
    const eq = t.match(/^([A-Za-z_][\w$]*)\s*[=:]\s*(.*)$/);
    if (eq) { route(eq[1]!, eq[2] ?? "", t); continue; }

    // 2. NAME  VALUE (a DBA_TAB_STAT_PREFS row, perhaps after OWNER and TABLE_NAME)
    const toks = [...t.matchAll(/\S+/g)];
    let hit = -1;
    for (let k = 0; k < Math.min(3, toks.length); k++) { const w = toks[k]![0]; if (canonical(w) || UNMODELLED.has(w.toUpperCase())) { hit = k; break; } }
    if (hit >= 0) { const m = toks[hit]!; route(m[0], t.slice((m.index ?? 0) + m[0].length).trim(), t); }
    else reject(t, "not recognised");
  }
  return { values: values as Partial<Input>, recognised, ignored, ignoredDetail, notes, provenance };
}
