// Column and index sections of the health check (WP2): histograms, extended statistics, indexes, statistics quality.
// Pure rules over the typed rows of the collector's DETAIL block (src/model/detail.ts); the contract is
// docs/design-health.md. Every finding names its basis: a 19c document and section (a quoted sentence where one
// settles the rule), a lab id from docs/lab-observations.md, or "inferred" where neither does.
import type { Input } from "../defaults";
import { toTime, type ColumnRec, type Detail, type ExtensionRec, type IndexRec } from "../detail";
import { fmt, pct, plural } from "../format";
import type { Level } from "../types";
import type { HealthContext, HealthFinding, HealthSection } from "./index";

// ---------------------------------------------------------------------------------------------- shared helpers

const lit = (v: string, placeholder: string) => `'${(v || placeholder).replace(/'/g, "''")}'`;
const qlit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ownerTable = (i: Input) => `${lit(i.owner, "OWNER")}, ${lit(i.tableName, "TABLE")}`;
const ident = (s: string) => (/^[A-Z][A-Z0-9_$#]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const qualified = (i: Input, name: string) => `${i.owner ? ident(i.owner) : "OWNER"}.${ident(name)}`;
const names = (xs: string[], max = 8) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${fmt(xs.length - max)} more`);
const is = (n: number) => (n === 1 ? "is" : "are");
const has = (n: number) => (n === 1 ? "has" : "have");
/** Compare expressions the way collect.sql does: no blanks, no double quotes, upper case, one outer pair of parentheses off. */
const norm = (s: string) => {
  const t = s.replace(/[\s"]/g, "").toUpperCase();
  return t.startsWith("(") && t.endsWith(")") ? t.slice(1, -1) : t;
};
/** A column group is a parenthesis around two or more column names and nothing else (the rule of collect.sql and of EXTENSION.kind). */
const GROUP_RE = /^\(\s*"[^"]+"(\s*,\s*"[^"]+")+\s*\)$/;
const kindOf = (e: ExtensionRec): "group" | "expression" => e.kind ?? (GROUP_RE.test(e.text ?? "") ? "group" : "expression");
const prettyExt = (e: ExtensionRec) => (kindOf(e) === "group" ? (e.text ?? e.name).replace(/"/g, "").replace(/\s*,\s*/g, ", ") : (e.text ?? e.name));
const groupMembers = (e: ExtensionRec) => [...(e.text ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
const colLabel = (d: Detail, c: ColumnRec) => {
  if (!c.isExtension) return c.name;
  const e = d.extensions.find((x) => x.name === c.name);
  return e ? prettyExt(e) : c.name;
};
const hasHistogram = (e: ExtensionRec) => !!e.histogram && e.histogram !== "NONE";
/** The limit CREATE_EXTENDED_STATS enforces: a maximum of (20, 10% of the non-virtual columns). */
const extensionLimit = (i: Input) => Math.max(20, Math.floor(i.columnCount / 10));
const nonNullRows = (i: Input, c: ColumnRec) => (i.numRows > 0 ? Math.max(0, i.numRows - (c.numNulls ?? 0)) : 0);

class Report {
  readonly findings: HealthFinding[] = [];
  add(level: Level, text: string, basis: string, fix?: string[]) {
    this.findings.push(fix && fix.length ? { level, text, basis, fix } : { level, text, basis });
  }
  has(...levels: Level[]) { return this.findings.some((f) => levels.includes(f.level)); }
}

const DOC = {
  hist: "19c SQL Tuning Guide, Histograms",
  histWhen: "19c SQL Tuning Guide, Histograms, When Oracle Database Creates Histograms",
  methodOpt: "19c DBMS_STATS reference, GATHER_TABLE_STATS, method_opt",
  ext: "19c SQL Tuning Guide, Managing Extended Statistics",
  createExt: "19c DBMS_STATS reference, CREATE_EXTENDED_STATS",
  seed: "19c DBMS_STATS reference, SEED_COL_USAGE",
  reportUsage: "19c DBMS_STATS reference, REPORT_COL_USAGE",
  clustering: "19c SQL Tuning Guide, Optimizer Statistics Concepts, Index Clustering Factor",
  indexUsage: "19c Database Reference, V$INDEX_USAGE_INFO and DBA_INDEX_USAGE",
  colStats: "19c Database Reference, ALL_TAB_COL_STATISTICS",
} as const;

/** The columns a METHOD_OPT text pins with FOR COLUMNS ... (upper case, quotes off); null when it names none. */
export function pinnedColumns(methodOpt: string | undefined | null): string[] | null {
  if (!methodOpt) return null;
  const out: string[] = [];
  for (const m of methodOpt.matchAll(/FOR\s+COLUMNS\s+(.*?)(?=\bFOR\s+(?:ALL|COLUMNS)\b|$)/gis)) {
    const body = (m[1] ?? "").replace(/\bSIZE\s+(?:\d+|AUTO|REPEAT|SKEWONLY)\b/gi, " ");
    for (const t of body.split(/[\s,]+/)) if (t) out.push(t.replace(/"/g, "").toUpperCase());
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------------------------- 1. histograms

const isHist = (c: ColumnRec) => !!c.histogram && c.histogram !== "NONE";
/** NOTES HIST_FOR_INCREM_STATS: the histogram only derives the global one and the optimizer does not use it (lab E1, E3i, Td). */
const isSupport = (c: ColumnRec) => /HIST_FOR_INCREM_STATS/.test(c.notes ?? "");

export function histogramsSection(ctx: HealthContext): HealthSection | null {
  const { input, detail, prov } = ctx;
  if (!detail.columns.length) return null;
  const OT = ownerTable(input);
  const r = new Report();
  const usageKnown = detail.columnUsageCollected === true;
  const incPart = input.partitioned && input.incremental === "TRUE";
  const hist = detail.columns.filter(isHist);
  const support = hist.filter(isSupport);
  const real = hist.filter((c) => !isSupport(c));
  const label = (c: ColumnRec) => colLabel(detail, c);
  const sqlCol = (c: ColumnRec) => {
    if (!c.isExtension) return ident(c.name);
    const e = detail.extensions.find((x) => x.name === c.name);
    return e?.text ? e.text.replace(/'/g, "''") : c.name;
  };

  const rows = hist.map((c) => [
    label(c),
    `${c.histogram}${isSupport(c) ? " (support only)" : ""}`,
    fmt(c.numBuckets),
    fmt(c.numDistinct),
    c.sampleSize !== null && nonNullRows(input, c) > 0 ? `${fmt(c.sampleSize)} (${pct(Math.min(1, c.sampleSize / nonNullRows(input, c)))})` : fmt(c.sampleSize),
    usageKnown ? (c.usage.length ? c.usage.join("/") : "none recorded") : "not collected",
  ]);

  if (!usageKnown && real.length) {
    r.add("info", "REPORT_COL_USAGE was not readable, so the check cannot tell which histograms the workload uses. Run the collector as SYSDBA, or as a user with ANALYZE ANY DICTIONARY and ANALYZE ANY.",
      `${DOC.reportUsage}: “To run this procedure, you need to have the SYSDBA administrative privilege or both ANALYZE ANY DICTIONARY and ANALYZE ANY system privileges.”`);
  }

  // histograms kept only to derive the global statistics of an incremental table
  if (support.length) {
    const n = support.length;
    r.add("info", `${names(support.map(label))} ${has(n)} a histogram only to derive the table's global statistics from the partitions (NOTES HIST_FOR_INCREM_STATS). The optimizer does not use ${n === 1 ? "it" : "them"}. Leave ${n === 1 ? "it" : "them"} alone: naming ${n === 1 ? "the column" : "the columns"} in METHOD_OPT turns ${n === 1 ? "it" : "them"} into real histograms and rereads every partition.`,
      "lab E1, E3i, Td; NOTES value HIST_FOR_INCREM_STATS as quoted in docs/lab-observations.md (the 19c ALL_TAB_COL_STATISTICS page does not list it)");
  }

  // a real histogram nobody filters on
  const unused = usageKnown ? real.filter((c) => c.usage.length === 0) : [];
  if (unused.length) {
    const n = unused.length, it = n === 1 ? "it" : "them";
    const why = `A histogram only changes the cardinality estimate of a predicate on its own column, and under SIZE AUTO the gather builds histograms for columns the workload has filtered on. So ${n === 1 ? "this one" : "these"} came from SKEWONLY, REPEAT, an explicit column list, or usage that was reset since. ${n === 1 ? "It costs" : "They cost"} gather time and dictionary space for nothing.`;
    const basis = `${DOC.histWhen}: “If you gather statistics for a table and do not query the table, then the database does not create histograms for columns in this table.”; ${DOC.hist}, Purpose of Histograms; lab E6 (SIZE 1 deletes histograms); the REPEAT plus SIZE 1 call follows the METHOD_OPT grammar and was not run`;
    const head = `${names(unused.map(label))} ${has(n)} a histogram but no recorded predicate uses ${it}.`;
    if (input.methodOpt === "size1") {
      r.add("info", `${head} METHOD_OPT is SIZE 1, so the next gather deletes ${it}. Nothing to do.`, `${basis}`);
    } else if (input.methodOpt === "pinned") {
      r.add("info", `${head} METHOD_OPT pins a column list. If ${n === 1 ? "the column is" : "these columns are"} on it you chose ${it} on purpose; if no query filters on ${n === 1 ? "it" : "them"}, take ${n === 1 ? "it" : "them"} off the list. Recorded usage can be incomplete after a RESET_COL_USAGE.`, basis);
    } else if (input.methodOpt === "skewonly") {
      r.add("warn", `${head} ${why} METHOD_OPT is SIZE SKEWONLY, which builds histograms from the data alone, so ${it} comes back at every gather.`, basis,
        [`EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'METHOD_OPT', 'FOR ALL COLUMNS SIZE AUTO')`,
         `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, method_opt => 'FOR ALL COLUMNS SIZE REPEAT FOR COLUMNS SIZE 1 ${unused.map(sqlCol).join(", ")}')  -- drops ${it} once; REPEAT keeps the other histograms`]);
    } else {
      r.add("warn", `${head} ${why}${incPart ? " On an incremental table a call that only deletes histograms rereads no partition (lab E6)." : ""}`, basis,
        [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, method_opt => 'FOR ALL COLUMNS SIZE REPEAT FOR COLUMNS SIZE 1 ${unused.map(sqlCol).join(", ")}')  -- REPEAT keeps the other histograms, SIZE 1 deletes ${it === "it" ? "this one" : "these"}`]);
    }
  }

  // METHOD_OPT SIZE 1 deletes histograms the workload uses
  if (input.methodOpt === "size1" && real.length) {
    const usedHist = real.filter((c) => c.usage.length > 0);
    if (usedHist.length) {
      const cols = prov?.histogramColumns?.length ? prov.histogramColumns : usedHist.map(sqlCol);
      r.add("warn", `METHOD_OPT is FOR ALL COLUMNS SIZE 1, but ${names(usedHist.map(label))} ${has(usedHist.length)} a histogram and ${usedHist.length === 1 ? "a query filters" : "queries filter"} on ${usedHist.length === 1 ? "it" : "them"}. The next gather deletes ${usedHist.length === 1 ? "it" : "them"}, and the estimates fall back to 1/NDV.`,
        "lab E6 (a call or preference with SIZE 1 removes every histogram); pinned list as in lab V1.6",
        [`EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'METHOD_OPT', 'FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 ${cols.join(", ")}')`]);
    }
  }

  // a pinned list that leaves a histogram column out
  if (input.methodOpt === "pinned") {
    const pinned = pinnedColumns(prov?.raw?.METHOD_OPT);
    if (pinned) {
      const left = real.filter((c) => !c.isExtension && !pinned.includes(c.name));
      if (left.length) {
        r.add("warn", `METHOD_OPT pins ${names(pinned)}, but ${names(left.map(label))} ${has(left.length)} a histogram that is not on the list. The SIZE 1 default for every other column deletes ${left.length === 1 ? "it" : "them"} at the next gather, and a gather by the automatic job and one with another METHOD_OPT then disagree about it.`,
          "lab E6 (SIZE 1 deletes histograms), Td (a changed pinned list rereads every partition of an incremental table)",
          [`EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'METHOD_OPT', 'FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 ${[...pinned, ...left.map((c) => ident(c.name))].join(", ")}')  -- keeps them; or leave them out on purpose`]);
      }
    }
  }

  // histogram kinds
  const sampled = real.filter((c) => (c.histogram === "HYBRID" || c.histogram === "TOP-FREQUENCY") && c.sampleSize !== null && nonNullRows(input, c) > 0 && c.sampleSize < 0.5 * nonNullRows(input, c));
  if (sampled.length) {
    r.add("info", `${names(sampled.map((c) => `${label(c)} (${fmt(c.sampleSize)} of ${fmt(nonNullRows(input, c))} rows)`))}: ${sampled.length === 1 ? "this histogram was" : "these histograms were"} built from a sample. With AUTO_SAMPLE_SIZE the gather reads the table once for the basic statistics and takes a second, sampled pass for HYBRID and TOP-FREQUENCY histograms, so the endpoint counts come from the sample. That is normal; it matters only when a rare value does.`,
      "lab E3i, R2 (the second sampled pass); that endpoint counts are scaled from the sample is inferred");
  }
  const balanced = real.filter((c) => c.histogram === "HEIGHT BALANCED");
  if (balanced.length) {
    const auto = input.estimatePercent === "auto";
    r.add("warn", `${names(balanced.map(label))} ${has(balanced.length)} a HEIGHT BALANCED histogram, the legacy kind. Oracle builds it only when the NDV exceeds the bucket count and ESTIMATE_PERCENT is not AUTO_SAMPLE_SIZE. ${auto ? "ESTIMATE_PERCENT already is AUTO_SAMPLE_SIZE, so the next gather of the column replaces it; an older or hand-written call built it." : `ESTIMATE_PERCENT is ${input.estimatePercent} percent here. With AUTO_SAMPLE_SIZE the refresh replaces it with a HYBRID or TOP-FREQUENCY histogram, which treat popular values more accurately.`}`,
      `${DOC.hist}, Height-Balanced Histograms: “If the sampling percentage is AUTO_SAMPLE_SIZE, then the database creates either hybrid or frequency histograms.”; Hybrid and Top Frequency criteria: “The estimate_percent parameter in the DBMS_STATS statistics gathering procedure is set to AUTO_SAMPLE_SIZE.”`,
      auto ? undefined : [`EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'ESTIMATE_PERCENT', 'DBMS_STATS.AUTO_SAMPLE_SIZE')`]);
  }
  const wide = real.filter((c) => (c.histogram === "HYBRID" || c.histogram === "TOP-FREQUENCY") && c.numBuckets !== null && c.numBuckets >= 254 && (c.numDistinct ?? 0) > c.numBuckets && c.usage.includes("EQ"));
  if (wide.length) {
    r.add("info", `${names(wide.map((c) => `${label(c)} (${fmt(c.numDistinct)} values in ${fmt(c.numBuckets)} buckets)`))}: more distinct values than buckets, and equality predicates use ${wide.length === 1 ? "the column" : "the columns"}. A larger size is an option if the column is skewed and estimates for popular values are off; the maximum is 2048 buckets. It costs gather time and dictionary space, so try it on one column and compare plans${incPart ? "; on an incremental table a changed METHOD_OPT can reread every partition (lab Td)" : ""}.`,
      `${DOC.methodOpt}: “integer : Number of histogram buckets. Must be in the range [1,2048].”; whether it helps is a judgement, not a rule`,
      [`-- option, not a recommendation: EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'METHOD_OPT', 'FOR ALL COLUMNS SIZE AUTO FOR COLUMNS SIZE 2048 ${wide.map(sqlCol).join(", ")}')`]);
  }
  const exact = real.filter((c) => c.histogram === "FREQUENCY" && c.numBuckets !== null && c.numBuckets === c.numDistinct && !unused.includes(c));
  if (exact.length) {
    r.add("good", `${names(exact.map(label))}: FREQUENCY histogram with one bucket per distinct value, so it is exact for equality predicates.`,
      `${DOC.hist}: “Starting in Oracle Database 12c, if the sampling size is the default of AUTO_SAMPLE_SIZE, then the database creates frequency histograms from a full table scan.”`);
  }

  // columns the workload filters on that have no histogram yet
  if (usageKnown) {
    const unique = new Set(detail.uniqueColumns ?? []);
    const cand = detail.columns.filter((c) => !isHist(c) && !unique.has(c.name) && c.usage.some((u) => u === "EQ" || u === "RANGE" || u === "LIKE")
      && (c.numDistinct ?? 0) > 1 && (nonNullRows(input, c) === 0 || (c.numDistinct ?? 0) < 0.95 * nonNullRows(input, c)));
    if (cand.length) {
      const n = cand.length;
      if (input.methodOpt === "auto") {
        r.add("info", `${names(cand.map(label))} ${is(n)} filtered on (EQ, RANGE or LIKE) and ${has(n)} no histogram. Whether one is built depends on skew the gather has not looked at yet: the next SIZE AUTO gather decides.${incPart ? " On an incremental table the first gather after a first predicate rereads every partition, and a second sampled pass follows for a HYBRID histogram (lab E1, E3i); see the column-usage finding of the gather advice." : ""}`,
          `${DOC.histWhen}: “You run DBMS_STATS again, causing DBMS_STATS to query SYS.COL_USAGE$ to determine which columns require histograms based on the previous query workload.”; lab E1, E3i`);
      } else if (input.methodOpt !== "skewonly") {
        r.add("info", `${names(cand.map(label))} ${is(n)} filtered on and ${has(n)} no histogram. METHOD_OPT is ${input.methodOpt === "size1" ? "SIZE 1" : input.methodOpt === "repeat" ? "SIZE REPEAT" : "a pinned list"}, so no gather builds one. If ${n === 1 ? "the column is" : "a column is"} skewed, name ${n === 1 ? "it" : "that column"} in METHOD_OPT; otherwise leave it.`,
          `${DOC.methodOpt}: “REPEAT : Collects histograms only on the columns that already have histograms”; lab E3ii, E3iii (REPEAT builds none for new predicates)`);
      }
    }
    if (!hist.length && !detail.columns.some((c) => c.usage.length)) {
      r.add("info", `No column has a recorded predicate use${input.methodOpt === "auto" ? ", so SIZE AUTO builds no histogram until queries have run against the table" : ""}.`,
        `${DOC.histWhen}: “If you gather statistics for a table and do not query the table, then the database does not create histograms for columns in this table.”`);
    }
  }

  if (!r.findings.length) r.add("good", hist.length ? "Every histogram is used and of a current kind." : "No histograms, and no column needs one.", `${DOC.hist}; checked against REPORT_COL_USAGE`);
  const summary = hist.length === 0 ? "No histograms."
    : `${plural(hist.length, "histogram")}${support.length ? `, ${support.length} kept only for incremental statistics` : ""}${unused.length ? `, ${unused.length} with no recorded predicate use` : ""}.`;
  return { id: "histograms", title: "Histograms", summary, findings: r.findings, ...(rows.length ? { rows: { head: ["Column", "Histogram", "Buckets", "Distinct", "Sample", "Predicate use"], body: rows } } : {}) };
}

// ---------------------------------------------------------------------------------------------- 2. extended statistics

export function extendedSection(ctx: HealthContext): HealthSection | null {
  const { input, detail, prov } = ctx;
  if (!detail.columns.length) return null;
  const OT = ownerTable(input);
  const r = new Report();
  const usageKnown = detail.columnUsageCollected === true;
  const incPart = input.partitioned && input.incremental === "TRUE";
  const exts = detail.extensions;
  const groups = exts.filter((e) => kindOf(e) === "group");
  const exprs = exts.filter((e) => kindOf(e) === "expression");
  const colOf = (name: string) => detail.columns.find((c) => c.name === name && !c.isExtension);
  const fbi = (detail.fbiExpressions ?? []).map(norm);
  const known = new Set([...exts.map((e) => norm(e.text ?? "")), ...fbi]);
  // SEED_COL_USAGE is the only thing that records groups; without proof it ran, a group missing from the report says nothing
  const seedRan = groups.some((e) => e.used === true) || (prov?.columnGroupCandidates ?? []).some((c) => c.sources.includes("usage")) || detail.columns.some((c) => c.isExtension && c.usage.includes("FILTER"));
  const dropAdvice = (e: ExtensionRec) => [
    "-- confirm first: SEED_COL_USAGE over a representative workload, then REPORT_COL_USAGE (see the recipe below)",
    `EXEC DBMS_STATS.DROP_EXTENDED_STATS(${OT}, ${qlit(e.text ?? e.name)})`,
  ];
  const limit = extensionLimit(input);

  // proposed things
  const exprCands = (detail.expressionCandidates ?? []).filter((e) => !known.has(norm(e)));
  const groupCands = prov?.columnGroupCandidates ?? [];
  const eqCands = groupCands.filter((c) => c.equality);

  const rows = exts.map((e) => [
    prettyExt(e), kindOf(e), e.hasStats === null ? "–" : e.hasStats ? "yes" : "none yet", fmt(e.numDistinct), e.histogram ?? "–",
    e.used === null ? "not collected" : e.used ? "yes" : "no",
  ]);
  for (const c of eqCands) rows.push([`(${c.columns.join(", ")})`, "group, proposed", "–", "–", "–", c.sources.join(" + ")]);
  for (const e of exprCands) rows.push([`(${e})`, "expression, proposed", "–", "–", "–", "cached plan"]);

  // extensions without statistics
  const nostats = exts.filter((e) => e.hasStats === false);
  if (nostats.length) {
    const n = nostats.length;
    r.add(incPart ? "warn" : "info", `${names(nostats.map(prettyExt))} ${has(n)} no statistics yet; the next gather computes ${n === 1 ? "it" : "them"}, and until then the optimizer cannot use ${n === 1 ? "it" : "them"}.${incPart ? " On an incremental table that gather rereads every unlocked partition once (lab E4); a locked partition forces a full scan on every gather after (lab Tc)." : ""}`,
      `${DOC.ext} / ${DOC.createExt}: “The database gathers statistics for this extension when a user-initiated or automatic statistics gathering job gathers statistics for the table.”; lab E4, Tc, CG1`);
  }

  // groups
  for (const e of groups) {
    const members = groupMembers(e);
    const cols = members.map(colOf);
    const prod = cols.every((c) => c && c.numDistinct !== null) ? cols.reduce((p, c) => p * (c!.numDistinct ?? 1), 1) : null;
    const rowsTotal = input.numRows > 0 ? input.numRows : null;
    const independent = prod !== null ? Math.min(prod, rowsTotal ?? prod) : null;
    if (e.hasStats && e.numDistinct !== null && independent !== null && e.numDistinct > 0) {
      const ratio = independent / e.numDistinct;
      if (ratio >= 1.5) {
        r.add("info", `${prettyExt(e)}: the group has ${fmt(e.numDistinct)} distinct combinations where the columns alone multiply to ${fmt(prod)} (${fmt(ratio, 1)} times more). The columns are correlated, and equality and in-list predicates on both now use the group's NDV instead of the product of the single-column selectivities.`,
          `${DOC.ext}: “The optimizer uses column group statistics for equality predicates, inlist predicates, and for estimating the GROUP BY cardinality.”; lab CG1 (CITY, COUNTRY: NDV 50 against a product of 500)`);
      } else if (ratio < 1.2) {
        r.add("warn", `${prettyExt(e)}: the group has ${fmt(e.numDistinct)} distinct combinations and the columns alone multiply to ${fmt(prod)}${rowsTotal !== null && prod! > rowsTotal ? ` (capped by the ${fmt(rowsTotal)} rows)` : ""}. They look independent, so the group changes almost no estimate and still costs an NDV at every gather${incPart ? ", and every partition's synopsis carries it too" : ""}.`,
          `${DOC.ext}: a group helps when the columns are correlated; the NDV comparison is inferred`,
          dropAdvice(e));
      }
    }
    if (usageKnown && e.used === false) {
      const lvl: Level = seedRan ? "warn" : "info";
      r.add(lvl, seedRan
        ? `${prettyExt(e)}: no recorded use. REPORT_COL_USAGE lists other column groups of this table but not this one, so no query SEED_COL_USAGE watched filtered or grouped on these columns together. The group still costs one NDV${hasHistogram(e) ? " and a histogram" : ", and a histogram if SIZE AUTO decides,"} per gather. REPORT_COL_USAGE only knows what was recorded since the last RESET_COL_USAGE; run SEED_COL_USAGE over a representative workload to confirm before dropping it.`
        : `${prettyExt(e)} is not in REPORT_COL_USAGE. That says little: column groups are recorded only while SEED_COL_USAGE watches a workload, and nothing shows it ever ran for this table. It still costs one NDV per gather. Run SEED_COL_USAGE over a representative workload (recipe below) before judging it.`,
        `${DOC.seed}: “This procedure also records group of columns.” and “The procedure stores information in SYS.COL_GROUP_USAGE$.”; ${DOC.reportUsage} lists only what was recorded; RESET_COL_USAGE: “This procedure deletes the recorded column (group) usage information.”`,
        seedRan ? dropAdvice(e) : undefined);
    }
  }

  // expression extensions
  for (const e of exprs) {
    if (usageKnown && e.used === false) {
      r.add("warn", `${prettyExt(e)}: no predicate on this expression is recorded. Expression statistics help only when the expression itself appears in a predicate. The extension still costs an NDV${hasHistogram(e) ? ", a histogram" : ""} and a virtual column per gather. Usage is recorded when a statement is parsed, so a query parsed before the extension existed recorded nothing for it.`,
        `${DOC.ext}, Managing Expression Statistics; ${DOC.reportUsage}; the expression's usage flags are ordinary column usage (lab EXPR_PRED)`,
        dropAdvice(e));
    }
    if (fbi.includes(norm(e.text ?? ""))) {
      r.add("warn", `${prettyExt(e)} is redundant: a function-based index already carries this expression. Its hidden virtual column gets statistics of its own, so the optimizer has them without the extension.`,
        `${DOC.ext}: “the optimizer does not know how this function affects predicate cardinality unless a function-based index exists.” That the index's hidden column gets gathered statistics is inferred`,
        [`EXEC DBMS_STATS.DROP_EXTENDED_STATS(${OT}, ${qlit(e.text ?? e.name)})`]);
    }
  }

  // expression candidates
  if (exprCands.length) {
    const n = exprCands.length;
    r.add("info", `${n === 1 ? "A cached plan filters" : `${fmt(n)} expressions in cached plans filter`} on ${names(exprCands)}. That is weak evidence: a cached plan is one statement on one day. Expression statistics help only if queries really filter on the expression, and each extension counts against the limit of ${fmt(limit)} on this table (${fmt(exts.length)} exist).${incPart ? " On an incremental table the next gather rereads every partition (as for a column group, lab E4)." : ""}`,
      `${DOC.ext}, Managing Expression Statistics: “For an expression in the form ( function ( col )= constant ) applied to a WHERE clause column, the optimizer does not know how this function affects predicate cardinality unless a function-based index exists. However, you can gather expression statistics on the expression ( function ( col ) itself.”; candidates from V$SQL_PLAN, inferred`,
      exprCands.map((e) => `SELECT DBMS_STATS.CREATE_EXTENDED_STATS(${OT}, ${qlit(`(${e})`)}) FROM dual;`));
  }

  // column group candidates: the evidence only; advise.ts proposes the CREATE
  for (const c of groupCands) {
    const cols = c.columns.map(colOf);
    const ndvs = cols.map((x) => x?.numDistinct ?? null);
    const lo = ndvs.every((v) => v !== null) ? Math.max(...(ndvs as number[])) : null;
    const prod = c.ndvProduct;
    const cap = input.numRows > 0 && prod !== null ? Math.min(prod, input.numRows) : prod;
    const src = c.sources.map((s) => (s === "directive" ? "a SQL plan directive recorded a misestimate on them together" : "SEED_COL_USAGE recorded them filtered together")).join("; ");
    const set = `(${c.columns.join(", ")})`;
    if (!c.equality) {
      r.add("info", `${set}: ${src}, but not with equality predicates only. A column group is used for equality predicates, in-lists and GROUP BY, not for ranges, so a group would not help these queries.`, `${DOC.ext}: “The optimizer uses column group statistics for equality predicates, inlist predicates, and for estimating the GROUP BY cardinality.”; lab CG1 (a range directive on (SALE_DATE, STATUS) was not counted)`);
      continue;
    }
    r.add("info", `${set}: ${src}, with equality predicates. The single-column NDVs multiply to ${prod === null ? "an unknown number" : fmt(prod)}${lo !== null && cap !== null ? `; the true number of combinations lies between ${fmt(lo)} (the columns are nested) and ${fmt(cap)} (they are independent)` : ""}, and the group's own NDV settles it. A group pays off for correlated columns used together in equality predicates, in-lists or GROUP BY; for independent columns it changes nothing. The CREATE_EXTENDED_STATS call is in the gather advice.`,
      `${DOC.ext}; lab CG1 (directive and usage sources); NDV bounds inferred`);
  }

  // the limit
  const proposed = eqCands.length + exprCands.length;
  if (exts.length + proposed > limit) {
    r.add("warn", `The table has ${plural(exts.length, "extension")} and ${proposed} more ${proposed === 1 ? "is" : "are"} proposed against a limit of ${fmt(limit)} (the greater of 20 and 10% of its ${fmt(input.columnCount)} columns). CREATE_EXTENDED_STATS fails with ORA-20008 above it, so choose the ones the workload needs.`,
      `${DOC.createExt}: “The total number of extensions in a table cannot be greater than a maximum of (20, 10% of number of non-virtual columns in the table).” and ORA-20008 “Reached the upper limit on number of extensions”`);
  } else if (exts.length >= limit) {
    r.add("warn", `The table has ${plural(exts.length, "extension")}, the limit of ${fmt(limit)} (the greater of 20 and 10% of its columns). The next CREATE_EXTENDED_STATS fails with ORA-20008.`, `${DOC.createExt}: ORA-20008 “Reached the upper limit on number of extensions”`);
  }

  // how to find out what the workload wants
  const evidence = seedRan;
  if (!usageKnown || !evidence) {
    r.add("info", `${usageKnown ? "No column group usage is recorded for this table." : "REPORT_COL_USAGE was not readable, so group and expression usage is unknown."} SEED_COL_USAGE watches the statements that run in a time window (or a SQL tuning set) and records column groups, not expressions. The form of CREATE_EXTENDED_STATS without an extension then creates exactly the recorded groups. Expression usage is ordinary column usage and needs no seeding.`,
      `${DOC.seed}: “This procedure also records group of columns. You can create extensions for the recorded group of columns using the CREATE_EXTENDED_STATS Function procedure.”; ${DOC.createExt}: “This second form of this function creates statistics extensions based on the column group usage recorded by the SEED_COL_USAGE Procedure.”; needs ANALYZE ANY and ANALYZE ANY DICTIONARY`,
      [
        "-- SQL*Plus: SET LONG 1000000 LONGCHUNKSIZE 1000000 before the reports",
        "EXEC DBMS_STATS.SEED_COL_USAGE(NULL, NULL, 900)  -- watch every statement for 15 minutes; use a longer window or a SQL tuning set for a real workload",
        "-- now run the representative workload (EXPLAIN PLAN of the long queries is enough)",
        `SELECT DBMS_STATS.REPORT_COL_USAGE(${OT}) FROM dual;`,
        `SELECT DBMS_STATS.CREATE_EXTENDED_STATS(${OT}) FROM dual;  -- creates the recorded column groups; review the report first`,
      ]);
  }

  if (!r.has("warn", "bad") && exts.length > 0 && exts.every((e) => e.hasStats === true && e.used === true)) {
    r.add("good", `${plural(exts.length, "extension")}, all with statistics and all recorded as used by the workload.`, `${DOC.ext}; checked against DBA_STAT_EXTENSIONS and REPORT_COL_USAGE`);
  }
  if (!r.findings.length) r.add("info", "The table has no column groups and no expression statistics, and nothing in the collected data asks for one.", `${DOC.ext}`);

  const summary = `${plural(groups.length, "column group")}, ${plural(exprs.length, "expression extension")}${proposed ? `, ${proposed} proposed` : ""}; limit ${fmt(limit)}.`;
  return { id: "extended", title: "Extended statistics", summary, findings: r.findings, ...(rows.length ? { rows: { head: ["Extension", "Kind", "Statistics", "Distinct", "Histogram", "Used"], body: rows } } : {}) };
}

// ---------------------------------------------------------------------------------------------- 3. indexes

const noUsageRow = (x: IndexRec) => x.totalAccessCount === null && x.totalExecCount === null && x.lastUsed === null;
const everUsed = (x: IndexRec) => (x.totalAccessCount ?? 0) > 0 || (x.totalExecCount ?? 0) > 0 || x.lastUsed !== null;
const isUnique = (x: IndexRec) => (x.uniqueness ?? "").toUpperCase() === "UNIQUE";

export function indexesSection(ctx: HealthContext): HealthSection | null {
  const { input, detail } = ctx;
  const ix = detail.indexes;
  if (!ix.length && input.indexCount > 0) return null;
  if (!ix.length) {
    return { id: "indexes", title: "Indexes", summary: "The table has no indexes.", findings: [{ level: "info", text: "The table has no indexes, so a gather has no index statistics to refresh.", basis: "DBA_INDEXES" }] };
  }
  const OT = ownerTable(input);
  const r = new Report();
  const blocks = input.blocksPerPartition * (input.partitioned ? Math.max(1, input.partitions) : 1);
  const rowsOf = (x: IndexRec) => x.numRows ?? input.numRows;
  /** 0 = clustering factor at the table's block count (well ordered), 1 = at its row count (scattered). */
  const position = (x: IndexRec) => {
    const rows = rowsOf(x);
    if (x.clusteringFactor === null || rows <= blocks) return null;
    return (x.clusteringFactor - blocks) / (rows - blocks);
  };
  const scatter = (x: IndexRec) => {
    const p = position(x);
    return p === null ? "–" : p >= 0.9 ? "scattered" : p <= 0.1 ? "well ordered" : "in between";
  };

  const body = ix.map((x) => [
    x.name,
    [isUnique(x) ? "unique" : "non-unique", x.locality ? x.locality.toLowerCase() : (x.partitioned ? "partitioned" : ""), x.indexType && x.indexType !== "NORMAL" ? x.indexType.toLowerCase() : ""].filter(Boolean).join(", "),
    x.columns.join(", "),
    fmt(x.leafBlocks),
    x.clusteringFactor === null ? "–" : `${fmt(x.clusteringFactor)} (${scatter(x)})`,
    [x.status && x.status !== "VALID" && x.status !== "N/A" ? x.status.toLowerCase() : "", x.visibility === "INVISIBLE" ? "invisible" : "", x.staleStats ? "stale" : "", x.locked ? "locked" : ""].filter(Boolean).join(", ") || "ok",
    noUsageRow(x) ? "no usage row" : `${fmt(x.totalAccessCount)} accesses, ${fmt(x.totalExecCount)} executions${x.lastUsed ? `, last ${x.lastUsed.slice(0, 10)}` : ""}`,
  ]);

  // state
  const unusable = ix.filter((x) => x.status !== null && x.status !== "VALID" && x.status !== "N/A");
  if (unusable.length) {
    r.add("bad", `${names(unusable.map((x) => x.name))} ${is(unusable.length)} ${unusable.map((x) => x.status).join("/")}. The optimizer cannot use ${unusable.length === 1 ? "it" : "them"} and DML on the table may fail or skip ${unusable.length === 1 ? "its" : "their"} maintenance, depending on SKIP_UNUSABLE_INDEXES.`,
      "19c Database Reference, ALL_INDEXES.STATUS: “Indicates whether a nonpartitioned index is VALID or UNUSABLE”",
      unusable.map((x) => `ALTER INDEX ${qualified(input, x.name)} REBUILD;`));
  }
  const nostats = ix.filter((x) => x.lastAnalyzed === null && x.numRows === null);
  if (nostats.length) {
    r.add("warn", `${names(nostats.map((x) => x.name))} ${has(nostats.length)} no statistics, so the optimizer uses defaults for ${nostats.length === 1 ? "its" : "their"} depth, leaf blocks and clustering factor.`, "19c Database Reference, ALL_INDEXES (columns marked * are populated only after DBMS_STATS)",
      nostats.map((x) => `EXEC DBMS_STATS.GATHER_INDEX_STATS(${lit(input.owner, "OWNER")}, ${qlit(x.name)})`));
  }
  const invisible = ix.filter((x) => (x.visibility ?? "").toUpperCase() === "INVISIBLE");
  if (invisible.length) {
    r.add("info", `${names(invisible.map((x) => x.name))} ${is(invisible.length)} INVISIBLE: ignored by the optimizer unless OPTIMIZER_USE_INVISIBLE_INDEXES is TRUE, still maintained by DML, and still given statistics by a gather.`, "19c SQL Language Reference, ALTER INDEX: “VISIBLE | INVISIBLE Use this clause to specify whether the index is visible or invisible to the optimizer.”");
  }
  const locked = ix.filter((x) => x.locked === true);
  if (locked.length) {
    r.add("info", `${names(locked.map((x) => x.name))} ${has(locked.length)} locked statistics, so a gather leaves ${locked.length === 1 ? "them" : "them"} as they are.`, "DBA_IND_STATISTICS.STALE_STATS and STATTYPE_LOCKED; inferred from DBMS_STATS locking");
  }

  // stale index statistics
  const stale = ix.filter((x) => x.staleStats === true);
  if (stale.length) {
    const n = stale.length, tableStale = detail.staleStats === true;
    const behind = stale.filter((x) => x.numRows !== null && input.numRows > 0 && Math.abs(x.numRows - input.numRows) / input.numRows > 0.1);
    const cas = input.cascade;
    r.add(cas === "FALSE" ? "warn" : "info", `${names(stale.map((x) => x.name))} ${is(n)} flagged stale${tableStale ? "" : " while the table is not"}${behind.length ? `; ${names(behind.map((x) => `${x.name} counts ${fmt(x.numRows)} rows against the table's ${fmt(input.numRows)}`))}` : ""}. ${cas === "FALSE" ? "CASCADE is FALSE, so a gather of the table never refreshes index statistics." : cas === "AUTO_CASCADE" ? "With AUTO_CASCADE the next gather of the table scans every index anyway (lab F3)." : "CASCADE is TRUE, so the next gather of the table scans every index."}`,
      "DBA_IND_STATISTICS.STALE_STATS; lab F2, F3 (AUTO_CASCADE scanned both indexes at every gather); lab F4 (cascade false: no index work)",
      cas === "FALSE" ? [...(input.partitioned ? ["-- each call scans the whole index, global or local (lab F4, F6)"] : []), ...stale.map((x) => `EXEC DBMS_STATS.GATHER_INDEX_STATS(${lit(input.owner, "OWNER")}, ${qlit(x.name)})`)] : undefined);
  }

  // clustering factor
  const scattered = ix.filter((x) => !isUnique(x) && position(x) !== null && position(x)! >= 0.9);
  if (scattered.length) {
    r.add("info", `${names(scattered.map((x) => `${x.name} (clustering factor ${fmt(x.clusteringFactor)} of ${fmt(rowsOf(x))} rows, ${fmt(blocks)} table blocks)`))}: rows with the same key are spread over nearly as many blocks as there are rows, so an index range scan costs about one block read per row and the optimizer prefers a full scan for all but the most selective predicates. It is how the rows were inserted, not something a rebuild changes; reordering the table for one index can worsen another.`,
      `${DOC.clustering}: “A clustering factor that is close to the number of rows indicates that the rows are scattered randomly across the database blocks in relation to the index key.” and “An attempt to reorganize the table to improve the clustering factor for one index may degrade the clustering factor of the other index.”; ALL_INDEXES.CLUSTERING_FACTOR; the block count is the form's estimate`);
  }
  const tcb = ix.filter((x) => !isUnique(x) && x.clusteringFactor !== null && x.clusteringFactor > 0.9 * rowsOf(x) && everUsed(x));
  if (tcb.length) {
    const cur = detail.tableCachedBlocks;
    r.add("info", `${names(tcb.map((x) => x.name))} ${has(tcb.length)} a clustering factor above 90% of the rows and ${tcb.length === 1 ? "is" : "are"} used. TABLE_CACHED_BLOCKS${cur !== null && cur > 1 ? ` (now ${fmt(cur)})` : " (default 1)"} tells the gather how many recently read table blocks to assume cached, so a revisit of one of them is not counted as another block visit. A higher value lowers the factor of an index whose key order revisits the same blocks soon after; it cannot help when a key's rows lie all over the table. Treat 16 as an experiment on one index, compare plans, and undo it if they do not improve.`,
      "19c DBMS_STATS reference, SET_TABLE_PREFS: “TABLE_CACHED_BLOCKS Specifies the average number of blocks assumed to be cached in the buffer cache when calculating the index clustering factor.” The reference gives no range or default; the effect beyond that sentence and the value 16 are inferred",
      [`EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'TABLE_CACHED_BLOCKS', '16')`,
       ...tcb.map((x) => `EXEC DBMS_STATS.GATHER_INDEX_STATS(${lit(input.owner, "OWNER")}, ${qlit(x.name)})`),
       `-- undo: EXEC DBMS_STATS.DELETE_TABLE_PREFS(${OT}, 'TABLE_CACHED_BLOCKS'), then gather the index again`]);
  }

  // use
  const candidates = ix.filter((x) => !isUnique(x) && !everUsed(x));
  const uniqueUnused = ix.filter((x) => isUnique(x) && !everUsed(x));
  if (candidates.length) {
    const noRows = ix.every(noUsageRow);
    const leaf = candidates.reduce((s, x) => s + (x.leafBlocks ?? 0), 0);
    const cas = input.cascade !== "FALSE";
    r.add(noRows ? "info" : "warn", `${noRows ? "DBA_INDEX_USAGE has no row for any index of this table, so usage may not be collected or none was used since collection began. Candidates:" : "No recorded use:"} ${names(candidates.map((x) => x.name))}. The record is sampled by default and flushed every 15 minutes, so a rarely used index can be missing, and the check does not know how long the database has been collecting.${cas && leaf ? ` Under ${input.cascade === "TRUE" ? "CASCADE TRUE" : "AUTO_CASCADE"} each gather of the table also scans ${candidates.length === 1 ? "it" : "them"} (${fmt(leaf)} leaf blocks).` : ""}${uniqueUnused.length ? ` ${names(uniqueUnused.map((x) => x.name))} ${uniqueUnused.length === 1 ? "is" : "are"} unique and serve${uniqueUnused.length === 1 ? "s" : ""} a constraint whether or not queries use ${uniqueUnused.length === 1 ? "it" : "them"}.` : ""} Do not drop on this evidence: make ${candidates.length === 1 ? "it" : "each"} invisible for a full business cycle and watch.`,
      `${DOC.indexUsage}: “DBA_INDEX_USAGE displays cumulative statistics for each index.”; V$INDEX_USAGE_INFO: “A flush occurs every 15 minutes.” and “SAMPLED ... only a few of the executions are considered ... This is the default statistics collection type.”; INVISIBLE as the safe test: 19c SQL Language Reference, ALTER INDEX`,
      candidates.flatMap((x) => [`ALTER INDEX ${qualified(input, x.name)} INVISIBLE;`, `-- undo: ALTER INDEX ${qualified(input, x.name)} VISIBLE;`]));
  } else if (uniqueUnused.length && uniqueUnused.length === ix.length) {
    r.add("info", `${names(uniqueUnused.map((x) => x.name))}: no recorded use, but ${uniqueUnused.length === 1 ? "it is unique and serves" : "they are unique and serve"} a constraint.`, DOC.indexUsage);
  }

  // what a gather does to the indexes
  if (input.cascade !== "FALSE") {
    const leaf = ix.reduce((s, x) => s + (x.leafBlocks ?? 0), 0);
    const globalIdx = ix.filter((x) => x.locality !== "LOCAL");
    const localIdx = ix.filter((x) => x.locality === "LOCAL");
    const heavy = blocks > 0 && leaf > 0.5 * blocks;
    r.add(heavy ? "warn" : "info", `${input.cascade === "TRUE" ? "CASCADE is TRUE" : "With CASCADE => AUTO_CASCADE"}, a gather of the table scans all ${plural(ix.length, "index", "indexes")} in full, changed or not: ${fmt(leaf)} leaf blocks${blocks > 0 ? ` against about ${fmt(blocks)} table blocks` : ""}${heavy ? ", so the indexes cost more to read than the table" : ""}.${globalIdx.length && input.partitioned ? ` ${names(globalIdx.map((x) => x.name))} ${globalIdx.length === 1 ? "is a global index" : "are global indexes"}: its statistics need a full index scan.` : ""}${localIdx.length ? ` ${names(localIdx.map((x) => x.name))} ${localIdx.length === 1 ? "is local" : "are local"}: the new partition is scanned and, in the lab, the whole local index too.` : ""}`,
      `lab F2, F3 (both indexes scanned in full at every gather, nothing changed); 19c SQL Tuning Guide, Gathering Optimizer Statistics: “the database gathers global index statistics by performing a full index scan.”; for a plain table the same cost is assumed (inferred)`);
  } else {
    r.add("info", "CASCADE is FALSE, so a gather of the table does no index work; the index statistics age on their own.", "lab F4 (cascade false: no index work)");
  }

  // a shorter index that another index already starts with
  for (const a of ix) {
    if (isUnique(a) || !a.columns.length || a.columns.some((c) => /^SYS_NC/.test(c))) continue;
    const longer = ix.find((b) => b !== a && b.columns.length > a.columns.length && a.columns.every((c, i) => b.columns[i] === c));
    if (longer) {
      r.add("info", `${a.name} (${a.columns.join(", ")}) is a leading prefix of ${longer.name} (${longer.columns.join(", ")}). A query on the prefix can use the longer index, so the shorter one may be redundant; one that supports a foreign key, or a different ordering of range scans, may still be worth keeping.`, "inferred from the column lists; test with ALTER INDEX ... INVISIBLE before dropping");
    }
  }

  if (!r.has("bad", "warn") && !stale.length && !candidates.length && !scattered.length && !tcb.length) {
    r.add("good", `${plural(ix.length, "index", "indexes")}: valid, visible, with current statistics.`, "DBA_INDEXES, DBA_IND_STATISTICS");
  }
  const summary = `${plural(ix.length, "index", "indexes")}${scattered.length ? `, ${scattered.length} with scattered rows` : ""}${candidates.length ? `, ${candidates.length} with no recorded use` : ""}${stale.length ? `, ${stale.length} stale` : ""}.`;
  return { id: "indexes", title: "Indexes", summary, findings: r.findings, rows: { head: ["Index", "Kind", "Columns", "Leaf blocks", "Clustering factor", "State", "Recorded use"], body } };
}

// ---------------------------------------------------------------------------------------------- 4. statistics quality

const DATE_TYPE = /^(DATE|TIMESTAMP)/i;
const KEY_NAME = /(^|_)(ID|KEY|NO|NR|SEQ|NUM|CODE)$|^ID$/i;
const TIME_NAME = /(DATE|TIME|_DT|_TS|CREATED|UPDATED|LOADED|STAMP)/i;

export function qualitySection(ctx: HealthContext): HealthSection | null {
  const { input, detail } = ctx;
  if (!detail.columns.length) return null;
  const OT = ownerTable(input);
  const r = new Report();
  const cols = detail.columns.filter((c) => !c.isExtension);
  const rows = input.numRows;
  const tableTime = toTime(detail.lastAnalyzed);
  const changed = (detail.rowsChanged ?? 0) > 0;

  // impossible values
  if (rows > 0) {
    const impossible = cols.filter((c) => c.numNulls !== null && c.numNulls > rows);
    if (impossible.length) {
      r.add("bad", `${names(impossible.map((c) => `${c.name} (${fmt(c.numNulls)} nulls)`))}: more nulls than the table has rows (${fmt(rows)}). That cannot be true; the column statistics and the table statistics come from different gathers, or were set by hand.`,
        `${DOC.colStats}: “NUM_NULLS Number of NULLs in the column”; a column cannot hold more nulls than the table has rows`,
        [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
    }
    const tooMany = cols.filter((c) => c.numDistinct !== null && c.numDistinct > 1.1 * Math.max(1, rows - (c.numNulls ?? 0)) && !(c.numNulls !== null && c.numNulls > rows));
    if (tooMany.length) {
      r.add("bad", `${names(tooMany.map((c) => `${c.name} (NDV ${fmt(c.numDistinct)})`))}: more distinct values than non-null rows (${fmt(rows)} rows). A stale gather or a hand-set value; the optimizer will underestimate every equality predicate on ${tooMany.length === 1 ? "it" : "them"}.`,
        `${DOC.colStats}: “NUM_DISTINCT Number of distinct values in the column”; a column cannot have more values than rows`,
        [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
    }
  }

  // unique columns whose NDV does not match the rows
  const unique = (detail.uniqueColumns ?? []).map((n) => cols.find((c) => c.name === n)).filter((c): c is ColumnRec => !!c && c.numDistinct !== null);
  const off = rows > 0 ? unique.filter((c) => {
    const expect = rows - (c.numNulls ?? 0);
    return expect > 0 && Math.abs(c.numDistinct! - expect) / expect > 0.1;
  }) : [];
  if (off.length) {
    r.add("warn", `${names(off.map((c) => `${c.name} (NDV ${fmt(c.numDistinct)}, ${fmt(rows - (c.numNulls ?? 0))} non-null rows)`))}: a unique key has one value per non-null row, and these differ by more than 10%. The statistics are stale (${changed ? `${fmt(detail.rowsChanged)} rows changed since the gather` : "no DML is recorded, so check the gather date"}) or the NDV was scaled from a sample.`,
      `${DOC.colStats}: “NUM_DISTINCT Number of distinct values in the column”; the 10% threshold is the rule's own; ALL_INDEXES.DISTINCT_KEYS: “For indexes that enforce UNIQUE and PRIMARY KEY constraints, this value is the same as the number of rows in the table”`,
      [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
  }

  // density against 1/NDV when there is no histogram
  const dens = cols.filter((c) => !isHist(c) && c.numDistinct !== null && c.numDistinct > 0 && c.density !== null && Math.abs(c.density - 1 / c.numDistinct) / (1 / c.numDistinct) > 0.05);
  if (dens.length) {
    r.add("warn", `${names(dens.map((c) => `${c.name} (density ${c.density!.toPrecision(3)}, 1/NDV ${(1 / c.numDistinct!).toPrecision(3)})`))}: without a histogram the density equals 1/NDV, and these do not. The statistics were set by hand (SET_COLUMN_STATS), imported, or a histogram was deleted without a regather.`,
      `${DOC.colStats}: “If a histogram is not available on COLUMN_NAME, then the value of this column is 1 / NUM_DISTINCT.”`);
  }

  // zero-row partitions that have since taken DML
  const zero = detail.zeroRowPartitionsWithDml ?? 0;
  if (zero > 0) {
    const named = detail.partitions.filter((p) => p.numRows === 0 && (p.rowsChanged ?? 0) > 0);
    const fixes = named.slice(0, 10).map((p) => `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, partname => ${qlit(p.name)}, granularity => 'PARTITION')`);
    const inc = input.partitioned && input.incremental === "TRUE";
    r.add("bad", `${plural(zero, "partition")} ${has(zero)} statistics that say 0 rows but ${zero === 1 ? "has" : "have"} taken DML since${named.length ? `: ${names(named.map((p) => `${p.name} (${fmt(p.rowsChanged)} rows changed)`))}` : ""}. The partition was gathered empty and loaded afterwards, so the optimizer sees an empty partition and plans for one row. Gather ${zero === 1 ? "it" : "them"} now; next time copy statistics from a loaded partition (COPY_TABLE_STATS) before the load.`,
      "lab K1 (COPY_TABLE_STATS into an empty partition copies NUM_ROWS; a gather of the still empty partition stores 0); DBA_TAB_MODIFICATIONS; the optimizer's treatment of 0 rows is inferred",
      [...fixes, ...(named.length > 10 ? [`-- and ${named.length - 10} more partitions`] : []), ...(named.length === 0 ? [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`] : []),
       ...(inc && named.length ? ["-- then one plain gather: it reads nothing more and derives the global statistics (lab A3, A3b)", `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`] : [])]);
  }

  // values above HIGH_VALUE
  if (changed && tableTime !== null) {
    const stale = cols.filter((c) => DATE_TYPE.test(c.dataType ?? "") && (c.inIndex === true || TIME_NAME.test(c.name)) && toTime(c.high) !== null && toTime(c.high)! <= tableTime);
    if (stale.length) {
      r.add("warn", `${names(stale.map((c) => `${c.name} (high value ${c.high!.slice(0, 10)})`))}: the highest value the statistics know is not later than the last gather (${detail.lastAnalyzed!.slice(0, 10)}) and ${fmt(detail.rowsChanged)} rows have changed since. If the new rows carry later dates, a predicate on them lies above the HIGH_VALUE: the optimizer estimates fewer and fewer rows the further it lies beyond, and a query for yesterday's rows can be planned for almost none. Real-time statistics maintain high and low values on conventional DML, but only where the edition or service supports them (Exadata and cloud in 19c).`,
        `inferred: the 19c SQL Tuning Guide pages checked do not describe the estimate beyond HIGH_VALUE; Optimizer Statistics Concepts, Real-Time Statistics: “In QUANTITY_SOLD and AMOUNT_SOLD, the high and low values combine the manually gathered statistics and the real-time statistics.” and “See Also: Oracle Database Licensing Information User Manual for details on which features are supported for different editions and services”`,
        [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}${input.partitioned ? ", granularity => 'AUTO'" : ""})`]);
    }
    const seqs = cols.filter((c) => c.dataType === "NUMBER" && c.inIndex === true && KEY_NAME.test(c.name) && c.numDistinct !== null && rows > 0 && c.numDistinct >= 0.9 * (rows - (c.numNulls ?? 0)) && c.high !== null);
    if (seqs.length) {
      r.add("info", `${names(seqs.map((c) => `${c.name} (high value ${c.high})`))}: ${seqs.length === 1 ? "an indexed, near-unique number column that looks like a key" : "indexed, near-unique number columns that look like keys"}, and ${fmt(detail.rowsChanged)} rows have changed since the gather. If new rows get higher values (a sequence), predicates on the newest rows lie above the HIGH_VALUE.`,
        "inferred; the 19c SQL Tuning Guide pages checked do not describe estimates beyond HIGH_VALUE");
    }
  }

  // columns the last gather did not cover
  const nostat = cols.filter((c) => c.lastAnalyzed === null && c.numDistinct === null);
  if (nostat.length) {
    r.add("warn", `${names(nostat.map((c) => c.name))} ${has(nostat.length)} no column statistics, so the optimizer guesses the selectivity of any predicate on ${nostat.length === 1 ? "it" : "them"}.`, "DBA_TAB_COL_STATISTICS has no row with LAST_ANALYZED for the column",
      [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
  }
  if (tableTime !== null) {
    const old = cols.filter((c) => c.lastAnalyzed !== null && toTime(c.lastAnalyzed) !== null && tableTime - toTime(c.lastAnalyzed)! > 3_600_000);
    if (old.length) {
      r.add("info", `${names(old.map((c) => `${c.name} (${c.lastAnalyzed!.slice(0, 10)})`))}: column statistics older than the table's (${detail.lastAnalyzed!.slice(0, 10)}). The last gather did not cover ${old.length === 1 ? "this column" : "these columns"}: a column added since is not read by a plain gather of an incremental table (lab E5), and a METHOD_OPT that names columns skips the others.`,
        "lab E5 (ADD COLUMN triggers no partition reread); DBA_TAB_COL_STATISTICS.LAST_ANALYZED",
        [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, method_opt => 'FOR COLUMNS SIZE 1 ${old.map((c) => ident(c.name)).join(", ")}')  -- NDV and nulls for just these; add granularity => 'GLOBAL' on an incremental table to avoid touching the partitions`]);
    }
  }

  // a sample where AUTO_SAMPLE_SIZE should have read everything
  if (input.estimatePercent === "auto" && rows > 0) {
    const small = cols.filter((c) => !isHist(c) && !/STATS_ON_/.test(c.notes ?? "") && c.sampleSize !== null && (c.numNulls ?? 0) <= rows && c.sampleSize < 0.5 * (rows - (c.numNulls ?? 0)));
    if (small.length) {
      r.add("info", `${names(small.map((c) => `${c.name} (${fmt(c.sampleSize)} of ${fmt(rows - (c.numNulls ?? 0))} rows)`))}: sampled on well under half of the rows although ESTIMATE_PERCENT is AUTO_SAMPLE_SIZE, which reads every row for the basic statistics. An earlier gather with a fixed percentage left ${small.length === 1 ? "this" : "these"}; the NDV is scaled from the sample.`,
        `${DOC.colStats}: “SAMPLE_SIZE Sample size used in analyzing this column”; ${DOC.hist}: “if the sampling size is the default of AUTO_SAMPLE_SIZE, then the database creates frequency histograms from a full table scan”; inferred for the other statistics`);
    }
  }

  if (!r.findings.length) {
    r.add("good", `${plural(cols.length, "column")} checked: nulls, NDV, density, ranges and partition statistics are consistent with the ${fmt(rows)} rows.`, `${DOC.colStats}; checks listed in this section`);
  }
  const worst = r.has("bad") ? "problems that mislead the optimizer" : r.has("warn") ? "inconsistencies" : "nothing wrong";
  return { id: "quality", title: "Statistics quality", summary: `${plural(cols.length, "column")} checked: ${worst}.`, findings: r.findings };
}
