# Gather advisor (Oracle 19c)

What one `DBMS_STATS` gather will do to one table: what it reads, how it computes each
statistic, whether the global statistics are refreshed, what it leaves behind, and what the
next gather reads. Describe the table, the preferences in force, the call (or let the automatic
job run) and what changed since the last gather; the page answers step by step, with a finding
and a fix per problem and the SQL to run, change and verify. Paste the collector's output and it
also checks the real table (histograms, extended statistics, indexes, statistics quality, staleness,
gather history, pending and restorable statistics); `sql/survey.sql` ranks a schema's tables to
decide which ones to look at first.

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

It is pure SQL, no DDL or DML, nothing is gathered. It prints two blocks. `ADVISOR INPUT` is five
`SELECT`s over the dictionary (the third reads one SYS table to tell whether the synopses are in
step, and is skipped without the privilege; the fourth reads the SQL plan directives on the table,
the fifth the column-group usage report), plus one optional, error-tolerant block that flushes the
DML counters. `ADVISOR DETAIL` (statements 7 to 28) is the data of the health check: per-column
statistics with histograms, recorded usage and low/high values; per-index statistics with
`DBA_INDEX_USAGE`; extensions; the last 12 gathers that touched the table (`DBA_OPTSTAT_OPERATIONS`
and `_TASKS`); the maintenance windows and the last runs of the nightly and high-frequency tasks;
per-partition rows (up to 400 partitions); expression candidates from `V$SQL_PLAN`; pending,
retention and SYSAUX facts. Paste the whole output into "Fill the form from your database": every
field is filled, including the owner, table and partition names used in the generated statements,
and the health check appears below the findings. Only the lines between `ADVISOR INPUT BEGIN` and
`END`, and between `ADVISOR DETAIL BEGIN` and `END`, are read; an `ORA-` error in the middle is
skipped. The detail block is not part of the URL hash: reload the page and paste again. The output
ends with the dry run, `REPORT_GATHER_TABLE_STATS`, to compare with the advisor's partition count.

Privileges. Beyond reading the `DBA_*` views and calling `DBMS_STATS`, the detail block reads
`V$INSTANCE`, `V$PARAMETER`, `V$SYSAUX_OCCUPANTS`, `V$SQL_PLAN` (expression candidates),
`DBA_INDEX_USAGE`, `DBA_OPTSTAT_OPERATIONS` / `_OPERATION_TASKS`, `DBA_AUTOTASK_CLIENT` /
`_WINDOW_CLIENTS` / `_JOB_HISTORY`, `DBA_SCHEDULER_WINDOWS` and `DBA_AUTO_STAT_EXECUTIONS`, and calls
`DBMS_STATS.GET_STATS_HISTORY_RETENTION` / `_AVAILABILITY`. `REPORT_COL_USAGE` (column usage, group
usage) needs SYSDBA or `ANALYZE ANY DICTIONARY` plus `ANALYZE ANY`; the synopsis check reads
`SYS.WRI$_OPTSTAT_SYNOPSIS_HEAD$` (SYSDBA). Every statement stands alone: one that fails prints its
error and its records count as not collected. Without `REPORT_COL_USAGE` the column records carry no
usage flags (`COLUMN_USAGE_COLLECTED = N`); a view that cannot be read removes all records of its
statement (no `DBA_INDEX_USAGE` access loses the index records). The page lists the sections it
skipped and why. The scripts were run as SYSDBA; the missing-privilege paths were not tested as an
ordinary user.

With the form filled, **Use the recommended setup** leaves your setup as it is and opens a second
view, the chapter 8 setup (INCREMENTAL, staleness by percent, pinned histograms, the override on)
applied to your table. A switch at the top of the page flips the form and the result between
*Your setup* and *Recommended*; the fields that differ are marked in both, and a table compares
the verdict, the blocks read and each changed preference side by side. The recommended view is
read-only and follows your setup as you edit it. It also writes two scripts from your setup. *Apply* is the `SET_TABLE_PREFS` calls
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

### Survey a schema

To pick the tables worth a closer look, `sql/survey.sql` ranks the tables of one schema by the blocks
the next plain `GATHER_TABLE_STATS` would read (the advisor's rules, simplified; allocated segment
blocks, so a ranking, not a measurement). One line per table: preferences, state (no statistics,
stale, load, locked, pending, synopses), the last gather and the `@collect.sql` call to run next.
Same privileges as the collector; nothing is changed or gathered:

```
SQL> @survey.sql SHOP
```

## What it models

- **A partitioned table under `GATHER_TABLE_STATS`**: INCREMENTAL and its four conditions
  (PUBLISH, AUTO_SAMPLE_SIZE, GRANULARITY, INCREMENTAL_LEVEL), partname and granularity,
  staleness rules, locked partitions and tables, missing, out-of-step or old-format synopses
  (APPROXIMATE_NDV_ALGORITHM, ALLOW_MIXED_FORMAT), column usage
  under SIZE AUTO, column groups and new histograms, `PREFERENCE_OVERRIDES_PARAMETER`,
  `GATHER AUTO`. Every rule comes from a 19.27 lab log (`docs/lab-observations.md`) or the 19c
  documentation, cited per finding.
- **A plain table**: full scan or sample (row or block), approximate versus scaled-up NDV,
  which histogram kinds are possible, the METHOD_OPT rules (AUTO, SKEWONLY, REPEAT, a pinned
  list, SIZE 1), `GATHER AUTO` after a direct-path load, a staging table's table-level synopsis.
- **The automatic job**: whether the table is stale by STALE_PERCENT, which partitions it
  gathers, and when it leaves the global statistics behind.
- **Column groups (extended statistics)**: the groups the table has, the column sets the workload
  filters together that have no group yet (a SQL plan directive with equality predicates in
  `DBA_SQL_PLAN_DIRECTIVES`, or a group `SEED_COL_USAGE` recorded in `REPORT_COL_USAGE`), the
  product of the members' NDVs the optimizer assumes without the group, the `CREATE_EXTENDED_STATS`
  calls, what creating a group costs on an incremental table (one reread, a permanent full scan with
  locked partitions), a directive whose predicates are not all equalities (a group would not be
  used), `AUTO_STAT_EXTENSIONS`, and the extension limit.
- **Composite tables**: range-hash (and list/range) subpartitions. Under GRANULARITY AUTO the
  lab gathered partition statistics and partition synopses only (0 of 24 subpartitions), so DML in
  one subpartition rereads the whole parent partition (lab J); GRANULARITY SUBPARTITION and ALL also
  gather the subpartition level, shown as extra tasks rather than extra blocks.
- **A partition exchange since the last gather**: the gather reads nothing only when three things
  hold together, the empty target partition was gathered first, the staging table carried a
  table-level synopsis (INCREMENTAL TRUE, INCREMENTAL_LEVEL TABLE) and both sides have the same
  histograms (lab H2, H5, H6, H7, V3, Tg). Model the staging table as a plain table.
- **Pending statistics**: PUBLISH FALSE, the test / compare / publish / delete recipe
  (`OPTIMIZER_USE_PENDING_STATISTICS`, `DIFF_TABLE_STATS_IN_PENDING`, `PUBLISH_PENDING_STATS`), and
  pending rows left behind after PUBLISH is TRUE again.
- **Statistics from a bulk load**: `STATS_ON_LOAD`, and what `GATHER AUTO` still does after it.
- **Real-time and high-frequency statistics**: `optimizer_real_time_statistics`, and the
  high-frequency task as the one that runs (`AUTO_TASK_STATUS`, `AUTO_TASK_INTERVAL`,
  `AUTO_TASK_MAX_RUN_TIME`). In 19c both are licensed only for Exadata and Exadata Cloud
  (Licensing Information, Table 1-8), although the parameter and preferences exist on every
  edition; the page says so. Not run on the lab, see the limits below.
- **For every gather**: where each setting came from (call, preference, default, ignored by
  the override), the index work under CASCADE, where the result is written (dictionary or
  pending) and how cursors learn about it (rolling, at once, never).

### Health check of the real table

Shown under the findings when the paste carried the `ADVISOR DETAIL` block. It checks the
dictionary rows as the collector saw them against your setup in the form (METHOD_OPT, CASCADE,
INCREMENTAL, ...), so it follows your edits. Sections, by purpose:

- **Histograms**: the histograms the table has against recorded predicate use and the METHOD_OPT
  in force: histograms nobody filters on, filtered columns without one, support-only histograms
  (`HIST_FOR_INCREM_STATS`), a SIZE 1 or pinned list that will delete histograms, legacy
  HEIGHT BALANCED, sampled and under-bucketed ones.
- **Extended statistics**: column groups (their NDV against the product of the members', unused
  or without statistics), expression statistics no predicate uses, extensions a function-based
  index makes redundant, expression candidates from cached plans, directive-driven candidates,
  the extension limit, and the `SEED_COL_USAGE` recipe.
- **Indexes**: unusable, invisible, locked or unanalysed indexes, clustering factor and
  `TABLE_CACHED_BLOCKS`, indexes `DBA_INDEX_USAGE` never saw, indexes that are a leading prefix of
  another, and the index scans CASCADE adds to every gather.
- **Statistics quality**: impossible values (more nulls or distinct values than rows), a unique
  column whose NDV disagrees with the rows, densities that were set by hand, partitions with zero
  rows and DML, high values older than the last gather with DML since, columns never gathered or
  gathered earlier than the table, small samples under AUTO_SAMPLE_SIZE.
- **Staleness forecast**: rows changed against `STALE_PERCENT`, truncation, the DML rate and the
  days until the table is stale, the next maintenance window, the last automatic runs, the
  disabled task or `AUTOSTATS_TARGET`, the high-frequency task's runs, per-partition staleness.
- **Gather history**: failed or timed-out gathers, a gather much slower than usual, an
  INCREMENTAL table whose gathers read most partitions anyway, the automatic job leaving the
  global statistics behind.
- **Pending statistics**: rows waiting and since when, `OPTIMIZER_USE_PENDING_STATISTICS`, the
  publish or delete workflow, what publishing does to an incremental table.
- **Restore and compare**: retention (zero, unbounded, short against the gather interval),
  `SM/OPTSTAT` size, restore operations in the history, `DIFF_TABLE_STATS_IN_HISTORY` and
  `RESTORE_TABLE_STATS`.
- **Bulk-load statistics**, **real-time statistics** (with the high-frequency task and
  `OPTIMIZER_ADAPTIVE_STATISTICS`) and **subpartitions** (statistics per level, against GRANULARITY).

Each finding carries its basis (19c page or lab id; `docs/oracle19c-facts.md` has the quoted
sentences). The checks are heuristics over the dictionary, not a proof that a plan is wrong.

### Limits

- The estimates are an explanatory model supported by 19.27 lab observations, not an I/O
  predictor for every release update. The collector's table DML percentage is used when
  available; partition change percentages and block counts remain aggregates.
- Not run on the lab, so inferred or taken from the documentation: GRANULARITY AUTO on LIST and
  RANGE subpartitions (the lab has HASH only), everything about the high-frequency task, the
  interplay of real-time statistics with gathers, job-driven partition exchange, the real nightly
  task (schema `GATHER AUTO` stood in for it).
- Health check: `DBA_INDEX_USAGE` is sampled (`_iut_stat_collection_type` = SAMPLED, flushed about
  every 15 minutes), so "unused" is a hint. Expression candidates come from cached plans only
  (`V$SQL_PLAN`), so they see only statements still in the shared pool (one positive case on the
  lab, Q11). DML counters are flushed periodically
  (the collector flushes them when it may). The rules were checked on the lab database, nowhere
  else. The missing-privilege path of `REPORT_COL_USAGE` in the collector was not tested as a
  non-SYSDBA user.
- Degree and concurrency are shown, not modelled. Index-organized, external and temporary
  tables, domain and partitioned global indexes are outside the model. Owner and table names
  must be plain unquoted identifiers.

The [Oracle 19c review](docs/oracle19c-review.md) records the documentation checks, fixes,
and the full list of remaining limits. The recommended setup targets the explainer's append-only
workload: histogram pinning, ignoring locked-partition changes and publishing statistics need to
fit your workload.

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
                       advise.ts (the rules), parse.ts (paste parser), detail.ts (parser of the
                       ADVISOR DETAIL block into typed rows), setup.ts (apply and rollback scripts
                       of the recommended setup), hash.ts, clamp.ts
src/model/health/      the health check: index.ts (section list, report type), columns.ts
                       (histograms, extended statistics, indexes, quality), table.ts (staleness,
                       history, pending, restore, load, real-time, subpartitions)
src/ui/                form builder, result renderer (advice and health check), stacked bar, DOM helpers
src/style.css          tokens (light and dark), layout, components
sql/collect.sql        the collector script (copied into dist/ as collect.sql)
sql/recommend.sql      current vs recommended preferences for one table, standalone (not in the build)
sql/survey.sql         the tables of one schema ranked by the blocks a plain gather reads, standalone (not in the build)
test/                  vitest: advise, parse, detail, setup, oracle19c (documented semantics, collector integration), ui-health
test/fixtures/         real collect.sql and survey.sql output from the 19.27 lab, the parser's input
docs/lab-observations.md   the 19.27 lab log the partitioned rules cite, plus dictionary observations
docs/oracle19c-facts.md    quoted 19c documentation sentences and URLs per topic (the bases of the new rules)
docs/oracle19c-review.md   documentation reviews, fixes and the list of remaining limits
docs/design-health.md      contract of the DETAIL block and the health check
```

The model is deliberately separate from the page so the rules can be tested under Node. When a
rule changes, change its test and its `basis` together.
