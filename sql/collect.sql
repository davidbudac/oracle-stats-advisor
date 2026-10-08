-- collect.sql: everything the gather advisor needs about one table, as pasteable KEY = VALUE lines.
--
-- Pure SQL: four SELECT statements over the DBA_* views (the third reads one SYS table and is
-- skipped without the privilege), plus one optional, error-tolerant PL/SQL block that flushes the
-- DML counters. No DDL, no DML, nothing is gathered.
--
-- Run it in the PDB that owns the table, as a user who can read the DBA_* views and call
-- DBMS_STATS. The reports need more: REPORT_GATHER_TABLE_STATS ownership or ANALYZE ANY,
-- REPORT_COL_USAGE (statement 2) SYSDBA or ANALYZE ANY DICTIONARY plus ANALYZE ANY, and statement 3
-- reads SYS.WRI$_OPTSTAT_SYNOPSIS_HEAD$ (SYSDBA). Each is skipped without the privilege;
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
-- Only the lines between ADVISOR INPUT BEGIN and ADVISOR INPUT END are read; the detail and
-- the dry run after END are for you. A later KEY line overrides an earlier one, and an error
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
--   TABLE_CHANGE_PERCENT      the table-level row of DBA_TAB_MODIFICATIONS relative to NUM_ROWS
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
--   CHANGED_PARTITIONS        unlocked analysed partitions with rows in DBA_TAB_MODIFICATIONS
--   CHANGE_PERCENT            the largest change among them, relative to the partition's NUM_ROWS
--   LOCKED_*                  STATTYPE_LOCKED per partition (counted only when the table is not locked);
--                             LOCKED_NO_SYNOPSIS also when a locked partition lacks the statistics of a column
--                             group, which forces the same full scan (lab Tc)
--   TABLE_LOCKED              STATTYPE_LOCKED on the table row
--   COLUMN_CHANGE             group: DBA_STAT_EXTENSIONS has an extension some unlocked analysed partition lacks
--                             statistics for; usage: DBMS_STATS.REPORT_COL_USAGE lists a column whose
--                             global HISTOGRAM is NONE (statement 2); else none
--   COLUMN_USAGE              1 when REPORT_COL_USAGE lists at least one column
--
-- Oracle 19c. Exercised 2026-10-08 on 19.27 (PDB1 of the dbmint lab: STATS_LAB.SALES, E1, C1, N4, P2 and the
-- plain ST1); test/fixtures/collect-e1.txt is one real output. Read it before you run it elsewhere.

SET PAGESIZE 0 LINESIZE 32767 HEADING OFF FEEDBACK OFF VERIFY OFF TRIMOUT ON TRIMSPOOL ON
SET LONG 1000000 LONGCHUNKSIZE 1000000 TAB OFF
WHENEVER SQLERROR CONTINUE

DEFINE adv_owner = &1
DEFINE adv_table = &2

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
         NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0) AS mods,
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
         LEFT JOIN dba_tab_modifications m ON m.table_owner = s.owner AND m.table_name = s.table_name
                                           AND m.partition_name = s.partition_name AND m.subpartition_name IS NULL
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
         (SELECT LISTAGG(sp.preference_name, ',') WITHIN GROUP (ORDER BY sp.preference_name)
          FROM   dba_tab_stat_prefs sp WHERE sp.owner = tb.own AND sp.table_name = tb.tab) AS tbl_prefs,
         CASE WHEN tb.last_analyzed IS NULL THEN 'none'
              WHEN EXISTS (SELECT 1 FROM dba_tab_col_statistics c WHERE c.owner = tb.own AND c.table_name = tb.tab
                           AND c.notes LIKE '%STATS_ON_LOAD%') THEN 'load'
              ELSE 'gathered' END AS tbl_stats,
         (SELECT NVL(SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)), 0) FROM dba_tab_modifications m
          WHERE  m.table_owner = tb.own AND m.table_name = tb.tab AND m.partition_name IS NULL) AS tbl_mods,
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
         DBMS_STATS.GET_PREFS('PREFERENCE_OVERRIDES_PARAMETER', tb.own, tb.tab) AS p_overrides
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
         'TABLE_PREFS = ' || w.tbl_prefs,
         'HISTOGRAM_COLUMNS = ' || w.hist_cols,
         '-- histograms kept only for incremental statistics (NOTES HIST_FOR_INCREM_STATS, not used by the optimizer, so not pinned): ' || NVL(w.hist_support, '(none)'),
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
         'COLUMN_CHANGE = ' || CASE WHEN w.n_groups > 0 THEN 'group' ELSE 'none' END,
         '-- (statement 2 below may override COLUMN_CHANGE and COLUMN_USAGE from the column usage report, statement 3 SYNOPSES from the synopsis table)'
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
  SELECT COUNT(*) AS n_groups
  FROM   p, dba_stat_extensions e
  WHERE  e.owner = p.own AND e.table_name = p.tab
  AND    EXISTS (SELECT 1 FROM dba_tab_statistics s
                 WHERE  s.owner = e.owner AND s.table_name = e.table_name AND s.object_type = 'PARTITION'
                 AND    s.last_analyzed IS NOT NULL AND s.stattype_locked IS NULL
                 AND    NOT EXISTS (SELECT 1 FROM dba_part_col_statistics pc
                                    WHERE  pc.owner = s.owner AND pc.table_name = s.table_name
                                    AND    pc.partition_name = s.partition_name AND pc.column_name = e.extension_name
                                    AND    pc.last_analyzed IS NOT NULL))
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

-- ====================================================================== 4. end marker, detail, dry run
SELECT '-- ADVISOR INPUT END' AS line FROM dual;

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
       || CASE WHEN NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0) > 0
               THEN TO_CHAR(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0), 'FM999,999,999,990') || ' rows changed of '
                    || TO_CHAR(NVL(s.num_rows, 0), 'FM999,999,999,990') || '; ' ELSE '' END
       || 'STALE_STATS=' || NVL(s.stale_stats, '-') AS line
FROM   p
       JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'PARTITION'
       LEFT JOIN dba_tab_modifications m ON m.table_owner = s.owner AND m.table_name = s.table_name
                                         AND m.partition_name = s.partition_name AND m.subpartition_name IS NULL
WHERE  s.last_analyzed IS NULL OR s.stattype_locked IS NOT NULL
   OR  NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0) > 0
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

UNDEFINE adv_owner
UNDEFINE adv_table
