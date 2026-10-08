// The advisor: what one DBMS_STATS gather does to one table, from the table's preferences, the
// call (or the automatic job) and what changed since the last gather.
//
// Every rule on partitioned tables comes from the 19.27 lab log behind the explainer's chapter 8
// (docs/lab-observations.md: ids such as A3, C1, G2) or from the 19c documentation. The rules on
// plain tables, histograms, indexes and invalidation come from the 19c SQL Tuning Guide and the
// DBMS_STATS reference as summarised in the explainer's chapters 5, 6, 7 and 10. Each finding's
// `basis` says which; "inferred, not observed" marks a combination the lab did not run.

import { DEFAULTS, METHOD_OPT_TEXT, PREF_DEFAULTS, type Granularity, type Input, type MethodOpt, type Percent } from "./defaults";
import { clampInput } from "./clamp";
import { fmt, pct, plural } from "./format";
import type { AutoPlan, Cells, ColumnPlan, Effective, Finding, IndexPlan, Level, Outcome, Read, Resolved, ScanPlan, Step, WritePlan } from "./types";

const isTrue = (v: unknown): boolean => v === true || String(v).toUpperCase() === "TRUE";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const RANK: Record<Level, number> = { good: 0, warn: 1, bad: 2, info: -1 };

export function advise(raw: Partial<Record<keyof Input, unknown>> | null | undefined, withNext = true): Outcome {
  const { input: p, notes: clampNotes } = clampInput(raw);
  const flat = !p.partitioned;
  const N = p.partitions, B = p.blocksPerPartition, T = N * B;
  const NEW = p.newPartitions, CHG = p.changedPartitions, LCK = p.lockedPartitions, LCKCHG = p.lockedChanged, OLD = p.oldFormatPartitions;
  const U = N - LCK;
  const isInc = isTrue(p.incremental), ov = isTrue(p.overrides), pubOn = isTrue(p.publish);
  const S = p.synopses;
  const stalenessFlags = [p.useStalePercent && "USE_STALE_PERCENT", p.useLockedStats && "USE_LOCKED_STATS", p.allowMixedFormat && "ALLOW_MIXED_FORMAT"].filter(Boolean).join(",");
  const auto = p.runBy === "auto";

  const findings: Finding[] = [];
  const add = (level: Level, text: string, basis: string) => findings.push({ level, text, basis });
  const fixList: { rank: number; text: string }[] = [];
  const fixAt = (rank: number, text: string) => { if (!fixList.some((f) => f.text === text)) fixList.push({ rank, text }); };
  // the names the reader gave, else the placeholders; quotes doubled so the statements stay valid
  const lit = (v: string, placeholder: string) => `'${(v || placeholder).replace(/'/g, "''")}'`;
  const OT = `${lit(p.owner, "OWNER")}, ${lit(p.tableName, "TABLE")}`;
  const lockedName = lit(p.lockedPartitionName, "LOCKED_PARTITION");
  const sp = (name: string, value: string) => `EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, '${name}', '${value}')`;
  let hurtCall = false; // the call itself passes something that hurts: the fix is a plain call
  let verdict: [Level, string] | null = null;
  const setVerdict = (level: Level, headline: string) => { if (!verdict || RANK[level] > RANK[verdict[0]]) verdict = [level, headline]; };
  if (clampNotes.length) add("info", `Inputs adjusted: ${clampNotes.join(" ")}`, "input");
  if (!auto && p.force && LCK > 0) {
    add("warn", "force => TRUE with individually locked partitions was not tested in the lab. The read estimate retains the partition-lock assumptions; use the generated Oracle report to check this combination.", "not modelled; 19c DBMS_STATS force parameter");
    setVerdict("warn", "Individual partition locks with force: verify in Oracle");
  }

  // ---- step 0: the settings the gather actually uses
  const givenG = !auto && p.callGranularity !== "none", givenE = !auto && p.callEstimatePercent !== "none", givenM = !auto && p.callMethodOpt !== "none";
  const givenC = !auto && p.callCascade !== "none", givenI = !auto && p.callNoInvalidate !== "none", givenO = !auto && p.callOptions !== "none";
  const ignored: string[] = [];
  let gran: Granularity = p.granularity, est: Percent = p.estimatePercent, mo: MethodOpt = p.methodOpt;
  let cas = p.cascade, noInv = p.noInvalidate, opts = p.options;
  if (givenG) { if (ov) ignored.push("granularity"); else gran = p.callGranularity as Granularity; }
  if (givenE) { if (ov) ignored.push("estimate_percent"); else est = p.callEstimatePercent as number; }
  if (givenM) { if (ov) ignored.push("method_opt"); else mo = p.callMethodOpt as MethodOpt; }
  if (givenC) { if (ov) ignored.push("cascade"); else cas = p.callCascade as typeof cas; }
  if (givenI) { if (ov) ignored.push("no_invalidate"); else noInv = p.callNoInvalidate as typeof noInv; }
  if (givenO) { if (ov) ignored.push("options"); else opts = p.callOptions as typeof opts; }
  if (auto) opts = "GATHER AUTO";
  const blockSample = !auto && p.callBlockSample && isNum(est);
  const effective: Effective = { incremental: isInc, granularity: gran, estimatePercent: est, methodOpt: mo, cascade: cas, noInvalidate: noInv, options: opts, blockSample, ignored };
  const granFromCall = givenG && !ov, estFromCall = givenE && !ov;
  if (ignored.length) {
    add("info", `The table ignores ${ignored.join(", ")} from the call and uses ${ignored.length > 1 ? "its preferences" : "its preference"}. partname and force are not preferences, so they still apply.`, "lab G2, V1.5, Ta");
  }
  if (!auto && p.callBlockSample && !isNum(est)) add("info", "block_sample => TRUE has no effect with AUTO_SAMPLE_SIZE: there is no sample to take by blocks.", "19c DBMS_STATS reference");

  const resolved: Resolved[] = [];
  const res = (param: string, pref: keyof typeof PREF_DEFAULTS, value: string, prefValue: string, given: boolean, callValue?: string) => {
    if (auto) resolved.push({ param, value: param === "options" ? "GATHER AUTO" : prefValue, source: "job", note: "automatic selection using the table's preferences" });
    else if (given && ov) resolved.push({ param, value: prefValue, source: "ignored", note: `the call passed ${callValue ?? value}; PREFERENCE_OVERRIDES_PARAMETER is TRUE` });
    else if (given) resolved.push({ param, value, source: "call" });
    else resolved.push({ param, value: prefValue, source: prefValue === PREF_DEFAULTS[pref] ? "default" : "preference" });
  };
  const estText = (v: Percent | "none") => (v === "auto" ? "DBMS_STATS.AUTO_SAMPLE_SIZE" : v === "none" ? "" : `${fmt(v, 6)}`);
  res("estimate_percent", "ESTIMATE_PERCENT", estText(est), estText(p.estimatePercent), givenE, estText(p.callEstimatePercent));
  res("method_opt", "METHOD_OPT", METHOD_OPT_TEXT[mo], METHOD_OPT_TEXT[p.methodOpt], givenM, p.callMethodOpt === "none" ? undefined : METHOD_OPT_TEXT[p.callMethodOpt]);
  if (!flat) res("granularity", "GRANULARITY", gran, p.granularity, givenG, p.callGranularity);
  res("cascade", "CASCADE", cas === "AUTO_CASCADE" ? "DBMS_STATS.AUTO_CASCADE" : cas, p.cascade === "AUTO_CASCADE" ? "DBMS_STATS.AUTO_CASCADE" : p.cascade, givenC, p.callCascade);
  res("no_invalidate", "NO_INVALIDATE", noInv === "AUTO_INVALIDATE" ? "DBMS_STATS.AUTO_INVALIDATE" : noInv, p.noInvalidate === "AUTO_INVALIDATE" ? "DBMS_STATS.AUTO_INVALIDATE" : p.noInvalidate, givenI, p.callNoInvalidate);
  res("options", "OPTIONS", opts, p.options, givenO, p.callOptions);
  resolved.push({ param: "degree", value: p.degree, source: p.degree.toUpperCase() === "NULL" ? "default" : "preference", note: p.degree.toUpperCase() === "NULL" ? "the table's own DEGREE attribute" : undefined });
  const prefRow = (param: string, pref: keyof typeof PREF_DEFAULTS, value: string) => resolved.push({ param, value, source: value === PREF_DEFAULTS[pref] ? "default" : "preference" });
  prefRow("PUBLISH", "PUBLISH", p.publish);
  prefRow("STALE_PERCENT", "STALE_PERCENT", fmt(p.stalePercent, 4));
  if (!flat || isInc) prefRow("INCREMENTAL", "INCREMENTAL", p.incremental);
  if (isInc) {
    prefRow("INCREMENTAL_LEVEL", "INCREMENTAL_LEVEL", p.incrementalLevel);
    prefRow("INCREMENTAL_STALENESS", "INCREMENTAL_STALENESS", stalenessFlags || "NULL");
    prefRow("APPROXIMATE_NDV_ALGORITHM", "APPROXIMATE_NDV_ALGORITHM", p.ndvAlgorithm);
  }
  prefRow("PREFERENCE_OVERRIDES_PARAMETER", "PREFERENCE_OVERRIDES_PARAMETER", p.overrides);

  // the call as it would be written
  const nameOf = { new: lit(p.newPartitionName, "NEW_PARTITION"), changed: lit(p.changedPartitionName, "CHANGED_PARTITION") };
  const args: string[] = [];
  if (p.partname !== "none") args.push(`partname => ${nameOf[p.partname]}`);
  if (givenG) args.push(`granularity => '${p.callGranularity}'`);
  if (givenE) args.push(`estimate_percent => ${p.callEstimatePercent}`);
  if (!auto && p.callBlockSample) args.push("block_sample => TRUE");
  if (givenM) args.push(`method_opt => '${METHOD_OPT_TEXT[p.callMethodOpt as MethodOpt]}'`);
  if (givenC) args.push(`cascade => ${p.callCascade === "AUTO_CASCADE" ? "DBMS_STATS.AUTO_CASCADE" : p.callCascade}`);
  if (givenI) args.push(`no_invalidate => ${p.callNoInvalidate === "AUTO_INVALIDATE" ? "DBMS_STATS.AUTO_INVALIDATE" : p.callNoInvalidate}`);
  if (givenO) args.push(`options => '${p.callOptions}'`);
  if (!auto && p.force) args.push("force => TRUE");
  const head = `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT}`;
  const oneLine = `${head}${args.map((a) => `, ${a}`).join("")})`;
  const sql = auto
    ? `-- The automatic optimizer statistics collection: GATHER_DATABASE_STATS (auto) with\n-- OPTIONS => 'GATHER AUTO' and no other parameter. The nearest call you can run yourself:\nEXEC DBMS_STATS.GATHER_SCHEMA_STATS(${lit(p.owner, "OWNER")}, options => 'GATHER AUTO')`
    : !args.length || oneLine.length <= 96 ? oneLine : `BEGIN\n  ${head.slice(5)},\n${args.map((a) => `    ${a}`).join(",\n")});\nEND;\n/`;
  // BOOLEAN arguments need PL/SQL. On 19.27 REPORT_GATHER_TABLE_STATS also takes options => (ALL_ARGUMENTS
  // lists it, a call with GATHER AUTO runs) although the 19c reference omits it, so the call is passed as is.
  const dryRun = auto
    ? ["SET LONG 1000000 LONGCHUNKSIZE 1000000", "SELECT DBMS_STATS.REPORT_GATHER_AUTO_STATS(detail_level => 'TYPICAL', format => 'TEXT') FROM dual;"].join("\n")
    : [
      ...(givenO ? ["-- options => is accepted by REPORT_GATHER_TABLE_STATS on 19.27 although the 19c reference omits it; drop it if your release update rejects it."] : []),
      "SET LONG 1000000 LONGCHUNKSIZE 1000000",
      "VARIABLE advisor_report CLOB",
      "BEGIN",
      `  :advisor_report := DBMS_STATS.REPORT_GATHER_TABLE_STATS(${OT},`,
      ...args.map((a) => `    ${a},`),
      "    detail_level => 'TYPICAL', format => 'TEXT');",
      "END;", "/", "PRINT advisor_report",
    ].join("\n");

  let partname = auto ? "none" : p.partname;
  if (partname === "new" && NEW < 1) { add("warn", "partname names the new partition, but there are no new partitions here. The advisor models the call without it.", "input"); partname = "none"; }
  if (partname === "changed" && CHG < 1) { add("warn", "partname names a changed partition, but there are none here. The advisor models the call without it.", "input"); partname = "none"; }
  const named = partname !== "none";

  const read: Read = { newParts: 0, changedParts: 0, otherParts: 0, extraPass: 0, globalScan: 0 };
  const left = { newParts: NEW, changedParts: CHG, lack: 0 }; // what the gather leaves for the next plain call
  const sampleFactor = blockSample && isNum(est) ? est / 100 : 1;
  const units = () => read.newParts + read.changedParts + read.otherParts + read.extraPass + read.globalScan;
  const blocksNow = () => Math.ceil(units() * B * sampleFactor);

  // table-level staleness, as the automatic job and GATHER AUTO see it
  const tableChange = flat || p.useTableChangePercent ? p.tableChangePercent : (NEW * 100 + CHG * p.changePercent + LCKCHG * p.changePercent) / N;
  const tableStale = tableChange > p.stalePercent;
  const noStats = p.tableStats === "none";
  const autoPlan: AutoPlan = {
    tableChangePercent: tableChange, thresholdRows: Math.round((p.numRows * p.stalePercent) / 100), stale: tableStale || noStats,
    text: "",
  };

  const o: Outcome = {
    input: p, error: null, read, blocks: 0, partitionsRead: 0, global: flat ? "na" : "unchanged", globalNotes: null, synopsesAfter: flat ? "na" : S,
    verdict: ["good", ""], effective, resolved, findings, fixes: [], sql, dryRun, verify: "", steps: [],
    scan: { kind: "none", percent: null, passes: 0, text: "" },
    columns: { basic: "", ndv: "", rule: "", kinds: [], extraSample: false, deleted: false, text: "" },
    indexes: { mode: cas, fullScans: 0, partitionScans: 0, text: "" },
    write: { destination: "dictionary", history: "", invalidation: "rolling", text: "" },
    auto: autoPlan,
    cells: { total: N, newRead: 0, newLeft: NEW, changedRead: 0, changedLeft: CHG, locked: LCK, lockedChanged: LCKCHG, otherRead: 0, otherLeft: N - NEW - CHG - LCK, extraPass: false, globalScan: false },
    left, lockedNoSynopsisAfter: p.lockedNoSynopsis, next: null,
  };
  const readAllPartitions = () => { Object.assign(read, { newParts: NEW, changedParts: CHG, otherParts: N - NEW - CHG }); Object.assign(left, { newParts: 0, changedParts: 0, lack: 0 }); };
  const readUnlocked = () => { Object.assign(read, { newParts: NEW, changedParts: CHG, otherParts: U - NEW - CHG }); Object.assign(left, { newParts: 0, changedParts: 0, lack: 0 }); };
  const readNamed = () => {
    if (partname === "new") { read.newParts = 1; left.newParts = NEW - 1; } else { read.changedParts = 1; left.changedParts = CHG - 1; }
  };
  // Synopses in the adaptive-sampling format of 11g and 12.1 (partition NOTES ADAPTIVE_SAMPLING). 19c writes new ones
  // in HyperLogLog form by default and merges the two formats only under ALLOW_MIXED_FORMAT; without it the old-format
  // partitions count as stale and are read once more. From the 19c reference: the lab has no old-format synopses.
  let oldFormatReread = 0;
  const formatNotes = () => {
    const basis = "19c DBMS_STATS reference (APPROXIMATE_NDV_ALGORITHM, INCREMENTAL_STALENESS); inferred, not observed";
    if (p.ndvAlgorithm === "ADAPTIVE SAMPLING") {
      add("warn", "APPROXIMATE_NDV_ALGORITHM is ADAPTIVE SAMPLING: every synopsis is written in the 11g format, far larger than HyperLogLog and slower to merge. The default, REPEAT OR HYPERLOGLOG, writes new synopses in HyperLogLog form.", basis);
      fixAt(7, sp("APPROXIMATE_NDV_ALGORITHM", "REPEAT OR HYPERLOGLOG"));
    }
    if (OLD <= 0 || S !== "all") return;
    const one = OLD === 1;
    if (!p.allowMixedFormat) {
      if (!named) {
        const already = read.newParts + read.changedParts + read.otherParts;
        oldFormatReread = Math.max(0, Math.min(OLD, U - already));
        read.otherParts += oldFormatReread;
      }
      add("warn", `${plural(OLD, "partition")} still ${one ? "has" : "have"} a synopsis in the old adaptive-sampling format and INCREMENTAL_STALENESS lacks ALLOW_MIXED_FORMAT, so Oracle treats ${one ? "it" : "them"} as stale: ${named ? "the next plain gather reads them" : one ? "it is read" : "they are read"} once more and ${one ? "gets a HyperLogLog synopsis" : "get HyperLogLog synopses"}. One-off. ALLOW_MIXED_FORMAT, the default, avoids the reread: the old synopses are then merged as they are.`, basis);
      fixAt(7, sp("INCREMENTAL_STALENESS", `${stalenessFlags ? `${stalenessFlags},` : ""}ALLOW_MIXED_FORMAT`));
      setVerdict("warn", "One-off reread of the old-format partitions");
    } else {
      add("info", `${plural(OLD, "partition")} ${one ? "keeps" : "keep"} a synopsis in the old adaptive-sampling format. ALLOW_MIXED_FORMAT lets ${one ? "it" : "them"} merge with the HyperLogLog ones, so nothing is read for ${one ? "it" : "them"}. ${p.ndvAlgorithm === "HYPERLOGLOG" ? "Each is rewritten in HyperLogLog form when its partition is next re-gathered." : p.ndvAlgorithm === "ADAPTIVE SAMPLING" ? "New synopses are written in the old format too." : "REPEAT OR HYPERLOGLOG keeps the old format even when the partition is re-gathered; APPROXIMATE_NDV_ALGORITHM HYPERLOGLOG converts each as it is re-gathered, at no extra cost."}`, basis);
    }
  };
  let gathered = true; // whether the table statistics are written at all (false: ORA-20005, skipped by the job, nothing to do)
  let basicKept = false; // GATHER AUTO after a load: the basic statistics stay as they are

  const finish = (): Outcome => {
    o.blocks = blocksNow();
    o.partitionsRead = read.newParts + read.changedParts + read.otherParts;
    o.verdict = verdict ?? ["good", ""];
    if (hurtCall) {
      fixAt(9, "-- no parameters: the table's preferences decide");
      fixAt(9, `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`);
    }
    o.fixes = fixList.map((f, i) => ({ ...f, i })).sort((a, b) => a.rank - b.rank || a.i - b.i).map((f) => f.text);
    o.cells = {
      total: N,
      newRead: read.newParts, newLeft: Math.max(0, NEW - read.newParts),
      changedRead: read.changedParts, changedLeft: Math.max(0, CHG - read.changedParts),
      locked: LCK, lockedChanged: LCKCHG,
      otherRead: read.otherParts, otherLeft: Math.max(0, N - NEW - CHG - LCK - read.otherParts),
      extraPass: read.extraPass > 0, globalScan: read.globalScan > 0,
    };
    plans();
    if (withNext) {
      const published = gathered && pubOn;
      const globalPublished = published && (flat || !["untouched", "unchanged"].includes(o.global));
      const ni: Partial<Input> = {
        ...p, runBy: p.runBy, partname: "none", callGranularity: "none", callEstimatePercent: "none", callMethodOpt: "none", callCascade: "none", callNoInvalidate: "none", callOptions: "none",
        callBlockSample: false, force: false, columnChange: "none",
        newPartitions: left.newParts + left.lack, changedPartitions: left.changedParts, lockedNoSynopsis: o.lockedNoSynopsisAfter,
        // old-format synopses are rewritten only when Oracle must not merge formats; under ALLOW_MIXED_FORMAT they stay
        oldFormatPartitions: published && !p.allowMixedFormat && p.ndvAlgorithm !== "ADAPTIVE SAMPLING" ? Math.max(0, OLD - Math.min(OLD, o.partitionsRead)) : OLD,
        synopses: o.synopsesAfter === "all" || o.synopsesAfter === "partial" ? "all" : o.synopsesAfter === "table" || o.synopsesAfter === "na" ? (flat ? S : "none") : o.synopsesAfter,
        tableStats: globalPublished ? "gathered" : p.tableStats,
        tableChangePercent: globalPublished ? 0 : p.tableChangePercent,
        // Remaining below-threshold / locked DML is only estimable from partition inputs.
        useTableChangePercent: globalPublished && !flat && (left.changedParts > 0 || LCKCHG > 0) ? false : p.useTableChangePercent,
      };
      // Pending statistics do not replace published statistics or repair their synopses.
      if (!pubOn) Object.assign(ni, { newPartitions: NEW, changedPartitions: CHG, synopses: S, lockedNoSynopsis: p.lockedNoSynopsis });
      if (!flat && published && !named) {
        // the counters of the partitions that were read are reset; the rest keep their change
        ni.changedPartitions = left.changedParts;
      }
      const nx = advise(ni, false);
      nx.next = null;
      o.next = nx;
    }
    return o;
  };

  // ------------------------------------------------------------ the plans shared by every path
  const plans = () => {
    const estN: number | null = isNum(est) ? est : null;
    const estNum = estN !== null;
    const estV = estN ?? 0;
    // the scan
    if (!gathered || units() === 0) {
      o.scan = { kind: "none", percent: null, passes: 0, text: o.error ? "Nothing is read: the gather stops before it scans anything." : "Nothing is read." };
    } else if (estN === 100) {
      o.scan = { kind: "full", percent: 100, passes: units(), text: "ESTIMATE_PERCENT 100 reads every row and computes NDV from the complete data; it does not use AUTO_SAMPLE_SIZE's approximate NDV algorithm." };
    } else if (estNum) {
      o.scan = {
        kind: blockSample ? "block-sample" : "row-sample", percent: estV, passes: units(),
        text: blockSample
          ? `A ${fmt(estV, 6)}% block sample: whole blocks are picked, so about ${pct(estV / 100)} of the blocks are read. Rows that arrived together sit together, so the sample is correlated: a date column or a status that changes over time is misjudged.`
          : `A ${fmt(estV, 6)}% row sample. Every block is still visited to pick the rows, so the pass costs the same blocks as a full scan; only the CPU work shrinks.`,
      };
    } else {
      o.scan = {
        kind: "full", percent: null, passes: units(),
        text: `AUTO_SAMPLE_SIZE: one pass over every row of what is read. The NDV comes from hashing every value once into a fixed-size sketch, so nothing is sorted and nothing spills to TEMP.`,
      };
    }
    // the columns
    const usage = p.columnUsageRecorded;
    let rule: string, deleted = false, builds = false;
    switch (mo) {
      case "auto":
        rule = usage
          ? "SIZE AUTO: a column gets a histogram only when it has appeared in a predicate (recorded column usage: equality, equijoin, range or LIKE) and the data justifies one: skewed values, gaps and dense spots, or NDV of 254 or less with repeated values."
          : "SIZE AUTO with no column usage recorded: no column has appeared in a predicate yet, so no histogram is built at all.";
        builds = usage; break;
      case "skewonly":
        rule = "SIZE SKEWONLY: histograms are decided from the data alone, without column usage; every skewed column gets one, used in predicates or not.";
        builds = true; break;
      case "repeat":
        rule = p.histogramsPresent
          ? "SIZE REPEAT: only columns that already have a histogram get one, with the same bucket count. A column whose NDV grew past its old bucket count silently gets a top-frequency or hybrid histogram instead."
          : "SIZE REPEAT on a table without histograms: none are built, now or later.";
        builds = p.histogramsPresent; break;
      case "pinned":
        rule = "An explicit list: the named columns get histograms with the buckets asked for; every other column is SIZE 1, so column usage changes nothing.";
        builds = true; break;
      default:
        rule = p.histogramsPresent
          ? "FOR ALL COLUMNS SIZE 1: no histograms, and every histogram the table has today is deleted at the global and the partition level."
          : "FOR ALL COLUMNS SIZE 1: no histogram is built.";
        deleted = p.histogramsPresent; break;
    }
    const kinds = !gathered || !builds ? [] : estNum
      ? ["FREQUENCY", "HEIGHT-BALANCED (no TOP-FREQUENCY, no HYBRID: those need AUTO_SAMPLE_SIZE)"]
      : ["FREQUENCY and TOP-FREQUENCY, from the same full scan", "HYBRID, from one extra query per candidate over a row sample of about 5,500 non-null values"];
    const extraSample = gathered && builds && !estNum;
    o.columns = {
      basic: basicKept ? "Kept from the load (STATS_ON_LOAD): NUM_ROWS, BLOCKS, AVG_ROW_LEN, and per column NUM_NULLS, LOW_VALUE, HIGH_VALUE, AVG_COL_LEN, NDV." : "NUM_ROWS, BLOCKS and AVG_ROW_LEN; for every column NUM_NULLS, LOW_VALUE, HIGH_VALUE, AVG_COL_LEN and NUM_DISTINCT, all from the one pass.",
      ndv: !flat && o.global === "merged" ? "Partition NDVs from the one-pass sketch of each partition read; the global NDV merged from the partition synopses, nothing re-read." : estN === 100 ? "NDV computed from all rows, without scaling up a sample." : estNum ? `Estimated from the ${fmt(estV, 6)}% sample; rare values can make NDV inaccurate.` : "Approximate NDV computed from every row (SAMPLE_SIZE = NUM_ROWS); accuracy depends on the data and algorithm.",
      rule, kinds, extraSample, deleted,
      text: "",
    };
    // indexes
    const partsRead = read.newParts + read.changedParts + read.otherParts;
    const partOnly = gran === "PARTITION";
    let fullScans = 0, partitionScans = 0, itext: string;
    if (!gathered || cas === "FALSE") {
      itext = cas === "FALSE" ? "CASCADE is FALSE: no index is read. Index statistics stay as they are." : "No index work: the gather did not run.";
    } else if (p.indexCount === 0) {
      itext = "The table has no indexes.";
    } else {
      const local = flat ? 0 : Math.min(p.localIndexCount, p.indexCount), global = p.indexCount - local;
      if (!flat && partOnly) {
        partitionScans = local * partsRead; fullScans = global;
        itext = `GRANULARITY PARTITION: the ${plural(local, "local index")} ${local === 1 ? "gets" : "get"} statistics for the ${plural(partsRead, "index partition")} of the partitions read; the index-level statistics are left alone. ${global ? `The ${plural(global, "global index")} ${global === 1 ? "has" : "have"} no partitions to scope to, so ${global === 1 ? "it is" : "they are"} scanned in full.` : ""}`.trim();
      } else {
        partitionScans = local * partsRead; fullScans = p.indexCount;
        itext = flat
          ? `${cas === "TRUE" ? "cascade TRUE: every index is gathered" : "AUTO_CASCADE: Oracle decides per index whether new statistics are needed; in practice every index of a gathered table is read"}: ${plural(p.indexCount, "full index scan")}, one per index. BLEVEL, LEAF_BLOCKS, DISTINCT_KEYS and the clustering factor come from walking each index in key order.`
          : `Index statistics are not incremental: indexes have no synopses, and the index-level statistics of each index come from a full index scan. ${cas === "TRUE" ? "cascade TRUE gathers every index" : "Under AUTO_CASCADE the lab saw every index scanned in full on every gather, even when no row had changed"}: ${plural(p.indexCount, "full index scan")}${local ? `, plus the ${plural(partitionScans, "index partition")} of the ${plural(local, "local index")} for the partitions read` : ""}.`;
      }
      if (!flat && !pubOn) itext += " With PUBLISH FALSE the index statistics are pending too.";
    }
    o.indexes = { mode: cas, fullScans, partitionScans, text: itext };
    // write and invalidate
    if (!gathered) {
      o.write = { destination: "nothing", history: "Nothing is replaced, so nothing goes to the statistics history.", invalidation: "none", text: "No statistics are written and no cursor is invalidated." };
    } else if (!pubOn) {
      o.write = { destination: "pending", history: "The published statistics are not replaced, so nothing goes to the history.", invalidation: "none", text: "PUBLISH is FALSE: the result goes to the pending area (DBA_TAB_PENDING_STATS, DBA_TAB_COL_STATISTICS is unchanged). No cursor is invalidated. Test with OPTIMIZER_USE_PENDING_STATISTICS = TRUE, then PUBLISH_PENDING_STATS or DELETE_PENDING_STATS." };
    } else {
      const inv = noInv === "AUTO_INVALIDATE"
        ? "AUTO_INVALIDATE: dependent cursors are marked, not thrown out. On its next use each marked cursor draws a random deadline within the next five hours (18,000 s, _optimizer_invalidation_period); its first use after that hard-parses a new child with the new statistics. 'I gathered and the plan did not change' is usually this."
        : noInv === "FALSE"
          ? "no_invalidate FALSE: every dependent cursor is invalidated at once; its next execution hard-parses with the new statistics. Right for tests; a hard-parse storm in production."
          : "no_invalidate TRUE: no cursor is invalidated. Only statements parsed from now on see the new statistics; existing plans change when their cursors age out or the instance restarts.";
      o.write = {
        destination: "dictionary", invalidation: noInv === "AUTO_INVALIDATE" ? "rolling" : noInv === "FALSE" ? "immediate" : "never",
        history: "The statistics being replaced are saved to the history first (DBA_TAB_STATS_HISTORY), restorable with RESTORE_TABLE_STATS for the retention period, 31 days by default.",
        text: `The new statistics are written to the dictionary and published (LAST_ANALYZED moves, the DML counters in DBA_TAB_MODIFICATIONS reset). ${inv}`,
      };
    }
    // the automatic job
    const thr = autoPlan.thresholdRows;
    autoPlan.text = flat
      ? `The automatic job gathers this table when the rows changed since its last gather (inserts + updates + deletes in DBA_TAB_MODIFICATIONS) exceed STALE_PERCENT, ${fmt(p.stalePercent, 4)}% of ${fmt(p.numRows)} rows = ${fmt(thr)} rows${noStats ? "; a table without statistics is gathered first" : ""}. Today: ${pct(tableChange / 100)} changed, ${autoPlan.stale ? "stale: it is on the list, neediest objects first, until the maintenance window closes" : "not stale: the job skips it, however old the statistics are"}.`
      : `Modelled from schema GATHER AUTO tests on 19.27; the nightly job itself was not run. Missing or stale partitions are candidates. A global refresh is expected when global statistics are missing or the table is stale${ov ? ", or when a selected partition gather uses PREFERENCE_OVERRIDES_PARAMETER TRUE" : ""}. Table change: ${pct(tableChange / 100)} (${p.useTableChangePercent ? "supplied table-level DML percentage" : "estimate assuming equal-sized partitions"}); threshold: ${fmt(thr)} rows. Actual selection and reads should be checked with the database report.`;
  };

  // ============================================================ the automatic job
  if (auto) {
    const basisAuto = flat ? "19c Tuning Guide; lab G6, G7" : "lab G6, G7, G8, G9, Tb1, Tb2, Ti";
    if (p.tableLocked) {
      gathered = false;
      setVerdict("warn", "Skipped: statistics are locked");
      add("warn", "The automatic job skips tables with locked statistics; it raises no error. The table stays as it is until someone unlocks it or gathers with force => TRUE.", "19c Tuning Guide");
      fixAt(8, `EXEC DBMS_STATS.UNLOCK_TABLE_STATS(${OT})`);
      return finish();
    }
    if (flat) {
      if (!autoPlan.stale) {
        gathered = false;
        setVerdict("good", "Not stale: the job leaves it alone");
        add("info", `${pct(tableChange / 100)} of the rows changed, below STALE_PERCENT ${fmt(p.stalePercent, 4)}%. The job gathers only missing and stale statistics, so this table is not on its list, however old LAST_ANALYZED is.`, basisAuto);
        add("info", `It becomes stale after ${fmt(autoPlan.thresholdRows)} changed rows. Lower STALE_PERCENT on the table if that is too slow, or gather it yourself after a load.`, "19c Tuning Guide");
        return finish();
      }
      read.otherParts = 1;
      setVerdict("good", noStats ? "Missing statistics: gathered first" : "Stale: gathered with the table's preferences");
      add("good", `The table is ${noStats ? "without statistics" : `stale (${pct(tableChange / 100)} changed, above ${fmt(p.stalePercent, 4)}%)`}, so the job gathers it with its own preferences: ${isNum(est) ? `a ${fmt(est, 6)}% sample` : "one full scan"}, ${METHOD_OPT_TEXT[mo]}, CASCADE ${cas}.`, basisAuto);
      if (isNum(est)) { add("warn", `ESTIMATE_PERCENT ${fmt(est, 6)} uses ${est === 100 ? "full computation" : "sample-based NDV estimation"} and cannot use the AUTO_SAMPLE_SIZE top-frequency/hybrid histogram path.`, "19c Tuning Guide"); fixAt(4, sp("ESTIMATE_PERCENT", "DBMS_STATS.AUTO_SAMPLE_SIZE")); setVerdict(est === 100 ? "warn" : "bad", est === 100 ? "Stale: gathered with full computation" : "Stale: gathered, but sampled"); }
      if (mo === "size1" && p.histogramsPresent) { add("bad", "The METHOD_OPT preference is SIZE 1: every nightly gather deletes the histograms, including ones a manual gather added. Fix the preference, not the gather.", "19c Tuning Guide; explainer chapter 6"); fixAt(6, sp("METHOD_OPT", "FOR ALL COLUMNS SIZE AUTO")); setVerdict("bad", "Stale: gathered, histograms deleted"); }
      if (!pubOn) { add("bad", "PUBLISH is FALSE: the job gathers into the pending area every night. LAST_ANALYZED stays old and the table stays stale, although DBA_OPTSTAT_OPERATIONS shows it was gathered.", "19c Tuning Guide; explainer chapter 6"); fixAt(3, sp("PUBLISH", "TRUE")); setVerdict("bad", "Stale: gathered into the pending area, every night"); }
      if (noInv === "TRUE") add("warn", "NO_INVALIDATE is TRUE: this gather does not invalidate existing cursors; they use new statistics after a later hard parse.", "19c DBMS_STATS reference");
      return finish();
    }
    // partitioned
    const staleChg = CHG > 0 && p.changePercent > p.stalePercent;
    read.newParts = NEW; left.newParts = 0;
    if (staleChg) { read.changedParts = CHG; left.changedParts = 0; }
    const partsRead = NEW + (staleChg ? CHG : 0);
    if (CHG > 0 && !staleChg) add("info", `The ${plural(CHG, "changed partition")} changed by ${pct(p.changePercent / 100)}, below STALE_PERCENT ${fmt(p.stalePercent, 4)}%: the job does not regather ${CHG === 1 ? "it" : "them"}. The job uses STALE_PERCENT per partition; INCREMENTAL_STALENESS is a rule for manual incremental gathers.`, "lab G7 for the above-threshold case; inferred for below");
    if (LCKCHG > 0) add("info", `${plural(LCKCHG, "locked partition")} had DML. The job never gathers locked partitions.`, "19c Tuning Guide");
    const refreshGlobal = tableStale || noStats || (ov && partsRead > 0);
    if (!refreshGlobal && partsRead === 0) {
      gathered = false;
      o.global = "untouched";
      setVerdict("good", "Nothing stale: the job leaves it alone");
      add("info", "No unlocked partition needs statistics and the global statistics are present and fresh. The preference override does not itself select a fresh table for gathering.", basisAuto);
      return finish();
    }
    if (!isInc) {
      if (refreshGlobal) {
        read.globalScan = N; o.global = "fullscan"; o.globalNotes = "";
        // Automatic selection does not make every fresh or locked partition stale.
        setVerdict("warn", "Global refresh: selected partitions, then the whole table");
        add("warn", `INCREMENTAL is FALSE and the table is stale as a whole (${pct(tableChange / 100)} changed), so the job gathers it the old way: the stale partitions and then a scan of the whole table for the global statistics, ${fmt(blocksNow())} blocks.`, "lab T0; inferred for the job's selection");
        fixAt(1, sp("INCREMENTAL", "TRUE"));
      } else {
        o.global = "untouched"; o.globalNotes = null;
        setVerdict(partsRead ? "warn" : "good", partsRead ? "Partitions gathered, global statistics left behind" : "Nothing stale: the job leaves it alone");
        if (partsRead) add("warn", `The ${plural(partsRead, "new or stale partition")} ${partsRead === 1 ? "is" : "are"} gathered, but the table as a whole changed by only ${pct(tableChange / 100)}, below STALE_PERCENT, so the global statistics stay as they were: the new rows are not in them, and the partition key's high value still ends before them.`, "lab Ti, G6");
        else add("info", "No partition is new or stale by STALE_PERCENT, and neither is the table as a whole.", basisAuto);
        fixAt(1, sp("INCREMENTAL", "TRUE"));
      }
      return finish();
    }
    // incremental table under the job
    const conditionsHold = pubOn && !isNum(est) && p.incrementalLevel !== "TABLE";
    if (!conditionsHold) {
      add("bad", `INCREMENTAL is TRUE but ${!pubOn ? "PUBLISH is FALSE" : isNum(est) ? `ESTIMATE_PERCENT is ${fmt(est, 6)}` : "INCREMENTAL_LEVEL is TABLE"}, so the job cannot gather incrementally either: when it refreshes the global statistics it reads every partition and then the whole table.`, "lab G1, A8, N2; inferred for the job");
      if (!pubOn) fixAt(3, sp("PUBLISH", "TRUE"));
      if (isNum(p.estimatePercent)) fixAt(4, sp("ESTIMATE_PERCENT", "DBMS_STATS.AUTO_SAMPLE_SIZE"));
      if (p.incrementalLevel === "TABLE") fixAt(2, sp("INCREMENTAL_LEVEL", "PARTITION"));
    }
    if (refreshGlobal) {
      if (conditionsHold && gran !== "PARTITION") {
        if (S !== "all") readUnlocked();
        const synOk = !(LCKCHG > 0 && !p.useLockedStats) && !p.lockedNoSynopsis && !(LCK > 0 && S !== "all");
        if (synOk) {
          o.global = "merged"; o.globalNotes = "INCREMENTAL"; o.synopsesAfter = "all";
          formatNotes();
          setVerdict("good", `Incremental: the job reads ${fmt(read.newParts + read.changedParts + read.otherParts)} of ${fmt(N)} partitions, merges the rest`);
          add("good", `${noStats ? "Global statistics are missing" : tableStale ? `The table is stale as a whole (${pct(tableChange / 100)} changed)` : "PREFERENCE_OVERRIDES_PARAMETER is TRUE"}, so a global refresh is expected, merged from synopses without another table scan.`, "lab T1, G8, G9, Tb2; inferred for the nightly job");
        } else {
          read.globalScan = N; o.global = "fullscan"; o.globalNotes = "";
          if (S !== "all") readUnlocked();
          setVerdict("bad", "Full scan for the global statistics");
          add("bad", S !== "all" ? "The synopses are missing or out of step, so the job has to read every unlocked partition and, since the locked ones cannot get a synopsis, scan the whole table for the global statistics." : "A locked partition with DML or without a synopsis cannot be merged, so the global statistics come from a scan of the whole table.", "lab C1, V2, Tc; inferred for the job");
        }
      } else if (gran === "PARTITION") {
        o.global = "untouched"; o.globalNotes = null;
        setVerdict("warn", "GRANULARITY PARTITION: global statistics never refreshed");
        add("warn", "The GRANULARITY preference is PARTITION, so even a stale table gets only partition statistics from the job; the global row count and high values never move.", "lab G2b; inferred for the job");
        fixAt(5, sp("GRANULARITY", "AUTO"));
      } else {
        readAllPartitions(); read.globalScan = N; o.global = !pubOn ? "pending" : isNum(est) ? "sample" : "fullscan"; o.globalNotes = o.global === "pending" ? null : p.incrementalLevel === "TABLE" ? "HYPERLOGLOG" : "";
        setVerdict("bad", "Two full passes");
      }
    } else {
      o.global = "untouched"; o.globalNotes = null;
      if (partsRead) {
        setVerdict("warn", "Partitions gathered, global statistics left behind");
        add("warn", `The ${plural(partsRead, "partition")} ${partsRead === 1 ? "gets" : "get"} statistics and ${partsRead === 1 ? "a synopsis" : "synopses"}, but the table as a whole changed by ${pct(tableChange / 100)}, below STALE_PERCENT ${fmt(p.stalePercent, 4)}%, so the job leaves the global statistics alone. The global row count and the partition key's high value lag until the table has changed by STALE_PERCENT: on ten years of monthly partitions, 10% is a year.`, "lab G6, G7, Tb1");
        add("info", "Three ways out: end every load with a plain GATHER_TABLE_STATS, which merges the synopses and reads nothing beyond the new partition; lower STALE_PERCENT on the table; or set PREFERENCE_OVERRIDES_PARAMETER TRUE, under which the job refreshed the global statistics in the lab.", "lab G8, Tb2");
        fixAt(5, `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})  -- after each load: merges the synopses`);
        fixAt(7, sp("PREFERENCE_OVERRIDES_PARAMETER", "TRUE"));
        if (S !== "all") { o.synopsesAfter = "partial"; add("info", "Not every partition has a synopsis yet, so the first global refresh will cost a read of the rest.", "inferred, not observed"); } else o.synopsesAfter = "all";
      } else {
        setVerdict("good", "Nothing stale: the job leaves it alone");
        add("info", "No partition is new or stale by STALE_PERCENT, and the table as a whole is not stale either.", basisAuto);
      }
    }
    return finish();
  }

  // ============================================================ a plain (non-partitioned) table
  if (flat) {
    if (p.tableLocked && !p.force) {
      o.error = "ORA-20005"; gathered = false;
      setVerdict("bad", "ORA-20005: nothing gathered");
      add("bad", "The statistics are locked (LOCK_TABLE_STATS). Every gather raises ORA-20005, object statistics are locked, unless it passes force => TRUE.", "lab D1; 19c DBMS_STATS reference");
      fixAt(8, `EXEC DBMS_STATS.UNLOCK_TABLE_STATS(${OT})`);
      fixAt(8, "-- or add force => TRUE to the call: it gathers through the lock, which stays");
      return finish();
    }
    if (p.tableLocked) add("info", "force => TRUE gathers through the lock. The lock stays, so the automatic job keeps skipping the table.", "lab D3");
    const estN: number | null = isNum(est) ? est : null;
    const estNum = estN !== null;
    const estV = estN ?? 0;
    if (opts === "GATHER AUTO") {
      if (p.tableStats === "gathered" && !tableStale) {
        gathered = false;
        setVerdict("good", "Nothing to read");
        add("good", `OPTIONS GATHER AUTO gathers only what is missing or stale. The statistics are fresh (${pct(tableChange / 100)} changed, below STALE_PERCENT ${fmt(p.stalePercent, 4)}%), so nothing is read and nothing changes.`, "19c DBMS_STATS reference");
        return finish();
      }
      if (p.tableStats === "load" && !tableStale) {
        basicKept = true;
        read.extraPass = 0;
        setVerdict("good", "Fills the gaps: histograms and index statistics only");
        add("good", "The load left table and basic column statistics (NOTES = STATS_ON_LOAD) but no histograms and no index statistics. GATHER AUTO keeps the basic statistics and adds only what is missing: a histogram sample for the candidate columns, and the indexes.", "19c Tuning Guide; explainer chapter 7, observed on 19.27");
        add("info", "Under GATHER AUTO the frequency histograms are built from a sample rather than from a full scan.", "19c DBMS_STATS reference");
        return finish();
      }
      add("info", `OPTIONS GATHER AUTO: the statistics are ${p.tableStats === "none" ? "missing" : `stale (${pct(tableChange / 100)} changed)`}, so the table is gathered in full.`, "19c DBMS_STATS reference");
    }
    read.otherParts = 1;
    if (isInc && p.incrementalLevel === "TABLE" && !estNum && pubOn) {
      o.synopsesAfter = "table"; o.globalNotes = "HYPERLOGLOG";
      add("good", "INCREMENTAL TRUE with INCREMENTAL_LEVEL TABLE: the gather also builds one table-level synopsis (column NOTES HYPERLOGLOG). That is what a staging table needs so that an exchange into an incremental partitioned table does not reread the partition.", "lab H5, V3");
    } else if (isInc) add("info", p.incrementalLevel === "TABLE" ? "A table-level synopsis requires published statistics and AUTO_SAMPLE_SIZE; this gather does not build one." : "INCREMENTAL TRUE does nothing on a non-partitioned table unless INCREMENTAL_LEVEL is TABLE (a staging table for an exchange).", "19c DBMS_STATS reference");
    if (estV === 100) {
      setVerdict("info", "Full computation: every row, exact NDV");
      add("info", "ESTIMATE_PERCENT 100 computes from every row. It does not enable incremental synopses or AUTO_SAMPLE_SIZE's top-frequency and hybrid histogram path.", "19c DBMS_STATS reference; 19c Tuning Guide");
    } else if (estNum) {
      setVerdict("warn", `Sampled at ${fmt(estV, 6)}%: guessed NDV, no hybrid histograms`);
      add("warn", `ESTIMATE_PERCENT ${fmt(estV, 6)}: ${blockSample ? `a block sample reads about ${pct(estV / 100)} of the blocks, but rows stored together are sampled together` : "a row sample still reads every block"}. The NDV is scaled up from the sample and lands far too low on columns with many rare values; top-frequency and hybrid histograms are impossible, so skewed columns get height-balanced ones. On 11g and later this is usually slower and worse than AUTO_SAMPLE_SIZE.`, "19c Tuning Guide; explainer chapter 5");
      if (estFromCall) hurtCall = true;
      if (isNum(p.estimatePercent)) fixAt(4, sp("ESTIMATE_PERCENT", "DBMS_STATS.AUTO_SAMPLE_SIZE"));
    } else setVerdict("good", "One full scan, approximate NDV");
    if (mo === "size1" && p.histogramsPresent) {
      setVerdict("bad", "Reads once, but deletes every histogram");
      add("bad", "method_opt FOR ALL COLUMNS SIZE 1 deletes every histogram on the table, including the ones the automatic job built. The symptom: plans that are good after the nightly job and bad after this script.", "lab E6; explainer chapter 5");
      if (givenM && !ov) hurtCall = true; else fixAt(6, sp("METHOD_OPT", "FOR ALL COLUMNS SIZE AUTO"));
    } else if (mo === "size1") add("info", "FOR ALL COLUMNS SIZE 1: no histograms are built. The table has none to lose.", "19c DBMS_STATS reference");
    if (mo === "repeat" && !p.histogramsPresent) add("warn", "SIZE REPEAT on a table without histograms never builds one, however skewed a column is.", "19c DBMS_STATS reference");
    if (mo === "auto" && !p.columnUsageRecorded) add("info", "No column usage has been recorded, so SIZE AUTO builds no histogram. Histograms appear at the first gather after the columns have been used in predicates.", "19c Tuning Guide; explainer chapter 5");
    if (!pubOn) {
      o.global = "na";
      setVerdict("warn", "Pending: the published statistics do not change");
      add("warn", "PUBLISH is FALSE: the result waits in DBA_TAB_PENDING_STATS. The published statistics, LAST_ANALYZED and the staleness flag do not change, so the automatic job will gather the table again, into the pending area again.", "lab G1; 19c Tuning Guide");
      fixAt(3, sp("PUBLISH", "TRUE"));
    }
    if (noInv === "TRUE") add("warn", "no_invalidate TRUE: this gather does not invalidate existing cursors; they use new statistics after a later hard parse.", "19c DBMS_STATS reference");
    if (cas === "FALSE" && p.indexCount > 0) add("info", "CASCADE FALSE: the indexes keep their statistics. CREATE INDEX and REBUILD compute their own, so a new index is not left without; an index whose table was reloaded or moved is.", "19c Tuning Guide; explainer chapter 10");
    if (p.tableStats === "none") add("info", "The table has no statistics yet: the first gather records everything, and the automatic job would have done the same at the next maintenance window.", "19c Tuning Guide");
    return finish();
  }

  // ============================================================ a partitioned table, GATHER_TABLE_STATS
  // ---- step 1: a lock on the table
  if (p.tableLocked && !p.force) {
    o.error = "ORA-20005"; gathered = false;
    setVerdict("bad", "ORA-20005: nothing gathered");
    add("bad", "LOCK_TABLE_STATS locks the table and every partition, also partitions added later. Every gather on the table or on one partition raises ORA-20005, and UNLOCK_PARTITION_STATS on the new partition changes nothing.", "lab D1, D2");
    fixAt(8, `EXEC DBMS_STATS.UNLOCK_TABLE_STATS(${OT})`);
    fixAt(8, "-- or add force => TRUE to the call: it gathers through the lock, which stays");
    return finish();
  }
  if (p.tableLocked) add("info", "force => TRUE gathers through the table lock, still incrementally if the conditions hold. The lock stays.", "lab D3");
  if (opts === "GATHER AUTO") {
    if (isInc) add("info", "options => 'GATHER AUTO' on an incremental table: the reference says the option applies only to tables without INCREMENTAL; in the lab GATHER_TABLE_STATS with it read the new partition and refreshed the global statistics like a plain call. Modelled as a plain call.", "lab G5b; 19c DBMS_STATS reference");
    else add("info", "options => 'GATHER AUTO' gathers level by level what is missing or stale. On a table without INCREMENTAL the lab saw a stale partition gathered and the global statistics left alone; modelled here as the plain call, which is the upper bound.", "lab Ti; inferred for GATHER_TABLE_STATS");
  }

  const partOnly = gran === "PARTITION";
  if (!isInc && named && gran === "APPROX_GLOBAL AND PARTITION") add("warn", "APPROX_GLOBAL AND PARTITION can aggregate global statistics without scanning the table, excluding column NDV and index distinct keys, when all partition statistics are available. That aggregation path is not modelled: the displayed full scan is an upper bound.", "19c DBMS_STATS reference");
  // the old way: what a gather does when it cannot work incrementally
  const oldWay = (inferredNamed: boolean) => {
    if (gran !== "GLOBAL") { if (named) readNamed(); else readUnlocked(); }
    if (!partOnly) read.globalScan = N;
    if (named && inferredNamed) add("info", "The call names a partition. Gathered the old way, that reads the partition and then the whole table, as it does without INCREMENTAL (X2). With the setting that forces the old way here, this combination was not observed.", "lab X2; inferred, not observed");
    if (partOnly) add("info", "GRANULARITY PARTITION never scans the whole table, so only the partition level is gathered. This combination, without incremental statistics, was not observed.", "19c DBMS_STATS reference; inferred, not observed");
  };

  // ---- step 2: INCREMENTAL = FALSE
  if (!isInc) {
    oldWay(false);
    o.global = partOnly ? "untouched" : isNum(est) ? "sample" : "fullscan";
    o.globalNotes = partOnly ? null : "";
    o.synopsesAfter = named ? (S === "all" ? "partial" : S) : (S === "all" ? "stale" : S);
    const what = gran === "GLOBAL" ? "the whole table for global statistics only" : named ? (partOnly ? "that one partition" : "that partition and then the whole table") : (partOnly ? "every partition" : "every partition and then the whole table");
    setVerdict("warn", gran === "GLOBAL" ? "Global statistics only: one table scan" : partOnly ? "Global statistics left behind" : named ? "Not incremental: one partition, then the whole table" : "Not incremental: every partition, then the whole table");
    add("warn", `INCREMENTAL is FALSE, so the gather reads ${what}: ${fmt(blocksNow())} blocks. Nothing is kept between gathers, so the next gather costs the same.`, "lab T0, L1, X2");
    if (!partOnly && gran !== "GLOBAL") add("info", "The second pass exists because NDV does not add up across partitions: 24 monthly NDVs of about 2,500 say nothing about the global 5,000. Without synopses the only way to a global NDV is to read the whole table again.", "19c Tuning Guide; explainer chapter 8");
    if (S === "all") add("info", "Synopses from earlier incremental gathers stay in SYSAUX but are no longer kept up to date. Switching INCREMENTAL back on rereads every partition once to rebuild them.", "lab L1");
    if (partOnly) add("warn", "The global row count and the partition key's high value stay as they were. If the table never had global statistics, the TABLE row is aggregated from the partitions with GLOBAL_STATS = NO: row counts right, NDVs guesses.", "inferred, not observed; lab A3, A10 saw it on an incremental table; 19c Tuning Guide");
    if (isNum(est)) { add("warn", `ESTIMATE_PERCENT ${fmt(est, 6)}: ${est === 100 ? "NDV is computed from all rows" : "NDV is estimated from a sample"}; frequency and height-balanced histograms are available, but top-frequency and hybrid need AUTO_SAMPLE_SIZE.`, "19c Tuning Guide"); if (estFromCall) hurtCall = true; if (isNum(p.estimatePercent)) fixAt(4, sp("ESTIMATE_PERCENT", "DBMS_STATS.AUTO_SAMPLE_SIZE")); }
    if (mo === "size1" && p.histogramsPresent) { add("bad", "FOR ALL COLUMNS SIZE 1 deletes every histogram, global and partition level.", "lab E6"); setVerdict("bad", "Two passes, and every histogram deleted"); if (givenM && !ov) hurtCall = true; }
    if (!pubOn) { o.global = partOnly ? "untouched" : "pending"; add("warn", "PUBLISH is FALSE: all of it goes to the pending area; the published statistics do not change.", "lab G1"); fixAt(3, sp("PUBLISH", "TRUE")); }
    fixAt(1, sp("INCREMENTAL", "TRUE"));
    fixAt(1, "-- the first incremental gather then reads every partition once to build the synopses");
    if (partOnly) { if (granFromCall) hurtCall = true; if (p.granularity === "PARTITION") fixAt(5, sp("GRANULARITY", "AUTO")); }
    if (!verdict) setVerdict("warn", "Not incremental");
    return finish();
  }

  // ---- step 3: settings that make an incremental table gather the old way
  const estNum = isNum(est);
  const causes: string[] = [];
  if (estNum) causes.push("estimate");
  if (!pubOn) causes.push("publish");
  if (p.incrementalLevel === "TABLE") causes.push("level");
  if (causes.length) {
    const first = causes[0];
    if (causes.includes("estimate")) {
      add("bad", `ESTIMATE_PERCENT ${fmt(est as number, 6)} cannot build synopses. The gather runs the old way: ${named && partOnly ? "that partition is sampled and gets no synopsis" : "partitions are sampled, then the whole table"}. Existing synopses stay in SYSAUX but no longer match the statistics.`, "lab A8, X3");
      if (estFromCall) hurtCall = true;
      if (isNum(p.estimatePercent)) fixAt(4, sp("ESTIMATE_PERCENT", "DBMS_STATS.AUTO_SAMPLE_SIZE"));
    }
    if (causes.includes("publish")) {
      add("bad", "PUBLISH is FALSE. Pending statistics are gathered without synopses: every partition, then the whole table. The result waits in DBA_TAB_PENDING_STATS and the published statistics do not change.", "lab G1, G1b");
      add("bad", "Publishing the pending statistics leaves the synopses out of step: the next gather rereads every partition. Deleting them instead lets the next gather read only what changed.", "lab G1c, Tf");
      fixAt(3, sp("PUBLISH", "TRUE"));
      fixAt(3, `-- Optional, after reviewing the pending statistics: EXEC DBMS_STATS.DELETE_PENDING_STATS(${OT})`);
    }
    if (causes.includes("level")) {
      add("bad", "INCREMENTAL_LEVEL TABLE keeps one synopsis for the whole table, which is what a staging table needs before an exchange. On a partitioned table it replaces the partition synopses, and every gather reads every partition and then the whole table.", "lab N2, X4");
      add("info", "Back on PARTITION, every partition is read once more to rebuild its synopsis. TABLE belongs on the staging table of an exchange, not on the partitioned table.", "lab X4");
      fixAt(2, sp("INCREMENTAL_LEVEL", "PARTITION"));
    }
    if (causes.length > 1) add("info", "More than one of these is set. Fixing one is not enough: each alone forces the old way.", "lab A8, G1, N2");

    if (first === "estimate" && named && partOnly) {
      readNamed();
      o.global = "untouched"; o.globalNotes = null;
      if (S === "all") { o.synopsesAfter = "partial"; left.lack = 1; } else Object.assign(left, { newParts: NEW, changedParts: CHG, lack: 0 });
      setVerdict("warn", "Sampled partition has no synopsis; global statistics left behind");
      add("info", S === "all" ? "The next plain gather reads that partition again to build its synopsis, and merges the global statistics." : "No synopsis was built.", "lab X3");
    } else {
      oldWay(true);
      if (first === "estimate") {
        o.global = partOnly ? "untouched" : "sample"; o.globalNotes = partOnly ? null : "";
        o.synopsesAfter = S === "all" ? (named ? "partial" : "stale") : S;
        if (named && S === "all") left.lack = 1;
        setVerdict("bad", partOnly ? "Every partition sampled, no synopses kept" : estFromCall ? "Two full passes now, one more later" : "Two full passes, every time");
        if (!named && S !== "none") add("bad", `The next plain gather finds the synopses out of step with the statistics and reads ${LCK ? "every unlocked partition" : `all ${fmt(N)} partitions`} to rebuild them (${fmt(U * B)} blocks)${estFromCall ? "" : ", unless the preference is fixed first"}.`, "lab A8b");
      } else if (first === "publish") {
        o.global = "pending"; o.globalNotes = null;
        Object.assign(left, { newParts: NEW, changedParts: CHG, lack: 0 });
        setVerdict("bad", "Two full passes, every time");
      } else {
        o.global = partOnly ? "untouched" : "fullscan"; o.globalNotes = "HYPERLOGLOG";
        o.synopsesAfter = "table";
        setVerdict("bad", "Two full passes, every time");
      }
    }
    if (mo === "size1" && p.histogramsPresent) { add("bad", "FOR ALL COLUMNS SIZE 1 also deletes every histogram, global and partition level.", "lab E6"); if (givenM && !ov) hurtCall = true; }
    return finish();
  }

  // ---- step 4: the incremental gather
  const staleChg = CHG > 0 && p.changePercent > 0 && (!p.useStalePercent || p.changePercent > p.stalePercent);
  const lockedNoSyn = p.lockedNoSynopsis || (LCK > 0 && S !== "all");
  const inferredLockedNoSyn = !p.lockedNoSynopsis && LCK > 0 && S !== "all";
  let synopsisBuildOnly = false;

  // 4.1 which partitions are read
  if (S !== "all") {
    if (named && partOnly) {
      readNamed();
      Object.assign(left, { newParts: 0, changedParts: 0, lack: Math.max(0, U - 1) });
      synopsisBuildOnly = S === "none";
    } else readUnlocked();
  } else if (named) {
    readNamed();
    const kNew = left.newParts, kChg = staleChg ? left.changedParts : 0;
    if (kNew + kChg > 0) add("warn", `${plural(kNew + kChg, "other partition")} still ${kNew ? "without statistics" : "stale"}${kNew && kChg ? " or stale" : ""}. The call names one partition, so the rest wait for the next gather; the dry run lists them.`, "inferred, not observed");
    if (partname === "changed" && !staleChg) add("info", "The call names a changed partition, so it is read even though the change is below the staleness threshold.", "inferred, not observed");
  } else {
    read.newParts = NEW; left.newParts = 0;
    if (staleChg) { read.changedParts = CHG; left.changedParts = 0; }
  }
  if (S === "none") add("info", `No synopses exist yet. The first incremental gather reads ${named && partOnly ? "the named partition" : "every unlocked partition"} once to build them.`, "lab T1, N1");
  if (S === "stale") add("info", "The synopses no longer match the statistics, so each partition is read again to rebuild its synopsis.", "lab A8b, L1");
  if (S === "none" && named && !partOnly) add("warn", "The call names a partition, but the table has no synopses yet and GRANULARITY is not PARTITION, so every unlocked partition is read.", "lab N1");
  if (S === "none" && partOnly && !named) add("info", "GRANULARITY PARTITION without partname still reads every unlocked partition to build its synopsis.", "inferred, not observed; lab A10 saw only the new partition read, on a table that had synopses");
  if (synopsisBuildOnly) {
    add("good", "The call builds synopses one partition at a time, which is how to start a very large table. Finish with one plain call, and set PREFERENCE_OVERRIDES_PARAMETER only after the build: it turns PARTITION into AUTO.", "lab V1.2, V1.3, example 5");
    add("info", `The plain call afterwards reads the partitions that still have no synopsis (${fmt(left.lack)} now), then merges. The advisor cannot know how many calls you have already made.`, "lab V1.3, V5");
  }

  // changed partitions and staleness (only when synopses exist and no partname scoped the call)
  if (S === "all" && !named && CHG > 0) {
    if (!p.useStalePercent && p.changePercent > 0) add("info", `By default any DML makes a partition stale: the ${plural(CHG, "changed partition")} ${CHG === 1 ? "is" : "are"} read although only ${pct(p.changePercent / 100)} of the rows changed. USE_STALE_PERCENT would skip changes below STALE_PERCENT, at the price of global statistics that lag.`, "lab B1, B2");
    else if (p.useStalePercent && staleChg) add("info", `The ${plural(CHG, "changed partition")} changed by more than STALE_PERCENT (${fmt(p.stalePercent, 4)}%), so ${CHG === 1 ? "it is" : "they are"} read.`, "lab B3, B3b");
    else if (p.useStalePercent && !staleChg) add("warn", `The ${plural(CHG, "changed partition")} changed by ${pct(p.changePercent / 100)}, below STALE_PERCENT (${fmt(p.stalePercent, 4)}%): not read. The global row count lags the table by these changes until they cross the threshold.`, "lab B2");
  }
  formatNotes();

  // 4.2 column changes
  const cc = p.columnChange;
  let colReread = false;
  if (cc !== "none") {
    if (named && partOnly) {
      add("info", "A column change is pending. This call reads one partition only; the next call that covers every partition will reread all of them.", "lab E3i, E4");
    } else if (cc === "usage" && mo !== "auto") {
      add("good", mo === "skewonly" ? "SIZE SKEWONLY does not look at column usage, so a first predicate on a column changes nothing. Not observed in the lab; SIZE REPEAT and a pinned list behaved this way." : "The first predicate on a column adds nothing: METHOD_OPT does not choose histograms from column usage here, so no partition is read again.", mo === "skewonly" ? "inferred, not observed; lab E3ii, V1.6" : "lab E3ii, V1.6");
    } else {
      readUnlocked();
      colReread = true;
      if (cc === "usage" || cc === "histogram") read.extraPass = U;
      if (cc === "usage") {
        add("warn", "With METHOD_OPT on SIZE AUTO, a first predicate on a column makes it a histogram candidate. A global histogram is derived from partition histograms, so every unlocked partition is read again for the hybrid histograms, once or twice (one pass was enough for skewed columns). The extra histograms are marked HIST_FOR_INCREM_STATS and are not used for optimization.", "lab E1, E3i, R2");
        fixAt(6, sp("METHOD_OPT", "FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 <column>"));
        fixAt(6, "-- template: pin the columns that need histograms; the first predicate on any other column then costs nothing");
      } else if (cc === "group") {
        add("warn", "A new column group needs a synopsis and statistics for the group in every partition, so every unlocked partition is read once.", "lab E4");
      } else {
        add("warn", "One more histogram in a pinned METHOD_OPT reads every unlocked partition twice: once for the synopsis and once for the real histogram.", "lab Td");
      }
      add("info", "The price is paid once per new column, column group or histogram. The next gather reads nothing for it.", "lab E2, E4b");
      setVerdict("warn", "One-off reread of every partition");
    }
  }

  // 4.3 locked partitions
  const reasons: string[] = [];
  if (LCKCHG > 0 && !p.useLockedStats) reasons.push("changed");
  if (lockedNoSyn) reasons.push("nosyn");
  if (colReread && LCK > 0) reasons.push("column");
  const fullScanForced = !partOnly && reasons.length > 0;
  const tail = partOnly ? " Once a plain call merges the global statistics, this applies." : "";
  if (reasons.includes("changed")) {
    add("bad", `${plural(LCKCHG, "locked partition")} had DML. ${LCKCHG === 1 ? "It is" : "They are"} not read, but the synopsis cannot be refreshed, so the global statistics come from a scan of the whole table (${fmt(T)} blocks) on every gather until ${LCKCHG === 1 ? "it is" : "they are"} unlocked.${tail}`, "lab C1, C1b, X1");
    fixAt(7, sp("INCREMENTAL_STALENESS", "USE_STALE_PERCENT,USE_LOCKED_STATS,ALLOW_MIXED_FORMAT"));
    fixAt(8, `EXEC DBMS_STATS.UNLOCK_PARTITION_STATS(${OT}, ${lockedName})`);
    fixAt(8, "-- gather, then lock the partition again if you want it frozen");
  }
  if (reasons.includes("nosyn")) {
    add("bad", `${inferredLockedNoSyn ? "A locked partition cannot get a synopsis, and the table has none yet" : "A locked partition has no synopsis, or none for a column group (statistics copied in and locked, or a column group added after the lock)"}, so the global statistics come from a scan of the whole table (${fmt(T)} blocks) on every gather, with or without USE_LOCKED_STATS.${tail}`, inferredLockedNoSyn ? "inferred, not observed; lab V2, Tl for the copied-statistics case" : "lab V2, Tl");
    fixAt(8, `EXEC DBMS_STATS.UNLOCK_PARTITION_STATS(${OT}, ${lockedName})`);
    fixAt(8, "-- gather that partition, then lock it again if you want it frozen");
  }
  if (reasons.includes("column")) {
    add("bad", `The locked partitions cannot get a synopsis for the new column, column group or histogram, so the global statistics come from a scan of the whole table on this and every later gather until they are unlocked.${tail}`, "lab Tc; inferred for histograms");
    fixAt(8, `EXEC DBMS_STATS.UNLOCK_PARTITION_STATS(${OT}, ${lockedName})`);
    fixAt(8, "-- gather with the column change, then lock the partitions again");
  }
  if (LCKCHG > 0 && p.useLockedStats) add("warn", `${plural(LCKCHG, "locked partition")} had DML and USE_LOCKED_STATS is on, so nothing is read for ${LCKCHG === 1 ? "it" : "them"}. Their new rows are in no statistic, the global row count included.`, "lab C2, V1.7");
  if (LCK > 0 && LCKCHG === 0 && cc === "none" && !lockedNoSyn) add("info", "Locked partitions with no DML cost nothing and change nothing.", "lab C4, D5");
  if (fullScanForced) {
    setVerdict("bad", "Full scan for the global statistics, every time");
    read.globalScan = N;
  }
  o.lockedNoSynopsisAfter = p.lockedNoSynopsis || (LCK > 0 && S !== "all") || (colReread && LCK > 0);

  // 4.4 global statistics
  if (partOnly) {
    o.global = "untouched"; o.globalNotes = null;
    if (synopsisBuildOnly) setVerdict("good", "Building synopses one partition at a time");
    else {
      setVerdict("warn", "Global statistics left behind");
      add("warn", "The call asks for the partition level only. The partitions get statistics and synopses, but the global row count and the partition key's high value still end before the new data. A plain call afterwards merges the synopses and reads nothing.", "lab A3, A3b, A10, G2b");
      if (granFromCall) hurtCall = true;
      if (p.granularity === "PARTITION") fixAt(5, sp("GRANULARITY", "AUTO"));
    }
  } else if (fullScanForced) {
    o.global = "fullscan"; o.globalNotes = "";
  } else {
    o.global = "merged"; o.globalNotes = "INCREMENTAL";
    add("good", "The global statistics are merged from the partition synopses. Nothing beyond the partitions is read.", "lab A1, A2, T1b");
  }
  if (!["AUTO", "PARTITION"].includes(gran)) add("info", `GRANULARITY ${gran} behaved like AUTO in the lab, with the same reads. The documentation and the lab both promise AUTO, so use AUTO.`, "lab A4, A5, A6, A7");

  // 4.5 METHOD_OPT => SIZE 1 in the call
  if (mo === "size1" && p.histogramsPresent) {
    add("bad", "method_opt => 'FOR ALL COLUMNS SIZE 1' reads nothing extra but deletes every histogram, at the global and the partition level. With SIZE REPEAT as the preference they do not come back.", "lab E6, E6b");
    setVerdict("bad", "Reads little, but deletes every histogram");
    if (givenM && !ov) hurtCall = true; else fixAt(6, sp("METHOD_OPT", "FOR ALL COLUMNS SIZE AUTO"));
  }

  // 4.6 synopses afterwards
  const leftover = named && S === "all" ? left.newParts + (staleChg ? left.changedParts : 0) : 0;
  if (lockedNoSyn || LCKCHG > 0 || leftover > 0 || (S !== "all" && named && partOnly && left.lack > 0)) o.synopsesAfter = "partial";
  else o.synopsesAfter = "all";

  // 4.7 verdict when nothing above raised it
  if (!verdict) {
    const k = read.newParts + read.changedParts + read.otherParts;
    if (k + read.extraPass + read.globalScan === 0) setVerdict("good", "Nothing to read");
    else setVerdict("good", `Incremental: reads ${fmt(k)} of ${fmt(N)} partitions, merges the rest`);
  }
  if ((verdict as [Level, string] | null)?.[0] === "good" && !synopsisBuildOnly && !findings.some((f) => f.level === "good")) add("good", "Only partitions with no statistics, or with stale ones, are read. Every other synopsis is reused.", "lab A1, T1b");
  if (noInv === "TRUE") add("warn", "no_invalidate TRUE: this gather does not invalidate existing cursors; they use new statistics after a later hard parse.", "19c DBMS_STATS reference");
  if (cas !== "FALSE" && p.indexCount > 0 && isInc) add("info", `Indexes are not incremental: with CASCADE ${cas === "TRUE" ? "TRUE" : "at its default"} every gather scans each of the ${plural(p.indexCount, "index", "indexes")} in full. If that dominates, set CASCADE FALSE and gather the indexes on your own schedule (GATHER_INDEX_STATS with granularity PARTITION after each load, GLOBAL weekly). That needs the override left at FALSE.`, "lab F2, F3, F5, F6, V1.4");
  return finish();
}

/** Build the ordered step list and the verification queries for an outcome (pure; called by the page). */
export function stepsOf(o: Outcome): Step[] {
  const p = o.input, flat = !p.partitioned, auto = p.runBy === "auto";
  const N = p.partitions, B = p.blocksPerPartition;
  const r = o.read;
  const steps: Step[] = [];
  const fromCall = o.resolved.filter((x) => x.source === "call").map((x) => x.param);
  const fromPref = o.resolved.filter((x) => x.source === "preference").map((x) => x.param);
  const ign = o.resolved.filter((x) => x.source === "ignored").map((x) => x.param);
  steps.push({
    id: "resolve", title: "Resolve the settings", status: "does",
    text: auto
      ? "The automatic job passes no parameters: every setting is the table's preference, else the global one. GATHER AUTO means only what is missing or stale."
      : `${fromCall.length ? `From the call: ${fromCall.join(", ")}. ` : ""}${ign.length ? `Passed but ignored (PREFERENCE_OVERRIDES_PARAMETER): ${ign.join(", ")}. ` : ""}${fromPref.length ? `From table or global preferences that differ from Oracle's defaults: ${fromPref.join(", ")}. ` : ""}Everything else is the documented default.`,
    basis: "19c DBMS_STATS reference; explainer chapter 6",
  });
  if (o.error) steps.push({ id: "locks", title: "Check the locks", status: "stops", text: "The statistics are locked and the call has no force => TRUE: ORA-20005, and the gather ends here.", basis: "lab D1" });
  else if (auto && p.tableLocked) steps.push({ id: "locks", title: "Check the locks", status: "stops", text: "The statistics are locked: the job skips the table without an error.", basis: "19c Tuning Guide" });
  else steps.push({ id: "locks", title: "Check the locks", status: "does", text: p.tableLocked ? "The table is locked, but force => TRUE goes through it. The lock stays." : p.lockedPartitions ? `The table is not locked. ${plural(p.lockedPartitions, "partition")} ${p.lockedPartitions === 1 ? "is" : "are"}: ${p.lockedPartitions === 1 ? "it is" : "they are"} never read, whatever changed in ${p.lockedPartitions === 1 ? "it" : "them"}.` : "Nothing is locked." });
  if (o.write.destination === "nothing") steps.push({ id: "history", title: "Save the current statistics", status: "skips", text: o.write.history });
  else if (o.write.destination === "pending") steps.push({ id: "history", title: "Save the current statistics", status: "skips", text: o.write.history, basis: "19c Tuning Guide" });
  else steps.push({ id: "history", title: "Save the current statistics", status: "does", text: o.write.history, basis: "19c Tuning Guide; explainer chapter 12" });
  // read
  const units = r.newParts + r.changedParts + r.otherParts + r.extraPass + r.globalScan;
  let readText: string;
  if (units === 0) readText = o.error ? "Nothing." : o.verdict[1].startsWith("Nothing") || o.verdict[1].startsWith("Not stale") || o.verdict[1].startsWith("Fills") ? (o.columns.basic.startsWith("Kept") ? "No pass for the basic statistics: the load already counted the rows. Only the histogram sample below." : "Nothing: no partition is new or stale, and the global statistics need no scan.") : "Nothing.";
  else if (flat) readText = `${o.scan.text} ${fmt(o.blocks)} blocks.`;
  else {
    const parts: string[] = [];
    if (r.newParts) parts.push(`${plural(r.newParts, "new partition")} (no statistics yet)`);
    if (r.changedParts) parts.push(`${plural(r.changedParts, "changed partition")}`);
    if (r.otherParts) parts.push(`${plural(r.otherParts, "other partition")} again`);
    if (r.extraPass) parts.push(`one more pass over ${plural(r.extraPass, "partition")} for the histograms`);
    if (r.globalScan) parts.push(`then the whole table (${fmt(N)} partitions) for the global statistics`);
    readText = `${parts.join(", ")}: ${fmt(o.blocks)} blocks, counted as whole partitions of ${fmt(B)}. ${o.scan.text}`;
  }
  steps.push({ id: "read", title: "Read the table", status: units === 0 ? "skips" : "does", text: readText, reads: units ? `${fmt(o.blocks)} blocks` : "0 blocks", basis: flat ? "19c Tuning Guide; explainer chapter 5" : "19.27 lab, scaled to your numbers" });
  // columns
  const kinds = o.columns.kinds.length ? ` Histogram kinds possible: ${o.columns.kinds.join("; ")}.` : "";
  const del = o.columns.deleted ? " Every existing histogram is deleted." : "";
  steps.push({ id: "columns", title: "Column statistics and histograms", status: o.write.destination === "nothing" ? "skips" : "does", text: o.write.destination === "nothing" ? "Nothing is computed." : `${o.columns.basic} NDV: ${o.columns.ndv} Histograms: ${o.columns.rule}${kinds}${del}`, basis: "19c Tuning Guide; explainer chapter 5" });
  // global
  if (!flat) {
    const g = o.global;
    const gtext = g === "merged" ? `Merged from the partition synopses (one per partition and column, ${fmt(N * p.columnCount)} in all): NUM_ROWS and NUM_NULLS summed, low and high values taken across partitions, NDV from the merged sketches. Global column NOTES say INCREMENTAL.`
      : g === "fullscan" ? "From a scan of the whole table: exact NDVs, no synopsis used. Global column NOTES are blank."
      : g === "sample" ? "From a sampled scan of the whole table. Global column NOTES are blank."
      : g === "untouched" ? "Not touched: the global row count, NDVs and the partition key's high value stay as they were."
      : g === "pending" ? "Computed from a full scan into the pending area; the published global statistics are unchanged."
      : "Unchanged.";
    const syn = o.synopsesAfter === "all" ? "Every unlocked partition has a synopsis that matches its statistics." : o.synopsesAfter === "none" ? "No synopses exist." : o.synopsesAfter === "stale" ? "The synopses stay in SYSAUX but no longer match the statistics." : o.synopsesAfter === "table" ? "One table-level synopsis only." : "Some partitions lack a current synopsis.";
    steps.push({ id: "global", title: "Global statistics and synopses", status: g === "untouched" || g === "unchanged" ? "skips" : "does", text: `${gtext} Afterwards: ${syn}`, basis: "19.27 lab" });
  }
  steps.push({ id: "indexes", title: "Indexes (CASCADE)", status: o.indexes.fullScans + o.indexes.partitionScans ? "does" : "skips", text: o.indexes.text, reads: o.indexes.fullScans + o.indexes.partitionScans ? `${plural(o.indexes.fullScans, "full index scan")}${o.indexes.partitionScans ? `, ${plural(o.indexes.partitionScans, "index partition")}` : ""}` : undefined, basis: flat ? "19c Tuning Guide; explainer chapter 10" : "lab F2, F3; 19c Tuning Guide" });
  steps.push({ id: "write", title: "Write and invalidate", status: o.write.destination === "nothing" ? "skips" : "does", text: o.write.text, basis: "19c DBMS_STATS reference; explainer chapter 5" });
  const nx = o.next;
  const nextText = nx ? (auto ? `The next job run: ${nx.verdict[1]}. ${nx.blocks ? `${fmt(nx.blocks)} blocks.` : "Nothing is read."}` : `The next plain call (no parameters): ${nx.verdict[1]}. ${nx.blocks ? `${fmt(nx.blocks)} blocks.` : "Nothing is read."}`) : "";
  steps.push({ id: "after", title: "Afterwards", status: "note", text: `${nextText} ${o.auto.text}`.trim(), basis: "19.27 lab; 19c Tuning Guide" });
  return steps;
}

/** Queries to check what a gather really did, with the names from the form. */
export function verifySql(o: Outcome): string {
  const p = o.input;
  const q = (v: string, ph: string) => `'${(v || ph).replace(/'/g, "''")}'`;
  const own = q(p.owner, "OWNER"), tab = q(p.tableName, "TABLE");
  const lines = [
    "SET LONG 1000000 LONGCHUNKSIZE 1000000   -- NOTES below is a CLOB",
    "",
    "-- What the last gather on the table really read: one task per object",
    "SELECT t.target, t.target_type, t.target_size, t.status, t.end_time - t.start_time AS elapsed",
    "FROM   dba_optstat_operation_tasks t",
    "WHERE  t.opid = (SELECT MAX(o.id) FROM dba_optstat_operations o",
    `                 WHERE o.target = '"' || ${own} || '"."' || ${tab} || '"')`,
    "ORDER  BY t.start_time;",
    "",
    "-- The parameters that gather really used (NOTES is XML), and when",
    "SELECT operation, start_time, end_time, status, notes",
    "FROM   dba_optstat_operations",
    `WHERE  target = '"' || ${own} || '"."' || ${tab} || '"'`,
    "ORDER  BY start_time DESC FETCH FIRST 5 ROWS ONLY;",
    "",
    "-- How each column was gathered: SAMPLE_SIZE, the histogram, and the NOTES",
    "SELECT column_name, num_distinct, sample_size, histogram, TRIM(notes) AS notes",
    "FROM   dba_tab_col_statistics",
    `WHERE  owner = ${own} AND table_name = ${tab};`,
  ];
  if (p.partitioned) {
    lines.push(
      "",
      "-- Is the global NDV derived from synopses (NOTES = INCREMENTAL), and which partitions have one?",
      "SELECT TRIM(notes) AS notes, COUNT(*) AS partition_columns",
      "FROM   dba_part_col_statistics",
      `WHERE  owner = ${own} AND table_name = ${tab}`,
      "GROUP  BY TRIM(notes);",
      "",
      "-- Partitions without statistics, locked, or stale",
      "SELECT partition_name, num_rows, last_analyzed, stattype_locked, stale_stats, global_stats",
      "FROM   dba_tab_statistics",
      `WHERE  owner = ${own} AND table_name = ${tab}`,
      "ORDER  BY partition_position NULLS FIRST;",
    );
  }
  if (!isTrue(p.publish)) {
    lines.push("", "-- The pending statistics this gather produced", "SELECT table_name, partition_name, num_rows, last_analyzed", "FROM   dba_tab_pending_stats", `WHERE  owner = ${own} AND table_name = ${tab};`);
  }
  lines.push("", "-- Index statistics: when, from how many entries", "SELECT index_name, object_type, partition_name, last_analyzed, sample_size, global_stats", "FROM   dba_ind_statistics", `WHERE  table_owner = ${own} AND table_name = ${tab}`, "ORDER  BY index_name, object_type, partition_position NULLS FIRST;");
  return lines.join("\n");
}

export { DEFAULTS };
