# Oracle Database 19c review — 2026-10-08

The advisor and both SQL scripts use APIs and dictionary columns available in 19c, but the
original implementation was not fully correct. This review found and corrected the issues
below. It does not certify exact gather behavior for every table or release update.

## Evidence

- Reviewed `src/model`, generated gather/report/setup SQL, `sql/collect.sql`, and
  `sql/recommend.sql` against the Oracle 19c references linked below.
- Cross-checked the existing [19.27 lab observations](lab-observations.md). They distinguish
  measured behavior from inferred combinations. In particular, schema `GATHER AUTO` was
  tested; the actual nightly task was **not** run.
- The original 39 tests passed despite these issues. Added regression coverage and corrected
  old assertions that encoded the wrong behavior.
- Final validation: `npm run check` passed (type checking, 49 tests, production build).
  Browser smoke checks confirmed collector paste, measured-percentage visibility and URL
  persistence, the CLOB report block, and quoted-NULL rollback. Refreshed both prebuilt files.
- No live Oracle connection was supplied and no local SQL*Plus/SQLcl executable was available.
  The revised SQL scripts were reviewed statically, **not executed against Oracle in this
  review**. The earlier script headers describe runs of their original versions.

## Corrected issues

1. **Staleness rollback:** a preference value of `'NULL'` now remains a string in rollback
   SQL. A pasted call with SQL `NULL` is treated as a reset to `ALLOW_MIXED_FORMAT`.
2. **Gather/report SQL:** long gather calls now use a complete PL/SQL block. The report
   preserves supported call arguments, including partition, granularity and Boolean values,
   using a CLOB bind in PL/SQL. (The follow-up below corrects one point: 19.27 does accept
   `options =>` in the report, so it is now passed through.)
3. **Table staleness:** the model now uses the collector's global DML percentage when supplied,
   instead of replacing it with a partition-count estimate. The choice survives URL sharing.
   Single-partition tables and change/staleness percentages above 100 are accepted.
4. **Automatic and subsequent gathers:** a fresh table has no index or publication work merely
   because the override preference is enabled. Pending gathers leave published statistics
   stale. Missing global statistics trigger a refresh. Building all unlocked synopses does
   not also require a full global scan. These job predictions remain inferences.
5. **Gather scope:** non-incremental `GLOBAL` gathers no longer charge one scan per partition
   as well as the global scan. Stale load statistics are not incorrectly preserved by
   `GATHER AUTO`. A fixed estimate or pending gather no longer reports a new staging synopsis.
   A 100% estimate is described as full computation, not an extrapolated sample.
6. **Histogram fixes:** generated fixes set `METHOD_OPT` explicitly. Deleting a table preference
   cannot guarantee AUTO when the inherited global value is SIZE 1 or REPEAT.
7. **Collector categories:** a partition needing a missing synopsis is not also counted as a
   changed partition; its name is available for the generated call. Locked partitions without
   statistics are counted as locked, not as unlocked new partitions. Collected percentages
   retain precision at the staleness boundary.
8. **Standalone recommendations:** unlock counts use a union rather than adding overlapping
   categories. Numeric zero is recognized as AUTO_SAMPLE_SIZE. The pinned column template
   keeps comma separators. Pending-statistics deletion is an optional commented command.
9. **Explanations:** NO_INVALIDATE TRUE no longer means a cursor can never use new statistics;
   a later hard parse can do so. The page distinguishes measured lab results, estimates and
   unverified combinations.

## Remaining limits

This is the one list; the extension review below adds to it.

- The nightly job, AUTO_CASCADE selection, internal histogram work and synopsis format
  changes are not precisely predictable from these fields. `force` with individual partition
  locks remains unverified; the model flags that combination. Non-incremental
  `APPROX_GLOBAL AND PARTITION` aggregation remains an upper-bound estimate.
- The collector records the maximum DML percentage among changed partitions and an average
  block count. Unequal partition sizes or percentages crossing the threshold differently can
  change both partition counts and I/O. DML counters do not capture every partition DDL event.
- Column `NOTES` and recorded usage are heuristics for synopsis availability and histogram
  eligibility, not a complete inventory of valid synopses or proof of a new histogram.
  Existing usage alone does not prove the next gather will reread every partition.
- Both command-line scripts normalize owner/table names to uppercase. Their supported input
  is conventional unquoted identifiers; quoted mixed-case or punctuation-containing names
  need adaptation. The histogram list parser likewise assumes simple column names.
  Very long column lists can exceed LISTAGG/ODCIVARCHAR2LIST limits.
- Outside the model: temporary, external and index-organized tables, domain indexes, partitioned
  global indexes, `partname` with a subpartition name, degree and concurrency (shown, not
  modelled).
- Not run on the lab (updated 2026-10-11), so inferred or documentation-only: GRANULARITY ALL or SUBPARTITION on
  HASH subpartitions, LIST-LIST and other composites that are not range-x; everything the high-frequency task does (it never ran; the lab has
  `AUTO_TASK_STATUS` OFF); real-time statistics beside gathers (not available on the lab);
  job-driven partition exchange (lab H and V3 used explicit calls).
- Health check: it works on dictionary heuristics, developed against one 19.27 lab database.
  `DBA_INDEX_USAGE` is sampled (`_iut_stat_collection_type` = SAMPLED, 15-minute flush), so "unused"
  is a hint. Expression candidates come from `V$SQL_PLAN`, so only from cached plans (weak
  evidence); one positive case on the lab (lab Q11). DML counters are flushed
  periodically, so the staleness forecast is as current as the last flush. The missing-privilege
  path of `REPORT_COL_USAGE` in the collector was not tested as a non-SYSDBA user.
- Real-time statistics and the high-frequency task are licensed only for Exadata and Exadata Cloud
  in 19c (Licensing Information, Table 1-8), although the parameter and preferences exist on every
  edition. The page says so; it does not detect the edition.
- Dictionary reads need access to the DBA views. Package reports can additionally require
  ownership or `ANALYZE ANY`; dictionary objects have stronger requirements. Merely granting
  SELECT_CATALOG_ROLE and EXECUTE on DBMS_STATS does not grant every reporting privilege.
- Recommendations are workload choices. The append-only preset intentionally trades
  freshness for less work; it is not Oracle's universal recommended configuration.

For database validation, run both scripts in the owning PDB on representative lab tables,
check for ORA-/SP2- errors, and compare the generated report with the advisor. Reporting lists
objects; a controlled gather and recursive SQL/task inspection are needed to verify actual
scan behavior. Do not interpret the TypeScript tests as an Oracle integration test.

## Follow-up review, 2026-10-08, on 19.27 and against the 19c documentation

Both scripts were executed on 19.27 (PDB1: STATS_LAB.E1, SALES, ST1 and the composite C1) and
compared with Oracle's own `REPORT_GATHER_TABLE_STATS`; the model was run on the collector's real
output. The reference and Tuning Guide pages were read in full. Corrected:

1. **Synopsis staleness.** The collector called E1's synopses `stale` because the global column
   NOTES were blank, but they were blank only because a locked partition with DML forces the full
   scan (lab C1); every synopsis was in step with its partition to the second. The advisor then
   predicted a reread of all unlocked partitions on top of the full scan, and a second "no synopses
   yet" finding, which Oracle's report (one TABLE task) contradicts. Statement 1 now reads that case
   as `all`; a new statement 3 compares each unlocked partition's LAST_ANALYZED with its synopsis
   time in `SYS.WRI$_OPTSTAT_SYNOPSIS_HEAD$` and overrides the guess when the table is readable.
2. **OPTIONS in the report.** Item 2 above was wrong for 19.27: `REPORT_GATHER_TABLE_STATS` accepts
   `options =>` (ALL_ARGUMENTS lists it; a call with GATHER AUTO ran). The 19c reference omits it.
   The dry run now passes the call's options through and says so.
3. **Support-only histograms.** HISTOGRAM_COLUMNS and the pinned-list template no longer include
   columns whose NOTES say HIST_FOR_INCREM_STATS (four of SALES's five histograms). The reference
   says such a histogram "is not used for optimization", and pinning it with SIZE 254 turns it into
   a real one (lab Td). They are listed in a comment instead.
4. **Composite tables.** BLOCKS_PER_PARTITION was the average subpartition segment (C1: 32 instead
   of about 129 blocks). It is now the sum of partition and subpartition segments over the partition
   count.
5. **LOB indexes.** INDEXES and LOCAL_INDEXES exclude INDEX_TYPE = 'LOB', which DBMS_STATS does not
   gather; DBA_INDEXES lists them (714 in the lab database).
6. **Column groups and locks.** A column group counts as a pending change only while an unlocked
   partition lacks its statistics. A locked partition lacking them sets LOCKED_NO_SYNOPSIS instead,
   which is the full scan on every gather that the lab saw (Tc).
7. **Wording and privileges.** The NO_INVALIDATE TRUE texts that still said "never"; the
   REPORT_COL_USAGE privilege (SYSDBA, or ANALYZE ANY DICTIONARY plus ANALYZE ANY, not just
   ANALYZE ANY); `SET LONG` before the CLOB reports; the plain-table preset blurb; SQL lines that
   SQL*Plus echoes under an error are no longer listed as ignored by the paste box.

8. **Synopsis format.** New: the collector reports APPROXIMATE_NDV_ALGORITHM and OLD_FORMAT_PARTITIONS
   (partition NOTES `ADAPTIVE_SAMPLING`, the marker the reference documents for the 11g format), and the
   advisor reads old-format partitions once more when INCREMENTAL_STALENESS lacks ALLOW_MIXED_FORMAT,
   explains the merge when it has it, and flags ADAPTIVE SAMPLING. Documentation-based only: the lab
   has no old-format synopses.

9. **Column groups.** New: the collector reports the column groups the table has (`COLUMN_GROUPS`,
   `COLUMN_GROUP_LIST`), the column sets a USABLE `DYNAMIC_SAMPLING` directive misestimated that no
   group covers (`COLUMN_GROUP_CANDIDATES`, from `DBA_SQL_PLAN_DIRECTIVES` and `DBA_SQL_PLAN_DIR_OBJECTS`,
   whose `NOTES` is XMLTYPE on 19c: `equality_predicates_only` decides whether a group helps), the
   group lines of `REPORT_COL_USAGE` (`COLUMN_GROUP_USAGE_LIST`), and `AUTO_STAT_EXTENSIONS`. An
   extension without statistics now sets `COLUMN_CHANGE = group` on plain tables too, and statement 2
   no longer overrides it with `usage`. The advisor proposes `CREATE_EXTENDED_STATS` (a function, so
   as `SELECT ... FROM dual`), prices the group on an incremental table from lab E4 and Tc, explains
   a range-only directive, flags `AUTO_STAT_EXTENSIONS ON` on an incremental table, and checks the
   extension limit. Verified against the 19c Tuning Guide (Managing Extended Statistics: "The optimizer
   uses column group statistics for equality predicates, inlist predicates, and for estimating the
   GROUP BY cardinality"; `AUTO_STAT_EXTENSIONS` ON lets a directive trigger the creation) and the
   DBMS_STATS reference (the limit "a maximum of (20, 10% of number of non-virtual columns)", groups of
   2 to 32 columns, ORA-20007 and ORA-20008). Exercised on 19.27 (lab CG1, `docs/lab-observations.md`):
   with `OPTIMIZER_ADAPTIVE_STATISTICS` FALSE the lab queries created no directive; with it TRUE for
   the session one appeared after the flush. The directive stayed USABLE after the group was created
   and gathered; the collector drops the set because the extension covers it.

Confirmed as written: GATHER AUTO "is only applicable to tables that do not have INCREMENTAL
enabled" and builds frequency histograms from a sample; the `'NULL'` versus `NULL` staleness
semantics; the APPROX_GLOBAL AND PARTITION aggregation text; online statistics keep the basic
statistics; the REPORT_GATHER_AUTO_STATS signature; multi-object gathers and the job skip locked
objects; DBA_PART_COL_STATISTICS has NOTES; the incremental prerequisites.

Still open: statement 3 allows one minute between a partition's LAST_ANALYZED and its synopsis
(every lab synopsis matched to the second); statement 1's guess cannot tell the INCREMENTAL-toggled
case (lab L1) from the locked case when both apply; `group# = 2 * object_id` is an undocumented
mapping of the synopsis table, verified on 19.27 only.

## Extension review — 2026-10-11

Added in `ce5efea` and `ec8ba71` (and the fixes after them):

- **Collector detail block.** `collect.sql` prints a second block, `ADVISOR DETAIL BEGIN/END` (statements
  7 to 28): per-column statistics with histograms, usage and low/high values; per-index statistics with
  `DBA_INDEX_USAGE`; extensions; gather history from `DBA_OPTSTAT_OPERATIONS` / `_OPERATION_TASKS`;
  maintenance windows and automatic-task runs; high-frequency task runs; per-partition rows;
  expression candidates from `V$SQL_PLAN`; pending, retention and SYSAUX facts. The format and its
  rules are in `design-health.md`; `src/model/detail.ts` parses it and never throws on a bad line.
- **Health check.** `src/model/health/` turns the rows into sections (histograms, extended
  statistics, indexes, statistics quality, staleness forecast, gather history, pending statistics,
  restore and compare, bulk-load statistics, real-time statistics, subpartitions), each finding with
  a `basis`. The result pane renders them under the findings and lists skipped sections.
- **Form scenarios.** Composite tables and GRANULARITY SUBPARTITION; a partition exchange since the
  last gather (three conditions for a no-read gather: lab H2, H5, H6, H7, V3, Tg); real-time
  statistics; the high-frequency task (`runBy = hf`, `AUTO_TASK_STATUS` / `_INTERVAL` / `_MAX_RUN_TIME`);
  pending statistics (test, compare, publish, delete recipe); bulk-load statistics (`STATS_ON_LOAD`,
  GATHER AUTO). Seven new presets.
- **`sql/survey.sql`** ranks a schema's tables by the blocks the next plain gather would read.
- **Collector fixes.** DML counters for composite tables (`DBA_TAB_MODIFICATIONS` can hold
  subpartition rows only there, as on `STATS_LAB.C1`; a fresh table had all three levels, CP5) and for tables without a roll-up row (the roll-up is not added to the
  partition rows: that double-counts); `COLUMN_GROUPS` no longer counts expression extensions.

- **Composite tables, second run (2026-10-11).** The inference that GRANULARITY AUTO gathers no
  subpartition statistics for LIST and RANGE subpartitions was wrong (lab CP1, CP2: 9 of 9
  gathered; HASH still 0, CP3). The model now has `gathersSubpartitions(granularity, type)` (ALL,
  SUBPARTITION, and AUTO unless HASH) and a `subPass` read field: incremental, a new partition
  plus one modified subpartition per changed partition (the observed lower bound, CP5/CP6); not
  incremental, a third full pass (CP8). Synopses stay partition-level (CP4, CP7). The health
  check uses the same rule. Still not run: ALL or SUBPARTITION on HASH, non range-x composites.

How it was verified:

1. **Fact sheet.** `oracle19c-facts.md` quotes the 19c sentences (URL and section) for every
   documentation claim and marks what the documentation does not say. Appendix A lists assumptions
   the pages do not support.
2. **Lab fixtures.** The collector was run on 19.27 against STATS_LAB.SALES, C1, CG1,
   ORASTATS_TEST.EXPR_PRED and ORDERS; the outputs are the parser fixtures in `test/fixtures/`
   (`survey.sql`: `survey-STATS_LAB.txt`). The dictionary facts found on the way are in
   `lab-observations.md`, "Dictionary observations (2026-10-11, 19.27)".
3. **Reviewer pass** of `ce5efea` against the documentation (`ec8ba71`): the exchange lab ids were
   split per condition (H2/H7/H6 versus H5); the claim that GRANULARITY ALL / SUBPARTITION builds
   subpartition synopses was withdrawn (the documentation is silent; CP4/CP7 confirmed: partition-level only); the real-time statistics
   wording follows the documentation (both NOTES values, "most essential statistics");
   `AUTO_TASK_MAX_RUN_TIME` cites both Oracle pages, which disagree (maximum versus default 3600);
   the high-frequency verify SQL uses documented columns; licensing wording follows Table 1-8.

Not checked: the missing-privilege paths of the detail statements as a non-SYSDBA user; the rules on a
database other than the lab; anything listed under "Remaining limits" as not run.

## Oracle references

- [19c DBMS_STATS reference](https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/DBMS_STATS.html):
  preference null semantics, valid STALE_PERCENT values, gather granularity, report signature,
  cursor invalidation and privileges.
- [19c SQL*Plus EXECUTE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqpug/EXECUTE.html):
  multiline EXECUTE requires SQL*Plus continuation syntax; PL/SQL blocks avoid that issue.
- [19c Gathering Optimizer Statistics](https://docs.oracle.com/en/database/oracle/oracle-database/19/tgsql/gathering-optimizer-statistics.html):
  incremental prerequisites, index statistics, and the relationship between the automatic task
  and GATHER AUTO.
- [19c Histograms](https://docs.oracle.com/en/database/oracle/oracle-database/19/tgsql/histograms.html):
  histogram selection under AUTO_SAMPLE_SIZE versus a fixed estimate.
- [19c ALL_TAB_MODIFICATIONS](https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/ALL_TAB_MODIFICATIONS.html)
  and [ALL_TAB_COL_STATISTICS](https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/ALL_TAB_COL_STATISTICS.html):
  dictionary meanings, approximate DML counters and column notes.
