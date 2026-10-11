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
/** A name list inside a single-quoted METHOD_OPT literal. */
const inLit = (xs: string[]) => xs.join(", ").replace(/'/g, "''");
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
    const it = n === 1 ? "it" : "them";
    r.add("info", `${names(support.map(label))} ${has(n)} a histogram that only supports the global statistics of the incremental table (NOTES HIST_FOR_INCREM_STATS); the optimizer does not use ${it}. Keep ${n === 1 ? "the column" : "the columns"} out of METHOD_OPT: naming ${n === 1 ? "it" : "them"} makes ${it} real histograms and rereads every partition.`,
      `19c Database Reference, ALL_PART_COL_STATISTICS.NOTES: “HIST_FOR_INCREM_STATS : A histogram used to support incremental statistics has been created and it is not used for optimization.”; lab E1, E3i (the value on table-level column rows, combined with INCREMENTAL), Td (a column named in METHOD_OPT: every partition read, real histogram)`);
  }

  // a real histogram nobody filters on
  const unused = usageKnown ? real.filter((c) => c.usage.length === 0) : [];
  if (unused.length) {
    const n = unused.length, it = n === 1 ? "it" : "them";
    const why = `A histogram helps the estimates for filter and join predicates on its own column, and SIZE AUTO builds one only for a column the workload has used. So ${n === 1 ? "this one" : "these"} came from SKEWONLY, REPEAT, an explicit column list, or usage that was reset since. ${n === 1 ? "It costs" : "They cost"} gather time and dictionary space for nothing.`;
    const basis = `${DOC.histWhen}: “If you gather statistics for a table and do not query the table, then the database does not create histograms for columns in this table.”; ${DOC.hist}, Purpose of Histograms; lab E6 (SIZE 1 deletes histograms); the REPEAT plus SIZE 1 call follows the METHOD_OPT grammar and was not run`;
    const head = `${names(unused.map(label))} ${has(n)} a histogram but no recorded filter or join uses ${it}.`;
    if (input.methodOpt === "size1") {
      r.add("info", `${head} METHOD_OPT is SIZE 1, so the next gather deletes ${it}.`, basis);
    } else if (input.methodOpt === "pinned") {
      r.add("info", `${head} METHOD_OPT pins a column list; if ${n === 1 ? "the column is" : "these columns are"} on it, take ${it} off unless you chose ${it} on purpose. Usage recorded before a RESET_COL_USAGE is gone.`, basis);
    } else if (input.methodOpt === "skewonly") {
      r.add("warn", `${head} ${why} METHOD_OPT is SIZE SKEWONLY, which builds histograms from the data alone, so ${it} comes back at every gather.`, basis,
        [`EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'METHOD_OPT', 'FOR ALL COLUMNS SIZE AUTO')`,
         `-- drops ${it} once; REPEAT keeps the other histograms`,
         `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, method_opt => 'FOR ALL COLUMNS SIZE REPEAT FOR COLUMNS SIZE 1 ${inLit(unused.map(sqlCol))}')`]);
    } else {
      r.add("warn", `${head} ${why}${incPart ? " On an incremental table a call that only deletes histograms rereads no partition (lab E6)." : ""}`, basis,
        [`-- REPEAT keeps the other histograms, SIZE 1 deletes ${it === "it" ? "this one" : "these"}`,
         `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, method_opt => 'FOR ALL COLUMNS SIZE REPEAT FOR COLUMNS SIZE 1 ${inLit(unused.map(sqlCol))}')`]);
    }
  }

  // METHOD_OPT SIZE 1 deletes histograms the workload uses
  if (input.methodOpt === "size1" && real.length) {
    const usedHist = real.filter((c) => c.usage.length > 0);
    if (usedHist.length) {
      const cols = usedHist.map(sqlCol);
      r.add("warn", `METHOD_OPT is FOR ALL COLUMNS SIZE 1, but ${names(usedHist.map(label))} ${has(usedHist.length)} a histogram and ${usedHist.length === 1 ? "a query filters" : "queries filter"} on ${usedHist.length === 1 ? "it" : "them"}. The next gather deletes ${usedHist.length === 1 ? "it" : "them"}, and the estimates fall back to 1/NDV.`,
        "lab E6 (a call or preference with SIZE 1 removes every histogram); pinned list as in lab V1.6",
        [`EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'METHOD_OPT', 'FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 ${inLit(cols)}')`]);
    }
  }

  // a pinned list that leaves a histogram column out
  if (input.methodOpt === "pinned") {
    const pinned = pinnedColumns(prov?.raw?.METHOD_OPT);
    if (pinned) {
      const left = real.filter((c) => !c.isExtension && !pinned.includes(c.name));
      if (left.length) {
        r.add("warn", `METHOD_OPT pins ${names(pinned)}, but ${names(left.map(label))} ${has(left.length)} a histogram that is not on the list. The SIZE 1 that applies to every other column deletes ${left.length === 1 ? "it" : "them"} at the next gather.`,
          "lab E6 (SIZE 1 deletes histograms), Td (a changed pinned list rereads every partition of an incremental table)",
          ["-- adds them to the list; leave them out if you want them gone",
           `EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'METHOD_OPT', 'FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 ${inLit([...pinned, ...left.map((c) => ident(c.name))])}')`]);
      }
    }
  }

  // histogram kinds
  const balanced = real.filter((c) => c.histogram === "HEIGHT BALANCED");
  if (balanced.length) {
    const auto = input.estimatePercent === "auto";
    r.add("warn", `${names(balanced.map(label))} ${has(balanced.length)} a HEIGHT BALANCED histogram, the legacy kind. Oracle builds it only when the NDV exceeds the bucket count and ESTIMATE_PERCENT is not AUTO_SAMPLE_SIZE. ${auto ? "ESTIMATE_PERCENT already is AUTO_SAMPLE_SIZE, so the next gather of the column replaces it with a HYBRID histogram; an older or hand-written call built this one." : `ESTIMATE_PERCENT is ${input.estimatePercent} percent here; with AUTO_SAMPLE_SIZE a regather replaces it with a HYBRID histogram.`}`,
      `${DOC.hist}, Height-Balanced Histograms: “If the sampling percentage is AUTO_SAMPLE_SIZE, then the database creates either hybrid or frequency histograms.”; Hybrid and Top Frequency criteria: “The estimate_percent parameter in the DBMS_STATS statistics gathering procedure is set to AUTO_SAMPLE_SIZE.”`,
      auto ? undefined : [`EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'ESTIMATE_PERCENT', 'DBMS_STATS.AUTO_SAMPLE_SIZE')`]);
  }
  const wide = real.filter((c) => (c.histogram === "HYBRID" || c.histogram === "TOP-FREQUENCY") && c.numBuckets !== null && c.numBuckets >= 254 && (c.numDistinct ?? 0) > c.numBuckets && c.usage.includes("EQ"));
  if (wide.length) {
    r.add("info", `${names(wide.map((c) => `${label(c)} (${fmt(c.numDistinct)} values in ${fmt(c.numBuckets)} buckets)`))}: more distinct values than buckets, and equality predicates use ${wide.length === 1 ? "the column" : "the columns"}. If the estimates for popular values are off, a larger size (up to 2048) is an option; it costs gather time and dictionary space, so try one column and compare plans${incPart ? ". On an incremental table a changed METHOD_OPT can reread every partition (lab Td)" : ""}.`,
      `${DOC.methodOpt}: “integer : Number of histogram buckets. Must be in the range [1,2048].”; whether it helps is a judgement, not a rule`,
      ["-- an option, not a recommendation",
       `-- EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'METHOD_OPT', 'FOR ALL COLUMNS SIZE AUTO FOR COLUMNS SIZE 2048 ${inLit(wide.map(sqlCol))}')`]);
  }
  const exact = real.filter((c) => c.histogram === "FREQUENCY" && c.numBuckets !== null && c.numBuckets === c.numDistinct && !unused.includes(c)
    && (c.sampleSize === null || nonNullRows(input, c) === 0 || c.sampleSize >= 0.99 * nonNullRows(input, c)));
  if (exact.length) {
    r.add("good", `${names(exact.map(label))}: FREQUENCY histogram from all rows, one bucket per value: exact for equality predicates.`,
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
        r.add("info", `${names(cand.map(label))} ${is(n)} filtered on (EQ, RANGE or LIKE) and ${has(n)} no histogram: the data was even enough at the last gather, or the first predicate came after it. The next SIZE AUTO gather decides.${incPart ? " On an incremental table a new histogram rereads every partition (lab E1, E3i)." : ""}`,
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
  // an extension row of a function-based index's hidden virtual column (SYS_NC...) is made by Oracle, not by a user (lab Q5)
  const exts = detail.extensions.filter((e) => !/^SYS_NC/i.test(e.name));
  const groups = exts.filter((e) => kindOf(e) === "group");
  const exprs = exts.filter((e) => kindOf(e) === "expression");
  const colOf = (name: string) => detail.columns.find((c) => c.name === name && !c.isExtension);
  const fbi = (detail.fbiExpressions ?? []).map(norm);
  const known = new Set([...exts.map((e) => norm(e.text ?? "")), ...fbi]);
  // SEED_COL_USAGE is the only thing that records groups; without proof it ran, a group missing from the report says nothing
  const seedRan = groups.some((e) => e.used === true) || (prov?.columnGroupCandidates ?? []).some((c) => c.sources.includes("usage")) || detail.columns.some((c) => c.isExtension && c.usage.includes("FILTER"));
  const dropAdvice = (e: ExtensionRec) => [
    kindOf(e) === "group"
      ? "-- confirm first: SEED_COL_USAGE over a representative workload, then REPORT_COL_USAGE (recipe below)"
      : "-- confirm first: REPORT_COL_USAGE after the representative workload has run (SEED_COL_USAGE does not record expressions)",
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
    r.add(incPart ? "warn" : "info", `${names(nostats.map(prettyExt))} ${has(n)} no statistics yet; the next gather computes ${n === 1 ? "it" : "them"}, and until then the optimizer cannot use ${n === 1 ? "it" : "them"}.${incPart ? " On an incremental table that gather rereads every unlocked partition (lab E4)." : ""}`,
      `${DOC.ext} / ${DOC.createExt}: “The database gathers statistics for this extension when a user-initiated or automatic statistics gathering job gathers statistics for the table.”; lab E4, Tc, CG1`);
  }

  // groups
  for (const e of groups) {
    const members = groupMembers(e);
    const cols = members.map(colOf);
    const prod = cols.every((c) => c && c.numDistinct !== null) ? cols.reduce((p, c) => p * (c!.numDistinct ?? 1), 1) : null;
    const rowsTotal = input.numRows > 0 ? input.numRows : null;
    const independent = prod !== null ? Math.min(prod, rowsTotal ?? prod) : null;
    const unusedNote = usageKnown && e.used === false;
    let flagged = false;
    if (e.hasStats && e.numDistinct !== null && independent !== null && e.numDistinct > 0) {
      const ratio = independent / e.numDistinct;
      if (ratio >= 1.5) {
        r.add("info", `${prettyExt(e)}: ${fmt(e.numDistinct)} distinct combinations against ${fmt(prod)} for independent columns (${fmt(ratio, 1)} times fewer). The columns are correlated, and equality and in-list predicates on both now use the group's NDV.`,
          `${DOC.ext}: “The optimizer uses column group statistics for equality predicates, inlist predicates, and for estimating the GROUP BY cardinality.”; lab CG1 (CITY, COUNTRY: NDV 50 against a product of 500)`);
      } else if (ratio < 1.2) {
        flagged = true;
        const unusedClause = unusedNote && seedRan ? " REPORT_COL_USAGE lists other groups of this table but not this one." : "";
        r.add("warn", `${prettyExt(e)}: ${fmt(e.numDistinct)} distinct combinations against ${fmt(prod)} for the columns alone${rowsTotal !== null && prod! > rowsTotal ? ` (capped by the ${fmt(rowsTotal)} rows)` : ""}. Both NDVs are approximate, but a ratio this close to 1 fits independent columns: the group then changes almost no estimate and still costs an NDV at every gather${incPart ? " and a synopsis entry in every partition" : ""}.${unusedClause} Confirm with SEED_COL_USAGE before dropping it.`,
          `${DOC.ext}: a group helps when the columns are correlated; the NDV comparison is inferred`,
          dropAdvice(e));
      }
    }
    if (unusedNote && !flagged) {
      r.add(seedRan ? "warn" : "info", seedRan
        ? `${prettyExt(e)}: no recorded use. REPORT_COL_USAGE lists other groups of this table but not this one, so no statement SEED_COL_USAGE watched filtered or grouped on these columns together. The group costs an NDV${hasHistogram(e) ? " and a histogram" : ""} per gather; confirm over a representative workload before dropping it.`
        : `${prettyExt(e)} is not in REPORT_COL_USAGE, which says little: groups are recorded only while SEED_COL_USAGE watches a workload, and nothing shows it ran for this table. Run it over a representative workload (recipe below) before judging the group.`,
        `${DOC.seed}: “This procedure also records group of columns.” and “The procedure stores information in SYS.COL_GROUP_USAGE$.”; ${DOC.reportUsage} lists only what was recorded; RESET_COL_USAGE: “This procedure deletes the recorded column (group) usage information.”`,
        seedRan ? dropAdvice(e) : undefined);
    }
  }

  // expression extensions
  for (const e of exprs) {
    if (usageKnown && e.used === false) {
      r.add("info", `${prettyExt(e)}: no predicate on this expression is recorded. Expression statistics help only when the expression itself appears in a predicate, and usage is recorded at parse time, so a statement parsed before the extension existed counted nothing. The extension costs an NDV${hasHistogram(e) ? " and a histogram" : ""} per gather.`,
        `${DOC.ext}, Managing Expression Statistics; ${DOC.reportUsage}; the extension's usage flags are ordinary column usage (lab EXPR_PRED)`,
        dropAdvice(e));
    }
    if (fbi.includes(norm(e.text ?? ""))) {
      r.add("info", `${prettyExt(e)} may be redundant: a function-based index already carries this expression, and its hidden virtual column has statistics of its own.`,
        `${DOC.ext}: “the optimizer does not know how this function affects predicate cardinality unless a function-based index exists.”; lab Q5 and docs/oracle19c-facts.md 2.8 (the FBI column is listed in DBA_STAT_EXTENSIONS, CREATOR SYSTEM, with statistics); that a second extension adds nothing is inferred`,
        [`EXEC DBMS_STATS.DROP_EXTENDED_STATS(${OT}, ${qlit(e.text ?? e.name)})`]);
    }
  }

  // expression candidates
  if (exprCands.length) {
    const n = exprCands.length;
    r.add("info", `${n === 1 ? "A cached plan filters" : `${fmt(n)} expressions in cached plans filter`} on ${names(exprCands)}. One cached statement is weak evidence: create an extension only for an expression your workload filters on repeatedly. Each counts toward the limit of ${fmt(limit)} (${fmt(exts.length)} exist).${incPart ? " On an incremental table the next gather rereads every partition (as for a column group, lab E4)." : ""}`,
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
      r.add("info", `${set}: ${src}, but not with equality predicates only. The optimizer uses a group for equality predicates, in-lists and GROUP BY, so it would not help these queries.`, `${DOC.ext}: “The optimizer uses column group statistics for equality predicates, inlist predicates, and for estimating the GROUP BY cardinality.”; lab CG1 (a range directive on (SALE_DATE, STATUS) was not counted)`);
      continue;
    }
    r.add("info", `${set}: ${src}, with equality predicates. The single-column NDVs multiply to ${prod === null ? "an unknown number" : fmt(prod)}${lo !== null && cap !== null ? `; the true number of combinations lies between ${fmt(lo)} (nested columns) and ${fmt(cap)} (independent columns)` : ""}, and only the group's own NDV settles it. A group pays off for correlated columns; for independent ones it changes nothing. The CREATE_EXTENDED_STATS call is in the gather advice.`,
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
    r.add("info", `${usageKnown ? "No column group usage is recorded for this table." : "REPORT_COL_USAGE was not readable, so group usage is unknown."} SEED_COL_USAGE records the column groups of the statements that run in a time window (or a SQL tuning set); CREATE_EXTENDED_STATS without an extension then creates exactly those groups. It does not record expressions.`,
      `${DOC.seed}: “This procedure also records group of columns. You can create extensions for the recorded group of columns using the CREATE_EXTENDED_STATS Function procedure.”; ${DOC.createExt}: “This second form of this function creates statistics extensions based on the column group usage recorded by the SEED_COL_USAGE Procedure.”; needs ANALYZE ANY and ANALYZE ANY DICTIONARY`,
      [
        "-- SQL*Plus: SET LONG 1000000 LONGCHUNKSIZE 1000000 before the reports",
        "-- watch every statement for 15 minutes; use a longer window or a SQL tuning set for a real workload",
        "EXEC DBMS_STATS.SEED_COL_USAGE(NULL, NULL, 900)",
        "-- now run the representative workload (EXPLAIN PLAN of the long queries is enough)",
        `SELECT DBMS_STATS.REPORT_COL_USAGE(${OT}) FROM dual;`,
        "-- review the report, then create the recorded column groups",
        `SELECT DBMS_STATS.CREATE_EXTENDED_STATS(${OT}) FROM dual;`,
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
    const u = unusable.length === 1;
    r.add("bad", `${names(unusable.map((x) => x.name))} ${is(unusable.length)} UNUSABLE: the optimizer ignores ${u ? "it" : "them"} and DML does not maintain ${u ? "it" : "them"}. With SKIP_UNUSABLE_INDEXES FALSE, DML that would update ${u ? "it" : "one"} fails.`,
      "19c Administrator's Guide, Managing Indexes: “An unusable index is ignored by the optimizer and is not maintained by DML.”, and “When SKIP_UNUSABLE_INDEXES is TRUE (the default), then: DML statements against the table proceed, but unusable indexes are not maintained.”; 19c Database Reference, ALL_INDEXES.STATUS",
      unusable.map((x) => `ALTER INDEX ${qualified(input, x.name)} REBUILD;`));
  }
  const nostats = ix.filter((x) => x.lastAnalyzed === null && x.numRows === null);
  if (nostats.length) {
    r.add("warn", `${names(nostats.map((x) => x.name))} ${has(nostats.length)} no statistics (LAST_ANALYZED and NUM_ROWS are empty), so the optimizer has no depth, leaf-block count or clustering factor to cost ${nostats.length === 1 ? "it" : "them"} with.`, "19c Database Reference, ALL_INDEXES (the statistics columns are populated by DBMS_STATS)",
      nostats.map((x) => `EXEC DBMS_STATS.GATHER_INDEX_STATS(${lit(input.owner, "OWNER")}, ${qlit(x.name)})`));
  }
  const invisible = ix.filter((x) => (x.visibility ?? "").toUpperCase() === "INVISIBLE");
  if (invisible.length) {
    r.add("info", `${names(invisible.map((x) => x.name))} ${is(invisible.length)} INVISIBLE: the optimizer ignores ${invisible.length === 1 ? "it" : "them"} unless OPTIMIZER_USE_INVISIBLE_INDEXES is TRUE, and DML still maintains ${invisible.length === 1 ? "it" : "them"}.`,
      "19c Administrator's Guide, Managing Indexes: “An invisible index is ignored by the optimizer unless you explicitly set the OPTIMIZER_USE_INVISIBLE_INDEXES initialization parameter to TRUE at the session or system level. Unlike unusable indexes, an invisible index is maintained during DML statements.”");
  }
  const locked = ix.filter((x) => x.locked === true);
  if (locked.length) {
    const one = locked.length === 1;
    r.add("info", `${names(locked.map((x) => x.name))} ${has(locked.length)} locked statistics: a gather of the table skips ${one ? "it" : "them"}, and GATHER_INDEX_STATS on ${one ? "it" : "one"} raises an error unless force => TRUE.`,
      "19c DBMS_STATS reference, LOCK_TABLE_STATS: “The SET_*, DELETE_*, IMPORT_*, GATHER_* procedures that modify statistics in the dictionary of an individual table, index or column will raise an error if statistics of the object is locked.”; that a table gather skips a locked index is inferred from the same text");
  }

  // stale index statistics
  const stale = ix.filter((x) => x.staleStats === true);
  if (stale.length) {
    const n = stale.length;
    const behind = stale.filter((x) => x.numRows !== null && input.numRows > 0 && Math.abs(x.numRows - input.numRows) / input.numRows > 0.1);
    const cas = input.cascade;
    const tableNote = detail.staleStats === false ? " while the table is not" : "";
    r.add(cas === "FALSE" ? "warn" : "info", `${names(stale.map((x) => x.name))} ${is(n)} flagged stale${tableNote}${behind.length ? `; ${names(behind.map((x) => `${x.name} counts ${fmt(x.numRows)} rows against the table's ${fmt(input.numRows)}`))}` : ""}. ${cas === "FALSE" ? "CASCADE is FALSE, so a gather of the table never refreshes index statistics." : `A gather of the table refreshes ${n === 1 ? "it" : "them"} (CASCADE ${cas === "TRUE" ? "TRUE" : "AUTO_CASCADE"}).`}`,
      "DBA_IND_STATISTICS.STALE_STATS; 19c DBMS_STATS reference, GATHER_TABLE_STATS cascade: “Specifying this option is equivalent to running the GATHER_INDEX_STATS procedure on each index of the table.”; lab F4 (cascade false: no index work)",
      cas === "FALSE" ? ["-- each call scans the whole index (lab F2, F6)", ...stale.map((x) => `EXEC DBMS_STATS.GATHER_INDEX_STATS(${lit(input.owner, "OWNER")}, ${qlit(x.name)})`)] : undefined);
  }

  // clustering factor, and TABLE_CACHED_BLOCKS for the scattered indexes that are in use
  const scattered = ix.filter((x) => !isUnique(x) && position(x) !== null && position(x)! >= 0.9);
  if (scattered.length) {
    const tcb = scattered.filter(everUsed);
    const cur = detail.tableCachedBlocks;
    r.add("info", `${names(scattered.map((x) => `${x.name} (clustering factor ${fmt(x.clusteringFactor)} of ${fmt(rowsOf(x))} rows, ${fmt(blocks)} table blocks)`))}: rows with the same key are spread over nearly as many blocks as there are rows, so a range scan costs about one block read per row and the optimizer prefers a full scan unless the predicate is very selective. A rebuild does not change this; reordering the table for one index can worsen another.${tcb.length ? ` TABLE_CACHED_BLOCKS${cur !== null ? ` (now ${fmt(cur)})` : ""} is the number of blocks the gather assumes cached when it computes the factor. A higher value can lower it when the key order revisits blocks read a moment before, not when each key's rows lie all over the table. Try 16 on one index and compare plans.` : ""}`,
      `${DOC.clustering}: “A clustering factor that is close to the number of rows indicates that the rows are scattered randomly across the database blocks in relation to the index key.” and “An attempt to reorganize the table to improve the clustering factor for one index may degrade the clustering factor of the other index.”; the block count is the form's estimate${tcb.length ? "; 19c DBMS_STATS reference, SET_TABLE_PREFS: “TABLE_CACHED_BLOCKS Specifies the average number of blocks assumed to be cached in the buffer cache when calculating the index clustering factor.” The reference gives no range or default; what a higher value does beyond that sentence, and the value 16, are inferred" : ""}`,
      tcb.length ? [`EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, 'TABLE_CACHED_BLOCKS', '16')`,
        ...tcb.map((x) => `EXEC DBMS_STATS.GATHER_INDEX_STATS(${lit(input.owner, "OWNER")}, ${qlit(x.name)})`),
        "-- undo, then gather the index again",
        `EXEC DBMS_STATS.DELETE_TABLE_PREFS(${OT}, 'TABLE_CACHED_BLOCKS')`] : undefined);
  }

  // use
  const candidates = ix.filter((x) => !isUnique(x) && !everUsed(x));
  const uniqueUnused = ix.filter((x) => isUnique(x) && !everUsed(x));
  if (candidates.length) {
    const noRows = ix.every(noUsageRow);
    const leaf = candidates.reduce((s, x) => s + (x.leafBlocks ?? 0), 0);
    const cas = input.cascade !== "FALSE";
    const hidden = candidates.filter((x) => (x.visibility ?? "").toUpperCase() === "INVISIBLE");
    const toHide = candidates.filter((x) => !hidden.includes(x));
    const it = (xs: IndexRec[]) => (xs.length === 1 ? "it" : "them");
    r.add("info", `${noRows ? "DBA_INDEX_USAGE has no row for any index of this table, so usage may not be collected, or none was used since collection began. Candidates:" : "No recorded use:"} ${names(candidates.map((x) => x.name))}. The record is sampled by default and flushed every 15 minutes, so a rarely used index can be missing, and the check does not know how long the database has been collecting.${cas && leaf ? ` A gather of the table with CASCADE ${input.cascade === "TRUE" ? "TRUE" : "AUTO_CASCADE"} reads ${candidates.length === 1 ? "it" : "them"} (${fmt(leaf)} leaf blocks).` : ""}${uniqueUnused.length ? ` ${names(uniqueUnused.map((x) => x.name))} ${uniqueUnused.length === 1 ? "is" : "are"} unique and serve${uniqueUnused.length === 1 ? "s" : ""} a constraint whether or not queries use ${it(uniqueUnused)}.` : ""}${toHide.length ? ` Do not drop on this evidence: make ${toHide.length === 1 ? "it" : "each"} invisible for a full business cycle and watch.` : ""}${hidden.length ? ` ${names(hidden.map((x) => x.name))} ${is(hidden.length)} already invisible; if nothing broke over a business cycle, ${hidden.length === 1 ? "it" : "they"} can go.` : ""}`,
      `${DOC.indexUsage}: “DBA_INDEX_USAGE displays cumulative statistics for each index.”; V$INDEX_USAGE_INFO: “A flush occurs every 15 minutes.” and “SAMPLED ... only a few of the executions are considered ... This is the default statistics collection type.”; invisible as the safe test: 19c Administrator's Guide, Managing Indexes`,
      toHide.flatMap((x) => [`ALTER INDEX ${qualified(input, x.name)} INVISIBLE;`, `-- undo: ALTER INDEX ${qualified(input, x.name)} VISIBLE;`]));
  } else if (uniqueUnused.length && uniqueUnused.length === ix.length) {
    r.add("info", `${names(uniqueUnused.map((x) => x.name))}: no recorded use, but ${uniqueUnused.length === 1 ? "it is unique and serves" : "they are unique and serve"} a constraint.`, DOC.indexUsage);
  }

  // what a gather does to the indexes
  if (input.cascade !== "FALSE") {
    const leaf = ix.reduce((s, x) => s + (x.leafBlocks ?? 0), 0);
    const incPart = input.partitioned && input.incremental === "TRUE";
    const globalIdx = ix.filter((x) => x.locality !== "LOCAL");
    const localIdx = ix.filter((x) => x.locality === "LOCAL");
    r.add("info", `${input.cascade === "TRUE" ? "CASCADE is TRUE" : "CASCADE is AUTO_CASCADE (the database decides)"}, so a gather of the table also gathers ${plural(ix.length, "index", "indexes")}: ${fmt(leaf)} leaf blocks${blocks > 0 ? ` against about ${fmt(blocks)} table blocks` : ""}.${input.cascade !== "TRUE" ? " In the lab (F3, an incremental table) both indexes were scanned in full at every gather, changed or not." : ""}${incPart && globalIdx.length ? ` On an incremental table a global index needs a full index scan (${names(globalIdx.map((x) => x.name))}).` : ""}${incPart && localIdx.length ? ` ${names(localIdx.map((x) => x.name))} ${localIdx.length === 1 ? "is local" : "are local"}: the modified index partitions are scanned and, in the lab, the whole local index too.` : ""}`,
      `19c DBMS_STATS reference, GATHER_TABLE_STATS cascade: “Use the constant DBMS_STATS.AUTO_CASCADE to enable the database to determine whether index statistics need to be collected.”; lab F2, F3 (both indexes scanned in full at every gather, nothing changed${incPart ? "" : ", on an incremental table; for a plain table the same is inferred"}); 19c SQL Tuning Guide, Considerations for Incremental Statistics Maintenance: “the database gathers global index statistics by performing a full index scan.”`);
  } else {
    r.add("info", "CASCADE is FALSE, so a gather of the table does no index work; the index statistics age on their own.", "lab F4 (cascade false: no index work)");
  }

  // a shorter index that a longer one of the same kind already starts with
  for (const a of ix) {
    if (isUnique(a) || !a.columns.length || a.columns.some((c) => /^SYS_NC/.test(c)) || (a.indexType ?? "NORMAL") !== "NORMAL") continue;
    const longer = ix.find((b) => b !== a && b.columns.length > a.columns.length && (b.indexType ?? "NORMAL") === "NORMAL" && b.locality === a.locality && a.columns.every((c, i) => b.columns[i] === c));
    if (longer) {
      r.add("info", `${a.name} (${a.columns.join(", ")}) is a leading prefix of ${longer.name} (${longer.columns.join(", ")}). A query on the prefix can use the longer index, so the shorter one may be redundant; it is smaller, which only matters for index-only scans and range scans over many entries.`, "inferred from the column lists; test with ALTER INDEX ... INVISIBLE before dropping");
    }
  }

  if (!r.has("bad", "warn") && !stale.length && !candidates.length && !scattered.length) {
    r.add("good", `${plural(ix.length, "index", "indexes")}: valid, visible, with current statistics.`, "DBA_INDEXES, DBA_IND_STATISTICS");
  }
  const summary = `${plural(ix.length, "index", "indexes")}${scattered.length ? `, ${scattered.length} with scattered rows` : ""}${candidates.length ? `, ${candidates.length} with no recorded use` : ""}${stale.length ? `, ${stale.length} stale` : ""}.`;
  return { id: "indexes", title: "Indexes", summary, findings: r.findings, rows: { head: ["Index", "Kind", "Columns", "Leaf blocks", "Clustering factor", "State", "Recorded use"], body } };
}

// ---------------------------------------------------------------------------------------------- 4. statistics quality

const DATE_TYPE = /^(DATE|TIMESTAMP)/i;
const KEY_NAME = /(^|_)(ID|KEY|NO|NR|SEQ|NUM|CODE)$|^ID$/i;
/** Types DBMS_STATS reads column statistics for; LOB, LONG, XML and object columns are left out of the "no statistics" check. */
const SCALAR_TYPE = /^(NUMBER|FLOAT|BINARY_(FLOAT|DOUBLE)|VARCHAR2?|NVARCHAR2|CHAR|NCHAR|DATE|TIMESTAMP|INTERVAL|RAW|ROWID)/i;
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
      r.add("bad", `${names(impossible.map((c) => `${c.name} (${fmt(c.numNulls)} nulls)`))}: more nulls than the table has rows (${fmt(rows)}). That cannot be true: the column and table statistics come from different gathers, or one was set by hand.`,
        `${DOC.colStats}: “NUM_NULLS Number of NULLs in the column”; a column cannot hold more nulls than the table has rows`,
        [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
    }
    const tooMany = cols.filter((c) => c.numDistinct !== null && c.numDistinct > 1.1 * Math.max(1, rows - (c.numNulls ?? 0)) && !(c.numNulls !== null && c.numNulls > rows));
    if (tooMany.length) {
      r.add("warn", `${names(tooMany.map((c) => `${c.name} (NDV ${fmt(c.numDistinct)})`))}: more distinct values than non-null rows (${fmt(rows)} rows): the table statistics are older than the column statistics, or a value was set by hand. The optimizer underestimates every equality predicate on ${tooMany.length === 1 ? "it" : "them"}.`,
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
  const frac = rows > 0 && detail.rowsChanged !== null ? detail.rowsChanged / rows : 0;
  if (changed && tableTime !== null && frac >= 0.01) {
    // an ever-growing date column has a high value close to the gather; a birth date or an expiry date does not
    const grow = cols.filter((c) => DATE_TYPE.test(c.dataType ?? "") && (c.inIndex === true || TIME_NAME.test(c.name)) && toTime(c.high) !== null && toTime(c.high)! <= tableTime && tableTime - toTime(c.high)! <= 7 * 86_400_000);
    if (grow.length) {
      const hot = detail.staleStats === true || frac > input.stalePercent / 100;
      r.add(hot ? "warn" : "info", `${names(grow.map((c) => `${c.name} (high value ${c.high!.slice(0, 10)})`))}: the highest value is within a week of the last gather (${detail.lastAnalyzed!.slice(0, 10)}) and ${fmt(detail.rowsChanged)} rows (${pct(frac)}) have changed since. If the new rows carry later dates, a predicate on them lies above HIGH_VALUE and the optimizer estimates fewer rows the further beyond it lies.`,
        `inferred: the 19c pages checked do not describe the estimate beyond HIGH_VALUE (docs/oracle19c-facts.md 10.1); Tuning Guide, Real-Time Statistics: “In QUANTITY_SOLD and AMOUNT_SOLD, the high and low values combine the manually gathered statistics and the real-time statistics.”`,
        [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}${input.partitioned ? ", granularity => 'AUTO'" : ""})`]);
    }
    const seqs = cols.filter((c) => c.dataType === "NUMBER" && c.inIndex === true && KEY_NAME.test(c.name) && c.numDistinct !== null && c.numDistinct >= 0.9 * (rows - (c.numNulls ?? 0)) && c.high !== null);
    if (seqs.length) {
      r.add("info", `${names(seqs.map((c) => `${c.name} (high value ${c.high})`))}: ${seqs.length === 1 ? "an indexed, near-unique number column that looks like a key" : "indexed, near-unique number columns that look like keys"}, and ${fmt(detail.rowsChanged)} rows (${pct(frac)}) have changed since the gather. If new rows get higher values (a sequence), predicates on the newest rows lie above HIGH_VALUE.`,
        "inferred from the column names and statistics; the 19c pages checked do not describe estimates beyond HIGH_VALUE");
    }
  }

  // columns the last gather did not cover
  const nostat = cols.filter((c) => c.lastAnalyzed === null && c.numDistinct === null && SCALAR_TYPE.test(c.dataType ?? ""));
  if (nostat.length) {
    r.add("warn", `${names(nostat.map((c) => c.name))} ${has(nostat.length)} no column statistics, so the optimizer guesses the selectivity of any predicate on ${nostat.length === 1 ? "it" : "them"}.`, "DBA_TAB_COL_STATISTICS has no row with LAST_ANALYZED for the column",
      [`EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`]);
  }
  if (tableTime !== null) {
    const old = cols.filter((c) => c.lastAnalyzed !== null && toTime(c.lastAnalyzed) !== null && tableTime - toTime(c.lastAnalyzed)! > 3_600_000);
    if (old.length) {
      r.add("info", `${names(old.map((c) => `${c.name} (${c.lastAnalyzed!.slice(0, 10)})`))}: column statistics older than the table's (${detail.lastAnalyzed!.slice(0, 10)}): the last gather did not cover ${old.length === 1 ? "this column" : "these columns"}. A column added since is not read by a plain gather of an incremental table (lab E5), and a METHOD_OPT that names columns skips the others.`,
        "lab E5 (ADD COLUMN: the next plain gather rereads no partition); DBA_TAB_COL_STATISTICS.LAST_ANALYZED",
        [...(input.partitioned && input.incremental === "TRUE" ? ["-- incremental table: a changed column list can reread every partition (lab Td); the dry run lists what it would read", `SELECT DBMS_STATS.REPORT_GATHER_TABLE_STATS(${OT}, method_opt => 'FOR COLUMNS SIZE 1 ${inLit(old.map((c) => ident(c.name)))}') FROM dual;`] : []),
         `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}, method_opt => 'FOR COLUMNS SIZE 1 ${inLit(old.map((c) => ident(c.name)))}')`]);
    }
  }

  // a sample where AUTO_SAMPLE_SIZE should have read everything
  if (input.estimatePercent === "auto" && rows > 0) {
    const small = cols.filter((c) => !isHist(c) && !/STATS_ON_/.test(c.notes ?? "") && c.sampleSize !== null && (c.numNulls ?? 0) <= rows && c.sampleSize < 0.5 * (rows - (c.numNulls ?? 0)));
    if (small.length) {
      r.add("info", `${names(small.map((c) => `${c.name} (${fmt(c.sampleSize)} of ${fmt(rows - (c.numNulls ?? 0))} rows)`))}: sampled on well under half of the rows although ESTIMATE_PERCENT is AUTO_SAMPLE_SIZE, which reads every row for the basic statistics. Probably an earlier gather with a fixed percentage left ${small.length === 1 ? "this" : "these"}; the NDV is scaled from the sample.`,
        `${DOC.colStats}: “SAMPLE_SIZE Sample size used in analyzing this column”; ${DOC.hist}: “if the sampling size is the default of AUTO_SAMPLE_SIZE, then the database creates frequency histograms from a full table scan”; inferred for the other statistics`);
    }
  }

  if (!r.findings.length) {
    r.add("good", `${plural(cols.length, "column")} checked against the ${fmt(rows)} rows: nulls, NDV, density, sample sizes and dates show no inconsistency.`, `${DOC.colStats}; checks listed in this section`);
  }
  const worst = r.has("bad") ? "problems that mislead the optimizer" : r.has("warn") ? "inconsistencies" : "nothing wrong";
  return { id: "quality", title: "Statistics quality", summary: `${plural(cols.length, "column")} checked: ${worst}.`, findings: r.findings };
}
