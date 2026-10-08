// setupScripts: the SET_TABLE_PREFS calls that take a table from the form's preferences to the
// recommended setup, and the calls that put the original preferences back.
//
// The apply script sets only what differs. The rollback restores each changed preference to what
// it was: DELETE_TABLE_PREFS when the paste said the table had no value of its own (the value in
// force came from the schema, global or default level), SET_TABLE_PREFS to the old value otherwise.
// Without that knowledge every changed preference is pinned to its old value in force.

import { METHOD_OPT_TEXT, RECOMMENDED, type Input } from "./defaults";

/** What the paste said beyond the form: which preferences the table sets itself, the columns with a histogram, the exact preference texts. */
export interface Provenance {
  /** Preference names set at table level (DBA_TAB_STAT_PREFS); null when the paste did not say. */
  tablePrefs: string[] | null;
  /** Columns that have a histogram today, in the order the paste listed them. */
  histogramColumns: string[];
  /** The preference text as pasted, by canonical name, for an exact rollback. */
  raw: Record<string, string>;
}

export const emptyProvenance = (): Provenance => ({ tablePrefs: null, histogramColumns: [], raw: {} });

/** The preference each form field feeds; editing the field makes the pasted text of that preference stale. */
export const PREF_OF_FIELD: Partial<Record<keyof Input, string>> = {
  incremental: "INCREMENTAL", incrementalLevel: "INCREMENTAL_LEVEL",
  useStalePercent: "INCREMENTAL_STALENESS", useLockedStats: "INCREMENTAL_STALENESS", allowMixedFormat: "INCREMENTAL_STALENESS",
  publish: "PUBLISH", estimatePercent: "ESTIMATE_PERCENT", granularity: "GRANULARITY", methodOpt: "METHOD_OPT",
  overrides: "PREFERENCE_OVERRIDES_PARAMETER", cascade: "CASCADE", noInvalidate: "NO_INVALIDATE", options: "OPTIONS", degree: "DEGREE", stalePercent: "STALE_PERCENT",
};

export const COLUMN_PLACEHOLDER = "<column list>";

export interface SetupScripts { apply: string; rollback: string; changed: string[]; diff: { name: string; before: string | null; after: string }[] }

const stalenessOf = (p: Input) => [p.useStalePercent && "USE_STALE_PERCENT", p.useLockedStats && "USE_LOCKED_STATS", p.allowMixedFormat && "ALLOW_MIXED_FORMAT"].filter(Boolean) as string[];
const sameStaleness = (a: Input, b: Input) => a.useStalePercent === b.useStalePercent && a.useLockedStats === b.useLockedStats && a.allowMixedFormat === b.allowMixedFormat;

/** One preference of the recommended setup: its name, the old and new text, and whether the form says it changes. */
interface Pref { name: string; before: string | null; after: string; changed: boolean }

export function setupScripts(before: Input, prov: Provenance | null): SetupScripts {
  const P = prov ?? emptyProvenance();
  const after: Input = { ...before, ...RECOMMENDED };
  const lit = (v: string, placeholder: string) => `'${(v || placeholder).replace(/'/g, "''")}'`;
  const OT = `${lit(before.owner, "OWNER")}, ${lit(before.tableName, "TABLE")}`;
  const label = `${before.owner || "OWNER"}.${before.tableName || "TABLE"}`;
  // the value as SET_TABLE_PREFS takes it: quoted, or an unquoted NULL for "no staleness flag"
  const arg = (v: string | null) => (v === null || v === "" || v.toUpperCase() === "NULL" ? "NULL" : lit(v, ""));
  const set = (name: string, v: string | null) => `EXEC DBMS_STATS.SET_TABLE_PREFS(${OT}, '${name}', ${arg(v)})`;
  const del = (name: string) => `EXEC DBMS_STATS.DELETE_TABLE_PREFS(${OT}, '${name}')`;
  const raw = (name: string) => (Object.hasOwn(P.raw, name) ? P.raw[name]!.trim() : null);

  const cols = P.histogramColumns.filter(Boolean);
  const pinned = `FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 ${cols.length ? cols.join(", ") : COLUMN_PLACEHOLDER}`;
  const estText = (p: Input) => (p.estimatePercent === "auto" ? "DBMS_STATS.AUTO_SAMPLE_SIZE" : String(p.estimatePercent));
  const methodText = (p: Input) => raw("METHOD_OPT") ?? METHOD_OPT_TEXT[p.methodOpt];

  const prefs: Pref[] = [
    { name: "INCREMENTAL", before: raw("INCREMENTAL") ?? before.incremental, after: after.incremental, changed: before.incremental !== after.incremental },
    { name: "INCREMENTAL_LEVEL", before: raw("INCREMENTAL_LEVEL") ?? before.incrementalLevel, after: after.incrementalLevel, changed: before.incrementalLevel !== after.incrementalLevel },
    { name: "INCREMENTAL_STALENESS", before: raw("INCREMENTAL_STALENESS") ?? (stalenessOf(before).join(",") || null), after: stalenessOf(after).join(","), changed: !sameStaleness(before, after) },
    { name: "PUBLISH", before: raw("PUBLISH") ?? before.publish, after: after.publish, changed: before.publish !== after.publish },
    { name: "ESTIMATE_PERCENT", before: raw("ESTIMATE_PERCENT") ?? estText(before), after: estText(after), changed: before.estimatePercent !== after.estimatePercent },
    { name: "GRANULARITY", before: raw("GRANULARITY") ?? before.granularity, after: after.granularity, changed: before.granularity !== after.granularity },
    { name: "METHOD_OPT", before: methodText(before), after: pinned, changed: before.methodOpt !== "pinned" },
    { name: "PREFERENCE_OVERRIDES_PARAMETER", before: raw("PREFERENCE_OVERRIDES_PARAMETER") ?? before.overrides, after: after.overrides, changed: before.overrides !== after.overrides },
  ];
  const changed = prefs.filter((p) => p.changed);
  const kept = prefs.filter((p) => !p.changed);
  const gather = `EXEC DBMS_STATS.GATHER_TABLE_STATS(${OT})`;

  // ---- apply
  const apply: string[] = [
    `-- Recommended setup for ${label} (explainer chapter 8, example 1).`,
    "-- Preferences only: nothing is gathered and no plan changes until the next gather.",
  ];
  if (!before.owner || !before.tableName) apply.push("-- OWNER and TABLE are placeholders: fill in Owner and Table in the form.");
  if (changed.length) apply.push(...changed.map((p) => set(p.name, p.after)));
  else apply.push("-- nothing to set: every preference of the recommended setup is already in force");
  if (changed.some((p) => p.name === "METHOD_OPT")) {
    apply.push(cols.length
      ? `-- METHOD_OPT pins the ${cols.length === 1 ? "column that has a histogram" : `${cols.length} columns that have a histogram`} today: ${cols.join(", ")}. Edit the list before you run it.`
      : `-- METHOD_OPT: replace ${COLUMN_PLACEHOLDER} with the columns whose histograms you want kept (the paste did not list them).`);
  }
  if (kept.length) apply.push(`-- already in force: ${kept.map((p) => `${p.name} = ${p.before ?? "NULL"}`).join("; ")}`);
  apply.push("");
  if (before.partitioned) {
    apply.push(
      before.synopses === "all"
        ? "-- Every partition already has a synopsis: the next gather reads only new and changed partitions."
        : "-- Then build the synopses. The first incremental gather reads every partition once; after it,",
      ...(before.synopses === "all" ? [] : ["-- a gather reads only new and changed partitions. Uncomment when the window allows it:"]),
      `${before.synopses === "all" ? "-- next gather: " : "-- "}${gather}`,
    );
  } else {
    apply.push("-- Not a partitioned table: INCREMENTAL and the synopses do not apply; the next gather reads the table once.", `-- ${gather}`);
  }

  // ---- rollback
  const known = P.tablePrefs !== null;
  const tableLevel = new Set((P.tablePrefs ?? []).map((n) => n.toUpperCase()));
  const rollback: string[] = [`-- Rollback: the preferences of ${label} as they were before the recommended setup.`];
  if (!changed.length) rollback.push("-- nothing to undo: the apply script sets nothing");
  else if (known) rollback.push("-- A preference the table did not set itself is deleted, so it inherits again; the others get their old value back.");
  else rollback.push("-- The paste did not say which preferences the table set itself (the current collect.sql does), so each one is pinned to its old value in force.");
  for (const p of changed) {
    if (known && !tableLevel.has(p.name)) rollback.push(`${del(p.name)}   -- inherited: ${p.before ?? "NULL"}`);
    else rollback.push(set(p.name, p.before));
  }
  if (changed.length && before.partitioned) {
    rollback.push("", "-- Synopses built by a gather stay: they are harmless, and the next gather that touches a partition replaces its synopsis.");
  }
  return { apply: apply.join("\n"), rollback: rollback.join("\n"), changed: changed.map((p) => p.name), diff: changed.map(({ name, before, after }) => ({ name, before, after })) };
}
