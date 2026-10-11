-- collect.sql: everything the gather advisor needs about one table, as pasteable KEY = VALUE lines.
--
-- Pure SQL: SELECT statements over the DBA_* and V$ views (statement 3 reads one SYS table and is
-- skipped without the privilege), plus one optional, error-tolerant PL/SQL block that flushes the
-- DML counters. No DDL, no DML, nothing is gathered. Every statement stands alone: one that fails
-- prints its error (WHENEVER SQLERROR CONTINUE) and the page treats what it would have printed as not collected.
--
-- Run it in the PDB that owns the table, as a user who can read the DBA_* views and call
-- DBMS_STATS. The reports need more: REPORT_GATHER_TABLE_STATS ownership or ANALYZE ANY,
-- REPORT_COL_USAGE (statements 2 and 5) SYSDBA or ANALYZE ANY DICTIONARY plus ANALYZE ANY, and
-- statement 3 reads SYS.WRI$_OPTSTAT_SYNOPSIS_HEAD$ (SYSDBA). Each is skipped without the privilege;
-- SELECT_CATALOG_ROLE + EXECUTE alone is not sufficient for every report.
-- Input owner/table names must be conventional unquoted identifiers.
-- See docs/oracle19c-review.md for the review and remaining model limits.
--
--
--     sqlplus / as sysdba                 (or sqlcl, or SQL Developer: open the file, F5)
--     SQL> alter session set container = PDB1;
--     SQL> @collect.sql SHOP SALES        (without arguments it prompts for owner and table)
--
-- Then paste the whole output into the advisor's "Fill the form from your database" box.
-- The form is filled from the lines between ADVISOR INPUT BEGIN and ADVISOR INPUT END. The lines between
-- ADVISOR DETAIL BEGIN and ADVISOR DETAIL END feed the health check (the records are described below and in
-- docs/design-health.md); the partition list and the dry run after them are for you.
-- A later KEY line overrides an earlier one, and an error
-- message in the middle (a missing privilege) is ignored by the paste box.
--
-- Where each value comes from:
--   PARTITIONED, PARTITIONS   DBA_TABLES, DBA_TAB_PARTITIONS (PARTITIONS = 1 for a plain table)
--   BLOCKS_PER_PARTITION      DBA_SEGMENTS blocks of all partition and subpartition segments divided by the
--                             partition count (the table's blocks for a plain table); DBA_TAB_STATISTICS
--                             blocks when no segment
--   NUM_ROWS                  DBA_TAB_STATISTICS, the TABLE row
--   COLUMNS, INDEXES          DBA_TAB_COLS (visible columns), DBA_INDEXES without LOB indexes (DBMS_STATS does
--                             not gather them); LOCAL_INDEXES from DBA_PART_INDEXES, LOB indexes excluded too
--   HISTOGRAMS                1 when any global column statistic has a histogram
--   TABLE_STATS               gathered | none (no LAST_ANALYZED) | load (column NOTES say STATS_ON_LOAD)
--   TABLE_CHANGE_PERCENT      the table-level row of DBA_TAB_MODIFICATIONS relative to NUM_ROWS; the sum of the partitions'
--                             changes when the table has no such row (adding the roll-up row to the partition rows would count
--                             every change twice: SOE.ORDER_ITEMS, roll-up 5.3 percent, agrees with STALE_STATS = NO)
--   the preferences           DBMS_STATS.GET_PREFS(name, owner, table): the value in force
--   TABLE_PREFS               the preferences the table sets itself (DBA_TAB_STAT_PREFS); the rollback script
--                             deletes a changed preference that is not listed here so it inherits again
--   HISTOGRAM_COLUMNS         the visible columns whose global histogram the optimizer uses; the recommended
--                             METHOD_OPT pins them. A histogram whose NOTES say HIST_FOR_INCREM_STATS exists only
--                             to derive the global one and is not used for optimization (19c Reference); it is
--                             listed in a comment instead, because pinning it makes it a real one (lab Td)
--   SYNOPSES                  statement 3 compares each unlocked partition's LAST_ANALYZED with its synopsis
--                             time in SYS.WRI$_OPTSTAT_SYNOPSIS_HEAD$: all when no synopsis is older than its
--                             partition's statistics, none when no partition has one, stale otherwise. Without
--                             access to that table, statement 1 guesses from the dictionary: all when every
--                             analysed partition has one (DBA_PART_COL_STATISTICS NOTES with HYPERLOGLOG or
--                             ADAPTIVE_SAMPLING) and the global column NOTES say INCREMENTAL, or when a locked
--                             partition explains the blank global NOTES (lab C1, Tc, V2); none when no partition
--                             has one; stale otherwise
--   OLD_FORMAT_PARTITIONS     partitions whose synopsis is in the 11g adaptive-sampling format (DBA_PART_COL_STATISTICS
--                             NOTES ADAPTIVE_SAMPLING); without ALLOW_MIXED_FORMAT they count as stale and are read again
--   NEW_PARTITIONS            partitions without statistics, plus unlocked analysed partitions without a
--                             synopsis when the table has synopses
--   CHANGED_PARTITIONS        unlocked analysed partitions with rows in DBA_TAB_MODIFICATIONS. A composite table has only
--                             subpartition rows there (STATS_LAB.C1): they are added up to the partition, counting only rows
--                             whose TIMESTAMP is later than the partition's LAST_ANALYZED, else the initial load would show as
--                             100 percent change. This also feeds CHANGE_PERCENT and the PARTITION records
--   CHANGE_PERCENT            the largest change among them, relative to the partition's NUM_ROWS
--   LOCKED_*                  STATTYPE_LOCKED per partition (counted only when the table is not locked);
--                             LOCKED_NO_SYNOPSIS also when a locked partition lacks the statistics of a column
--                             group, which forces the same full scan (lab Tc)
--   TABLE_LOCKED              STATTYPE_LOCKED on the table row
--   COLUMN_CHANGE             group: DBA_STAT_EXTENSIONS has an extension some unlocked analysed partition lacks
--                             statistics for; usage: DBMS_STATS.REPORT_COL_USAGE lists a column whose
--                             global HISTOGRAM is NONE (statement 2); else none
--   COLUMN_USAGE              1 when REPORT_COL_USAGE lists at least one column
--   AUTO_STAT_EXTENSIONS      the preference in force: ON lets a SQL plan directive make the gather create a column group
--   COLUMN_GROUPS             extensions that are column groups (DBA_STAT_EXTENSIONS, extension text starting with
--                             a parenthesis); COLUMN_GROUP_LIST names them. An extension without statistics (created
--                             since the last gather) also sets COLUMN_CHANGE = group
--   COLUMN_GROUP_CANDIDATES   statement 4: column sets of two or more columns a USABLE DYNAMIC_SAMPLING directive
--                             (DBA_SQL_PLAN_DIRECTIVES, DBA_SQL_PLAN_DIR_OBJECTS) misestimated and no column group
--                             covers; counted when the directive's predicates were all equalities, the case a column
--                             group serves (19c Tuning Guide, Managing Extended Statistics). COLUMN_GROUP_CANDIDATE_LIST
--                             has every such set as columns|directive|eq or range|product of the members' NDVs
--   SUBPARTITIONED            1 when DBA_PART_TABLES.SUBPARTITIONING_TYPE is HASH, LIST or RANGE; then SUBPARTITION_TYPE is
--                             that type and SUBPARTITIONS_PER_PARTITION the DBA_TAB_SUBPARTITIONS count divided by the partitions
--   REALTIME_STATS            1 when V$PARAMETER optimizer_real_time_statistics is TRUE (the parameter exists on 19.27)
--   PENDING_STATS             1 when DBA_TAB_PENDING_STATS has rows for the table
--   AUTO_TASK_STATUS, AUTO_TASK_INTERVAL, AUTO_TASK_MAX_RUN_TIME
--                             statement 1b, the global DBMS_STATS.GET_PREFS of the high-frequency task (ON/OFF, seconds, seconds)
--   COLUMN_GROUP_USAGE_LIST   statement 5: the group lines of REPORT_COL_USAGE ("(A, B) : FILTER", recorded under
--                             SEED_COL_USAGE) without a column group; the paste box merges them into the candidates
--
-- The detail block (statements 7 to 28), for the health check. KEY = value for a scalar, KIND = f1|f2|... for a row;
-- a missing field is empty, | in text is written /, dates are YYYY-MM-DD HH24:MI:SS, flags Y/N, empty means unknown.
--   scalars (statements 7 to 18)
--     DETAIL_VERSION, COLLECTED_AT, DB_VERSION (V$INSTANCE.VERSION_FULL)
--     LAST_ANALYZED, STALE_STATS                       DBA_TAB_STATISTICS, the TABLE row
--     MODS_TIMESTAMP, ROWS_CHANGED, ROWS_TRUNCATED      DBA_TAB_MODIFICATIONS (table row; else the partitions' changes added up)
--     STATS_ON_LOAD, REALTIME_STATS_NOTES               NOTES of DBA_TAB_STATISTICS and DBA_TAB_COL_STATISTICS
--     SUBPARTITIONING, SUBPARTITIONS, SUBPARTITIONS_WITH_STATS   DBA_PART_TABLES, DBA_TAB_SUBPARTITIONS
--     ZERO_ROW_PARTITIONS_WITH_DML                      partitions with NUM_ROWS = 0 and inserts counted since
--     PARTITIONS_OMITTED                                the partition count, instead of PARTITION records, above 400
--     PENDING_ROWS, PENDING_SINCE                       DBA_TAB_PENDING_STATS
--     OPTIMIZER_USE_PENDING_STATISTICS, REALTIME_STATS_PARAM, OPTIMIZER_ADAPTIVE_STATISTICS   V$PARAMETER
--     RETENTION_DAYS, HISTORY_AVAILABLE_SINCE           DBMS_STATS.GET_STATS_HISTORY_RETENTION / _AVAILABILITY
--     HISTORY_ROWS, HISTORY_OLDEST, HISTORY_NEWEST      DBA_TAB_STATS_HISTORY (table and partition rows)
--     SYSAUX_OPTSTAT_MB                                 V$SYSAUX_OCCUPANTS, SM/OPTSTAT
--     AUTO_TASK_STATUS, AUTO_TASK_INTERVAL, AUTO_TASK_MAX_RUN_TIME, AUTOSTATS_TARGET   global DBMS_STATS.GET_PREFS
--     TABLE_CACHED_BLOCKS                               DBMS_STATS.GET_PREFS for the table
--     AUTOTASK_STATUS                                   DBA_AUTOTASK_CLIENT, 'auto optimizer stats collection'
--     UNIQUE_COLUMNS                                    visible columns alone in a unique index or an enabled unique/primary key
--     FBI_EXPRESSIONS                                   DBA_IND_EXPRESSIONS (a LONG, read through DBMS_XMLGEN), ; between
--     EXPRESSION_CANDIDATES                             function calls on a column in the predicates of cached plans (V$SQL_PLAN), ; between
--     COLUMN_USAGE_COLLECTED                            Y when REPORT_COL_USAGE could be read (statement 19), else N
--   records
--     COLUMN     name|data_type|nullable|num_distinct|num_nulls|num_buckets|histogram|sample_size|density|avg_col_len|last_analyzed|notes|low|high|usage|in_index
--                DBA_TAB_COLS + DBA_TAB_COL_STATISTICS; usage from REPORT_COL_USAGE: the flags of the report line (EQ, RANGE, LIKE,
--                NULL, EQUIJOIN, NONEQUIJOIN, and FILTER, JOIN, GROUP_BY when listed), / between; empty extension data_type
--     INDEX      name|uniqueness|index_type|partitioned|locality|columns|blevel|leaf_blocks|distinct_keys|clustering_factor|num_rows|last_analyzed|stale_stats|locked|status|visibility|total_access_count|total_exec_count|last_used
--     EXTENSION  name|extension_text|kind|has_stats|num_distinct|histogram|used     DBA_STAT_EXTENSIONS
--     HISTORY    opid|operation|start_time|end_time|status|job_name|target_type|partitions_gathered|global_gathered|indexes_gathered|target_size|histogram_columns
--                DBA_OPTSTAT_OPERATIONS + DBA_OPTSTAT_OPERATION_TASKS, last 12 (statement 23 explains the fields)
--     WINDOW     name|repeat_interval|duration|enabled|next_start        DBA_SCHEDULER_WINDOWS + DBA_AUTOTASK_WINDOW_CLIENTS
--     AUTORUN    window_name|window_start|job_status|job_duration|job_info    last 7 of DBA_AUTOTASK_JOB_HISTORY
--     HFRUN      opid|start_time|end_time|status|completed|failed|timed_out|origin    last 7 of DBA_AUTO_STAT_EXECUTIONS
--     PARTITION  name|position|num_rows|blocks|last_analyzed|stale_stats|locked|rows_changed|synopsis    DBA_TAB_STATISTICS partition rows
--
-- Oracle 19c. Exercised 2026-10-08 on 19.27 (PDB1 of the dbmint lab: STATS_LAB.SALES, E1, C1, N4, P2 and the
-- plain ST1); test/fixtures/collect-*.txt are real outputs (the detail block was added 2026-10-11 and run on
-- STATS_LAB.SALES, C1, CG1 and ORASTATS_TEST.EXPR_PRED, ORDERS). Read it before you run it elsewhere.

SET PAGESIZE 0 LINESIZE 32767 HEADING OFF FEEDBACK OFF VERIFY OFF TRIMOUT ON TRIMSPOOL ON
SET LONG 1000000 LONGCHUNKSIZE 1000000 TAB OFF
WHENEVER SQLERROR CONTINUE

DEFINE adv_owner = &1
DEFINE adv_table = &2
DEFINE adv_usage_ok = N

-- Optional: make DBA_TAB_MODIFICATIONS current. Needs ANALYZE ANY; silently skipped without it.
BEGIN
  DBMS_STATS.FLUSH_DATABASE_MONITORING_INFO;
EXCEPTION WHEN OTHERS THEN NULL;
END;
/

-- ====================================================================== 1. the table and its partitions
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), tb AS (
  SELECT p.own, p.tab, t.partitioned,
         s.num_rows, s.blocks AS stat_blocks, s.last_analyzed, s.stattype_locked AS tbl_lock
  FROM   p
         JOIN dba_tables t ON t.owner = p.own AND t.table_name = p.tab
         LEFT JOIN dba_tab_statistics s ON s.owner = t.owner AND s.table_name = t.table_name AND s.object_type = 'TABLE'
), pr AS (
  SELECT s.partition_name, s.partition_position, s.num_rows, s.blocks, s.last_analyzed, s.stale_stats,
         NVL(NVL((SELECT SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)) FROM dba_tab_modifications m
              WHERE  m.table_owner = s.owner AND m.table_name = s.table_name AND m.partition_name = s.partition_name AND m.subpartition_name IS NULL),
             (SELECT SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)) FROM dba_tab_modifications m
              WHERE  m.table_owner = s.owner AND m.table_name = s.table_name AND m.partition_name = s.partition_name AND m.subpartition_name IS NOT NULL
              AND    (s.last_analyzed IS NULL OR m.timestamp > s.last_analyzed))), 0) AS mods,
         CASE WHEN tb.tbl_lock IS NULL AND s.stattype_locked IS NOT NULL THEN 1 ELSE 0 END AS is_locked,
         CASE WHEN EXISTS (SELECT 1 FROM dba_part_col_statistics c
                           WHERE  c.owner = s.owner AND c.table_name = s.table_name AND c.partition_name = s.partition_name
                           AND   (c.notes LIKE '%HYPERLOGLOG%' OR c.notes LIKE '%ADAPTIVE_SAMPLING%'))
              THEN 1 ELSE 0 END AS has_syn,
         CASE WHEN s.last_analyzed IS NOT NULL AND EXISTS (SELECT 1 FROM dba_stat_extensions e
                           WHERE  e.owner = s.owner AND e.table_name = s.table_name
                           AND    NOT EXISTS (SELECT 1 FROM dba_part_col_statistics c
                                              WHERE  c.owner = s.owner AND c.table_name = s.table_name
                                              AND    c.partition_name = s.partition_name AND c.column_name = e.extension_name
                                              AND    c.last_analyzed IS NOT NULL))
              THEN 1 ELSE 0 END AS lacks_ext,
         CASE WHEN EXISTS (SELECT 1 FROM dba_part_col_statistics c
                           WHERE  c.owner = s.owner AND c.table_name = s.table_name AND c.partition_name = s.partition_name
                           AND    c.notes LIKE '%ADAPTIVE_SAMPLING%')
              THEN 1 ELSE 0 END AS old_fmt
  FROM   tb
         JOIN dba_tab_statistics s ON s.owner = tb.own AND s.table_name = tb.tab AND s.object_type = 'PARTITION'
  WHERE  tb.partitioned = 'YES'
), pc AS (
  SELECT pr.*,
         CASE WHEN is_locked = 0 AND (last_analyzed IS NULL OR
                   (has_syn = 0 AND EXISTS (SELECT 1 FROM dba_tab_col_statistics c, tb
                     WHERE c.owner = tb.own AND c.table_name = tb.tab AND c.notes LIKE '%INCREMENTAL%')))
              THEN 1 ELSE 0 END AS is_new,
         CASE WHEN mods = 0 THEN 0 WHEN NVL(num_rows, 0) = 0 THEN 100 ELSE 100 * mods / num_rows END AS pct
  FROM   pr
), ag AS (
  SELECT COUNT(*)                                                                   AS n_parts,
         SUM(mods)                                                                  AS sum_mods,
         SUM(is_new)                                                                AS n_no_stats,
         SUM(has_syn)                                                               AS n_with_syn,
         SUM(old_fmt)                                                               AS n_old_fmt,
         SUM(CASE WHEN is_locked = 0 AND is_new = 0 AND has_syn = 0 THEN 1 ELSE 0 END) AS n_lack_syn,
         SUM(CASE WHEN is_locked = 0 AND is_new = 0 AND mods > 0 THEN 1 ELSE 0 END)   AS n_changed,
         MAX(CASE WHEN is_locked = 0 AND is_new = 0 AND mods > 0 THEN pct END)        AS max_pct,
         SUM(is_locked)                                                             AS n_locked,
         SUM(CASE WHEN is_locked = 1 AND mods > 0 THEN 1 ELSE 0 END)                 AS n_locked_chg,
         MAX(CASE WHEN is_locked = 1 AND (has_syn = 0 OR lacks_ext = 1) THEN 1 ELSE 0 END)   AS locked_no_syn,
         ROUND(AVG(blocks))                                                         AS stat_blocks_avg,
         MAX(CASE WHEN is_new = 1 THEN partition_name END)
           KEEP (DENSE_RANK FIRST ORDER BY is_new DESC, partition_position)         AS name_new,
         MAX(CASE WHEN is_locked = 0 AND is_new = 0 AND mods > 0 THEN partition_name END)
           KEEP (DENSE_RANK LAST ORDER BY CASE WHEN is_locked = 0 AND is_new = 0 AND mods > 0 THEN pct ELSE -1 END, partition_position) AS name_changed,
         MAX(CASE WHEN is_locked = 1 THEN partition_name END)
           KEEP (DENSE_RANK LAST ORDER BY is_locked, CASE WHEN mods > 0 THEN 1 ELSE 0 END, partition_position) AS name_locked
  FROM   pc
), v AS (
  SELECT tb.own, tb.tab, tb.partitioned,
         CASE WHEN tb.partitioned = 'YES' THEN ag.n_parts ELSE 1 END AS n_parts,
         GREATEST(NVL(CASE WHEN tb.partitioned = 'YES'
                           THEN (SELECT ROUND(SUM(g.blocks) / NULLIF(ag.n_parts, 0)) FROM dba_segments g
                                 WHERE  g.owner = tb.own AND g.segment_name = tb.tab
                                 AND    g.segment_type IN ('TABLE PARTITION', 'TABLE SUBPARTITION'))
                           ELSE (SELECT SUM(g.blocks) FROM dba_segments g
                                 WHERE  g.owner = tb.own AND g.segment_name = tb.tab AND g.segment_type = 'TABLE')
                      END, NVL(CASE WHEN tb.partitioned = 'YES' THEN ag.stat_blocks_avg ELSE tb.stat_blocks END, 1)), 1) AS blocks_per,
         NVL(tb.num_rows, 0) AS num_rows,
         (SELECT COUNT(*) FROM dba_tab_cols c WHERE c.owner = tb.own AND c.table_name = tb.tab AND c.hidden_column = 'NO') AS n_cols,
         (SELECT COUNT(*) FROM dba_indexes i WHERE i.table_owner = tb.own AND i.table_name = tb.tab AND i.index_type <> 'LOB') AS n_idx,
         (SELECT COUNT(*) FROM dba_part_indexes i JOIN dba_indexes x ON x.owner = i.owner AND x.index_name = i.index_name
          WHERE  i.owner = tb.own AND i.table_name = tb.tab AND i.locality = 'LOCAL' AND x.index_type <> 'LOB') AS n_local,
         CASE WHEN EXISTS (SELECT 1 FROM dba_tab_col_statistics c WHERE c.owner = tb.own AND c.table_name = tb.tab
                           AND c.histogram IS NOT NULL AND c.histogram <> 'NONE') THEN '1' ELSE '0' END AS has_hist,
         (SELECT LISTAGG(c.column_name, ',') WITHIN GROUP (ORDER BY c.column_id)
          FROM   dba_tab_cols c
          WHERE  c.owner = tb.own AND c.table_name = tb.tab AND c.hidden_column = 'NO'
          AND    EXISTS (SELECT 1 FROM dba_tab_col_statistics cs
                         WHERE  cs.owner = c.owner AND cs.table_name = c.table_name AND cs.column_name = c.column_name
                         AND    cs.histogram IS NOT NULL AND cs.histogram <> 'NONE'
                         AND    NVL(cs.notes, 'x') NOT LIKE '%HIST_FOR_INCREM_STATS%')) AS hist_cols,
         (SELECT LISTAGG(c.column_name, ',') WITHIN GROUP (ORDER BY c.column_id)
          FROM   dba_tab_cols c
          WHERE  c.owner = tb.own AND c.table_name = tb.tab AND c.hidden_column = 'NO'
          AND    EXISTS (SELECT 1 FROM dba_tab_col_statistics cs
                         WHERE  cs.owner = c.owner AND cs.table_name = c.table_name AND cs.column_name = c.column_name
                         AND    cs.histogram IS NOT NULL AND cs.histogram <> 'NONE'
                         AND    cs.notes LIKE '%HIST_FOR_INCREM_STATS%')) AS hist_support,
         (SELECT COUNT(*) FROM dba_stat_extensions e
          WHERE  e.owner = tb.own AND e.table_name = tb.tab AND DBMS_LOB.SUBSTR(e.extension, 1, 1) = '(') AS n_cg,
         (SELECT LISTAGG(REPLACE(REPLACE(DBMS_LOB.SUBSTR(e.extension, 4000, 1), '"', ''), ' ', ''), '; ' ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY e.extension_name)
          FROM   dba_stat_extensions e
          WHERE  e.owner = tb.own AND e.table_name = tb.tab AND DBMS_LOB.SUBSTR(e.extension, 1, 1) = '(') AS cg_list,
         (SELECT COUNT(*) FROM dba_stat_extensions e
          WHERE  e.owner = tb.own AND e.table_name = tb.tab
          AND    NOT EXISTS (SELECT 1 FROM dba_tab_col_statistics c
                             WHERE  c.owner = e.owner AND c.table_name = e.table_name AND c.column_name = e.extension_name
                             AND    c.last_analyzed IS NOT NULL)) AS n_ext_nostats,
         (SELECT LISTAGG(sp.preference_name, ',') WITHIN GROUP (ORDER BY sp.preference_name)
          FROM   dba_tab_stat_prefs sp WHERE sp.owner = tb.own AND sp.table_name = tb.tab) AS tbl_prefs,
         CASE WHEN tb.last_analyzed IS NULL THEN 'none'
              WHEN EXISTS (SELECT 1 FROM dba_tab_col_statistics c WHERE c.owner = tb.own AND c.table_name = tb.tab
                           AND c.notes LIKE '%STATS_ON_LOAD%') THEN 'load'
              ELSE 'gathered' END AS tbl_stats,
         -- the table's roll-up row when there is one; else the partitions' own changes added up (a roll-up row and
         -- the partition rows together would count every change twice)
         NVL(NVL((SELECT SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)) FROM dba_tab_modifications m
                  WHERE  m.table_owner = tb.own AND m.table_name = tb.tab AND m.partition_name IS NULL), ag.sum_mods), 0) AS tbl_mods,
         CASE WHEN tb.tbl_lock IS NOT NULL THEN '1' ELSE '0' END AS tbl_locked,
         CASE WHEN EXISTS (SELECT 1 FROM dba_tab_col_statistics c WHERE c.owner = tb.own AND c.table_name = tb.tab
                           AND c.notes LIKE '%INCREMENTAL%') THEN 1 ELSE 0 END AS global_incr,
         (SELECT COUNT(*) FROM dba_stat_extensions e
          WHERE  e.owner = tb.own AND e.table_name = tb.tab
          AND    EXISTS (SELECT 1 FROM dba_tab_statistics s
                         WHERE  s.owner = e.owner AND s.table_name = e.table_name AND s.object_type = 'PARTITION'
                         AND    s.last_analyzed IS NOT NULL AND s.stattype_locked IS NULL
                         AND    NOT EXISTS (SELECT 1 FROM dba_part_col_statistics c
                                            WHERE  c.owner = s.owner AND c.table_name = s.table_name
                                            AND    c.partition_name = s.partition_name AND c.column_name = e.extension_name
                                            AND    c.last_analyzed IS NOT NULL))) AS n_groups,
         ag.n_no_stats, ag.n_with_syn, ag.n_lack_syn, ag.n_changed, ag.max_pct, ag.n_locked, ag.n_locked_chg, ag.locked_no_syn, ag.n_old_fmt,
         ag.name_new, ag.name_changed, ag.name_locked,
         (SELECT MAX(t.subpartitioning_type) FROM dba_part_tables t WHERE t.owner = tb.own AND t.table_name = tb.tab) AS subpart_type,
         (SELECT COUNT(*) FROM dba_tab_subpartitions s WHERE s.table_owner = tb.own AND s.table_name = tb.tab) AS n_subparts,
         (SELECT UPPER(value) FROM v$parameter WHERE name = 'optimizer_real_time_statistics') AS realtime_param,
         (SELECT COUNT(*) FROM dba_tab_pending_stats s WHERE s.owner = tb.own AND s.table_name = tb.tab) AS n_pending,
         DBMS_STATS.GET_PREFS('INCREMENTAL', tb.own, tb.tab)                    AS p_incremental,
         DBMS_STATS.GET_PREFS('INCREMENTAL_LEVEL', tb.own, tb.tab)              AS p_incr_level,
         DBMS_STATS.GET_PREFS('INCREMENTAL_STALENESS', tb.own, tb.tab)          AS p_incr_staleness,
         DBMS_STATS.GET_PREFS('APPROXIMATE_NDV_ALGORITHM', tb.own, tb.tab)      AS p_ndv_alg,
         DBMS_STATS.GET_PREFS('PUBLISH', tb.own, tb.tab)                        AS p_publish,
         DBMS_STATS.GET_PREFS('ESTIMATE_PERCENT', tb.own, tb.tab)               AS p_estimate,
         DBMS_STATS.GET_PREFS('GRANULARITY', tb.own, tb.tab)                    AS p_granularity,
         DBMS_STATS.GET_PREFS('METHOD_OPT', tb.own, tb.tab)                     AS p_method_opt,
         DBMS_STATS.GET_PREFS('CASCADE', tb.own, tb.tab)                        AS p_cascade,
         DBMS_STATS.GET_PREFS('NO_INVALIDATE', tb.own, tb.tab)                  AS p_no_invalidate,
         DBMS_STATS.GET_PREFS('OPTIONS', tb.own, tb.tab)                        AS p_options,
         DBMS_STATS.GET_PREFS('DEGREE', tb.own, tb.tab)                         AS p_degree,
         DBMS_STATS.GET_PREFS('STALE_PERCENT', tb.own, tb.tab)                  AS p_stale_percent,
         DBMS_STATS.GET_PREFS('PREFERENCE_OVERRIDES_PARAMETER', tb.own, tb.tab) AS p_overrides,
         DBMS_STATS.GET_PREFS('AUTO_STAT_EXTENSIONS', tb.own, tb.tab)           AS p_auto_ext
  FROM   tb LEFT JOIN ag ON 1 = 1
), w AS (
  SELECT v.*,
         CASE WHEN NVL(n_with_syn, 0) = 0 THEN 'none'
              WHEN global_incr = 1 THEN 'all'
              WHEN NVL(n_lack_syn, 0) = 0 AND (NVL(n_locked_chg, 0) > 0 OR NVL(locked_no_syn, 0) = 1) THEN 'all'
              ELSE 'stale' END AS synopses,
         CASE WHEN tbl_mods = 0 THEN 0 WHEN num_rows = 0 THEN 100 ELSE 100 * tbl_mods / num_rows END AS tbl_change
  FROM   v
)
SELECT column_value AS line
FROM   w,
       TABLE(sys.odcivarchar2list(
         '-- Gather advisor input for ' || w.own || '.' || w.tab || ', collected ' || TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS'),
         '-- paste everything from BEGIN to END (the whole output is fine) into the advisor',
         '-- ADVISOR INPUT BEGIN',
         'OWNER = ' || w.own,
         'TABLE_NAME = ' || w.tab,
         'PARTITIONED = ' || w.partitioned,
         'PARTITIONS = ' || TO_CHAR(w.n_parts),
         'BLOCKS_PER_PARTITION = ' || TO_CHAR(w.blocks_per),
         'NUM_ROWS = ' || TO_CHAR(w.num_rows),
         'COLUMNS = ' || TO_CHAR(w.n_cols),
         'INDEXES = ' || TO_CHAR(w.n_idx),
         'LOCAL_INDEXES = ' || TO_CHAR(w.n_local),
         'HISTOGRAMS = ' || w.has_hist,
         'TABLE_STATS = ' || w.tbl_stats,
         'TABLE_CHANGE_PERCENT = ' || TO_CHAR(w.tbl_change, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,'''),
         'INCREMENTAL = ' || NVL(w.p_incremental, 'NULL'),
         'INCREMENTAL_LEVEL = ' || NVL(w.p_incr_level, 'NULL'),
         'INCREMENTAL_STALENESS = ' || NVL(w.p_incr_staleness, 'NULL'),
         'APPROXIMATE_NDV_ALGORITHM = ' || NVL(w.p_ndv_alg, 'NULL'),
         'PUBLISH = ' || NVL(w.p_publish, 'NULL'),
         'ESTIMATE_PERCENT = ' || NVL(w.p_estimate, 'NULL'),
         'GRANULARITY = ' || NVL(w.p_granularity, 'NULL'),
         'METHOD_OPT = ' || NVL(w.p_method_opt, 'NULL'),
         'CASCADE = ' || NVL(w.p_cascade, 'NULL'),
         'NO_INVALIDATE = ' || NVL(w.p_no_invalidate, 'NULL'),
         'OPTIONS = ' || NVL(w.p_options, 'NULL'),
         'DEGREE = ' || NVL(w.p_degree, 'NULL'),
         'STALE_PERCENT = ' || NVL(w.p_stale_percent, 'NULL'),
         'PREFERENCE_OVERRIDES_PARAMETER = ' || NVL(w.p_overrides, 'NULL'),
         'AUTO_STAT_EXTENSIONS = ' || NVL(w.p_auto_ext, 'NULL'),
         'SUBPARTITIONED = ' || CASE WHEN w.subpart_type IN ('HASH', 'LIST', 'RANGE') THEN '1' ELSE '0' END,
         CASE WHEN w.subpart_type IN ('HASH', 'LIST', 'RANGE') THEN 'SUBPARTITION_TYPE = ' || w.subpart_type
              ELSE '-- SUBPARTITION_TYPE: not a composite-partitioned table' END,
         CASE WHEN w.subpart_type IN ('HASH', 'LIST', 'RANGE')
              THEN 'SUBPARTITIONS_PER_PARTITION = ' || TO_CHAR(GREATEST(1, ROUND(w.n_subparts / GREATEST(NVL(w.n_parts, 1), 1))))
              ELSE '-- SUBPARTITIONS_PER_PARTITION: not a composite-partitioned table' END,
         'REALTIME_STATS = ' || CASE WHEN w.realtime_param = 'TRUE' THEN '1' ELSE '0' END,
         'PENDING_STATS = ' || CASE WHEN w.n_pending > 0 THEN '1' ELSE '0' END,
         'TABLE_PREFS = ' || w.tbl_prefs,
         'HISTOGRAM_COLUMNS = ' || w.hist_cols,
         '-- histograms kept only for incremental statistics (NOTES HIST_FOR_INCREM_STATS, not used by the optimizer, so not pinned): ' || NVL(w.hist_support, '(none)'),
         'COLUMN_GROUPS = ' || TO_CHAR(w.n_cg),
         'COLUMN_GROUP_LIST = ' || w.cg_list,
         'SYNOPSES = ' || w.synopses,
         'NEW_PARTITIONS = ' || TO_CHAR(NVL(w.n_no_stats, 0)),
         'NEW_PARTITION = ' || w.name_new,
         'CHANGED_PARTITIONS = ' || TO_CHAR(NVL(w.n_changed, 0)),
         'CHANGED_PARTITION = ' || CASE WHEN NVL(w.n_changed, 0) > 0 THEN w.name_changed END,
         'CHANGE_PERCENT = ' || TO_CHAR(NVL(w.max_pct, 0), 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,'''),
         'LOCKED_PARTITIONS = ' || TO_CHAR(NVL(w.n_locked, 0)),
         'LOCKED_CHANGED = ' || TO_CHAR(NVL(w.n_locked_chg, 0)),
         'LOCKED_PARTITION = ' || CASE WHEN NVL(w.n_locked, 0) > 0 THEN w.name_locked END,
         'LOCKED_NO_SYNOPSIS = ' || TO_CHAR(NVL(w.locked_no_syn, 0)),
         'OLD_FORMAT_PARTITIONS = ' || TO_CHAR(NVL(w.n_old_fmt, 0)),
         'TABLE_LOCKED = ' || w.tbl_locked,
         'COLUMN_CHANGE = ' || CASE WHEN w.n_groups > 0 OR w.n_ext_nostats > 0 THEN 'group' ELSE 'none' END,
         '-- (statement 2 below may override COLUMN_CHANGE and COLUMN_USAGE from the column usage report, statement 3 SYNOPSES from the synopsis table)'
       ));

-- ====================================================================== 1b. the high-frequency statistics task (global preferences; skipped on error)
-- Own statement: a release that lacks one of these preferences loses only these three lines. ON or OFF, seconds, seconds.
SELECT column_value AS line
FROM   TABLE(sys.odcivarchar2list(
         'AUTO_TASK_STATUS = ' || DBMS_STATS.GET_PREFS('AUTO_TASK_STATUS'),
         'AUTO_TASK_INTERVAL = ' || DBMS_STATS.GET_PREFS('AUTO_TASK_INTERVAL'),
         'AUTO_TASK_MAX_RUN_TIME = ' || DBMS_STATS.GET_PREFS('AUTO_TASK_MAX_RUN_TIME')
       ));

-- ====================================================================== 2. column usage (needs REPORT_COL_USAGE; skipped on error)
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), r AS (
  SELECT p.own, p.tab, DBMS_STATS.REPORT_COL_USAGE(p.own, p.tab) AS rep FROM p
), u AS (
  SELECT r.own, r.tab,
         DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+(\S+)\s*:', 1, LEVEL, 'm', 1), 128, 1) AS col
  FROM   r
  CONNECT BY LEVEL <= REGEXP_COUNT(r.rep, '^\s*\d+\.\s+\S+\s*:', 1, 'm')
), g AS (
  -- an extension some unlocked partition lacks statistics for, or one without global statistics: COLUMN_CHANGE stays group
  SELECT COUNT(*) AS n_groups
  FROM   p, dba_stat_extensions e
  WHERE  e.owner = p.own AND e.table_name = p.tab
  AND   (EXISTS (SELECT 1 FROM dba_tab_statistics s
                 WHERE  s.owner = e.owner AND s.table_name = e.table_name AND s.object_type = 'PARTITION'
                 AND    s.last_analyzed IS NOT NULL AND s.stattype_locked IS NULL
                 AND    NOT EXISTS (SELECT 1 FROM dba_part_col_statistics pc
                                    WHERE  pc.owner = s.owner AND pc.table_name = s.table_name
                                    AND    pc.partition_name = s.partition_name AND pc.column_name = e.extension_name
                                    AND    pc.last_analyzed IS NOT NULL))
         OR NOT EXISTS (SELECT 1 FROM dba_tab_col_statistics c
                        WHERE  c.owner = e.owner AND c.table_name = e.table_name AND c.column_name = e.extension_name
                        AND    c.last_analyzed IS NOT NULL))
), x AS (
  SELECT COUNT(u.col) AS n_used,
         LISTAGG(CASE WHEN NVL(c.histogram, 'NONE') = 'NONE'
                      AND NOT (c.num_distinct IS NOT NULL AND t.num_rows IS NOT NULL AND c.num_distinct >= t.num_rows)
                      THEN u.col END, ',') WITHIN GROUP (ORDER BY u.col) AS candidates
  FROM   u
         JOIN dba_tab_col_statistics c ON c.owner = u.own AND c.table_name = u.tab AND c.column_name = u.col
         LEFT JOIN dba_tab_statistics t ON t.owner = u.own AND t.table_name = u.tab AND t.object_type = 'TABLE'
)
SELECT column_value AS line
FROM   x, g,
       TABLE(sys.odcivarchar2list(
         'COLUMN_USAGE = ' || CASE WHEN x.n_used > 0 THEN '1' ELSE '0' END,
         CASE WHEN g.n_groups = 0 AND x.candidates IS NOT NULL THEN 'COLUMN_CHANGE = usage' ELSE '-- COLUMN_CHANGE: unchanged by the column usage report' END,
         '-- columns used in predicates without a histogram: ' || NVL(x.candidates, '(none)')
       ));

-- ====================================================================== 3. synopses in step with the statistics? (reads SYS.WRI$_OPTSTAT_SYNOPSIS_HEAD$; skipped on error)
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), s AS (
  SELECT s.last_analyzed,
         CASE WHEN t.stattype_locked IS NULL AND s.stattype_locked IS NOT NULL THEN 1 ELSE 0 END AS is_locked,
         (SELECT MAX(h.analyzetime)
          FROM   sys.wri$_optstat_synopsis_head$ h, dba_objects o
          WHERE  o.owner = s.owner AND o.object_name = s.table_name AND o.subobject_name = s.partition_name
          AND    o.object_type = 'TABLE PARTITION' AND h.group# = o.object_id * 2) AS syn_time
  FROM   p
         JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'PARTITION'
         LEFT JOIN dba_tab_statistics t ON t.owner = p.own AND t.table_name = p.tab AND t.object_type = 'TABLE'
), x AS (
  SELECT COUNT(syn_time) AS n_syn,
         SUM(CASE WHEN is_locked = 0 AND last_analyzed IS NOT NULL AND (syn_time IS NULL OR syn_time < last_analyzed - 1/1440) THEN 1 ELSE 0 END) AS n_behind
  FROM   s
)
SELECT column_value AS line
FROM   x,
       TABLE(sys.odcivarchar2list(
         'SYNOPSES = ' || CASE WHEN NVL(x.n_syn, 0) = 0 THEN 'none' WHEN NVL(x.n_behind, 0) = 0 THEN 'all' ELSE 'stale' END,
         '-- from the synopsis table: ' || TO_CHAR(NVL(x.n_syn, 0)) || ' partition(s) with a synopsis, '
           || TO_CHAR(NVL(x.n_behind, 0)) || ' unlocked partition(s) analysed after their synopsis'
       ));

-- ====================================================================== 4. column sets the optimizer asked for: SQL plan directives (DBA views only)
-- A DYNAMIC_SAMPLING directive on two or more columns of the table records a cardinality misestimate
-- on them together. Its TABLE row says whether the predicates were all equalities: only then does a
-- column group help (the optimizer uses column group statistics for equality predicates, in-lists and
-- GROUP BY). Sets already covered by an extension are left out.
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), n AS (
  SELECT LEVEL AS i FROM dual CONNECT BY LEVEL <= 32
), ext AS (
  SELECT e.extension_name, DBMS_LOB.SUBSTR(e.extension, 4000, 1) AS txt
  FROM   p, dba_stat_extensions e
  WHERE  e.owner = p.own AND e.table_name = p.tab AND DBMS_LOB.SUBSTR(e.extension, 1, 1) = '('
), extset AS (
  SELECT ext.extension_name,
         LISTAGG(REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1), ',')
           WITHIN GROUP (ORDER BY REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1)) AS cols
  FROM   ext, n
  WHERE  n.i <= REGEXP_COUNT(ext.txt, '"[^"]+"')
  GROUP  BY ext.extension_name
), dcols AS (
  SELECT d.directive_id, o.subobject_name AS col, c.num_distinct
  FROM   p, dba_sql_plan_directives d
         JOIN dba_sql_plan_dir_objects o ON o.directive_id = d.directive_id
         LEFT JOIN dba_tab_col_statistics c ON c.owner = o.owner AND c.table_name = o.object_name AND c.column_name = o.subobject_name
  WHERE  o.owner = p.own AND o.object_name = p.tab AND o.object_type = 'COLUMN'
  AND    d.type = 'DYNAMIC_SAMPLING' AND d.state = 'USABLE'
), dsets AS (
  SELECT dc.directive_id,
         LISTAGG(dc.col, ',') WITHIN GROUP (ORDER BY dc.col) AS cols,
         COUNT(*) AS n_cols,
         ROUND(EXP(SUM(LN(GREATEST(NVL(dc.num_distinct, 1), 1))))) AS ndv_product,
         (SELECT MAX(CASE WHEN EXTRACTVALUE(o.notes, '/obj_note/equality_predicates_only') = 'NO' THEN 'range' ELSE 'eq' END)
          FROM   p, dba_sql_plan_dir_objects o
          WHERE  o.directive_id = dc.directive_id AND o.owner = p.own AND o.object_name = p.tab AND o.object_type = 'TABLE') AS kind
  FROM   dcols dc
  GROUP  BY dc.directive_id
), cand AS (
  SELECT ds.cols, MIN(NVL(ds.kind, 'eq')) AS kind, MIN(ds.ndv_product) AS ndv_product
  FROM   dsets ds
  WHERE  ds.n_cols >= 2 AND NOT EXISTS (SELECT 1 FROM extset x WHERE x.cols = ds.cols)
  GROUP  BY ds.cols
), x AS (
  SELECT SUM(CASE WHEN kind = 'eq' THEN 1 ELSE 0 END) AS n_eq,
         LISTAGG(cols || '|directive|' || kind || '|' || TO_CHAR(ndv_product), '; ' ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY kind, cols) AS list
  FROM   cand
)
SELECT column_value AS line
FROM   x,
       TABLE(sys.odcivarchar2list(
         'COLUMN_GROUP_CANDIDATES = ' || TO_CHAR(NVL(x.n_eq, 0)),
         'COLUMN_GROUP_CANDIDATE_LIST = ' || x.list,
         '-- column sets a SQL plan directive misestimated, without a column group: eq = equality predicates only (a group helps), range = not (it does not); the number is the product of the members'' NDVs'
       ));

-- ====================================================================== 5. column sets SEED_COL_USAGE recorded (REPORT_COL_USAGE; skipped on error)
-- REPORT_COL_USAGE lists a group line "(A, B) : FILTER" for columns filtered together while
-- DBMS_STATS.SEED_COL_USAGE was monitoring. Sets already covered by an extension are left out.
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), n AS (
  SELECT LEVEL AS i FROM dual CONNECT BY LEVEL <= 32
), ext AS (
  SELECT e.extension_name, DBMS_LOB.SUBSTR(e.extension, 4000, 1) AS txt
  FROM   p, dba_stat_extensions e
  WHERE  e.owner = p.own AND e.table_name = p.tab AND DBMS_LOB.SUBSTR(e.extension, 1, 1) = '('
), extset AS (
  SELECT ext.extension_name,
         LISTAGG(REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1), ',')
           WITHIN GROUP (ORDER BY REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1)) AS cols
  FROM   ext, n
  WHERE  n.i <= REGEXP_COUNT(ext.txt, '"[^"]+"')
  GROUP  BY ext.extension_name
), r AS (
  SELECT p.own, p.tab, DBMS_STATS.REPORT_COL_USAGE(p.own, p.tab) AS rep FROM p
), g AS (
  SELECT LEVEL AS gi,
         REGEXP_REPLACE(DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+\(([^)]*)\)', 1, LEVEL, 'm', 1), 4000, 1), '\s', '') AS txt
  FROM   r
  CONNECT BY LEVEL <= REGEXP_COUNT(r.rep, '^\s*\d+\.\s+\(', 1, 'm')
), gcols AS (
  SELECT g.gi, REGEXP_SUBSTR(g.txt, '[^,]+', 1, n.i) AS col
  FROM   g, n
  WHERE  n.i <= REGEXP_COUNT(g.txt, '[^,]+')
), gsets AS (
  SELECT gc.gi,
         LISTAGG(gc.col, ',') WITHIN GROUP (ORDER BY gc.col) AS cols,
         ROUND(EXP(SUM(LN(GREATEST(NVL(c.num_distinct, 1), 1))))) AS ndv_product
  FROM   gcols gc
         CROSS JOIN p
         LEFT JOIN dba_tab_col_statistics c ON c.owner = p.own AND c.table_name = p.tab AND c.column_name = gc.col
  GROUP  BY gc.gi
), cand AS (
  SELECT gs.cols, MIN(gs.ndv_product) AS ndv_product
  FROM   gsets gs
  WHERE  NOT EXISTS (SELECT 1 FROM extset x WHERE x.cols = gs.cols)
  GROUP  BY gs.cols
), x AS (
  SELECT COUNT(*) AS n_usage,
         LISTAGG(cols || '|usage|eq|' || TO_CHAR(ndv_product), '; ' ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY cols) AS list
  FROM   cand
)
SELECT column_value AS line
FROM   x,
       TABLE(sys.odcivarchar2list(
         'COLUMN_GROUP_USAGE_LIST = ' || x.list,
         '-- column sets SEED_COL_USAGE recorded without a column group (' || TO_CHAR(x.n_usage) || '); the paste box adds them to the candidates'
       ));

-- ====================================================================== 6. end of the advisor input
SELECT '-- ADVISOR INPUT END' AS line FROM dual;

-- ====================================================================== 7. the detail block: header (ADVISOR DETAIL BEGIN ... END)
-- Records for the health check: one KEY = value line per scalar, one KIND = f1|f2|... line per row.
-- Every statement below is pure SQL and stands alone: one that fails (a privilege, a view this release
-- lacks) prints its error and nothing else, and the page treats those records as not collected.
-- Field text has | replaced by / and line breaks by a space; dates are YYYY-MM-DD HH24:MI:SS; flags Y/N.
SELECT column_value AS line
FROM   TABLE(sys.odcivarchar2list(
         '-- ADVISOR DETAIL BEGIN',
         'DETAIL_VERSION = 1',
         'COLLECTED_AT = ' || TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
       ));

-- ====================================================================== 8. instance scalars (V$ views; skipped on error)
WITH x AS (
  SELECT (SELECT version_full FROM v$instance)                                                              AS ver,
         (SELECT UPPER(value) FROM v$parameter WHERE name = 'optimizer_use_pending_statistics')            AS use_pending,
         (SELECT UPPER(value) FROM v$parameter WHERE name = 'optimizer_real_time_statistics')               AS realtime,
         (SELECT UPPER(value) FROM v$parameter WHERE name = 'optimizer_adaptive_statistics')                AS adaptive,
         (SELECT TO_CHAR(ROUND(space_usage_kbytes / 1024, 1), 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')
          FROM   v$sysaux_occupants WHERE occupant_name = 'SM/OPTSTAT')                                    AS optstat_mb
  FROM   dual
)
SELECT column_value AS line
FROM   x,
       TABLE(sys.odcivarchar2list(
         'DB_VERSION = ' || x.ver,
         'OPTIMIZER_USE_PENDING_STATISTICS = ' || x.use_pending,
         'REALTIME_STATS_PARAM = ' || x.realtime,
         'OPTIMIZER_ADAPTIVE_STATISTICS = ' || x.adaptive,
         'SYSAUX_OPTSTAT_MB = ' || x.optstat_mb
       ));

-- ====================================================================== 9. the table's own statistics and DML counters
-- LAST_ANALYZED, STALE_STATS: the TABLE row of DBA_TAB_STATISTICS. MODS_TIMESTAMP, ROWS_CHANGED, ROWS_TRUNCATED:
-- the table row of DBA_TAB_MODIFICATIONS (no row = no DML since the last gather: 0 and N).
-- STATS_ON_LOAD, REALTIME_STATS_NOTES: NOTES of the table, partition and column statistics.
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), ts AS (
  SELECT s.last_analyzed, s.stale_stats
  FROM   p JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'TABLE'
), md AS (
  -- the table's roll-up row; the partitions' own changes (a composite table's subpartition rows counted only after the
  -- partition's LAST_ANALYZED) stand in when there is none
  SELECT COALESCE((SELECT MAX(m.timestamp) FROM dba_tab_modifications m WHERE m.table_owner = p.own AND m.table_name = p.tab AND m.partition_name IS NULL),
                  (SELECT MAX(m.timestamp) FROM dba_tab_modifications m WHERE m.table_owner = p.own AND m.table_name = p.tab)) AS ts,
         NVL((SELECT SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)) FROM dba_tab_modifications m
              WHERE  m.table_owner = p.own AND m.table_name = p.tab AND m.partition_name IS NULL),
             (SELECT SUM(NVL((SELECT SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)) FROM dba_tab_modifications m
              WHERE  m.table_owner = s.owner AND m.table_name = s.table_name AND m.partition_name = s.partition_name AND m.subpartition_name IS NULL),
             (SELECT SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)) FROM dba_tab_modifications m
              WHERE  m.table_owner = s.owner AND m.table_name = s.table_name AND m.partition_name = s.partition_name AND m.subpartition_name IS NOT NULL
              AND    (s.last_analyzed IS NULL OR m.timestamp > s.last_analyzed))))
              FROM   dba_tab_statistics s WHERE s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'PARTITION')) AS chg,
         (SELECT MAX(m.truncated) FROM dba_tab_modifications m WHERE m.table_owner = p.own AND m.table_name = p.tab AND m.partition_name IS NULL) AS truncated
  FROM   p
), nt AS (
  SELECT CASE WHEN EXISTS (SELECT 1 FROM p JOIN dba_tab_col_statistics c ON c.owner = p.own AND c.table_name = p.tab WHERE c.notes LIKE '%STATS_ON_LOAD%')
                OR EXISTS (SELECT 1 FROM p JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab WHERE s.notes LIKE '%STATS_ON_LOAD%')
              THEN 'Y' ELSE 'N' END AS on_load,
         CASE WHEN EXISTS (SELECT 1 FROM p JOIN dba_tab_col_statistics c ON c.owner = p.own AND c.table_name = p.tab WHERE c.notes LIKE '%STATS_ON_CONVENTIONAL_DML%')
                OR EXISTS (SELECT 1 FROM p JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab WHERE s.notes LIKE '%STATS_ON_CONVENTIONAL_DML%')
              THEN 'Y' ELSE 'N' END AS rt_notes
  FROM   dual
)
SELECT column_value AS line
FROM   p
       LEFT JOIN ts ON 1 = 1
       LEFT JOIN md ON 1 = 1
       CROSS JOIN nt,
       TABLE(sys.odcivarchar2list(
         'LAST_ANALYZED = ' || TO_CHAR(ts.last_analyzed, 'YYYY-MM-DD HH24:MI:SS'),
         'MODS_TIMESTAMP = ' || TO_CHAR(md.ts, 'YYYY-MM-DD HH24:MI:SS'),
         'ROWS_CHANGED = ' || TO_CHAR(NVL(md.chg, 0)),
         'ROWS_TRUNCATED = ' || CASE WHEN md.truncated = 'YES' THEN 'Y' ELSE 'N' END,
         'STALE_STATS = ' || ts.stale_stats,
         'STATS_ON_LOAD = ' || nt.on_load,
         'REALTIME_STATS_NOTES = ' || nt.rt_notes
       ));

-- ====================================================================== 10. partitioning scalars
-- SUBPARTITIONING: NONE, HASH, LIST or RANGE for a partitioned table, empty for a plain one.
-- PARTITIONS_OMITTED replaces the PARTITION records when the table has more than 400 partitions (statement 27).
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), pt AS (
  SELECT MAX(t.subpartitioning_type) AS st
  FROM   p JOIN dba_part_tables t ON t.owner = p.own AND t.table_name = p.tab
), sp AS (
  SELECT COUNT(*) AS n, COUNT(s.last_analyzed) AS n_stats
  FROM   p JOIN dba_tab_subpartitions s ON s.table_owner = p.own AND s.table_name = p.tab
), zr AS (
  SELECT COUNT(*) AS n
  FROM   p
         JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'PARTITION'
                                  AND s.last_analyzed IS NOT NULL AND s.num_rows = 0
  WHERE  NVL((SELECT SUM(NVL(m.inserts, 0)) FROM dba_tab_modifications m
              WHERE  m.table_owner = s.owner AND m.table_name = s.table_name AND m.partition_name = s.partition_name AND m.subpartition_name IS NULL),
             (SELECT SUM(NVL(m.inserts, 0)) FROM dba_tab_modifications m
              WHERE  m.table_owner = s.owner AND m.table_name = s.table_name AND m.partition_name = s.partition_name AND m.subpartition_name IS NOT NULL
              AND    (s.last_analyzed IS NULL OR m.timestamp > s.last_analyzed))) > 0
), np AS (
  SELECT COUNT(*) AS n
  FROM   p JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'PARTITION'
)
SELECT column_value AS line
FROM   pt, sp, zr, np,
       TABLE(sys.odcivarchar2list(
         'SUBPARTITIONING = ' || pt.st,
         'SUBPARTITIONS = ' || TO_CHAR(sp.n),
         'SUBPARTITIONS_WITH_STATS = ' || TO_CHAR(sp.n_stats),
         'ZERO_ROW_PARTITIONS_WITH_DML = ' || TO_CHAR(zr.n),
         CASE WHEN np.n > 400 THEN 'PARTITIONS_OMITTED = ' || TO_CHAR(np.n)
              ELSE '-- PARTITIONS_OMITTED: not needed, ' || TO_CHAR(np.n) || ' partition(s) listed below' END
       ));

-- ====================================================================== 11. pending statistics (DBA_TAB_PENDING_STATS)
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), pd AS (
  SELECT COUNT(*) AS n, MIN(s.last_analyzed) AS since
  FROM   p JOIN dba_tab_pending_stats s ON s.owner = p.own AND s.table_name = p.tab
)
SELECT column_value AS line
FROM   pd,
       TABLE(sys.odcivarchar2list(
         'PENDING_ROWS = ' || TO_CHAR(pd.n),
         'PENDING_SINCE = ' || TO_CHAR(pd.since, 'YYYY-MM-DD HH24:MI:SS')
       ));

-- ====================================================================== 12. statistics history of this table (DBA_TAB_STATS_HISTORY; table and partition rows)
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), h AS (
  SELECT COUNT(*) AS n, MIN(h.stats_update_time) AS oldest, MAX(h.stats_update_time) AS newest
  FROM   p JOIN dba_tab_stats_history h ON h.owner = p.own AND h.table_name = p.tab
)
SELECT column_value AS line
FROM   h,
       TABLE(sys.odcivarchar2list(
         'HISTORY_ROWS = ' || TO_CHAR(h.n),
         'HISTORY_OLDEST = ' || TO_CHAR(h.oldest, 'YYYY-MM-DD HH24:MI:SS'),
         'HISTORY_NEWEST = ' || TO_CHAR(h.newest, 'YYYY-MM-DD HH24:MI:SS')
       ));

-- ====================================================================== 13. history retention (DBMS_STATS functions; skipped on error)
SELECT column_value AS line
FROM   TABLE(sys.odcivarchar2list(
         'RETENTION_DAYS = ' || TO_CHAR(DBMS_STATS.GET_STATS_HISTORY_RETENTION),
         'HISTORY_AVAILABLE_SINCE = ' || TO_CHAR(DBMS_STATS.GET_STATS_HISTORY_AVAILABILITY, 'YYYY-MM-DD HH24:MI:SS')
       ));

-- ====================================================================== 14. preferences that are not per-table (DBMS_STATS.GET_PREFS; skipped on error)
-- AUTO_TASK_* describe the high-frequency task and are global preferences; AUTOSTATS_TARGET too;
-- TABLE_CACHED_BLOCKS is the value in force for this table.
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
)
SELECT column_value AS line
FROM   p,
       TABLE(sys.odcivarchar2list(
         'AUTO_TASK_STATUS = ' || DBMS_STATS.GET_PREFS('AUTO_TASK_STATUS'),
         'AUTO_TASK_INTERVAL = ' || DBMS_STATS.GET_PREFS('AUTO_TASK_INTERVAL'),
         'AUTO_TASK_MAX_RUN_TIME = ' || DBMS_STATS.GET_PREFS('AUTO_TASK_MAX_RUN_TIME'),
         'AUTOSTATS_TARGET = ' || DBMS_STATS.GET_PREFS('AUTOSTATS_TARGET'),
         'TABLE_CACHED_BLOCKS = ' || DBMS_STATS.GET_PREFS('TABLE_CACHED_BLOCKS', p.own, p.tab)
       ));

-- ====================================================================== 15. the nightly task (DBA_AUTOTASK_CLIENT)
SELECT 'AUTOTASK_STATUS = ' || c.status AS line
FROM   dba_autotask_client c
WHERE  c.client_name = 'auto optimizer stats collection';

-- ====================================================================== 16. columns that identify a row
-- UNIQUE_COLUMNS: visible columns that alone make up a unique index or an enabled unique/primary key constraint.
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), uc AS (
  SELECT ic.column_name
  FROM   p
         JOIN dba_indexes i ON i.table_owner = p.own AND i.table_name = p.tab AND i.uniqueness = 'UNIQUE' AND i.index_type <> 'LOB'
         JOIN dba_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
  WHERE  (SELECT COUNT(*) FROM dba_ind_columns x WHERE x.index_owner = i.owner AND x.index_name = i.index_name) = 1
  UNION
  SELECT cc.column_name
  FROM   p
         JOIN dba_constraints c ON c.owner = p.own AND c.table_name = p.tab AND c.constraint_type IN ('P', 'U') AND c.status = 'ENABLED'
         JOIN dba_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
  WHERE  (SELECT COUNT(*) FROM dba_cons_columns x WHERE x.owner = c.owner AND x.constraint_name = c.constraint_name) = 1
), vis AS (
  SELECT uc.column_name
  FROM   uc, p, dba_tab_cols t
  WHERE  t.owner = p.own AND t.table_name = p.tab AND t.column_name = uc.column_name AND t.hidden_column = 'NO'
)
SELECT 'UNIQUE_COLUMNS = ' || LISTAGG(vis.column_name, ',' ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY vis.column_name) AS line
FROM   vis;

-- ====================================================================== 17. function-based index expressions
-- DBA_IND_EXPRESSIONS.COLUMN_EXPRESSION is a LONG, which SQL cannot read; DBMS_XMLGEN turns it into text
-- (the XML generator reads the LONG itself). Such an expression already has a hidden virtual column and
-- column statistics, so no extension is needed for it.
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), q AS (
  SELECT DBMS_XMLGEN.GETXMLTYPE('SELECT column_expression FROM dba_ind_expressions WHERE table_owner = '''
           || REPLACE(p.own, '''', '''''') || ''' AND table_name = ''' || REPLACE(p.tab, '''', '''''') || '''') AS x
  FROM   p
), ex AS (
  SELECT DISTINCT REGEXP_REPLACE(TRANSLATE(t.expr, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), '\s+', ' ') AS expr
  FROM   q, XMLTABLE('/ROWSET/ROW' PASSING q.x COLUMNS expr VARCHAR2(4000) PATH 'COLUMN_EXPRESSION') t
)
SELECT 'FBI_EXPRESSIONS = ' || LISTAGG(ex.expr, ';' ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY ex.expr) AS line
FROM   ex;

-- ====================================================================== 18. expression candidates (V$SQL_PLAN; skipped on error)
-- Function calls wrapped around a column of this table in the predicates of cached plans of the table and
-- its indexes. Heuristic: a cached plan is weak evidence, nesting is followed one level deep, binds are
-- skipped, a table alias is dropped, INTERNAL_FUNCTION (an implicit conversion the plan adds) is unwrapped.
-- Left out: expressions that already have an extension or a function-based index (compared after removing
-- blanks and double quotes). At most 20.
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), cols AS (
  SELECT c.column_name
  FROM   p JOIN dba_tab_cols c ON c.owner = p.own AND c.table_name = p.tab AND c.hidden_column = 'NO'
), pl AS (
  SELECT sp.access_predicates AS a, sp.filter_predicates AS f
  FROM   v$sql_plan sp
  WHERE  (sp.object_owner, sp.object_name) IN (SELECT p.own, p.tab FROM p
                                               UNION ALL
                                               SELECT i.owner, i.index_name FROM p JOIN dba_indexes i ON i.table_owner = p.own AND i.table_name = p.tab)
), pr AS (
  SELECT a AS t FROM pl WHERE a IS NOT NULL
  UNION
  SELECT f FROM pl WHERE f IS NOT NULL
), n AS (
  SELECT LEVEL AS i FROM dual CONNECT BY LEVEL <= 8
), fx AS (
  SELECT DISTINCT REGEXP_SUBSTR(pr.t, '(^|[^A-Z0-9_$#"])((UPPER|LOWER|TRUNC|SUBSTR|TO_CHAR|TO_NUMBER|TO_DATE|NVL|COALESCE|ROUND|EXTRACT|CAST|INSTR|LENGTH|LTRIM|RTRIM|TRIM|REPLACE|FLOOR|CEIL|ABS|MOD)\(([^()]|\([^()]*\))*\))', 1, n.i, 'i', 2) AS e
  FROM   pr, n
  WHERE  n.i <= REGEXP_COUNT(pr.t, '(^|[^A-Z0-9_$#"])((UPPER|LOWER|TRUNC|SUBSTR|TO_CHAR|TO_NUMBER|TO_DATE|NVL|COALESCE|ROUND|EXTRACT|CAST|INSTR|LENGTH|LTRIM|RTRIM|TRIM|REPLACE|FLOOR|CEIL|ABS|MOD)\(([^()]|\([^()]*\))*\))', 1, 'i')
), cn AS (
  SELECT DISTINCT REGEXP_REPLACE(REGEXP_REPLACE(fx.e, 'INTERNAL_FUNCTION\(([^()]*)\)', '\1'), '"[^"]+"\."', '"') AS e
  FROM   fx
  WHERE  fx.e IS NOT NULL AND INSTR(fx.e, ':') = 0
), q AS (
  SELECT DBMS_XMLGEN.GETXMLTYPE('SELECT column_expression FROM dba_ind_expressions WHERE table_owner = '''
           || REPLACE(p.own, '''', '''''') || ''' AND table_name = ''' || REPLACE(p.tab, '''', '''''') || '''') AS x
  FROM   p
), have AS (
  SELECT REPLACE(REPLACE(UPPER(DBMS_LOB.SUBSTR(e.extension, 4000, 1)), ' ', ''), '"', '') AS t
  FROM   p JOIN dba_stat_extensions e ON e.owner = p.own AND e.table_name = p.tab
  UNION ALL
  SELECT REPLACE(REPLACE(UPPER(t.expr), ' ', ''), '"', '')
  FROM   q, XMLTABLE('/ROWSET/ROW' PASSING q.x COLUMNS expr VARCHAR2(4000) PATH 'COLUMN_EXPRESSION') t
), have1 AS (
  SELECT CASE WHEN SUBSTR(t, 1, 1) = '(' AND SUBSTR(t, -1) = ')' THEN SUBSTR(t, 2, LENGTH(t) - 2) ELSE t END AS t FROM have
), ok AS (
  SELECT cn.e, ROW_NUMBER() OVER (ORDER BY cn.e) AS rn
  FROM   cn
  WHERE  EXISTS (SELECT 1 FROM cols WHERE INSTR(cn.e, '"' || cols.column_name || '"') > 0)
  AND    NOT EXISTS (SELECT 1 FROM have1 WHERE have1.t = REPLACE(REPLACE(UPPER(cn.e), ' ', ''), '"', ''))
)
SELECT 'EXPRESSION_CANDIDATES = ' || LISTAGG(ok.e, ';' ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY ok.e) AS line
FROM   ok
WHERE  ok.rn <= 20;

-- ====================================================================== 19. is the column usage report readable? (REPORT_COL_USAGE; skipped on error)
-- The report is a CLOB the COLUMN and EXTENSION statements read again. A failing call cannot be caught in
-- pure SQL, so this statement tries it once and hands the answer to SQL*Plus: adv_usage_ok stays N when the call
-- raises an error, and also when it returns an error text (a missing table or privilege comes back as "ORA-20000: ..."
-- in the report, checked on 19.27) instead of a report; the statements below then print an empty usage.
COLUMN adv_ok NEW_VALUE adv_usage_ok NOPRINT
SELECT CASE WHEN DBMS_LOB.INSTR(DBMS_STATS.REPORT_COL_USAGE(UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))),
                                                              UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table')))), 'COLUMN USAGE REPORT FOR') > 0 THEN 'Y' ELSE 'N' END AS adv_ok
FROM   dual;
COLUMN adv_ok CLEAR
SELECT 'COLUMN_USAGE_COLLECTED = &adv_usage_ok' AS line FROM dual;

-- ====================================================================== 20. COLUMN records: one row per visible column and per extension
-- COLUMN = name|data_type|nullable|num_distinct|num_nulls|num_buckets|histogram|sample_size|density|avg_col_len|last_analyzed|notes|low|high|usage|in_index
-- Statistics are the global row of DBA_TAB_COL_STATISTICS. low/high are decoded from the RAW: NUMBER and FLOAT with
-- UTL_RAW.CAST_TO_NUMBER; DATE and TIMESTAMP from the first 7 bytes (year = (b1-100)*100 + (b2-100), month b3, day b4,
-- hour b5-1, minute b6-1, second b7-1); VARCHAR2 and CHAR as text (30 characters); empty for other types and for column groups.
-- usage: the flags of the REPORT_COL_USAGE line (EQ_JOIN and NONEQ_JOIN are written EQUIJOIN and NONEQUIJOIN), / between.
-- in_index: Y when the column is the leading column of an index (LOB indexes left out).
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
)
, n AS (
  SELECT LEVEL AS i FROM dual CONNECT BY LEVEL <= 32
), r AS (
  SELECT /*+ MATERIALIZE */ CASE WHEN '&adv_usage_ok' = 'Y' THEN DBMS_STATS.REPORT_COL_USAGE(p.own, p.tab) END AS rep FROM p
), ul AS (
  -- single-column lines of the report: "3. COL_NAME : EQ RANGE"
  SELECT DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+(\S+)\s*:', 1, LEVEL, 'm', 1), 128, 1) AS col,
         DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+\S+\s*:(.*)$', 1, LEVEL, 'm', 1), 200, 1) AS flags
  FROM   r
  CONNECT BY LEVEL <= REGEXP_COUNT(r.rep, '^\s*\d+\.\s+\S+\s*:', 1, 'm')
), gl AS (
  -- column group lines: "6. (CITY, COUNTRY) : FILTER"
  SELECT REGEXP_REPLACE(DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+\(([^)]*)\)\s*:', 1, LEVEL, 'm', 1), 4000, 1), '\s', '') AS txt,
         DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+\([^)]*\)\s*:(.*)$', 1, LEVEL, 'm', 1), 200, 1) AS flags
  FROM   r
  CONNECT BY LEVEL <= REGEXP_COUNT(r.rep, '^\s*\d+\.\s+\(', 1, 'm')
), gs AS (
  SELECT gl.flags,
         (SELECT LISTAGG(REGEXP_SUBSTR(gl.txt, '[^,]+', 1, n.i), ',') WITHIN GROUP (ORDER BY REGEXP_SUBSTR(gl.txt, '[^,]+', 1, n.i))
          FROM   n WHERE n.i <= REGEXP_COUNT(gl.txt, '[^,]+')) AS cols
  FROM   gl
), ext AS (
  SELECT e.extension_name AS nm, DBMS_LOB.SUBSTR(e.extension, 4000, 1) AS txt
  FROM   p JOIN dba_stat_extensions e ON e.owner = p.own AND e.table_name = p.tab
), exs AS (
  -- a group lists two or more columns and nothing else; any other extension is an expression
  SELECT ext.nm, ext.txt,
         CASE WHEN REGEXP_LIKE(ext.txt, '^\(\s*"[^"]+"(\s*,\s*"[^"]+")+\s*\)$') THEN 'group' ELSE 'expression' END AS kind,
         (SELECT LISTAGG(REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1), ',') WITHIN GROUP (ORDER BY REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1))
          FROM   n WHERE n.i <= REGEXP_COUNT(ext.txt, '"[^"]+"')) AS cols
  FROM   ext
), ucol AS (
  -- the usage flags per name: a column or an expression extension by name, a group extension by its column set
  SELECT ul.col AS nm, ul.flags FROM ul
  UNION ALL
  SELECT exs.nm, gs.flags FROM exs JOIN gs ON gs.cols = exs.cols WHERE exs.kind = 'group'
)
SELECT 'COLUMN = ' || c.column_name
       || '|' || CASE WHEN e.nm IS NULL THEN SUBSTR(TRANSLATE(c.data_type, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 106) END
       || '|' || c.nullable
       || '|' || TO_CHAR(s.num_distinct)
       || '|' || TO_CHAR(s.num_nulls)
       || '|' || TO_CHAR(s.num_buckets)
       || '|' || s.histogram
       || '|' || TO_CHAR(s.sample_size)
       || '|' || TO_CHAR(s.density, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')
       || '|' || TO_CHAR(s.avg_col_len)
       || '|' || TO_CHAR(s.last_analyzed, 'YYYY-MM-DD HH24:MI:SS')
       || '|' || TRIM(SUBSTR(TRANSLATE(s.notes, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 200))
       || '|' || CASE WHEN e.kind = 'group' THEN NULL ELSE SUBSTR(TRANSLATE(CASE
                 WHEN c.data_type IN ('NUMBER', 'FLOAT') THEN TO_CHAR(UTL_RAW.CAST_TO_NUMBER(s.low_value), 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')
                 WHEN (c.data_type = 'DATE' OR c.data_type LIKE 'TIMESTAMP%') AND LENGTH(s.low_value) >= 7 THEN
                      TO_CHAR((TO_NUMBER(SUBSTR(RAWTOHEX(s.low_value), 1, 2), 'XX') - 100) * 100 + (TO_NUMBER(SUBSTR(RAWTOHEX(s.low_value), 3, 2), 'XX') - 100), 'FM0000') || '-' || TO_CHAR(TO_NUMBER(SUBSTR(RAWTOHEX(s.low_value), 5, 2), 'XX'), 'FM00') || '-' || TO_CHAR(TO_NUMBER(SUBSTR(RAWTOHEX(s.low_value), 7, 2), 'XX'), 'FM00') || ' '
                      || TO_CHAR(TO_NUMBER(SUBSTR(RAWTOHEX(s.low_value), 9, 2), 'XX') - 1, 'FM00') || ':' || TO_CHAR(TO_NUMBER(SUBSTR(RAWTOHEX(s.low_value), 11, 2), 'XX') - 1, 'FM00') || ':' || TO_CHAR(TO_NUMBER(SUBSTR(RAWTOHEX(s.low_value), 13, 2), 'XX') - 1, 'FM00')
                 WHEN c.data_type IN ('VARCHAR2', 'CHAR') THEN
                      REGEXP_REPLACE(REPLACE(SUBSTR(UTL_RAW.CAST_TO_VARCHAR2(s.low_value), 1, 30), '|', '/'), '[[:cntrl:]]', ' ')
               END, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 200) END
       || '|' || CASE WHEN e.kind = 'group' THEN NULL ELSE SUBSTR(TRANSLATE(CASE
                 WHEN c.data_type IN ('NUMBER', 'FLOAT') THEN TO_CHAR(UTL_RAW.CAST_TO_NUMBER(s.high_value), 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')
                 WHEN (c.data_type = 'DATE' OR c.data_type LIKE 'TIMESTAMP%') AND LENGTH(s.high_value) >= 7 THEN
                      TO_CHAR((TO_NUMBER(SUBSTR(RAWTOHEX(s.high_value), 1, 2), 'XX') - 100) * 100 + (TO_NUMBER(SUBSTR(RAWTOHEX(s.high_value), 3, 2), 'XX') - 100), 'FM0000') || '-' || TO_CHAR(TO_NUMBER(SUBSTR(RAWTOHEX(s.high_value), 5, 2), 'XX'), 'FM00') || '-' || TO_CHAR(TO_NUMBER(SUBSTR(RAWTOHEX(s.high_value), 7, 2), 'XX'), 'FM00') || ' '
                      || TO_CHAR(TO_NUMBER(SUBSTR(RAWTOHEX(s.high_value), 9, 2), 'XX') - 1, 'FM00') || ':' || TO_CHAR(TO_NUMBER(SUBSTR(RAWTOHEX(s.high_value), 11, 2), 'XX') - 1, 'FM00') || ':' || TO_CHAR(TO_NUMBER(SUBSTR(RAWTOHEX(s.high_value), 13, 2), 'XX') - 1, 'FM00')
                 WHEN c.data_type IN ('VARCHAR2', 'CHAR') THEN
                      REGEXP_REPLACE(REPLACE(SUBSTR(UTL_RAW.CAST_TO_VARCHAR2(s.high_value), 1, 30), '|', '/'), '[[:cntrl:]]', ' ')
               END, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 200) END
       || '|' || REPLACE(REPLACE(REGEXP_REPLACE(TRIM(u.flags), '\s+', '/'), 'NONEQ_JOIN', 'NONEQUIJOIN'), 'EQ_JOIN', 'EQUIJOIN')
       || '|' || CASE WHEN e.nm IS NOT NULL THEN 'N'
                      WHEN EXISTS (SELECT 1 FROM dba_ind_columns ic JOIN dba_indexes i ON i.owner = ic.index_owner AND i.index_name = ic.index_name
                                   WHERE  ic.table_owner = c.owner AND ic.table_name = c.table_name AND ic.column_name = c.column_name
                                   AND    ic.column_position = 1 AND i.index_type <> 'LOB') THEN 'Y' ELSE 'N' END AS line
FROM   p
       JOIN dba_tab_cols c ON c.owner = p.own AND c.table_name = p.tab AND (c.hidden_column = 'NO' OR c.column_name IN (SELECT nm FROM ext))
       LEFT JOIN exs e ON e.nm = c.column_name
       LEFT JOIN dba_tab_col_statistics s ON s.owner = c.owner AND s.table_name = c.table_name AND s.column_name = c.column_name
       LEFT JOIN ucol u ON u.nm = c.column_name
ORDER  BY c.internal_column_id;

-- ====================================================================== 21. INDEX records: the table's indexes (LOB indexes left out)
-- INDEX = name|uniqueness|index_type|partitioned|locality|columns|blevel|leaf_blocks|distinct_keys|clustering_factor|num_rows|last_analyzed|stale_stats|locked|status|visibility|total_access_count|total_exec_count|last_used
-- DBA_INDEXES carries the index-level statistics, DBA_IND_STATISTICS the stale and locked flags, DBA_PART_INDEXES the
-- locality, DBA_INDEX_USAGE the access counts (no row = never seen in use, or the sample missed it: empty).
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
)
SELECT 'INDEX = ' || i.index_name
       || '|' || i.uniqueness
       || '|' || i.index_type
       || '|' || CASE WHEN i.partitioned = 'YES' THEN 'Y' ELSE 'N' END
       || '|' || pi.locality
       || '|' || (SELECT LISTAGG(ic.column_name, ',' ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY ic.column_position)
                  FROM   dba_ind_columns ic WHERE ic.index_owner = i.owner AND ic.index_name = i.index_name)
       || '|' || TO_CHAR(i.blevel)
       || '|' || TO_CHAR(i.leaf_blocks)
       || '|' || TO_CHAR(i.distinct_keys)
       || '|' || TO_CHAR(i.clustering_factor)
       || '|' || TO_CHAR(i.num_rows)
       || '|' || TO_CHAR(i.last_analyzed, 'YYYY-MM-DD HH24:MI:SS')
       || '|' || CASE st.stale_stats WHEN 'YES' THEN 'Y' WHEN 'NO' THEN 'N' END
       || '|' || CASE WHEN st.index_name IS NULL THEN NULL WHEN st.stattype_locked IS NULL THEN 'N' ELSE 'Y' END
       || '|' || i.status
       || '|' || i.visibility
       || '|' || TO_CHAR(u.total_access_count)
       || '|' || TO_CHAR(u.total_exec_count)
       || '|' || TO_CHAR(u.last_used, 'YYYY-MM-DD HH24:MI:SS') AS line
FROM   p
       JOIN dba_indexes i ON i.table_owner = p.own AND i.table_name = p.tab AND i.index_type <> 'LOB'
       LEFT JOIN dba_part_indexes pi ON pi.owner = i.owner AND pi.index_name = i.index_name
       LEFT JOIN dba_ind_statistics st ON st.owner = i.owner AND st.index_name = i.index_name AND st.object_type = 'INDEX'
       LEFT JOIN dba_index_usage u ON u.owner = i.owner AND u.name = i.index_name
ORDER  BY i.index_name;

-- ====================================================================== 22. EXTENSION records: column groups and expression statistics
-- EXTENSION = name|extension_text|kind|has_stats|num_distinct|histogram|used
-- kind: group (two or more columns and nothing else) or expression. used: Y when REPORT_COL_USAGE listed it
-- (a group as "(A, B)" with the same columns in any order, an expression by its SYS_STU name), N when not, empty
-- when the report was not readable (statement 19).
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
)
, n AS (
  SELECT LEVEL AS i FROM dual CONNECT BY LEVEL <= 32
), r AS (
  SELECT /*+ MATERIALIZE */ CASE WHEN '&adv_usage_ok' = 'Y' THEN DBMS_STATS.REPORT_COL_USAGE(p.own, p.tab) END AS rep FROM p
), ul AS (
  -- single-column lines of the report: "3. COL_NAME : EQ RANGE"
  SELECT DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+(\S+)\s*:', 1, LEVEL, 'm', 1), 128, 1) AS col,
         DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+\S+\s*:(.*)$', 1, LEVEL, 'm', 1), 200, 1) AS flags
  FROM   r
  CONNECT BY LEVEL <= REGEXP_COUNT(r.rep, '^\s*\d+\.\s+\S+\s*:', 1, 'm')
), gl AS (
  -- column group lines: "6. (CITY, COUNTRY) : FILTER"
  SELECT REGEXP_REPLACE(DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+\(([^)]*)\)\s*:', 1, LEVEL, 'm', 1), 4000, 1), '\s', '') AS txt,
         DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+\([^)]*\)\s*:(.*)$', 1, LEVEL, 'm', 1), 200, 1) AS flags
  FROM   r
  CONNECT BY LEVEL <= REGEXP_COUNT(r.rep, '^\s*\d+\.\s+\(', 1, 'm')
), gs AS (
  SELECT gl.flags,
         (SELECT LISTAGG(REGEXP_SUBSTR(gl.txt, '[^,]+', 1, n.i), ',') WITHIN GROUP (ORDER BY REGEXP_SUBSTR(gl.txt, '[^,]+', 1, n.i))
          FROM   n WHERE n.i <= REGEXP_COUNT(gl.txt, '[^,]+')) AS cols
  FROM   gl
), ext AS (
  SELECT e.extension_name AS nm, DBMS_LOB.SUBSTR(e.extension, 4000, 1) AS txt
  FROM   p JOIN dba_stat_extensions e ON e.owner = p.own AND e.table_name = p.tab
), exs AS (
  -- a group lists two or more columns and nothing else; any other extension is an expression
  SELECT ext.nm, ext.txt,
         CASE WHEN REGEXP_LIKE(ext.txt, '^\(\s*"[^"]+"(\s*,\s*"[^"]+")+\s*\)$') THEN 'group' ELSE 'expression' END AS kind,
         (SELECT LISTAGG(REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1), ',') WITHIN GROUP (ORDER BY REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1))
          FROM   n WHERE n.i <= REGEXP_COUNT(ext.txt, '"[^"]+"')) AS cols
  FROM   ext
), ucol AS (
  -- the usage flags per name: a column or an expression extension by name, a group extension by its column set
  SELECT ul.col AS nm, ul.flags FROM ul
  UNION ALL
  SELECT exs.nm, gs.flags FROM exs JOIN gs ON gs.cols = exs.cols WHERE exs.kind = 'group'
)
SELECT 'EXTENSION = ' || e.nm
       || '|' || SUBSTR(TRANSLATE(REGEXP_REPLACE(e.txt, '\s+', ' '), '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 1000)
       || '|' || e.kind
       || '|' || CASE WHEN st.last_analyzed IS NOT NULL THEN 'Y' ELSE 'N' END
       || '|' || TO_CHAR(st.num_distinct)
       || '|' || st.histogram
       || '|' || CASE WHEN '&adv_usage_ok' <> 'Y' THEN NULL
                      WHEN EXISTS (SELECT 1 FROM ucol u WHERE u.nm = e.nm) THEN 'Y' ELSE 'N' END AS line
FROM   p
       JOIN exs e ON 1 = 1
       LEFT JOIN dba_tab_col_statistics st ON st.owner = p.own AND st.table_name = p.tab AND st.column_name = e.nm
ORDER  BY e.nm;

-- ====================================================================== 23. HISTORY records: the last 12 operations that touched the table
-- HISTORY = opid|operation|start_time|end_time|status|job_name|target_type|partitions_gathered|global_gathered|indexes_gathered|target_size|histogram_columns
-- DBA_OPTSTAT_OPERATIONS, plus DBA_OPTSTAT_OPERATION_TASKS for what a gather did to this table. TARGET is "OWNER"."TABLE" or
-- "OWNER"."TABLE"."PARTITION", quoted (checked on 19.27); NOTES of a task hold <notes><histograms>A;B;</histograms><xstats>..</xstats></notes>.
-- An operation belongs to the table when one of its tasks has the table or one of its indexes as TARGET, or when its own TARGET is
-- the table (a restore, delete, lock or import has no tasks). set_*_prefs, purge_stats, export_* and the stat-table operations are left out.
-- target_type is the scope of the call: TABLE or INDEX (its TARGET is this table or one of its indexes), SCHEMA, AUTO (the nightly
-- job), or empty. partitions_gathered counts distinct COMPLETED TABLE PARTITION task targets, global_gathered is Y when a COMPLETED
-- TABLE task has the table as target, indexes_gathered counts distinct INDEX, INDEX PARTITION and INDEX SUBPARTITION task targets;
-- the three are empty for an operation without tasks on this table. target_size is the table task's TARGET_SIZE (blocks).
-- histogram_columns is the <histograms> list of that task, with ; between.
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab,
         '"' || UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) || '"."' || UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) || '"' AS tp
  FROM   dual
), ix AS (
  SELECT '"' || i.owner || '"."' || i.index_name || '"' AS ip
  FROM   p JOIN dba_indexes i ON i.table_owner = p.own AND i.table_name = p.tab
), tk AS (
  SELECT /*+ MATERIALIZE */ t.opid, t.target, t.target_type, t.status, t.target_size, t.notes,
         CASE WHEN SUBSTR(t.target, 1, LENGTH(p.tp)) = p.tp AND (LENGTH(t.target) = LENGTH(p.tp) OR SUBSTR(t.target, LENGTH(p.tp) + 1, 1) = '.')
              THEN 'T' ELSE 'I' END AS kind
  FROM   p JOIN dba_optstat_operation_tasks t
         ON (SUBSTR(t.target, 1, LENGTH(p.tp)) = p.tp AND (LENGTH(t.target) = LENGTH(p.tp) OR SUBSTR(t.target, LENGTH(p.tp) + 1, 1) = '.'))
         OR EXISTS (SELECT 1 FROM ix WHERE SUBSTR(t.target, 1, LENGTH(ix.ip)) = ix.ip AND (LENGTH(t.target) = LENGTH(ix.ip) OR SUBSTR(t.target, LENGTH(ix.ip) + 1, 1) = '.'))
), op AS (
  SELECT o.id, o.operation, o.start_time, o.end_time, o.status, o.job_name,
         CASE WHEN SUBSTR(o.target, 1, LENGTH(p.tp)) = p.tp AND (LENGTH(o.target) = LENGTH(p.tp) OR SUBSTR(o.target, LENGTH(p.tp) + 1, 1) = '.') THEN 'TABLE'
              WHEN EXISTS (SELECT 1 FROM ix WHERE SUBSTR(o.target, 1, LENGTH(ix.ip)) = ix.ip AND (LENGTH(o.target) = LENGTH(ix.ip) OR SUBSTR(o.target, LENGTH(ix.ip) + 1, 1) = '.')) THEN 'INDEX'
              WHEN o.target = 'AUTO' THEN 'AUTO'
              WHEN o.target IS NOT NULL AND INSTR(o.target, '.') = 0 THEN 'SCHEMA'
         END AS scope
  FROM   p, dba_optstat_operations o
  WHERE  o.operation NOT IN ('set_table_prefs', 'set_schema_prefs', 'set_global_prefs', 'purge_stats', 'create_stat_table', 'drop_stat_table')
  AND    o.operation NOT LIKE 'export%'
), hit AS (
  SELECT op.*, (SELECT COUNT(*) FROM tk x WHERE x.opid = op.id) AS n_tasks, ROW_NUMBER() OVER (ORDER BY op.start_time DESC, op.id DESC) AS rn
  FROM   op
  WHERE  op.scope IN ('TABLE', 'INDEX') OR op.id IN (SELECT opid FROM tk)
)
SELECT 'HISTORY = ' || TO_CHAR(h.id)
       || '|' || SUBSTR(TRANSLATE(h.operation, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 100)
       || '|' || TO_CHAR(h.start_time, 'YYYY-MM-DD HH24:MI:SS')
       || '|' || TO_CHAR(h.end_time, 'YYYY-MM-DD HH24:MI:SS')
       || '|' || h.status
       || '|' || SUBSTR(TRANSLATE(h.job_name, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 128)
       || '|' || h.scope
       || '|' || (SELECT CASE WHEN h.n_tasks = 0 THEN NULL
                              ELSE TO_CHAR(COUNT(DISTINCT CASE WHEN t.target_type = 'TABLE PARTITION' AND t.status = 'COMPLETED' AND t.target <> p.tp THEN t.target END)) END
                  FROM   tk t WHERE t.opid = h.id AND t.kind = 'T')
       || '|' || (SELECT CASE WHEN h.n_tasks = 0 THEN NULL
                              WHEN COUNT(CASE WHEN t.target = p.tp AND t.target_type = 'TABLE' AND t.status = 'COMPLETED' THEN 1 END) > 0 THEN 'Y' ELSE 'N' END
                  FROM   tk t WHERE t.opid = h.id AND t.kind = 'T')
       || '|' || (SELECT CASE WHEN h.n_tasks = 0 THEN NULL ELSE TO_CHAR(COUNT(DISTINCT t.target)) END
                  FROM   tk t WHERE t.opid = h.id AND t.kind = 'I' AND t.target_type IN ('INDEX', 'INDEX PARTITION', 'INDEX SUBPARTITION'))
       || '|' || (SELECT TO_CHAR(MAX(t.target_size)) FROM tk t WHERE t.opid = h.id AND t.target = p.tp AND t.target_type = 'TABLE')
       || '|' || (SELECT SUBSTR(TRANSLATE(RTRIM(REGEXP_SUBSTR(MAX(t.notes), '<histograms>(.*)</histograms>', 1, 1, NULL, 1), ';'), '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 1000)
                  FROM   tk t WHERE t.opid = h.id AND t.target = p.tp) AS line
FROM   p, hit h
WHERE  h.rn <= 12
ORDER  BY h.rn;

-- ====================================================================== 24. WINDOW records: the maintenance windows that run the optimizer statistics task
-- WINDOW = name|repeat_interval|duration|enabled|next_start
-- DBA_SCHEDULER_WINDOWS joined to DBA_AUTOTASK_WINDOW_CLIENTS where OPTIMIZER_STATS = ENABLED.
SELECT 'WINDOW = ' || w.window_name
       || '|' || SUBSTR(TRANSLATE(REGEXP_REPLACE(w.repeat_interval, '\s+', ' '), '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 500)
       || '|' || REGEXP_REPLACE(TO_CHAR(w.duration), '\.\d+$', '')
       || '|' || CASE w.enabled WHEN 'TRUE' THEN 'Y' ELSE 'N' END
       || '|' || TO_CHAR(w.next_start_date, 'YYYY-MM-DD HH24:MI:SS') AS line
FROM   dba_scheduler_windows w
       JOIN dba_autotask_window_clients c ON c.window_name = w.window_name
WHERE  c.optimizer_stats = 'ENABLED'
ORDER  BY w.next_start_date;

-- ====================================================================== 25. AUTORUN records: the last 7 runs of the nightly task
-- AUTORUN = window_name|window_start|job_status|job_duration|job_info
-- DBA_AUTOTASK_JOB_HISTORY for the client 'auto optimizer stats collection', newest first.
SELECT 'AUTORUN = ' || SUBSTR(TRANSLATE(h.window_name, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 128)
       || '|' || TO_CHAR(h.window_start_time, 'YYYY-MM-DD HH24:MI:SS')
       || '|' || SUBSTR(TRANSLATE(h.job_status, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 100)
       || '|' || REGEXP_REPLACE(TO_CHAR(h.job_duration), '\.\d+$', '')
       || '|' || SUBSTR(TRANSLATE(REGEXP_REPLACE(h.job_info, '\s+', ' '), '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 500) AS line
FROM  (SELECT h.*, ROW_NUMBER() OVER (ORDER BY h.window_start_time DESC, h.job_start_time DESC) AS rn
       FROM   dba_autotask_job_history h
       WHERE  h.client_name = 'auto optimizer stats collection') h
WHERE  h.rn <= 7
ORDER  BY h.rn;

-- ====================================================================== 26. HFRUN records: the last 7 runs of the statistics task(s)
-- HFRUN = opid|start_time|end_time|status|completed|failed|timed_out|origin
-- DBA_AUTO_STAT_EXECUTIONS, newest first; origin tells the high-frequency task from the nightly one (AUTO_TASK).
SELECT 'HFRUN = ' || TO_CHAR(h.opid)
       || '|' || TO_CHAR(h.start_time, 'YYYY-MM-DD HH24:MI:SS')
       || '|' || TO_CHAR(h.end_time, 'YYYY-MM-DD HH24:MI:SS')
       || '|' || SUBSTR(TRANSLATE(h.status, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 100)
       || '|' || TO_CHAR(h.completed)
       || '|' || TO_CHAR(h.failed)
       || '|' || TO_CHAR(h.timed_out)
       || '|' || SUBSTR(TRANSLATE(h.origin, '|' || CHR(10) || CHR(13) || CHR(9), '/   '), 1, 100) AS line
FROM  (SELECT h.*, ROW_NUMBER() OVER (ORDER BY h.start_time DESC, h.opid DESC) AS rn
       FROM   dba_auto_stat_executions h) h
WHERE  h.rn <= 7
ORDER  BY h.rn;

-- ====================================================================== 27. PARTITION records (at most 400 partitions; else PARTITIONS_OMITTED in statement 10)
-- PARTITION = name|position|num_rows|blocks|last_analyzed|stale_stats|locked|rows_changed|synopsis
-- DBA_TAB_STATISTICS partition rows; rows_changed from DBA_TAB_MODIFICATIONS (none = 0); locked is the partition's own
-- STATTYPE_LOCKED (a locked table shows on every partition). synopsis from the column NOTES heuristic of the INPUT block:
-- OLD (ADAPTIVE_SAMPLING, the 11g format), HLL (HYPERLOGLOG), NONE.
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
)
, np AS (
  SELECT COUNT(*) AS n
  FROM   p JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'PARTITION'
)
SELECT 'PARTITION = ' || s.partition_name
       || '|' || TO_CHAR(s.partition_position)
       || '|' || TO_CHAR(s.num_rows)
       || '|' || TO_CHAR(s.blocks)
       || '|' || TO_CHAR(s.last_analyzed, 'YYYY-MM-DD HH24:MI:SS')
       || '|' || CASE s.stale_stats WHEN 'YES' THEN 'Y' WHEN 'NO' THEN 'N' END
       || '|' || CASE WHEN s.stattype_locked IS NULL THEN 'N' ELSE 'Y' END
       || '|' || TO_CHAR(NVL(NVL((SELECT SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)) FROM dba_tab_modifications m
                   WHERE  m.table_owner = s.owner AND m.table_name = s.table_name AND m.partition_name = s.partition_name AND m.subpartition_name IS NULL),
                  (SELECT SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)) FROM dba_tab_modifications m
                   WHERE  m.table_owner = s.owner AND m.table_name = s.table_name AND m.partition_name = s.partition_name AND m.subpartition_name IS NOT NULL
                   AND    (s.last_analyzed IS NULL OR m.timestamp > s.last_analyzed))), 0))
       || '|' || CASE WHEN EXISTS (SELECT 1 FROM dba_part_col_statistics c
                                   WHERE c.owner = s.owner AND c.table_name = s.table_name AND c.partition_name = s.partition_name
                                   AND   c.notes LIKE '%ADAPTIVE_SAMPLING%') THEN 'OLD'
                      WHEN EXISTS (SELECT 1 FROM dba_part_col_statistics c
                                   WHERE c.owner = s.owner AND c.table_name = s.table_name AND c.partition_name = s.partition_name
                                   AND   c.notes LIKE '%HYPERLOGLOG%') THEN 'HLL'
                      ELSE 'NONE' END AS line
FROM   p
       JOIN np ON np.n <= 400
       JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'PARTITION'
ORDER  BY s.partition_position;

-- ====================================================================== 28. end of the detail block
SELECT '-- ADVISOR DETAIL END' AS line FROM dual;

-- ====================================================================== 29. human-readable tail (not parsed): partitions that matter, then the dry run
-- Partitions that matter: new, changed, locked, without a synopsis or with an old-format one (not parsed)
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
)
SELECT '--   ' || RPAD(s.partition_name, 32) || ' '
       || CASE WHEN s.last_analyzed IS NULL THEN 'no statistics; ' ELSE '' END
       || CASE WHEN s.stattype_locked IS NOT NULL THEN 'locked (' || s.stattype_locked || '); ' ELSE '' END
       || CASE WHEN s.last_analyzed IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dba_part_col_statistics c
                 WHERE c.owner = s.owner AND c.table_name = s.table_name AND c.partition_name = s.partition_name
                 AND (c.notes LIKE '%HYPERLOGLOG%' OR c.notes LIKE '%ADAPTIVE_SAMPLING%')) THEN 'no synopsis; ' ELSE '' END
       || CASE WHEN EXISTS (SELECT 1 FROM dba_part_col_statistics c
                 WHERE c.owner = s.owner AND c.table_name = s.table_name AND c.partition_name = s.partition_name
                 AND c.notes LIKE '%ADAPTIVE_SAMPLING%') THEN 'old-format synopsis; ' ELSE '' END
       || CASE WHEN s.chg > 0
               THEN TO_CHAR(s.chg, 'FM999,999,999,990') || ' rows changed of '
                    || TO_CHAR(NVL(s.num_rows, 0), 'FM999,999,999,990') || '; ' ELSE '' END
       || 'STALE_STATS=' || NVL(s.stale_stats, '-') AS line
FROM  (SELECT s.owner, s.table_name, s.partition_name, s.partition_position, s.last_analyzed, s.stattype_locked, s.num_rows, s.stale_stats,
              NVL(NVL((SELECT SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)) FROM dba_tab_modifications m
                            WHERE  m.table_owner = s.owner AND m.table_name = s.table_name AND m.partition_name = s.partition_name AND m.subpartition_name IS NULL),
                           (SELECT SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)) FROM dba_tab_modifications m
                            WHERE  m.table_owner = s.owner AND m.table_name = s.table_name AND m.partition_name = s.partition_name AND m.subpartition_name IS NOT NULL
                            AND    (s.last_analyzed IS NULL OR m.timestamp > s.last_analyzed))), 0) AS chg
       FROM   p JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'PARTITION') s
WHERE  s.last_analyzed IS NULL OR s.stattype_locked IS NOT NULL
   OR  s.chg > 0
   OR  NOT EXISTS (SELECT 1 FROM dba_part_col_statistics c
                   WHERE c.owner = s.owner AND c.table_name = s.table_name AND c.partition_name = s.partition_name
                   AND (c.notes LIKE '%HYPERLOGLOG%' OR c.notes LIKE '%ADAPTIVE_SAMPLING%'))
   OR  EXISTS (SELECT 1 FROM dba_part_col_statistics c
               WHERE c.owner = s.owner AND c.table_name = s.table_name AND c.partition_name = s.partition_name
               AND c.notes LIKE '%ADAPTIVE_SAMPLING%')
ORDER  BY s.partition_position
FETCH FIRST 60 ROWS ONLY;

-- Dry run: what the next plain gather would read, from DBMS_STATS itself. Reads nothing.
-- Compare its TABLE PARTITION tasks with the partitions the advisor says are read.
SELECT DBMS_STATS.REPORT_GATHER_TABLE_STATS(
         ownname => UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))),
         tabname => UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))),
         detail_level => 'TYPICAL', format => 'TEXT') AS dry_run
FROM   dual;

UNDEFINE adv_usage_ok
UNDEFINE adv_owner
UNDEFINE adv_table
