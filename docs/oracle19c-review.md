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
- Composite partitions, temporary/external/index-organized tables, domain or partitioned
  global indexes, partition exchange and real-time statistics are outside this model.
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

Confirmed as written: GATHER AUTO "is only applicable to tables that do not have INCREMENTAL
enabled" and builds frequency histograms from a sample; the `'NULL'` versus `NULL` staleness
semantics; the APPROX_GLOBAL AND PARTITION aggregation text; online statistics keep the basic
statistics; the REPORT_GATHER_AUTO_STATS signature; multi-object gathers and the job skip locked
objects; DBA_PART_COL_STATISTICS has NOTES; the incremental prerequisites.

Still open: statement 3 allows one minute between a partition's LAST_ANALYZED and its synopsis
(every lab synopsis matched to the second); statement 1's guess cannot tell the INCREMENTAL-toggled
case (lab L1) from the locked case when both apply; `group# = 2 * object_id` is an undocumented
mapping of the synopsis table, verified on 19.27 only.

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
