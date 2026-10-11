-- recommend.sql: the DBMS_STATS preferences in force for one table, next to what the gather advisor
-- would set them to, and the statements that get there.
--
-- Pure SQL: SELECTs over the DBA_* views (plus one optional, error-tolerant block that flushes
-- the DML counters, and three optional statements that need REPORT_COL_USAGE or V$SQL_PLAN). Statement 3
-- prints the column groups the table has and the CREATE_EXTENDED_STATS calls for the column sets a SQL
-- plan directive misestimated; statement 4 adds the sets SEED_COL_USAGE recorded; statement 5 lists, as
-- commented DROP_EXTENDED_STATS suggestions, the extensions (groups and expressions) REPORT_COL_USAGE does
-- not mention; statement 6 lists, as commented CREATE_EXTENDED_STATS lines, the expressions around a column
-- in cached plans (V$SQL_PLAN) that have no extension or function-based index yet. No DDL, no DML,
-- nothing is gathered, no preference is changed: the statements are printed, not run.
--
-- Run it in the PDB that owns the table, as a user who can read the DBA_* views and call
-- DBMS_STATS. REPORT_COL_USAGE (statements 2, 4 and 5) additionally needs SYSDBA or ANALYZE ANY DICTIONARY
-- plus ANALYZE ANY; it is skipped without. Statement 6 reads V$SQL_PLAN (SELECT_CATALOG_ROLE).
-- SELECT_CATALOG_ROLE + EXECUTE alone is not sufficient.
-- Input owner/table names must be conventional unquoted identifiers.
-- See docs/oracle19c-review.md for the review and remaining model limits.
--
--
--     sqlplus / as sysdba
--     SQL> alter session set container = PDB1;
--     SQL> @recommend.sql SHOP SALES       (without arguments it prompts for owner and table)
--
-- The rules are the preference-level rules of the advisor (src/model/advise.ts), applied to the
-- table as the dictionary describes it today, for a plain GATHER_TABLE_STATS or the automatic job:
--
--   INCREMENTAL                     TRUE on a partitioned table: without it every gather reads every
--                                   partition and then the whole table (lab T0, L1)
--   INCREMENTAL_LEVEL               PARTITION on a partitioned table: TABLE replaces the partition
--                                   synopses with one table-level one (lab N2, X4)
--   PUBLISH                         TRUE: pending statistics never change LAST_ANALYZED, and with
--                                   INCREMENTAL they are gathered without synopses (lab G1); existing
--                                   pending statistics are better deleted than published (lab G1c, Tf)
--   ESTIMATE_PERCENT                AUTO_SAMPLE_SIZE: a fixed percent scales the NDV up from a sample,
--                                   loses top-frequency and hybrid histograms and cannot build synopses
--                                   (lab A8, X3; 19c Tuning Guide)
--   GRANULARITY                     AUTO: PARTITION never refreshes the global statistics (lab A3, G2b);
--                                   the other values behaved like AUTO (lab A4-A7)
--   METHOD_OPT                      the SIZE 1 preference deletes every histogram the table has on every
--                                   gather (lab E6); SIZE REPEAT on a table without histograms never
--                                   builds one; under SIZE AUTO on an incremental table a first predicate
--                                   on a column rereads every partition (lab E1, E3i): statement 2 lists
--                                   the columns a pinned list would name
--   INCREMENTAL_STALENESS           add USE_LOCKED_STATS when a locked partition had DML, else the global
--                                   statistics come from a full scan on every gather (lab C1, C2); add
--                                   ALLOW_MIXED_FORMAT when a partition still has an 11g-format synopsis, else
--                                   it counts as stale and is read again (19c reference)
--   APPROXIMATE_NDV_ALGORITHM       REPEAT OR HYPERLOGLOG, the default, when ADAPTIVE SAMPLING is set: the 11g
--                                   format is far larger than HyperLogLog
--   PREFERENCE_OVERRIDES_PARAMETER  TRUE when the automatic job would gather new or stale partitions but
--                                   leave the global statistics behind because the table as a whole is
--                                   below STALE_PERCENT (lab G6, G7, Tb2); the alternative is one plain
--                                   GATHER_TABLE_STATS after each load
--   NO_INVALIDATE                   AUTO_INVALIDATE: TRUE leaves existing cursors on their plan until a later
--                                   hard parse
--   locks                           a locked table raises ORA-20005 and is skipped by the job (lab D1);
--                                   a locked partition with DML or without a synopsis forces a full scan
--                                   for the global statistics (lab C1, V2)
--   CASCADE, DEGREE, OPTIONS, STALE_PERCENT   shown, never changed
--
-- FROM says where the value in force comes from: 'table' when DBA_TAB_STAT_PREFS has a row for this
-- table (SET_TABLE_PREFS or SET_SCHEMA_PREFS), 'global' otherwise (SET_GLOBAL_PREFS or Oracle's default).
--
-- Oracle 19c. Exercised 2026-10-08 on 19.27 (PDB1 of the dbmint lab: STATS_LAB.SALES, A1, C1, E1, N2, N4, SHOPSALES and the plain ST1).

SET PAGESIZE 0 LINESIZE 32767 HEADING OFF FEEDBACK OFF VERIFY OFF TRIMOUT ON TRIMSPOOL ON TAB OFF
SET LONG 1000000 LONGCHUNKSIZE 1000000
WHENEVER SQLERROR CONTINUE

DEFINE adv_owner = &1
DEFINE adv_table = &2

-- Optional: make DBA_TAB_MODIFICATIONS current. Needs ANALYZE ANY; silently skipped without it.
BEGIN
  DBMS_STATS.FLUSH_DATABASE_MONITORING_INFO;
EXCEPTION WHEN OTHERS THEN NULL;
END;
/

-- ====================================================================== 1. settings and recommendations
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), tb AS (
  SELECT p.own, p.tab, t.partitioned,
         NVL(s.num_rows, 0) AS num_rows, s.last_analyzed, s.stattype_locked AS tbl_lock
  FROM   p
         JOIN dba_tables t ON t.owner = p.own AND t.table_name = p.tab
         LEFT JOIN dba_tab_statistics s ON s.owner = t.owner AND s.table_name = t.table_name AND s.object_type = 'TABLE'
), pf AS (
  SELECT tb.*,
         DBMS_STATS.GET_PREFS('INCREMENTAL', tb.own, tb.tab)                    AS c_incremental,
         DBMS_STATS.GET_PREFS('INCREMENTAL_LEVEL', tb.own, tb.tab)              AS c_incr_level,
         DBMS_STATS.GET_PREFS('INCREMENTAL_STALENESS', tb.own, tb.tab)          AS c_incr_staleness,
         DBMS_STATS.GET_PREFS('APPROXIMATE_NDV_ALGORITHM', tb.own, tb.tab)      AS c_ndv_alg,
         DBMS_STATS.GET_PREFS('PUBLISH', tb.own, tb.tab)                        AS c_publish,
         DBMS_STATS.GET_PREFS('ESTIMATE_PERCENT', tb.own, tb.tab)               AS c_estimate,
         DBMS_STATS.GET_PREFS('GRANULARITY', tb.own, tb.tab)                    AS c_granularity,
         DBMS_STATS.GET_PREFS('METHOD_OPT', tb.own, tb.tab)                     AS c_method_opt,
         DBMS_STATS.GET_PREFS('CASCADE', tb.own, tb.tab)                        AS c_cascade,
         DBMS_STATS.GET_PREFS('NO_INVALIDATE', tb.own, tb.tab)                  AS c_no_invalidate,
         DBMS_STATS.GET_PREFS('OPTIONS', tb.own, tb.tab)                        AS c_options,
         DBMS_STATS.GET_PREFS('DEGREE', tb.own, tb.tab)                         AS c_degree,
         DBMS_STATS.GET_PREFS('STALE_PERCENT', tb.own, tb.tab)                  AS c_stale_percent,
         DBMS_STATS.GET_PREFS('PREFERENCE_OVERRIDES_PARAMETER', tb.own, tb.tab) AS c_overrides,
         (SELECT LISTAGG(preference_name, ',') WITHIN GROUP (ORDER BY preference_name)
          FROM   dba_tab_stat_prefs x WHERE x.owner = tb.own AND x.table_name = tb.tab) AS tab_prefs
  FROM   tb
), pr AS (
  SELECT s.partition_name, s.partition_position, s.num_rows, s.last_analyzed,
         NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0) AS mods,
         CASE WHEN tb.tbl_lock IS NULL AND s.stattype_locked IS NOT NULL THEN 1 ELSE 0 END AS is_locked,
         CASE WHEN s.last_analyzed IS NULL THEN 1 ELSE 0 END AS is_new,
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
), ag AS (
  SELECT COUNT(*)                                                                      AS n_parts,
         SUM(CASE WHEN is_locked = 0 THEN is_new ELSE 0 END)                             AS n_new,
         SUM(CASE WHEN pr.is_locked = 0 AND pr.is_new = 0 AND pr.mods > 0
                   AND (NVL(pr.num_rows, 0) = 0 OR 100 * pr.mods / pr.num_rows > TO_NUMBER(pf.c_stale_percent DEFAULT 10 ON CONVERSION ERROR))
                  THEN 1 ELSE 0 END)                                                   AS n_stale,
         SUM(is_locked)                                                                AS n_locked,
         SUM(CASE WHEN is_locked = 1 AND mods > 0 THEN 1 ELSE 0 END)                    AS n_locked_chg,
         SUM(CASE WHEN is_locked = 1 AND (has_syn = 0 OR lacks_ext = 1) THEN 1 ELSE 0 END) AS n_locked_nosyn,
         SUM(CASE WHEN is_locked = 1 AND (has_syn = 0 OR lacks_ext = 1 OR
                   (mods > 0 AND UPPER(NVL(pf.c_incr_staleness, 'x')) NOT LIKE '%USE_LOCKED_STATS%'))
                  THEN 1 ELSE 0 END)                                                   AS n_unlock,
         SUM(has_syn)                                                                  AS n_with_syn,
         SUM(CASE WHEN is_locked = 0 AND is_new = 0 AND has_syn = 0 THEN 1 ELSE 0 END)    AS n_lack_syn,
         SUM(old_fmt)                                                                  AS n_old_fmt,
         MAX(CASE WHEN is_locked = 1 THEN partition_name END)
           KEEP (DENSE_RANK LAST ORDER BY is_locked, CASE WHEN has_syn = 0 THEN 2 WHEN mods > 0 THEN 1 ELSE 0 END, partition_position) AS name_locked
  FROM   pr, pf
  GROUP  BY pf.c_stale_percent, pf.c_incr_staleness
), f AS (
  SELECT pf.*,
         NVL(ag.n_parts, 1) AS n_parts, NVL(ag.n_new, 0) AS n_new, NVL(ag.n_stale, 0) AS n_stale,
         NVL(ag.n_locked, 0) AS n_locked, NVL(ag.n_locked_chg, 0) AS n_locked_chg, NVL(ag.n_locked_nosyn, 0) AS n_locked_nosyn,
         NVL(ag.n_with_syn, 0) AS n_with_syn, NVL(ag.n_lack_syn, 0) AS n_lack_syn, NVL(ag.n_old_fmt, 0) AS n_old_fmt, ag.name_locked, NVL(ag.n_unlock, 0) AS unlock_count,
         (SELECT COUNT(*) FROM dba_tab_col_statistics c WHERE c.owner = pf.own AND c.table_name = pf.tab
          AND c.histogram IS NOT NULL AND c.histogram <> 'NONE') AS n_hist,
         (SELECT COUNT(*) FROM dba_tab_pending_stats c WHERE c.owner = pf.own AND c.table_name = pf.tab) AS n_pending,
         (SELECT NVL(SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)), 0) FROM dba_tab_modifications m
          WHERE  m.table_owner = pf.own AND m.table_name = pf.tab AND m.partition_name IS NULL) AS tbl_mods,
         TO_NUMBER(pf.c_stale_percent DEFAULT 10 ON CONVERSION ERROR) AS stale_pct,
         CASE WHEN TO_NUMBER(pf.c_estimate DEFAULT NULL ON CONVERSION ERROR) > 0 THEN 1 ELSE 0 END AS est_fixed,
         CASE WHEN REGEXP_LIKE(UPPER(pf.c_method_opt), '^\s*FOR\s+ALL\s+(INDEXED\s+|HIDDEN\s+)?COLUMNS\s+SIZE\s+1\s*$') THEN 'size1'
              WHEN REGEXP_LIKE(UPPER(pf.c_method_opt), '^\s*FOR\s+ALL\s+(INDEXED\s+|HIDDEN\s+)?COLUMNS\s+SIZE\s+AUTO\s*$') THEN 'auto'
              WHEN REGEXP_LIKE(UPPER(pf.c_method_opt), '^\s*FOR\s+ALL\s+(INDEXED\s+|HIDDEN\s+)?COLUMNS\s+SIZE\s+REPEAT\s*$') THEN 'repeat'
              WHEN REGEXP_LIKE(UPPER(pf.c_method_opt), '^\s*FOR\s+ALL\s+(INDEXED\s+|HIDDEN\s+)?COLUMNS\s+SIZE\s+SKEWONLY\s*$') THEN 'skewonly'
              ELSE 'pinned' END AS mo,
         CASE WHEN UPPER(pf.c_incremental) = 'TRUE' THEN 1 ELSE 0 END AS inc,
         CASE WHEN UPPER(pf.c_publish) = 'TRUE' THEN 1 ELSE 0 END AS pub,
         CASE WHEN UPPER(pf.c_overrides) = 'TRUE' THEN 1 ELSE 0 END AS ov,
         CASE WHEN pf.partitioned = 'YES' THEN 1 ELSE 0 END AS part
  FROM   pf LEFT JOIN ag ON 1 = 1
), g AS (
  SELECT f.*,
         CASE WHEN tbl_mods = 0 THEN 0 WHEN num_rows = 0 THEN 100 ELSE 100 * tbl_mods / num_rows END AS tbl_change,
         -- the dictionary guess of collect.sql statement 1: a locked partition with DML or without a synopsis blanks the global NOTES
         -- although the other synopses are in step (lab C1, Tc, V2); collect.sql statement 3 reads the synopsis table for the exact answer
         CASE WHEN n_with_syn = 0 THEN 'none'
              WHEN EXISTS (SELECT 1 FROM dba_tab_col_statistics c WHERE c.owner = f.own AND c.table_name = f.tab AND c.notes LIKE '%INCREMENTAL%') THEN 'all'
              WHEN n_lack_syn = 0 AND (n_locked_chg > 0 OR n_locked_nosyn > 0) THEN 'all'
              ELSE 'stale' END AS synopses
  FROM   f
), r AS (
  SELECT g.*,
         -- the recommendations: NULL when the setting is fine as it is
         CASE WHEN part = 1 AND inc = 0 THEN 'TRUE' END AS r_incremental,
         CASE WHEN part = 1 AND UPPER(c_incr_level) = 'TABLE' THEN 'PARTITION' END AS r_incr_level,
         CASE WHEN pub = 0 THEN 'TRUE' END AS r_publish,
         CASE WHEN est_fixed = 1 THEN 'DBMS_STATS.AUTO_SAMPLE_SIZE' END AS r_estimate,
         CASE WHEN part = 1 AND UPPER(c_granularity) <> 'AUTO' THEN 'AUTO' END AS r_granularity,
         CASE WHEN mo = 'size1' AND n_hist > 0 THEN 'FOR ALL COLUMNS SIZE AUTO'
              WHEN mo = 'repeat' AND n_hist = 0 THEN 'FOR ALL COLUMNS SIZE AUTO' END AS r_method_opt,
         CASE WHEN part = 1 AND n_locked_chg > 0 AND UPPER(NVL(c_incr_staleness, 'x')) NOT LIKE '%USE_LOCKED_STATS%'
              THEN 'USE_STALE_PERCENT,USE_LOCKED_STATS,ALLOW_MIXED_FORMAT'
              WHEN part = 1 AND inc = 1 AND n_old_fmt > 0 AND UPPER(NVL(c_incr_staleness, 'x')) NOT LIKE '%ALLOW_MIXED_FORMAT%'
              THEN CASE WHEN c_incr_staleness IS NULL OR UPPER(c_incr_staleness) = 'NULL' THEN 'ALLOW_MIXED_FORMAT'
                        ELSE c_incr_staleness || ',ALLOW_MIXED_FORMAT' END END AS r_incr_staleness,
         CASE WHEN part = 1 AND UPPER(c_ndv_alg) LIKE 'ADAPTIVE%' THEN 'REPEAT OR HYPERLOGLOG' END AS r_ndv_alg,
         CASE WHEN part = 1 AND ov = 0 AND n_new + n_stale > 0 AND tbl_change <= stale_pct THEN 'TRUE' END AS r_overrides,
         CASE WHEN tbl_lock IS NULL AND unlock_count > 0 THEN unlock_count END AS n_unlock,
         CASE WHEN UPPER(c_no_invalidate) = 'TRUE' THEN 'DBMS_STATS.AUTO_INVALIDATE' END AS r_no_invalidate,
         '''' || own || ''', ''' || tab || '''' AS ot
  FROM   g
), lines AS (
  SELECT r.*,
         RPAD('-', 31, '-') || ' ' || RPAD('-', 36, '-') || ' ' || RPAD('-', 7, '-') || ' ' || RPAD('-', 36, '-') AS rule
  FROM   r
)
SELECT column_value AS line
FROM   lines l,
       TABLE(sys.odcivarchar2list(
         '-- Gather preferences for ' || l.own || '.' || l.tab || ', ' || TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS'),
         '-- ' || CASE WHEN l.part = 1 THEN 'partitioned, ' || TO_CHAR(l.n_parts) || ' partitions' ELSE 'not partitioned' END
               || ', ' || TO_CHAR(l.num_rows, 'FM999,999,999,990') || ' rows'
               || CASE WHEN l.last_analyzed IS NULL THEN ', no statistics' ELSE ', last analyzed ' || TO_CHAR(l.last_analyzed, 'YYYY-MM-DD HH24:MI') END
               || ', ' || TO_CHAR(l.tbl_change, 'FM9999990.00') || '% changed since (STALE_PERCENT ' || TO_CHAR(l.stale_pct) || ')'
               || ', ' || CASE WHEN l.n_hist = 0 THEN 'no histograms' ELSE TO_CHAR(l.n_hist) || ' histograms' END
               || CASE WHEN l.n_pending > 0 THEN ', ' || TO_CHAR(l.n_pending) || ' pending statistics' END
               || CASE WHEN l.tbl_lock IS NOT NULL THEN ', STATISTICS LOCKED (' || l.tbl_lock || ')' END,
         CASE WHEN l.part = 1 THEN
           '-- partitions: ' || TO_CHAR(l.n_new) || ' without statistics, ' || TO_CHAR(l.n_stale) || ' stale by STALE_PERCENT, '
               || TO_CHAR(l.n_locked) || ' locked (' || TO_CHAR(l.n_locked_chg) || ' with DML, ' || TO_CHAR(l.n_locked_nosyn) || ' without synopsis)'
               || ', synopses: ' || l.synopses
               || CASE WHEN l.n_old_fmt > 0 THEN ', ' || TO_CHAR(l.n_old_fmt) || ' with an old-format (adaptive sampling) synopsis' END END,
         '-- FROM: table = a preference on this table (SET_TABLE_PREFS / SET_SCHEMA_PREFS); global = SET_GLOBAL_PREFS or the Oracle default',
         ' ',
         RPAD('SETTING', 31) || ' ' || RPAD('CURRENT', 36) || ' ' || RPAD('FROM', 7) || ' ' || 'RECOMMENDED',
         l.rule,
         RPAD('INCREMENTAL', 31) || ' ' || NVL(l.c_incremental, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_incremental, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,INCREMENTAL,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_incremental, l.c_incremental) || CASE WHEN l.r_incremental IS NOT NULL THEN '   <-- change' END,
         RPAD('INCREMENTAL_LEVEL', 31) || ' ' || NVL(l.c_incr_level, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_incr_level, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,INCREMENTAL_LEVEL,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_incr_level, l.c_incr_level) || CASE WHEN l.r_incr_level IS NOT NULL THEN '   <-- change' END,
         RPAD('INCREMENTAL_STALENESS', 31) || ' ' || NVL(l.c_incr_staleness, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_incr_staleness, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,INCREMENTAL_STALENESS,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_incr_staleness, NVL(l.c_incr_staleness, 'NULL')) || CASE WHEN l.r_incr_staleness IS NOT NULL THEN '   <-- change' END,
         RPAD('APPROXIMATE_NDV_ALGORITHM', 31) || ' ' || NVL(l.c_ndv_alg, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_ndv_alg, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,APPROXIMATE_NDV_ALGORITHM,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_ndv_alg, NVL(l.c_ndv_alg, 'NULL')) || CASE WHEN l.r_ndv_alg IS NOT NULL THEN '   <-- change' END,
         RPAD('PUBLISH', 31) || ' ' || NVL(l.c_publish, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_publish, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,PUBLISH,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_publish, l.c_publish) || CASE WHEN l.r_publish IS NOT NULL THEN '   <-- change' END,
         RPAD('ESTIMATE_PERCENT', 31) || ' ' || NVL(l.c_estimate, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_estimate, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,ESTIMATE_PERCENT,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_estimate, l.c_estimate) || CASE WHEN l.r_estimate IS NOT NULL THEN '   <-- change' END,
         RPAD('GRANULARITY', 31) || ' ' || NVL(l.c_granularity, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_granularity, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,GRANULARITY,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_granularity, l.c_granularity) || CASE WHEN l.r_granularity IS NOT NULL THEN '   <-- change' END,
         RPAD('METHOD_OPT', 31) || ' ' || NVL(l.c_method_opt, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_method_opt, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,METHOD_OPT,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_method_opt, l.c_method_opt) || CASE WHEN l.r_method_opt IS NOT NULL THEN '   <-- change' END,
         RPAD('CASCADE', 31) || ' ' || NVL(l.c_cascade, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_cascade, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,CASCADE,%' THEN 'table' ELSE 'global' END, 7) || ' ' || l.c_cascade,
         RPAD('NO_INVALIDATE', 31) || ' ' || NVL(l.c_no_invalidate, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_no_invalidate, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,NO_INVALIDATE,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_no_invalidate, l.c_no_invalidate) || CASE WHEN l.r_no_invalidate IS NOT NULL THEN '   <-- change' END,
         RPAD('OPTIONS', 31) || ' ' || NVL(l.c_options, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_options, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,OPTIONS,%' THEN 'table' ELSE 'global' END, 7) || ' ' || l.c_options,
         RPAD('DEGREE', 31) || ' ' || NVL(l.c_degree, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_degree, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,DEGREE,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.c_degree, 'NULL'),
         RPAD('STALE_PERCENT', 31) || ' ' || NVL(l.c_stale_percent, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_stale_percent, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,STALE_PERCENT,%' THEN 'table' ELSE 'global' END, 7) || ' ' || l.c_stale_percent,
         RPAD('PREFERENCE_OVERRIDES_PARAMETER', 31) || ' ' || NVL(l.c_overrides, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_overrides, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,PREFERENCE_OVERRIDES_PARAMETER,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_overrides, l.c_overrides) || CASE WHEN l.r_overrides IS NOT NULL THEN '   <-- change' END,
         RPAD('statistics lock', 31) || ' ' || NVL(l.tbl_lock, 'none') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.tbl_lock, 'none')), 0)) || ' ' || RPAD(' ', 7) || ' ' || 'none' || CASE WHEN l.tbl_lock IS NOT NULL THEN '   <-- change' END,
         CASE WHEN l.part = 1 THEN
           RPAD('locked partitions', 31) || ' ' || TO_CHAR(l.n_locked) || RPAD(' ', GREATEST(36 - LENGTH(TO_CHAR(l.n_locked)), 0)) || ' ' || RPAD(' ', 7) || ' '
             || CASE WHEN l.n_unlock > 0 THEN 'unlock ' || TO_CHAR(l.n_unlock) || '   <-- change' ELSE TO_CHAR(l.n_locked) END END,
         ' ',
         '-- Recommended changes, in this order (nothing below has been run):',
         CASE WHEN l.r_incremental IS NULL AND l.r_incr_level IS NULL AND l.r_publish IS NULL AND l.r_estimate IS NULL AND l.r_granularity IS NULL
               AND l.r_method_opt IS NULL AND l.r_incr_staleness IS NULL AND l.r_ndv_alg IS NULL AND l.r_overrides IS NULL AND l.r_no_invalidate IS NULL
               AND l.tbl_lock IS NULL AND NVL(l.n_unlock, 0) = 0
              THEN '--   none: the preferences are as the advisor would set them' END,
         CASE WHEN l.r_incremental IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''INCREMENTAL'', ''TRUE'')' END,
         CASE WHEN l.r_incremental IS NOT NULL THEN
           '--   INCREMENTAL is FALSE: every gather reads every partition and then the whole table, and the automatic job leaves the global'
           || ' statistics behind unless the whole table is stale. The first incremental gather reads every partition once to build the synopses.' END,
         CASE WHEN l.r_incr_level IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''INCREMENTAL_LEVEL'', ''PARTITION'')' END,
         CASE WHEN l.r_incr_level IS NOT NULL THEN
           '--   INCREMENTAL_LEVEL TABLE keeps one synopsis for the whole table (a staging table''s setting); on a partitioned table every gather'
           || ' reads every partition and then the whole table.' END,
         CASE WHEN l.r_publish IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''PUBLISH'', ''TRUE'')' END,
         CASE WHEN l.r_publish IS NOT NULL THEN
           '--   PUBLISH is FALSE: every gather lands in DBA_TAB_PENDING_STATS; LAST_ANALYZED and the staleness flag never change, so the'
           || ' automatic job gathers it again every night' || CASE WHEN l.part = 1 THEN ', and pending statistics are gathered without synopses' END || '.' END,
         CASE WHEN l.n_pending > 0 THEN
           '-- Optional, after reviewing the pending statistics: EXEC DBMS_STATS.DELETE_PENDING_STATS(' || l.ot || ')' END,
         CASE WHEN l.n_pending > 0 THEN
           '--   ' || TO_CHAR(l.n_pending) || ' pending statistics are waiting'
           || CASE WHEN l.part = 1 THEN '; publishing them leaves the synopses out of step, so the next gather rereads every partition. Delete them and gather again.'
                   ELSE '; delete them and gather again, or PUBLISH_PENDING_STATS if they were meant to be tested first.' END END,
         CASE WHEN l.r_estimate IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''ESTIMATE_PERCENT'', ''DBMS_STATS.AUTO_SAMPLE_SIZE'')' END,
         CASE WHEN l.r_estimate IS NOT NULL THEN
           '--   ESTIMATE_PERCENT ' || TRIM(l.c_estimate) || CASE WHEN TO_NUMBER(l.c_estimate DEFAULT NULL ON CONVERSION ERROR) = 100
                   THEN ': full computation of NDV; top-frequency and hybrid histograms require AUTO_SAMPLE_SIZE'
                   ELSE ': NDV is estimated from a sample; top-frequency and hybrid histograms require AUTO_SAMPLE_SIZE' END
           || CASE WHEN l.part = 1 THEN ', and no synopsis can be built, so the gather runs the old way' END || '.' END,
         CASE WHEN l.r_granularity IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''GRANULARITY'', ''AUTO'')' END,
         CASE WHEN l.r_granularity IS NOT NULL THEN
           CASE WHEN UPPER(l.c_granularity) = 'PARTITION'
                THEN '--   GRANULARITY PARTITION never refreshes the global statistics: the global row count and the partition key''s high value stay behind the data.'
                ELSE '--   GRANULARITY ' || l.c_granularity || ' behaved like AUTO in the lab; AUTO is what the documentation promises.' END END,
         CASE WHEN l.r_method_opt IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''METHOD_OPT'', ''FOR ALL COLUMNS SIZE AUTO'')' END,
         CASE WHEN l.r_method_opt IS NOT NULL THEN
           CASE WHEN l.mo = 'size1'
                THEN '--   METHOD_OPT SIZE 1 deletes the ' || TO_CHAR(l.n_hist) || ' histograms this table has on every gather, including the ones a manual gather added.'
                ELSE '--   METHOD_OPT SIZE REPEAT on a table without histograms never builds one, however skewed a column is.' END
           || ' Set AUTO explicitly: the inherited global preference may also suppress histograms.' END,
         CASE WHEN l.r_incr_staleness IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''INCREMENTAL_STALENESS'', ''' || l.r_incr_staleness || ''')' END,
         CASE WHEN l.r_incr_staleness IS NOT NULL AND l.n_locked_chg > 0 AND UPPER(NVL(l.c_incr_staleness, 'x')) NOT LIKE '%USE_LOCKED_STATS%' THEN
           '--   ' || TO_CHAR(l.n_locked_chg) || ' locked partition(s) had DML: without USE_LOCKED_STATS the synopsis cannot be refreshed and the global statistics'
           || ' come from a full scan on every gather. With it, their new rows are in no statistic.' END,
         CASE WHEN l.r_incr_staleness IS NOT NULL AND l.n_old_fmt > 0 AND UPPER(NVL(l.c_incr_staleness, 'x')) NOT LIKE '%ALLOW_MIXED_FORMAT%' THEN
           '--   ' || TO_CHAR(l.n_old_fmt) || ' partition(s) keep a synopsis in the 11g adaptive-sampling format and ALLOW_MIXED_FORMAT is off: Oracle treats them as'
           || ' stale and reads them once more. With the flag (the default) both formats merge as they are.' END,
         CASE WHEN l.r_ndv_alg IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''APPROXIMATE_NDV_ALGORITHM'', ''REPEAT OR HYPERLOGLOG'')' END,
         CASE WHEN l.r_ndv_alg IS NOT NULL THEN
           '--   APPROXIMATE_NDV_ALGORITHM ADAPTIVE SAMPLING writes every synopsis in the 11g format, far larger than HyperLogLog and slower to merge;'
           || ' the default writes new ones in HyperLogLog form.' END,
         CASE WHEN l.r_overrides IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''PREFERENCE_OVERRIDES_PARAMETER'', ''TRUE'')' END,
         CASE WHEN l.r_overrides IS NOT NULL THEN
           '--   ' || TO_CHAR(l.n_new + l.n_stale) || ' partition(s) are new or stale, but the table as a whole changed by ' || TO_CHAR(l.tbl_change, 'FM9999990.00')
           || '% (STALE_PERCENT ' || TO_CHAR(l.stale_pct) || '): the automatic job gathers them and leaves the global statistics behind. TRUE makes the job'
           || ' merge them (and makes every call ignore its own parameters). Alternative: EXEC DBMS_STATS.GATHER_TABLE_STATS(' || l.ot || ') after each load.' END,
         CASE WHEN l.r_no_invalidate IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''NO_INVALIDATE'', ''DBMS_STATS.AUTO_INVALIDATE'')' END,
         CASE WHEN l.r_no_invalidate IS NOT NULL THEN
           '--   NO_INVALIDATE TRUE: this gather does not invalidate existing cursors; new statistics take effect after a later hard parse.' END,
         CASE WHEN l.tbl_lock IS NOT NULL THEN
           'EXEC DBMS_STATS.UNLOCK_TABLE_STATS(' || l.ot || ')' END,
         CASE WHEN l.tbl_lock IS NOT NULL THEN
           '--   the statistics are locked (' || l.tbl_lock || '): every gather raises ORA-20005 unless it passes force => TRUE, and the automatic job skips the table.' END,
         CASE WHEN l.n_unlock > 0 THEN
           'EXEC DBMS_STATS.UNLOCK_PARTITION_STATS(' || l.ot || ', ''' || l.name_locked || ''')' END,
         CASE WHEN l.n_unlock > 0 THEN
           '--   ' || TO_CHAR(l.n_unlock) || ' locked partition(s) with DML (USE_LOCKED_STATS off) or without a synopsis force a full scan for the global'
           || ' statistics on every gather. Unlock (one shown; all are listed below), gather, then lock again if they must stay frozen.' END,
         CASE WHEN l.part = 1 AND l.n_locked_chg > 0 AND l.n_unlock IS NULL THEN
           '--   note: ' || TO_CHAR(l.n_locked_chg) || ' locked partition(s) had DML and USE_LOCKED_STATS is on, so they are never read: their new rows are in no statistic, the global row count included.' END,
         CASE WHEN l.part = 0 AND l.inc = 1 AND UPPER(l.c_incr_level) <> 'TABLE' THEN
           '--   note: INCREMENTAL TRUE does nothing on a non-partitioned table unless INCREMENTAL_LEVEL is TABLE (a staging table for an exchange).' END,
         CASE WHEN l.part = 0 AND l.inc = 1 AND UPPER(l.c_incr_level) = 'TABLE' AND l.est_fixed = 1 THEN
           '--   note: INCREMENTAL_LEVEL TABLE builds a table-level synopsis for an exchange, but a fixed ESTIMATE_PERCENT cannot build one.' END,
         CASE WHEN l.part = 1 AND l.inc = 1 AND l.r_incr_level IS NULL AND l.r_publish IS NULL AND l.r_estimate IS NULL AND l.synopses <> 'all' THEN
           '--   note: the synopses are ' || CASE WHEN l.synopses = 'none' THEN 'not built yet' ELSE 'out of step with the statistics' END
           || ': the next gather reads every unlocked partition once to build them, then only what changed.' END,
         CASE WHEN l.part = 1 AND l.n_old_fmt > 0 AND l.r_incr_staleness IS NULL AND UPPER(NVL(l.c_ndv_alg, 'x')) LIKE 'REPEAT%' THEN
           '--   note: ' || TO_CHAR(l.n_old_fmt) || ' partition(s) keep an old-format (adaptive sampling) synopsis; REPEAT OR HYPERLOGLOG keeps that format even when the'
           || ' partition is re-gathered. APPROXIMATE_NDV_ALGORITHM HYPERLOGLOG converts each as it is re-gathered, at no extra cost.' END,
         CASE WHEN l.part = 1 AND l.mo = 'auto' AND (l.inc = 1 OR l.r_incremental IS NOT NULL) THEN
           '--   note: under METHOD_OPT SIZE AUTO the first predicate on a column rereads every partition for its histogram; the column usage below lists the candidates'
           || ' for a pinned list (FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 <columns>).' END
       ))
WHERE  column_value IS NOT NULL;

-- ====================================================================== 2. detail (needs REPORT_COL_USAGE; skipped on error)
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
)
SELECT '--   locked partition: ' || RPAD(s.partition_name, 32) || ' ' || s.stattype_locked
       || CASE WHEN NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0) > 0
               THEN ', ' || TO_CHAR(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0), 'FM999,999,999,990') || ' rows changed' END
       || CASE WHEN s.last_analyzed IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dba_part_col_statistics c
                 WHERE c.owner = s.owner AND c.table_name = s.table_name AND c.partition_name = s.partition_name
                 AND (c.notes LIKE '%HYPERLOGLOG%' OR c.notes LIKE '%ADAPTIVE_SAMPLING%')) THEN ', no synopsis' END AS line
FROM   p
       JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'PARTITION' AND s.stattype_locked IS NOT NULL
       LEFT JOIN dba_tab_modifications m ON m.table_owner = s.owner AND m.table_name = s.table_name
                                         AND m.partition_name = s.partition_name AND m.subpartition_name IS NULL
WHERE  NOT EXISTS (SELECT 1 FROM dba_tab_statistics t WHERE t.owner = p.own AND t.table_name = p.tab AND t.object_type = 'TABLE' AND t.stattype_locked IS NOT NULL)
ORDER  BY s.partition_position
FETCH FIRST 60 ROWS ONLY;

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
), x AS (
  SELECT COUNT(u.col) AS n_used,
         LISTAGG(CASE WHEN NVL(c.histogram, 'NONE') <> 'NONE' AND NVL(c.notes, 'x') NOT LIKE '%HIST_FOR_INCREM_STATS%' THEN u.col END, ',') WITHIN GROUP (ORDER BY u.col) AS with_hist,
         LISTAGG(CASE WHEN NVL(c.histogram, 'NONE') <> 'NONE' AND c.notes LIKE '%HIST_FOR_INCREM_STATS%' THEN u.col END, ',') WITHIN GROUP (ORDER BY u.col) AS support_hist,
         LISTAGG(CASE WHEN NVL(c.histogram, 'NONE') = 'NONE'
                      AND NOT (c.num_distinct IS NOT NULL AND t.num_rows IS NOT NULL AND c.num_distinct >= t.num_rows)
                      THEN u.col END, ',') WITHIN GROUP (ORDER BY u.col) AS candidates
  FROM   u
         JOIN dba_tab_col_statistics c ON c.owner = u.own AND c.table_name = u.tab AND c.column_name = u.col
         LEFT JOIN dba_tab_statistics t ON t.owner = u.own AND t.table_name = u.tab AND t.object_type = 'TABLE'
)
SELECT column_value AS line
FROM   x,
       TABLE(sys.odcivarchar2list(
         '--   column usage: ' || CASE WHEN x.n_used = 0 THEN 'none recorded, so SIZE AUTO builds no histogram yet' ELSE TO_CHAR(x.n_used) || ' column(s) used in predicates' END,
         CASE WHEN x.with_hist IS NOT NULL THEN '--   columns with a histogram today: ' || x.with_hist END,
         CASE WHEN x.support_hist IS NOT NULL THEN '--   histograms kept only for incremental statistics (NOTES HIST_FOR_INCREM_STATS, not used by the optimizer; pinning them makes them real ones): ' || x.support_hist END,
         CASE WHEN x.candidates IS NOT NULL THEN '--   used in predicates, no histogram yet (a SIZE AUTO gather may build one): ' || x.candidates END,
         CASE WHEN x.with_hist IS NOT NULL OR x.candidates IS NOT NULL THEN
           '--   pinned list template: FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 ' || TRIM(',' FROM NVL(x.with_hist, '') || ',' || NVL(x.candidates, '')) END
       ))
WHERE  column_value IS NOT NULL;

-- ====================================================================== 3. column groups (extended statistics): DBA views only
-- The groups the table has, and the column sets a USABLE DYNAMIC_SAMPLING SQL plan directive misestimated
-- that no group covers. A group helps only when the directive's predicates were all equalities (the
-- optimizer uses column group statistics for equality predicates, in-lists and GROUP BY). On an incremental
-- table a new group rereads every unlocked partition at the next gather (lab E4), and a locked partition
-- can never get its synopsis (lab Tc).
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), n AS (
  SELECT LEVEL AS i FROM dual CONNECT BY LEVEL <= 32
), ext AS (
  SELECT e.extension_name, DBMS_LOB.SUBSTR(e.extension, 4000, 1) AS txt,
         (SELECT c.last_analyzed FROM dba_tab_col_statistics c
          WHERE  c.owner = e.owner AND c.table_name = e.table_name AND c.column_name = e.extension_name) AS analyzed
  FROM   p, dba_stat_extensions e
  WHERE  e.owner = p.own AND e.table_name = p.tab
  AND    REGEXP_LIKE(DBMS_LOB.SUBSTR(e.extension, 4000, 1), '^\(\s*"[^"]+"(\s*,\s*"[^"]+")+\s*\)$')
), extset AS (
  SELECT ext.extension_name, ext.txt, ext.analyzed,
         LISTAGG(REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1), ',')
           WITHIN GROUP (ORDER BY REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1)) AS cols
  FROM   ext, n
  WHERE  n.i <= REGEXP_COUNT(ext.txt, '"[^"]+"')
  GROUP  BY ext.extension_name, ext.txt, ext.analyzed
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
         LISTAGG(dc.col, ', ') WITHIN GROUP (ORDER BY dc.col) AS pretty,
         COUNT(*) AS n_cols,
         ROUND(EXP(SUM(LN(GREATEST(NVL(dc.num_distinct, 1), 1))))) AS ndv_product,
         (SELECT MAX(CASE WHEN EXTRACTVALUE(o.notes, '/obj_note/equality_predicates_only') = 'NO' THEN 'range' ELSE 'eq' END)
          FROM   p, dba_sql_plan_dir_objects o
          WHERE  o.directive_id = dc.directive_id AND o.owner = p.own AND o.object_name = p.tab AND o.object_type = 'TABLE') AS kind
  FROM   dcols dc
  GROUP  BY dc.directive_id
), cand AS (
  SELECT ds.cols, MIN(ds.pretty) AS pretty, MIN(NVL(ds.kind, 'eq')) AS kind, MIN(ds.ndv_product) AS ndv_product
  FROM   dsets ds
  WHERE  ds.n_cols >= 2 AND NOT EXISTS (SELECT 1 FROM extset x WHERE x.cols = ds.cols)
  GROUP  BY ds.cols
), tb AS (
  SELECT p.own, p.tab, NVL(s.num_rows, 0) AS num_rows,
         (SELECT COUNT(*) FROM dba_tab_cols c WHERE c.owner = p.own AND c.table_name = p.tab AND c.hidden_column = 'NO') AS n_cols,
         (SELECT COUNT(*) FROM extset) AS n_ext,
         (SELECT COUNT(*) FROM cand WHERE kind = 'eq') AS n_cand,
         DBMS_STATS.GET_PREFS('AUTO_STAT_EXTENSIONS', p.own, p.tab) AS auto_ext
  FROM   p LEFT JOIN dba_tab_statistics s ON s.owner = p.own AND s.table_name = p.tab AND s.object_type = 'TABLE'
)
SELECT line
FROM  (SELECT 1 AS grp, 0 AS ord, '--   column groups: ' || TO_CHAR(tb.n_ext) || CASE WHEN tb.n_ext = 0 THEN ' (none)' END
              || '; AUTO_STAT_EXTENSIONS = ' || NVL(tb.auto_ext, 'NULL')
              || CASE WHEN tb.auto_ext = 'ON' THEN ' (a directive makes the next gather create a group by itself; OFF leaves the moment to you)' END AS line
       FROM   tb
       UNION ALL
       SELECT 2, ROWNUM, '--   has ' || x.txt || CASE WHEN x.analyzed IS NULL THEN ': no statistics yet, the next gather computes them' ELSE ', statistics of ' || TO_CHAR(x.analyzed, 'YYYY-MM-DD') END
       FROM   extset x
       UNION ALL
       SELECT 3, ROWNUM, CASE WHEN c.kind = 'eq'
                   THEN '-- a SQL plan directive misestimated these columns together (equality predicates); NDV product ' || TO_CHAR(c.ndv_product)
                        || CASE WHEN c.ndv_product > tb.num_rows THEN ', more than the ' || TO_CHAR(tb.num_rows) || ' rows' END || CHR(10)
                        || 'SELECT DBMS_STATS.CREATE_EXTENDED_STATS(''' || tb.own || ''', ''' || tb.tab || ''', ''(' || c.pretty || ')'') FROM dual;'
                   ELSE '--   (' || c.pretty || '): a SQL plan directive, but not with equality predicates only; a column group would not be used for those queries' END
       FROM   cand c, tb
       UNION ALL
       SELECT 4, 0, '--   the groups get statistics at the next gather; undo with DBMS_STATS.DROP_EXTENDED_STATS(owner, table, ''(columns)'')'
       FROM   tb WHERE tb.n_cand > 0
       UNION ALL
       SELECT 5, 0, '--   limit: at most ' || TO_CHAR(GREATEST(20, FLOOR(tb.n_cols / 10))) || ' extensions on this table (the greater of 20 and 10% of its columns); '
              || TO_CHAR(tb.n_ext) || ' exist, ' || TO_CHAR(tb.n_cand) || ' proposed'
       FROM   tb WHERE tb.n_ext + tb.n_cand > GREATEST(20, FLOOR(tb.n_cols / 10))
       UNION ALL
       SELECT 6, 0, '--   statement 4 below adds the groups SEED_COL_USAGE recorded, when REPORT_COL_USAGE is allowed'
       FROM   tb)
ORDER  BY grp, ord;

-- ====================================================================== 4. column groups SEED_COL_USAGE recorded (REPORT_COL_USAGE; skipped on error)
-- The group lines of REPORT_COL_USAGE, "(A, B) : FILTER", minus the sets a group or a directive above already covers.
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), n AS (
  SELECT LEVEL AS i FROM dual CONNECT BY LEVEL <= 32
), ext AS (
  SELECT e.extension_name, DBMS_LOB.SUBSTR(e.extension, 4000, 1) AS txt
  FROM   p, dba_stat_extensions e
  WHERE  e.owner = p.own AND e.table_name = p.tab
  AND    REGEXP_LIKE(DBMS_LOB.SUBSTR(e.extension, 4000, 1), '^\(\s*"[^"]+"(\s*,\s*"[^"]+")+\s*\)$')
), extset AS (
  SELECT ext.extension_name,
         LISTAGG(REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1), ',')
           WITHIN GROUP (ORDER BY REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1)) AS cols
  FROM   ext, n
  WHERE  n.i <= REGEXP_COUNT(ext.txt, '"[^"]+"')
  GROUP  BY ext.extension_name
), dsets AS (
  SELECT d.directive_id, LISTAGG(o.subobject_name, ',') WITHIN GROUP (ORDER BY o.subobject_name) AS cols
  FROM   p, dba_sql_plan_directives d
         JOIN dba_sql_plan_dir_objects o ON o.directive_id = d.directive_id
  WHERE  o.owner = p.own AND o.object_name = p.tab AND o.object_type = 'COLUMN'
  AND    d.type = 'DYNAMIC_SAMPLING' AND d.state = 'USABLE'
  GROUP  BY d.directive_id
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
         LISTAGG(gc.col, ', ') WITHIN GROUP (ORDER BY gc.col) AS pretty,
         ROUND(EXP(SUM(LN(GREATEST(NVL(c.num_distinct, 1), 1))))) AS ndv_product
  FROM   gcols gc
         CROSS JOIN p
         LEFT JOIN dba_tab_col_statistics c ON c.owner = p.own AND c.table_name = p.tab AND c.column_name = gc.col
  GROUP  BY gc.gi
), cand AS (
  SELECT gs.cols, MIN(gs.pretty) AS pretty, MIN(gs.ndv_product) AS ndv_product
  FROM   gsets gs
  WHERE  NOT EXISTS (SELECT 1 FROM extset x WHERE x.cols = gs.cols)
  AND    NOT EXISTS (SELECT 1 FROM dsets d WHERE d.cols = gs.cols)
  GROUP  BY gs.cols
)
SELECT '-- SEED_COL_USAGE recorded these columns filtered together; NDV product ' || TO_CHAR(c.ndv_product) || CHR(10)
       || 'SELECT DBMS_STATS.CREATE_EXTENDED_STATS(''' || p.own || ''', ''' || p.tab || ''', ''(' || c.pretty || ')'') FROM dual;' AS line
FROM   cand c, p
ORDER  BY c.cols;

-- ====================================================================== 5. extensions REPORT_COL_USAGE does not mention (skipped on error)
-- Suggestions only, printed as comments. A column group appears in the report as "(A, B) : FILTER" and only
-- while SEED_COL_USAGE watched a workload (it records column groups, in SYS.COL_GROUP_USAGE$; 19c reference),
-- so a group the report lacks is "not seen", not "never used", unless SEED_COL_USAGE ran over a representative
-- workload. An expression extension is listed by its SYS_STU name with the ordinary column usage flags (lab
-- EXPR_PRED), recorded since the table was created or RESET_COL_USAGE; a query parsed before the extension
-- existed recorded nothing for it. Each unlisted extension still costs an NDV (and a histogram if SIZE AUTO
-- decides) at every gather, and on an incremental table a new one rereads every partition (lab E4).
WITH p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own,
         UPPER(TRIM(BOTH '"' FROM TRIM('&adv_table'))) AS tab
  FROM   dual
), n AS (
  SELECT LEVEL AS i FROM dual CONNECT BY LEVEL <= 32
), ext AS (
  SELECT e.extension_name AS nm, DBMS_LOB.SUBSTR(e.extension, 4000, 1) AS txt
  FROM   p, dba_stat_extensions e
  WHERE  e.owner = p.own AND e.table_name = p.tab
), exs AS (
  -- a group lists two or more columns and nothing else; any other extension is an expression (the rule of collect.sql)
  SELECT ext.nm, ext.txt,
         CASE WHEN REGEXP_LIKE(ext.txt, '^\(\s*"[^"]+"(\s*,\s*"[^"]+")+\s*\)$') THEN 'group' ELSE 'expression' END AS kind,
         (SELECT LISTAGG(REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1), ',') WITHIN GROUP (ORDER BY REGEXP_SUBSTR(ext.txt, '"([^"]+)"', 1, n.i, NULL, 1))
          FROM   n WHERE n.i <= REGEXP_COUNT(ext.txt, '"[^"]+"')) AS cols
  FROM   ext
), r AS (
  SELECT p.own, p.tab, DBMS_STATS.REPORT_COL_USAGE(p.own, p.tab) AS rep FROM p
), u AS (
  -- "3. SYS_STUK0KH1IA6IF9E7R2BXDBW#UM : EQ RANGE NULL"
  SELECT DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+(\S+)\s*:', 1, LEVEL, 'm', 1), 128, 1) AS col
  FROM   r
  CONNECT BY LEVEL <= REGEXP_COUNT(r.rep, '^\s*\d+\.\s+\S+\s*:', 1, 'm')
), gl AS (
  -- "6. (CITY, COUNTRY) : FILTER"
  SELECT REGEXP_REPLACE(DBMS_LOB.SUBSTR(REGEXP_SUBSTR(r.rep, '^\s*\d+\.\s+\(([^)]*)\)\s*:', 1, LEVEL, 'm', 1), 4000, 1), '\s', '') AS txt
  FROM   r
  CONNECT BY LEVEL <= REGEXP_COUNT(r.rep, '^\s*\d+\.\s+\(', 1, 'm')
), gs AS (
  SELECT (SELECT LISTAGG(REGEXP_SUBSTR(gl.txt, '[^,]+', 1, n.i), ',') WITHIN GROUP (ORDER BY REGEXP_SUBSTR(gl.txt, '[^,]+', 1, n.i))
          FROM   n WHERE n.i <= REGEXP_COUNT(gl.txt, '[^,]+')) AS cols
  FROM   gl
), unl AS (
  SELECT x.nm, x.txt, x.kind
  FROM   exs x
  WHERE  (x.kind = 'group' AND NOT EXISTS (SELECT 1 FROM gs WHERE gs.cols = x.cols))
  OR     (x.kind = 'expression' AND NOT EXISTS (SELECT 1 FROM u WHERE u.col = x.nm))
), tb AS (
  SELECT p.own, p.tab, (SELECT COUNT(*) FROM exs) AS n_ext, (SELECT COUNT(*) FROM unl) AS n_unl FROM p
)
SELECT line
FROM  (SELECT 1 AS grp, 0 AS ord,
              '--   extensions: ' || TO_CHAR(tb.n_ext) || CASE WHEN tb.n_ext = 0 THEN ' (none)'
                   ELSE '; REPORT_COL_USAGE does not mention ' || TO_CHAR(tb.n_unl) || CASE WHEN tb.n_unl = 0 THEN ', so none is a drop candidate' END END AS line
       FROM   tb
       UNION ALL
       SELECT 2, ROWNUM,
              '-- EXEC DBMS_STATS.DROP_EXTENDED_STATS(''' || tb.own || ''', ''' || tb.tab || ''', ''' || REPLACE(u2.txt, '''', '''''') || ''');'
              || CASE WHEN u2.kind = 'group'
                      THEN '   -- column group not in the report: SEED_COL_USAGE records groups only while it watches a workload'
                      ELSE '   -- expression ' || u2.nm || ' with no recorded predicate use' END
       FROM   unl u2, tb
       UNION ALL
       SELECT 3, 0, '--   confirm first: run SEED_COL_USAGE(NULL, NULL, 900) over a representative workload and read REPORT_COL_USAGE again;'
       FROM   tb WHERE tb.n_unl > 0
       UNION ALL
       SELECT 4, 0, '--   a recent RESET_COL_USAGE, or a workload that has not run since the extension was created, also leaves the report short.'
       FROM   tb WHERE tb.n_unl > 0)
ORDER  BY grp, ord;

-- ====================================================================== 6. expression candidates (V$SQL_PLAN; skipped on error)
-- Function calls wrapped around a column of this table in the predicates of cached plans of the table and
-- its indexes: the statement of collect.sql (EXPRESSION_CANDIDATES), printed as commented CREATE_EXTENDED_STATS
-- lines. Heuristic: a cached plan is weak evidence, nesting is followed one level deep, binds are skipped, a
-- table alias is dropped, INTERNAL_FUNCTION (an implicit conversion the plan adds) is unwrapped. Left out:
-- expressions that already have an extension or a function-based index (compared after removing blanks and
-- double quotes). At most 20. Expression statistics help only when the expression itself is in a predicate
-- (19c Tuning Guide, Managing Extended Statistics); each one counts against the limit of extensions.
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
SELECT '-- seen in a cached plan (weak evidence); helps only if queries filter on this expression' || CHR(10)
       || '-- SELECT DBMS_STATS.CREATE_EXTENDED_STATS(''' || p.own || ''', ''' || p.tab || ''', ''(' || REPLACE(ok.e, '''', '''''') || ')'') FROM dual;' AS line
FROM   ok, p
WHERE  ok.rn <= 20
ORDER  BY ok.rn;

UNDEFINE adv_owner
UNDEFINE adv_table
