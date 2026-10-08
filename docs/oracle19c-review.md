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
   using a CLOB bind in PL/SQL. It explicitly identifies the missing `OPTIONS` capability.
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
