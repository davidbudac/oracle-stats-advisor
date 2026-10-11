# Design: the health check and the new scenarios (2026-10-11)

This note is the contract between the work packages that extend the advisor. Read it before
touching `sql/collect.sql`, `src/model/parse.ts`, `src/model/detail.ts`, `src/model/health/*`
or the result pane. Oracle facts stated here still have to be verified against the 19c
documentation or on the lab database (19.27) before they become a `basis`.

## Two kinds of extension

1. **Scenarios the form models** (no paste needed): composite (subpartitioned) tables, a
   partition exchange since the last gather, real-time statistics, the high-frequency task,
   pending statistics, statistics from a direct-path load. They are new `Input` fields,
   rules in `advise.ts`, presets, tests. Owner: WP5.
2. **A health check of the real table** from dictionary data the collector prints in a second
   block, `ADVISOR DETAIL BEGIN … END`. Pure TypeScript rules over typed rows. Shown only when
   the paste carried the block; never part of the URL hash. Owners: WP1 (collector, parser,
   types), WP2 (column/index rules), WP3 (table-level rules), WP4 (rendering).

## The DETAIL block (collect.sql → parse.ts → `Detail`)

Printed by `collect.sql` right after `-- ADVISOR INPUT END`, before the human-readable tail:

```
-- ADVISOR DETAIL BEGIN
KEY = value
ROWKIND = f1|f2|f3|...
-- ADVISOR DETAIL END
```

Rules of the format:

- One record per line. Scalar keys are `NAME = value`. Repeating records are `KIND = fields`
  with `|` between fields, in the fixed order below. A missing field is empty (`a||c`);
  never omit a separator. Field text must not contain `|` or a newline; the collector
  replaces `|` with `/` and newlines with a space (`TRANSLATE`/`REPLACE`).
- Numbers are plain (`1234.5`, `.` decimal; the parser also accepts `,`). Dates/timestamps are
  `YYYY-MM-DD HH24:MI:SS`. Booleans are `Y`/`N`. Empty means unknown, not zero.
- Each dictionary statement is error-tolerant in the same way as the existing collector: a
  statement that fails (privilege, missing view) prints nothing, and the parser treats missing
  records as "not collected". The parser must never throw on a malformed line; it records the
  line in `ignored` with a reason and continues.
- Statement numbering continues from the existing collector (7, 8, …). Every statement is
  pure SQL; no DDL, no DML, nothing gathered. The only PL/SQL is the existing optional flush.
- `ORA-` lines inside the block are skipped like in the INPUT block.

### Scalars

| Key | Source | Meaning |
|---|---|---|
| `DETAIL_VERSION` | constant `1` | format version |
| `COLLECTED_AT` | `SYSTIMESTAMP` | timestamp of the run |
| `DB_VERSION` | `V$INSTANCE.VERSION_FULL` | e.g. `19.27.0.0.0` |
| `LAST_ANALYZED` | `DBA_TAB_STATISTICS` table row | timestamp |
| `MODS_TIMESTAMP` | `DBA_TAB_MODIFICATIONS` table row `TIMESTAMP` | when the counters were last flushed/updated |
| `ROWS_CHANGED` | inserts+updates+deletes of the table row | since the last gather |
| `ROWS_TRUNCATED` | `TRUNCATED` of the table row | `Y`/`N` |
| `STALE_STATS` | `DBA_TAB_STATISTICS.STALE_STATS` table row | `YES`/`NO`/empty |
| `SUBPARTITIONING` | `DBA_PART_TABLES.SUBPARTITIONING_TYPE` | `NONE`, `HASH`, `LIST`, `RANGE` or empty for a plain table |
| `SUBPARTITIONS` | count of `DBA_TAB_SUBPARTITIONS` | |
| `SUBPARTITIONS_WITH_STATS` | subpartition rows with `LAST_ANALYZED` | |
| `ZERO_ROW_PARTITIONS_WITH_DML` | partitions whose statistics say `NUM_ROWS = 0` but `DBA_TAB_MODIFICATIONS` has inserts | |
| `PENDING_ROWS` | rows of `DBA_TAB_PENDING_STATS` for the table | |
| `PENDING_SINCE` | min `LAST_ANALYZED` of those rows | |
| `OPTIMIZER_USE_PENDING_STATISTICS` | `V$PARAMETER` | `TRUE`/`FALSE` |
| `RETENTION_DAYS` | `DBMS_STATS.GET_STATS_HISTORY_RETENTION` | |
| `HISTORY_AVAILABLE_SINCE` | `DBMS_STATS.GET_STATS_HISTORY_AVAILABILITY` | |
| `HISTORY_ROWS` | `DBA_TAB_STATS_HISTORY` rows for the table | |
| `HISTORY_OLDEST` / `HISTORY_NEWEST` | min/max `STATS_UPDATE_TIME` | |
| `SYSAUX_OPTSTAT_MB` | `V$SYSAUX_OCCUPANTS` `SM/OPTSTAT` | |
| `REALTIME_STATS_PARAM` | `V$PARAMETER optimizer_real_time_statistics` | `TRUE`/`FALSE`; the parameter exists in 19.27 |
| `REALTIME_STATS_NOTES` | `Y` when any `DBA_TAB_STATISTICS`/`DBA_TAB_COL_STATISTICS` `NOTES` for the table contains `STATS_ON_CONVENTIONAL_DML` | |
| `STATS_ON_LOAD` | `Y` when the table column `NOTES` say `STATS_ON_LOAD` | |
| `AUTO_TASK_STATUS` / `AUTO_TASK_INTERVAL` / `AUTO_TASK_MAX_RUN_TIME` | `DBMS_STATS.GET_PREFS` (global) | the high-frequency task |
| `AUTOSTATS_TARGET` | global preference | `AUTO`/`ALL`/`ORACLE` |
| `AUTOTASK_STATUS` | `DBA_AUTOTASK_CLIENT` `auto optimizer stats collection` | `ENABLED`/`DISABLED` |
| `TABLE_CACHED_BLOCKS` | preference in force for the table | |
| `OPTIMIZER_ADAPTIVE_STATISTICS` | `V$PARAMETER` | `TRUE`/`FALSE` |
| `UNIQUE_COLUMNS` | columns covered alone by a unique index, unique constraint or PK | comma list |
| `FBI_EXPRESSIONS` | `DBA_IND_EXPRESSIONS` of the table's indexes | `;`-separated expressions (already have a virtual column, so no extension is needed) |
| `EXPRESSION_CANDIDATES` | see statement "expression candidates" | `;`-separated expression texts |

### Records

`COLUMN = name|data_type|nullable|num_distinct|num_nulls|num_buckets|histogram|sample_size|density|avg_col_len|last_analyzed|notes|low|high|usage|in_index`

- One row per visible column and per extension (extension rows have the `SYS_STU…` name;
  `data_type` is empty for them). From `DBA_TAB_COL_STATISTICS` joined to `DBA_TAB_COLS`.
- `histogram`: `NONE`, `FREQUENCY`, `TOP-FREQUENCY`, `HEIGHT BALANCED`, `HYBRID` (as the view prints it).
- `low`/`high`: decoded for `NUMBER` (`UTL_RAW.CAST_TO_NUMBER`), `DATE` (decoded from the
  7 raw bytes), `VARCHAR2`/`CHAR` (`UTL_RAW.CAST_TO_VARCHAR2`, first 30 chars); empty otherwise.
- `usage`: the usage flags `REPORT_COL_USAGE` printed for the column, as a `/`-separated list
  of `EQ`, `EQUIJOIN`, `NONEQUIJOIN`, `RANGE`, `LIKE`, `NULL`, or empty (statement is skipped
  without the privilege; then every row has empty `usage` and `COLUMN_USAGE_COLLECTED = N`).
- `in_index`: `Y` when the column is the leading column of some index.

`INDEX = name|uniqueness|index_type|partitioned|locality|columns|blevel|leaf_blocks|distinct_keys|clustering_factor|num_rows|last_analyzed|stale_stats|locked|status|visibility|total_access_count|total_exec_count|last_used`

- From `DBA_INDEXES`, `DBA_IND_STATISTICS` (index level), `DBA_IND_COLUMNS`, `DBA_PART_INDEXES`,
  `DBA_INDEX_USAGE` (left join; empty when no row). `locality` is `LOCAL`/`GLOBAL`/empty.
  `columns` is a `,`-separated list in position order (expression columns by their `SYS_NC` name).

`EXTENSION = name|extension_text|kind|has_stats|num_distinct|histogram|used`

- `kind`: `group` when the text starts with `(` and lists columns only, `expression` otherwise.
- `has_stats`: `Y` when `DBA_TAB_COL_STATISTICS` has a row with `LAST_ANALYZED` for it.
- `used`: `Y` when `REPORT_COL_USAGE` listed the extension (groups appear as `(A, B)` lines;
  expressions appear by their `SYS_STU` name), empty when usage was not collected.

`HISTORY = opid|operation|start_time|end_time|status|job_name|target_type|partitions_gathered|global_gathered|indexes_gathered|target_size|histogram_columns`

- Last 12 operations that touched the table, newest first: `DBA_OPTSTAT_OPERATIONS` joined to
  `DBA_OPTSTAT_OPERATION_TASKS` on `OPID` where some task `TARGET` is the table
  (`"OWNER"."TABLE"` with quotes, or `"OWNER"."TABLE"."PART"`) or one of its indexes.
  `partitions_gathered` counts `TABLE PARTITION` tasks with `STATUS = COMPLETED`;
  `global_gathered` is `Y` when a `TABLE` task completed; `indexes_gathered` counts `INDEX` and
  `INDEX PARTITION` tasks. `histogram_columns` is the `<histograms>` list of the table task
  `NOTES` (`;`-separated). `job_name` tells the automatic job (`ORA$AT_OS_OPT_SY_…`) from a call.

`WINDOW = name|repeat_interval|duration|enabled|next_start`

- `DBA_SCHEDULER_WINDOWS` joined to `DBA_AUTOTASK_WINDOW_CLIENTS` where
  `OPTIMIZER_STATS = 'ENABLED'`. `duration` as `+000 04:00:00` text.

`AUTORUN = window_name|window_start|job_status|job_duration|job_info`

- Last 7 rows of `DBA_AUTOTASK_JOB_HISTORY` for `auto optimizer stats collection`.

`HFRUN = opid|start_time|end_time|status|completed|failed|timed_out|origin`

- Last 7 rows of `DBA_AUTO_STAT_EXECUTIONS`; the view also lists the nightly task's runs as
  `ORIGIN = AUTO_TASK`, the high-frequency task's as `HIGH_FREQ_AUTO_TASK`.

`PARTITION = name|position|num_rows|blocks|last_analyzed|stale_stats|locked|rows_changed|synopsis`

- Only when the table has at most 400 partitions, else skipped with a scalar
  `PARTITIONS_OMITTED = <count>`. `synopsis`: `HLL`, `OLD`, `NONE`, from the column `NOTES`
  heuristic the INPUT block already uses.

### Expression candidates (statement)

Expressions wrapped around a column of this table in the predicates of cached plans:
`V$SQL_PLAN` rows with `OBJECT_OWNER`/`OBJECT_NAME` = the table (and its indexes), regexp over
`FILTER_PREDICATES` and `ACCESS_PREDICATES` for `FUNC("COL"...)` with FUNC in
`UPPER|LOWER|TRUNC|SUBSTR|TO_CHAR|TO_NUMBER|TO_DATE|NVL|COALESCE|ROUND|EXTRACT|CAST|INSTR|LENGTH|LTRIM|RTRIM|TRIM|REPLACE|FLOOR|CEIL|ABS|MOD`.
Distinct texts, minus those already in `DBA_STAT_EXTENSIONS` or `DBA_IND_EXPRESSIONS`
(compare after removing whitespace and double quotes). At most 20. A cached plan is weak
evidence; the finding must say so and offer `SEED_COL_USAGE` as the firmer path for column
groups (SEED_COL_USAGE records column groups, not expressions — verify).

## The health report (`src/model/health/`)

```ts
export interface HealthFinding { level: Level; text: string; basis: string; fix?: string[] }
export interface HealthSection { id: string; title: string; summary: string; findings: HealthFinding[]; rows?: { head: string[]; body: string[][] } }
export interface HealthReport { collectedAt: string | null; sections: HealthSection[]; skipped: string[] }
export function health(input: Input, detail: Detail, prov: Provenance | null): HealthReport
```

- `health/index.ts` dispatches to the section modules; each module exports
  `sectionX(ctx): HealthSection | null` (null when its data was not collected; the id then
  goes to `skipped` with a one-line reason).
- Section ids and owners: `histograms` (WP2), `extended` (WP2), `indexes` (WP2), `quality`
  (WP2), `staleness` (WP3), `history` (WP3), `pending` (WP3), `restore` (WP3), `load` (WP3),
  `realtime` (WP3), `subpartitions` (WP3).
- Every finding has a `basis` naming the 19c document section or the lab id (same style as
  `advise.ts`). `fix` lines are runnable SQL / SQL*Plus with the owner and table filled in.
  Use `'` quoting like `advise.ts` does. Never generate a statement that changes data.
- Levels: `bad` = the optimizer or the gather is being hurt now; `warn` = likely waste or a
  risk; `info` = context; `good` = checked and fine (one per section at most).

## Form scenarios (WP5)

New `Input` fields (names fixed here so the collector and the parser can fill them):

| Field | Form | Collector key |
|---|---|---|
| `subpartitioned: boolean` | checkbox, shown when partitioned | `SUBPARTITIONED` (`1`/`0`) |
| `subpartitionType: "HASH" | "LIST" | "RANGE"` | select, shown when subpartitioned | `SUBPARTITION_TYPE` |
| `subpartitionsPerPartition: number` | number | `SUBPARTITIONS_PER_PARTITION` |
| `exchanged: boolean` | checkbox "A partition was exchanged in since the last gather" | not collected |
| `exchangeTargetGathered: boolean` | shown when exchanged | not collected |
| `exchangeStageSynopsis: boolean` | "the staging table had a table-level synopsis (INCREMENTAL TRUE, INCREMENTAL_LEVEL TABLE)" | not collected |
| `exchangeHistogramsMatch: boolean` | | not collected |
| `realTimeStats: boolean` | "Real-time statistics are on (optimizer_real_time_statistics / Exadata)" | `REALTIME_STATS` (`1`/`0`) |
| `hfTask: "OFF" | "ON"` | AUTO_TASK_STATUS | `AUTO_TASK_STATUS` |
| `hfInterval: number` | seconds | `AUTO_TASK_INTERVAL` |
| `hfMaxRunTime: number` | seconds | `AUTO_TASK_MAX_RUN_TIME` |
| `pendingStats: boolean` | "Pending statistics exist for the table" | `PENDING_STATS` (`1`/`0`) |

`runBy` gains the value `hf` (the high-frequency task). The INPUT block of the collector prints
these keys; WP1 adds them to `FORM_KEYS` in `parse.ts` with exactly these names.

## Verification duties

- Each rule cites its source. A doc claim is checked by fetching the 19c page (see
  `docs/oracle19c-review.md` for the pages used) and quoting the sentence in the commit or the
  lab log. A behavioural claim that the documentation does not settle is run on the lab
  database and recorded in `docs/lab-observations.md` with a new id.
- `collect.sql`, `recommend.sql` and `survey.sql` are run on the lab database against at least
  `STATS_LAB.SALES` (partitioned, incremental), `STATS_LAB.C1` (range-hash composite),
  `STATS_LAB.CG1` (plain, column groups), `ORASTATS_TEST.EXPR_PRED` (expression statistics)
  and `ORASTATS_TEST.ORDERS` (plain with several indexes); the outputs are the parser fixtures
  under `test/fixtures/`.
