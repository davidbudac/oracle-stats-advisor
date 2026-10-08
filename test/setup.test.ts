import { describe, expect, test } from "vitest";
import { COLUMN_PLACEHOLDER, DEFAULTS, RECOMMENDED, parsePrefs, setupScripts, type Input } from "../src/model";

const base: Input = { ...DEFAULTS, owner: "SHOP", tableName: "SALES" };
const lines = (s: string) => s.split("\n");
const execs = (s: string) => lines(s).filter((l) => /^EXEC/.test(l));

describe("setupScripts", () => {
  test("from Oracle's defaults: sets what differs, gather is a comment, rollback pins when provenance is unknown", () => {
    const { apply, rollback, changed } = setupScripts(base, null);
    expect(changed).toEqual(["INCREMENTAL", "INCREMENTAL_STALENESS", "METHOD_OPT", "PREFERENCE_OVERRIDES_PARAMETER"]);
    expect(execs(apply)).toEqual([
      "EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'INCREMENTAL', 'TRUE')",
      "EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'INCREMENTAL_STALENESS', 'USE_STALE_PERCENT,USE_LOCKED_STATS,ALLOW_MIXED_FORMAT')",
      `EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'METHOD_OPT', 'FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 ${COLUMN_PLACEHOLDER}')`,
      "EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'PREFERENCE_OVERRIDES_PARAMETER', 'TRUE')",
    ]);
    expect(apply).toMatch(/already in force: INCREMENTAL_LEVEL = PARTITION; PUBLISH = TRUE; ESTIMATE_PERCENT = DBMS_STATS.AUTO_SAMPLE_SIZE; GRANULARITY = AUTO/);
    expect(apply).toMatch(/^-- EXEC DBMS_STATS.GATHER_TABLE_STATS\('SHOP', 'SALES'\)$/m); // the first incremental gather, commented out
    expect(execs(rollback)).toEqual([
      "EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'INCREMENTAL', 'FALSE')",
      "EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'INCREMENTAL_STALENESS', 'ALLOW_MIXED_FORMAT')",
      "EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'METHOD_OPT', 'FOR ALL COLUMNS SIZE AUTO')",
      "EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'PREFERENCE_OVERRIDES_PARAMETER', 'FALSE')",
    ]);
    expect(rollback).toMatch(/did not say which preferences/);
  });

  test("diff: the changed preferences with their old and new text, for the comparison table", () => {
    const { diff, changed } = setupScripts(base, null);
    expect(diff.map((d) => d.name)).toEqual(changed);
    expect(diff[0]).toEqual({ name: "INCREMENTAL", before: "FALSE", after: "TRUE" });
    expect(setupScripts({ ...base, ...RECOMMENDED }, null).diff).toEqual([]);
  });

  test("placeholders without names, quotes doubled", () => {
    const { apply } = setupScripts({ ...DEFAULTS, owner: "O'HARA" }, null);
    expect(apply).toMatch(/SET_TABLE_PREFS\('O''HARA', 'TABLE', 'INCREMENTAL', 'TRUE'\)/);
    expect(apply).toMatch(/OWNER and TABLE are placeholders/);
  });

  test("already recommended: nothing to set or undo; next gather noted", () => {
    const { apply, rollback, changed } = setupScripts({ ...base, ...RECOMMENDED }, null);
    expect(changed).toEqual([]);
    expect(execs(apply)).toEqual([]);
    expect(apply).toMatch(/nothing to set/);
    expect(apply).toMatch(/already has a synopsis/);
    expect(rollback).toMatch(/nothing to undo/);
  });

  test("with the collector's paste: exact old texts, DELETE for inherited prefs, histogram columns pinned", () => {
    const r = parsePrefs(`-- ADVISOR INPUT BEGIN
OWNER = STATS_LAB
TABLE_NAME = E1
PARTITIONED = YES
INCREMENTAL = FALSE
INCREMENTAL_LEVEL = PARTITION
INCREMENTAL_STALENESS = NULL
PUBLISH = TRUE
ESTIMATE_PERCENT = DBMS_STATS.AUTO_SAMPLE_SIZE
GRANULARITY = global and partition
METHOD_OPT = for all columns size auto
PREFERENCE_OVERRIDES_PARAMETER = FALSE
TABLE_PREFS = GRANULARITY,METHOD_OPT
HISTOGRAM_COLUMNS = STATUS,REGION
SYNOPSES = none
-- ADVISOR INPUT END`);
    expect(r.ignored).toEqual([]);
    expect(r.provenance.tablePrefs).toEqual(["GRANULARITY", "METHOD_OPT"]);
    expect(r.provenance.histogramColumns).toEqual(["STATUS", "REGION"]);
    expect(r.provenance.raw.GRANULARITY).toBe("global and partition");
    const before: Input = { ...DEFAULTS, ...r.values };
    const { apply, rollback, changed } = setupScripts(before, r.provenance);
    expect(changed).toEqual(["INCREMENTAL", "INCREMENTAL_STALENESS", "GRANULARITY", "METHOD_OPT", "PREFERENCE_OVERRIDES_PARAMETER"]);
    expect(execs(apply)).toContain("EXEC DBMS_STATS.SET_TABLE_PREFS('STATS_LAB', 'E1', 'METHOD_OPT', 'FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 STATUS, REGION')");
    expect(execs(apply)).toContain("EXEC DBMS_STATS.SET_TABLE_PREFS('STATS_LAB', 'E1', 'GRANULARITY', 'AUTO')");
    expect(apply).toMatch(/pins the 2 columns that have a histogram today: STATUS, REGION/);
    expect(apply).toMatch(/Then build the synopses/);
    expect(execs(rollback)).toEqual([
      "EXEC DBMS_STATS.DELETE_TABLE_PREFS('STATS_LAB', 'E1', 'INCREMENTAL')   -- inherited: FALSE",
      "EXEC DBMS_STATS.DELETE_TABLE_PREFS('STATS_LAB', 'E1', 'INCREMENTAL_STALENESS')   -- inherited: NULL",
      "EXEC DBMS_STATS.SET_TABLE_PREFS('STATS_LAB', 'E1', 'GRANULARITY', 'global and partition')",
      "EXEC DBMS_STATS.SET_TABLE_PREFS('STATS_LAB', 'E1', 'METHOD_OPT', 'for all columns size auto')",
      "EXEC DBMS_STATS.DELETE_TABLE_PREFS('STATS_LAB', 'E1', 'PREFERENCE_OVERRIDES_PARAMETER')   -- inherited: FALSE",
    ]);
  });

  test("an empty TABLE_PREFS line means: known, none; SET_TABLE_PREFS calls mark table level; SQL NULL resets staleness to its default", () => {
    const none = parsePrefs("TABLE_PREFS =\nINCREMENTAL = FALSE").provenance;
    expect(none.tablePrefs).toEqual([]);
    const calls = parsePrefs("EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'INCREMENTAL_STALENESS', NULL)\nEXEC DBMS_STATS.SET_GLOBAL_PREFS('INCREMENTAL', 'FALSE')");
    expect(calls.provenance.tablePrefs).toEqual(["INCREMENTAL_STALENESS"]);
    const { rollback } = setupScripts({ ...base, ...calls.values }, calls.provenance);
    expect(execs(rollback)).toContain("EXEC DBMS_STATS.SET_TABLE_PREFS('SHOP', 'SALES', 'INCREMENTAL_STALENESS', 'ALLOW_MIXED_FORMAT')");
    expect(execs(rollback)).toContain("EXEC DBMS_STATS.DELETE_TABLE_PREFS('SHOP', 'SALES', 'INCREMENTAL')   -- inherited: FALSE");
  });

  test("a pinned METHOD_OPT is kept as pasted; a plain table gets no synopsis talk", () => {
    const r = parsePrefs("PARTITIONED = NO\nMETHOD_OPT = FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 STATUS\nTABLE_PREFS = METHOD_OPT");
    const { apply, changed } = setupScripts({ ...base, ...r.values }, r.provenance);
    expect(changed).not.toContain("METHOD_OPT");
    expect(apply).toMatch(/METHOD_OPT = FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 STATUS/);
    expect(apply).toMatch(/Not a partitioned table/);
    expect(apply).not.toMatch(/build the synopses/);
  });
});
