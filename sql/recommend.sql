-- recommend.sql: the DBMS_STATS preferences in force for one table, next to what the gather advisor
-- would set them to, and the statements that get there.
--
-- Pure SQL: one SELECT over the DBA_* views (plus one optional, error-tolerant block that flushes
-- the DML counters, and one optional statement that needs REPORT_COL_USAGE). No DDL, no DML,
-- nothing is gathered, no preference is changed: the statements are printed, not run.
--
-- Run it in the PDB that owns the table, as a user who can read the DBA_* views and call
-- DBMS_STATS (a DBA, or SELECT_CATALOG_ROLE + EXECUTE on DBMS_STATS):
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
--                                   statistics come from a full scan on every gather (lab C1, C2)
--   PREFERENCE_OVERRIDES_PARAMETER  TRUE when the automatic job would gather new or stale partitions but
--                                   leave the global statistics behind because the table as a whole is
--                                   below STALE_PERCENT (lab G6, G7, Tb2); the alternative is one plain
--                                   GATHER_TABLE_STATS after each load
--   NO_INVALIDATE                   AUTO_INVALIDATE: TRUE means existing cursors never see new statistics
--   locks                           a locked table raises ORA-20005 and is skipped by the job (lab D1);
--                                   a locked partition with DML or without a synopsis forces a full scan
--                                   for the global statistics (lab C1, V2)
--   CASCADE, DEGREE, OPTIONS, STALE_PERCENT   shown, never changed
--
-- FROM says where the value in force comes from: 'table' when DBA_TAB_STAT_PREFS has a row for this
-- table (SET_TABLE_PREFS or SET_SCHEMA_PREFS), 'global' otherwise (SET_GLOBAL_PREFS or Oracle's default).
--
-- Oracle 19c. Verified 2026-10-08 on 19.27 (PDB1 of the dbmint lab: STATS_LAB.SALES, A1, E1, N2, N4, SHOPSALES and the plain ST1).

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
              THEN 1 ELSE 0 END AS has_syn
  FROM   tb
         JOIN dba_tab_statistics s ON s.owner = tb.own AND s.table_name = tb.tab AND s.object_type = 'PARTITION'
         LEFT JOIN dba_tab_modifications m ON m.table_owner = s.owner AND m.table_name = s.table_name
                                           AND m.partition_name = s.partition_name AND m.subpartition_name IS NULL
  WHERE  tb.partitioned = 'YES'
), ag AS (
  SELECT COUNT(*)                                                                      AS n_parts,
         SUM(is_new)                                                                   AS n_new,
         SUM(CASE WHEN pr.is_locked = 0 AND pr.is_new = 0 AND pr.mods > 0
                   AND (NVL(pr.num_rows, 0) = 0 OR 100 * pr.mods / pr.num_rows > TO_NUMBER(pf.c_stale_percent DEFAULT 10 ON CONVERSION ERROR))
                  THEN 1 ELSE 0 END)                                                   AS n_stale,
         SUM(is_locked)                                                                AS n_locked,
         SUM(CASE WHEN is_locked = 1 AND mods > 0 THEN 1 ELSE 0 END)                    AS n_locked_chg,
         SUM(CASE WHEN is_locked = 1 AND is_new = 0 AND has_syn = 0 THEN 1 ELSE 0 END)  AS n_locked_nosyn,
         SUM(has_syn)                                                                  AS n_with_syn,
         MAX(CASE WHEN is_locked = 1 THEN partition_name END)
           KEEP (DENSE_RANK LAST ORDER BY is_locked, CASE WHEN is_new = 0 AND has_syn = 0 THEN 2 WHEN mods > 0 THEN 1 ELSE 0 END, partition_position) AS name_locked
  FROM   pr, pf
  GROUP  BY pf.c_stale_percent
), f AS (
  SELECT pf.*,
         NVL(ag.n_parts, 1) AS n_parts, NVL(ag.n_new, 0) AS n_new, NVL(ag.n_stale, 0) AS n_stale,
         NVL(ag.n_locked, 0) AS n_locked, NVL(ag.n_locked_chg, 0) AS n_locked_chg, NVL(ag.n_locked_nosyn, 0) AS n_locked_nosyn,
         NVL(ag.n_with_syn, 0) AS n_with_syn, ag.name_locked,
         (SELECT COUNT(*) FROM dba_tab_col_statistics c WHERE c.owner = pf.own AND c.table_name = pf.tab
          AND c.histogram IS NOT NULL AND c.histogram <> 'NONE') AS n_hist,
         (SELECT COUNT(*) FROM dba_tab_pending_stats c WHERE c.owner = pf.own AND c.table_name = pf.tab) AS n_pending,
         (SELECT NVL(SUM(NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0)), 0) FROM dba_tab_modifications m
          WHERE  m.table_owner = pf.own AND m.table_name = pf.tab AND m.partition_name IS NULL) AS tbl_mods,
         TO_NUMBER(pf.c_stale_percent DEFAULT 10 ON CONVERSION ERROR) AS stale_pct,
         CASE WHEN REGEXP_LIKE(pf.c_estimate, '^\s*[0-9.]+\s*$') THEN 1 ELSE 0 END AS est_fixed,
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
         CASE WHEN tbl_mods = 0 THEN 0 WHEN num_rows = 0 THEN 100 ELSE ROUND(100 * tbl_mods / num_rows, 2) END AS tbl_change,
         CASE WHEN n_with_syn = 0 THEN 'none'
              WHEN EXISTS (SELECT 1 FROM dba_tab_col_statistics c WHERE c.owner = f.own AND c.table_name = f.tab AND c.notes LIKE '%INCREMENTAL%') THEN 'all'
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
              THEN 'USE_STALE_PERCENT,USE_LOCKED_STATS,ALLOW_MIXED_FORMAT' END AS r_incr_staleness,
         CASE WHEN part = 1 AND ov = 0 AND n_new + n_stale > 0 AND tbl_change <= stale_pct THEN 'TRUE' END AS r_overrides,
         CASE WHEN tbl_lock IS NULL AND (n_locked_nosyn > 0 OR (n_locked_chg > 0 AND UPPER(NVL(c_incr_staleness, 'x')) NOT LIKE '%USE_LOCKED_STATS%'))
              THEN n_locked_nosyn + CASE WHEN UPPER(NVL(c_incr_staleness, 'x')) NOT LIKE '%USE_LOCKED_STATS%' THEN n_locked_chg ELSE 0 END END AS n_unlock,
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
               || ', synopses: ' || l.synopses END,
         '-- FROM: table = a preference on this table (SET_TABLE_PREFS / SET_SCHEMA_PREFS); global = SET_GLOBAL_PREFS or the Oracle default',
         ' ',
         RPAD('SETTING', 31) || ' ' || RPAD('CURRENT', 36) || ' ' || RPAD('FROM', 7) || ' ' || 'RECOMMENDED',
         l.rule,
         RPAD('INCREMENTAL', 31) || ' ' || NVL(l.c_incremental, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_incremental, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,INCREMENTAL,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_incremental, l.c_incremental) || CASE WHEN l.r_incremental IS NOT NULL THEN '   <-- change' END,
         RPAD('INCREMENTAL_LEVEL', 31) || ' ' || NVL(l.c_incr_level, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_incr_level, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,INCREMENTAL_LEVEL,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_incr_level, l.c_incr_level) || CASE WHEN l.r_incr_level IS NOT NULL THEN '   <-- change' END,
         RPAD('INCREMENTAL_STALENESS', 31) || ' ' || NVL(l.c_incr_staleness, 'NULL') || RPAD(' ', GREATEST(36 - LENGTH(NVL(l.c_incr_staleness, 'NULL')), 0)) || ' ' || RPAD(CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,INCREMENTAL_STALENESS,%' THEN 'table' ELSE 'global' END, 7) || ' ' || NVL(l.r_incr_staleness, NVL(l.c_incr_staleness, 'NULL')) || CASE WHEN l.r_incr_staleness IS NOT NULL THEN '   <-- change' END,
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
               AND l.r_method_opt IS NULL AND l.r_incr_staleness IS NULL AND l.r_overrides IS NULL AND l.r_no_invalidate IS NULL
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
           'EXEC DBMS_STATS.DELETE_PENDING_STATS(' || l.ot || ')' END,
         CASE WHEN l.n_pending > 0 THEN
           '--   ' || TO_CHAR(l.n_pending) || ' pending statistics are waiting'
           || CASE WHEN l.part = 1 THEN '; publishing them leaves the synopses out of step, so the next gather rereads every partition. Delete them and gather again.'
                   ELSE '; delete them and gather again, or PUBLISH_PENDING_STATS if they were meant to be tested first.' END END,
         CASE WHEN l.r_estimate IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''ESTIMATE_PERCENT'', ''DBMS_STATS.AUTO_SAMPLE_SIZE'')' END,
         CASE WHEN l.r_estimate IS NOT NULL THEN
           '--   ESTIMATE_PERCENT ' || TRIM(l.c_estimate) || ': the NDV is scaled up from a sample, top-frequency and hybrid histograms are impossible'
           || CASE WHEN l.part = 1 THEN ', and no synopsis can be built, so the gather runs the old way' END || '.' END,
         CASE WHEN l.r_granularity IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''GRANULARITY'', ''AUTO'')' END,
         CASE WHEN l.r_granularity IS NOT NULL THEN
           CASE WHEN UPPER(l.c_granularity) = 'PARTITION'
                THEN '--   GRANULARITY PARTITION never refreshes the global statistics: the global row count and the partition key''s high value stay behind the data.'
                ELSE '--   GRANULARITY ' || l.c_granularity || ' behaved like AUTO in the lab; AUTO is what the documentation promises.' END END,
         CASE WHEN l.r_method_opt IS NOT NULL THEN
           CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,METHOD_OPT,%'
                THEN 'EXEC DBMS_STATS.DELETE_TABLE_PREFS(' || l.ot || ', ''METHOD_OPT'')'
                ELSE 'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''METHOD_OPT'', ''FOR ALL COLUMNS SIZE AUTO'')' END END,
         CASE WHEN l.r_method_opt IS NOT NULL THEN
           CASE WHEN l.mo = 'size1'
                THEN '--   METHOD_OPT SIZE 1 deletes the ' || TO_CHAR(l.n_hist) || ' histograms this table has on every gather, including the ones a manual gather added.'
                ELSE '--   METHOD_OPT SIZE REPEAT on a table without histograms never builds one, however skewed a column is.' END
           || CASE WHEN ',' || l.tab_prefs || ',' LIKE '%,METHOD_OPT,%' THEN ' Deleting the table preference falls back to the global value.' END END,
         CASE WHEN l.r_incr_staleness IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''INCREMENTAL_STALENESS'', ''USE_STALE_PERCENT,USE_LOCKED_STATS,ALLOW_MIXED_FORMAT'')' END,
         CASE WHEN l.r_incr_staleness IS NOT NULL THEN
           '--   ' || TO_CHAR(l.n_locked_chg) || ' locked partition(s) had DML: without USE_LOCKED_STATS the synopsis cannot be refreshed and the global statistics'
           || ' come from a full scan on every gather. With it, their new rows are in no statistic.' END,
         CASE WHEN l.r_overrides IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''PREFERENCE_OVERRIDES_PARAMETER'', ''TRUE'')' END,
         CASE WHEN l.r_overrides IS NOT NULL THEN
           '--   ' || TO_CHAR(l.n_new + l.n_stale) || ' partition(s) are new or stale, but the table as a whole changed by ' || TO_CHAR(l.tbl_change, 'FM9999990.00')
           || '% (STALE_PERCENT ' || TO_CHAR(l.stale_pct) || '): the automatic job gathers them and leaves the global statistics behind. TRUE makes the job'
           || ' merge them (and makes every call ignore its own parameters). Alternative: EXEC DBMS_STATS.GATHER_TABLE_STATS(' || l.ot || ') after each load.' END,
         CASE WHEN l.r_no_invalidate IS NOT NULL THEN
           'EXEC DBMS_STATS.SET_TABLE_PREFS(' || l.ot || ', ''NO_INVALIDATE'', ''DBMS_STATS.AUTO_INVALIDATE'')' END,
         CASE WHEN l.r_no_invalidate IS NOT NULL THEN
           '--   NO_INVALIDATE TRUE: existing cursors never see the new statistics.' END,
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
         LISTAGG(CASE WHEN NVL(c.histogram, 'NONE') <> 'NONE' THEN u.col END, ',') WITHIN GROUP (ORDER BY u.col) AS with_hist,
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
         CASE WHEN x.candidates IS NOT NULL THEN '--   used in predicates, no histogram yet (a SIZE AUTO gather may build one): ' || x.candidates END,
         CASE WHEN x.with_hist IS NOT NULL OR x.candidates IS NOT NULL THEN
           '--   pinned list template: FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 ' || REPLACE(TRIM(',' FROM NVL(x.with_hist, '') || ',' || NVL(x.candidates, '')), ',', ' ') END
       ))
WHERE  column_value IS NOT NULL;

UNDEFINE adv_owner
UNDEFINE adv_table
