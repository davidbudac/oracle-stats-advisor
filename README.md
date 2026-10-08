# Gather advisor (Oracle 19c)

What one `DBMS_STATS` gather will do to one table: what it reads, how it computes each
statistic, whether the global statistics are refreshed, what it leaves behind, and what the
next gather reads. Describe the table, the preferences in force, the call (or let the automatic
job run) and what changed since the last gather; the page answers step by step, with a finding
and a fix per problem and the SQL to run, change and verify.

A standalone HTML + TypeScript page. No backend, no external requests, no fonts or scripts from
the internet: the build is one `dist/index.html` that works from `file://` or any static server.

It is the standalone successor of the incremental statistics advisor in the explainer
[Optimizer Statistics, explained](https://stats-explained.davidbudac.cz) (chapter 8), extended
to plain tables, the automatic job, histograms, indexes and cursor invalidation.

## Use it

No build needed: `prebuilt/gather-advisor.html` is the committed build (with `prebuilt/collect.sql`
next to it for the download link). Open it straight from disk.

To build it yourself:

```sh
npm install
npm run build        # dist/index.html (self-contained) + dist/collect.sql
```

Open `dist/index.html` in a browser, or serve the `dist/` directory with anything static
(`python3 -m http.server`, nginx, a file share). The form state lives in the URL hash, so a
filled form can be shared as a link.

To fill the form from a real table, run `sql/collect.sql` in the PDB that owns the table as a
user who can read the `DBA_*` views and call `DBMS_STATS` (SQL*Plus, SQLcl or SQL Developer):

```
SQL> @collect.sql SHOP SALES
```

It is pure SQL: three `SELECT`s over the dictionary (plus one optional, error-tolerant block
that flushes the DML counters). Paste the whole output into "Fill the form from your database":
every field is filled, including the owner, table and partition names used in the generated
statements. Only the lines between `ADVISOR INPUT BEGIN` and `END` are read; an `ORA-` error in
the middle (for example `REPORT_COL_USAGE` without the privilege) is skipped. The output ends with
the dry run, `REPORT_GATHER_TABLE_STATS`, to compare with the advisor's partition count.

With the form filled, **Use the recommended setup** does two things: it switches the form to the
chapter 8 setup (INCREMENTAL, staleness by percent, pinned histograms, the override on), and it
writes two scripts for the table as it was at that moment. *Apply* is the `SET_TABLE_PREFS` calls
for every preference that differs, with the first incremental gather as a commented line;
*Roll back* restores the previous values. The collector reports which preferences the table set
itself (`TABLE_PREFS`) and which columns have a histogram (`HISTOGRAM_COLUMNS`), so the rollback
deletes a preference the table inherited rather than pinning it, and the pinned `METHOD_OPT`
lists the histogram columns. Without that paste the scripts still work, with placeholders.

To get only the settings, without the page: `sql/recommend.sql` prints the DBMS_STATS preferences
in force for one table (current value, whether it is a table or a global preference, recommended
value) and the `SET_TABLE_PREFS` / unlock statements the advisor would propose, with the reason
after each. Same privileges and invocation as `collect.sql`; nothing is changed or gathered:

```
SQL> @recommend.sql SHOP SALES
```

To get only the settings, without the page: `sql/recommend.sql` prints the DBMS_STATS preferences
in force for one table (current value, whether it is a table or a global preference, recommended
value) and the `SET_TABLE_PREFS` / unlock statements the advisor would propose, with the reason
after each. Same privileges and invocation as `collect.sql`; nothing is changed or gathered:

```
SQL> @recommend.sql SHOP SALES
```

## What it models

- **A partitioned table under `GATHER_TABLE_STATS`**: INCREMENTAL and its four conditions
  (PUBLISH, AUTO_SAMPLE_SIZE, GRANULARITY, INCREMENTAL_LEVEL), partname and granularity,
  staleness rules, locked partitions and tables, missing or out-of-step synopses, column usage
  under SIZE AUTO, column groups and new histograms, `PREFERENCE_OVERRIDES_PARAMETER`,
  `GATHER AUTO`. Every rule comes from a 19.27 lab log (`docs/lab-observations.md`) or the 19c
  documentation, cited per finding.
- **A plain table**: full scan or sample (row or block), approximate versus scaled-up NDV,
  which histogram kinds are possible, the METHOD_OPT rules (AUTO, SKEWONLY, REPEAT, a pinned
  list, SIZE 1), `GATHER AUTO` after a direct-path load, a staging table's table-level synopsis.
- **The automatic job**: whether the table is stale by STALE_PERCENT, which partitions it
  gathers, and when it leaves the global statistics behind.
- **For every gather**: where each setting came from (call, preference, default, ignored by
  the override), the index work under CASCADE, where the result is written (dictionary or
  pending) and how cursors learn about it (rolling, at once, never).

Not modelled: subpartitions, partition exchange, degree and concurrency, real-time and
high-frequency statistics. The page lists these under "About".

## Develop

```sh
npm run dev          # Vite dev server
npm test             # vitest: the lab scenarios pinned against the model
npm run typecheck
npm run check        # typecheck + test + build
```

Layout:

```
index.html             the page (markup only; the form is built by src/ui/form.ts)
src/main.ts            bootstrap: theme, form, presets, paste box, URL hash
src/model/             pure TypeScript, no DOM: defaults.ts (fields, defaults, presets),
                       advise.ts (the rules), parse.ts (paste parser), setup.ts (apply and
                       rollback scripts of the recommended setup), hash.ts, clamp.ts
src/ui/                form builder, result renderer, stacked bar, DOM helpers
src/style.css          tokens (light and dark), layout, components
sql/collect.sql        the collector script (copied into dist/ as collect.sql)
sql/recommend.sql      current vs recommended preferences for one table, standalone (not in the build)
sql/recommend.sql      current vs recommended preferences for one table, standalone (not in the build)
test/                  vitest: advise.test.ts, parse.test.ts, setup.test.ts
docs/lab-observations.md   the 19.27 lab log the partitioned rules cite
```

The model is deliberately separate from the page so the rules can be tested under Node. When a
rule changes, change its test and its `basis` together.
