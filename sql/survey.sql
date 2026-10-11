-- survey.sql: the tables of one schema, ranked by how much a plain GATHER_TABLE_STATS would read, and why.
--
-- Pure SQL: one SELECT over the DBA_* views (plus one optional, error-tolerant block that flushes
-- the DML counters). No DDL, no DML, nothing is gathered, no preference is changed. Use it to decide
-- which tables to feed to collect.sql first: the top of the list is where the next gather costs most.
--
-- Run it in the PDB that owns the schema, as SYSDBA or as a user who can read the DBA_* views and
-- call DBMS_STATS.GET_PREFS. Every statement is error tolerant: a GET_PREFS that fails for one table
-- prints '?' for its preferences, a view you may not read leaves its columns empty.
-- Input owner name must be a conventional unquoted identifier.
-- See docs/oracle19c-review.md for the review and remaining model limits.
--
--     sqlplus / as sysdba
--     SQL> alter session set container = PDB1;
--     SQL> @survey.sql SHOP                (without an argument it prompts for the owner)
--
-- Performance: the dictionary is read once per view (DBA_SEGMENTS, DBA_TAB_STATISTICS,
-- DBA_TAB_COL_STATISTICS, DBA_PART_COL_STATISTICS, DBA_TAB_MODIFICATIONS, DBA_INDEXES,
-- DBA_OPTSTAT_OPERATION_TASKS), each filtered to the owner and aggregated in a WITH clause. The one
-- per-table cost is DBMS_STATS.GET_PREFS, a PL/SQL call (nine per table): fine for a few thousand
-- tables, minutes for tens of thousands. DBA_SEGMENTS and the operation history are the slow views
-- on a big database.
--
-- One line per table, widest first (at most 200 are printed, then a count of the rest). The line is
-- about 295 characters wide and fixed width: spool it and open it in an editor, or widen the terminal.
--
--   TABLE              the table name (the schema is in the title; the hint column has OWNER.TABLE);
--                      P is P for a partitioned table, PARTS its partitions, SUB the subpartition type
--                      of a composite table (HASH, LIST, RANGE) or '-'
--   BLOCKS, ROWS       DBA_SEGMENTS blocks summed over the table, partition or subpartition segments
--                      (allocated, so an upper bound of what a scan reads); DBA_TAB_STATISTICS blocks when
--                      there is no segment. ROWS = NUM_ROWS of the table row
--   INCR               INCREMENTAL in force (Y, N; Y-TBL when INCREMENTAL_LEVEL is TABLE)
--   EST, METHOD        ESTIMATE_PERCENT (AUTO or the number), METHOD_OPT (AUTO, SIZE 1, REPEAT, SKEW,
--                      pinned, or the odd one as it is)
--   PUB, STAL, GRAN, OVR   PUBLISH (Y/N), STALE_PERCENT, GRANULARITY (abbreviated), and
--                      PREFERENCE_OVERRIDES_PARAMETER (Y/N); all via DBMS_STATS.GET_PREFS(pref, owner, table)
--   STATE              NOSTAT (no LAST_ANALYZED), STALE (STALE_STATS of the table row is YES), LOAD (the
--                      column NOTES say STATS_ON_LOAD, statistics came from a direct-path load), LOCK
--                      (STATTYPE_LOCKED on the table row), PEND (rows in DBA_TAB_PENDING_STATS)
--   SYN                partitioned tables: the state of the synopses from the dictionary, the same
--                      heuristic as collect.sql statement 1: all when the global column NOTES say
--                      INCREMENTAL (or a locked partition explains the blank NOTES), none when no
--                      partition has one (DBA_PART_COL_STATISTICS NOTES HYPERLOGLOG or ADAPTIVE_SAMPLING),
--                      stale otherwise
--   NOST, DMLP, LKP    partitions without statistics, partitions with rows in DBA_TAB_MODIFICATIONS (a
--                      composite table's subpartition rows are summed into the partition), locked partitions
--   CHG%               DML since the last gather relative to NUM_ROWS: the table-level row of
--                      DBA_TAB_MODIFICATIONS, or the sum of the partition rows when there is none
--   EST.READ           the estimated blocks the next plain GATHER_TABLE_STATS reads, see below
--   IDX                indexes without LOB indexes. CASCADE reads them too (lab F2, F3); they are not in EST.READ
--   WHY                the branch of the formula that gave EST.READ
--   LAST GATHER, SECS, BY   the newest COMPLETED table-level task of DBA_OPTSTAT_OPERATION_TASKS
--                      (TARGET_TYPE TABLE, TARGET '"OWNER"."TABLE"'): start time, duration in seconds, and
--                      auto when the operation ran in the automatic job (JOB_NAME ORA$AT_OS_OPT_SY_...),
--                      call otherwise. Partition-only gathers (TABLE PARTITION tasks) are not looked at
--   HINT               the collect.sql call for the table
--
-- EST.READ, in blocks, is the advisor's rule set (src/model/advise.ts, lab-observations.md) in a simplified form:
--
--   table statistics locked          0: a plain gather raises ORA-20005 (lab D1)
--   plain table                      BLOCKS. Once, whatever ESTIMATE_PERCENT says: a fixed percent samples rows,
--                                    which touches most blocks; a second, sampled pass for a new histogram
--                                    (SIZE AUTO with recorded column usage) is not counted
--   partitioned, not incremental     2 x BLOCKS: every partition, then the whole table once more (lab T0, L1, R2).
--                                    "Not incremental" is INCREMENTAL FALSE, INCREMENTAL_LEVEL TABLE, PUBLISH FALSE
--                                    or a fixed ESTIMATE_PERCENT (lab A8, G1, N2, X3). 1 x BLOCKS when GRANULARITY
--                                    is PARTITION or SUBPARTITION: the global statistics are not refreshed (lab G2b)
--   partitioned, incremental         only the blocks of the unlocked partitions a gather reads: the new ones (no
--                                    LAST_ANALYZED), the changed ones and those without a synopsis (lab L2, N1; the dry run
--                                    lists them). Changed is any DML under the default
--                                    INCREMENTAL_STALENESS (lab B1), more than STALE_PERCENT of the partition's
--                                    NUM_ROWS under USE_STALE_PERCENT (lab B2, B3), or an 11g-format synopsis without
--                                    ALLOW_MIXED_FORMAT. The global statistics come from the synopses. Every unlocked
--                                    partition when no partition has a synopsis (lab N1, E1, L1, F0), and also when each
--                                    has one but the global NOTES say they are out of step (SYN stale, lab Tf)
--                      plus          the whole table once more when a locked partition has DML (and
--                      BLOCKS        INCREMENTAL_STALENESS lacks USE_LOCKED_STATS) or has no synopsis, or lacks the
--                                    statistics of a column group: the global statistics then need a full scan (lab C1, V2, Tc)
--
-- Blocks of one partition are its own DBA_SEGMENTS blocks, not the table average. DML counts only after the
-- partition's LAST_ANALYZED (the subpartition rows of a composite table are never reset by a gather); the
-- table-level row of DBA_TAB_MODIFICATIONS, when there is one, is not added to the partition rows. Not modelled: locked
-- partitions of a non-incremental table are counted as if read, the sampled passes of SIZE AUTO and of
-- fixed ESTIMATE_PERCENT, index work, parallelism, partition exchange, index-organized tables (the index
-- segment is not a TABLE segment, so BLOCKS falls back to DBA_TAB_STATISTICS), external tables, and the
-- automatic job's own selection (it skips what is not stale; a plain call reads everything above).
-- Excluded: dropped tables (recycle bin), temporary tables, IOT overflow and mapping tables.
--
-- Oracle 19c. Exercised 2026-10-11 on 19.27 (PDB1 of the dbmint lab: STATS_LAB, ORASTATS_TEST, SOE);
-- test/fixtures/survey-STATS_LAB.txt is one real output.

SET PAGESIZE 0 LINESIZE 32767 HEADING OFF FEEDBACK OFF VERIFY OFF TRIMOUT ON TRIMSPOOL ON TAB OFF
SET LONG 1000000 LONGCHUNKSIZE 1000000
WHENEVER SQLERROR CONTINUE

DEFINE adv_owner = &1

-- Optional: make DBA_TAB_MODIFICATIONS current. Needs ANALYZE ANY; silently skipped without it.
BEGIN
  DBMS_STATS.FLUSH_DATABASE_MONITORING_INFO;
EXCEPTION WHEN OTHERS THEN NULL;
END;
/

-- ====================================================================== the survey (one statement; terminated by / because of the WITH FUNCTION)
WITH
  FUNCTION gp(p_name VARCHAR2, p_owner VARCHAR2, p_table VARCHAR2) RETURN VARCHAR2 IS
  BEGIN
    RETURN DBMS_STATS.GET_PREFS(p_name, p_owner, p_table);
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
p AS (
  SELECT UPPER(TRIM(BOTH '"' FROM TRIM('&adv_owner'))) AS own FROM dual
), tb AS (
  SELECT p.own, t.table_name, t.partitioned,
         s.num_rows, s.blocks AS stat_blocks, s.last_analyzed, s.stale_stats, s.stattype_locked AS tbl_lock
  FROM   p
         JOIN dba_tables t ON t.owner = p.own
         LEFT JOIN dba_tab_statistics s ON s.owner = t.owner AND s.table_name = t.table_name AND s.object_type = 'TABLE'
  WHERE  t.dropped = 'NO' AND t.temporary = 'N' AND NVL(t.iot_type, 'x') NOT IN ('IOT_OVERFLOW', 'IOT_MAPPING')
), pf AS (
  -- the preferences, evaluated once per table
  SELECT /*+ MATERIALIZE */ tb.*,
         gp('INCREMENTAL', tb.own, tb.table_name)                    AS c_inc,
         gp('INCREMENTAL_LEVEL', tb.own, tb.table_name)              AS c_level,
         gp('INCREMENTAL_STALENESS', tb.own, tb.table_name)          AS c_staleness,
         gp('PUBLISH', tb.own, tb.table_name)                        AS c_publish,
         gp('ESTIMATE_PERCENT', tb.own, tb.table_name)               AS c_estimate,
         gp('METHOD_OPT', tb.own, tb.table_name)                     AS c_method_opt,
         gp('STALE_PERCENT', tb.own, tb.table_name)                  AS c_stale,
         gp('GRANULARITY', tb.own, tb.table_name)                    AS c_gran,
         gp('PREFERENCE_OVERRIDES_PARAMETER', tb.own, tb.table_name) AS c_over
  FROM   tb
), sg AS (
  SELECT s.segment_name AS table_name, s.partition_name, s.segment_type, SUM(s.blocks) AS blocks
  FROM   p, dba_segments s
  WHERE  s.owner = p.own AND s.segment_type IN ('TABLE', 'TABLE PARTITION', 'TABLE SUBPARTITION')
  GROUP  BY s.segment_name, s.partition_name, s.segment_type
), tblk AS (
  SELECT table_name, SUM(blocks) AS blocks FROM sg GROUP BY table_name
), pblk AS (
  -- blocks per partition; a composite table's subpartition segments are summed into the partition
  SELECT sg.table_name, NVL(sp.partition_name, sg.partition_name) AS partition_name, SUM(sg.blocks) AS blocks
  FROM   sg
         LEFT JOIN dba_tab_subpartitions sp ON sg.segment_type = 'TABLE SUBPARTITION'
                                            AND sp.table_owner = (SELECT own FROM p)
                                            AND sp.table_name = sg.table_name AND sp.subpartition_name = sg.partition_name
  WHERE  sg.segment_type <> 'TABLE'
  GROUP  BY sg.table_name, NVL(sp.partition_name, sg.partition_name)
), mr AS (
  -- DBA_TAB_MODIFICATIONS: a row per partition (subpartition of a composite table), and for some partitioned tables a
  -- table-level roll-up row as well (partition_name NULL; summing every row would count the DML twice). A gather never
  -- resets the subpartition rows of a composite table (no subpartition statistics are gathered, lab J), so only DML after
  -- the LAST_ANALYZED of the partition (of the table, for the table-level row) counts
  SELECT m.table_name, m.partition_name, m.subpartition_name,
         CASE WHEN m.timestamp > NVL(CASE WHEN m.partition_name IS NULL THEN tb.last_analyzed ELSE s.last_analyzed END, DATE '1900-01-01')
              THEN NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0) ELSE 0 END AS mods
  FROM   p
         JOIN dba_tab_modifications m ON m.table_owner = p.own
         LEFT JOIN tb ON tb.table_name = m.table_name
         LEFT JOIN dba_tab_statistics s ON s.owner = m.table_owner AND s.table_name = m.table_name
                                        AND s.object_type = 'PARTITION' AND s.partition_name = m.partition_name
), md AS (
  -- per partition: its own row, else the sum of its subpartition rows
  SELECT table_name, partition_name,
         COALESCE(MAX(CASE WHEN subpartition_name IS NULL THEN mods END), SUM(mods)) AS mods
  FROM   mr
  WHERE  partition_name IS NOT NULL
  GROUP  BY table_name, partition_name
), tmd AS (
  -- per table: the table-level row, else the sum of the partitions
  SELECT table_name, COALESCE(MAX(tm), SUM(pm)) AS mods
  FROM  (SELECT table_name, mods AS tm, NULL AS pm FROM mr WHERE partition_name IS NULL
         UNION ALL
         SELECT table_name, NULL, mods FROM md)
  GROUP  BY table_name
), sy AS (
  -- partitions that have a synopsis (NOTES HYPERLOGLOG or ADAPTIVE_SAMPLING), and whether it is the 11g format
  SELECT c.table_name, c.partition_name, MAX(CASE WHEN c.notes LIKE '%ADAPTIVE_SAMPLING%' THEN 1 ELSE 0 END) AS old_fmt
  FROM   p, dba_part_col_statistics c
  WHERE  c.owner = p.own AND (c.notes LIKE '%HYPERLOGLOG%' OR c.notes LIKE '%ADAPTIVE_SAMPLING%')
  GROUP  BY c.table_name, c.partition_name
), cs AS (
  SELECT c.table_name,
         MAX(CASE WHEN c.notes LIKE '%INCREMENTAL%' THEN 1 ELSE 0 END)   AS g_inc,
         MAX(CASE WHEN c.notes LIKE '%STATS_ON_LOAD%' THEN 1 ELSE 0 END) AS on_load
  FROM   p, dba_tab_col_statistics c
  WHERE  c.owner = p.own
  GROUP  BY c.table_name
), ix AS (
  SELECT i.table_name, COUNT(*) AS n_idx
  FROM   p, dba_indexes i
  WHERE  i.table_owner = p.own AND i.index_type <> 'LOB'
  GROUP  BY i.table_name
), pe AS (
  SELECT DISTINCT x.table_name
  FROM   p, dba_tab_pending_stats x
  WHERE  x.owner = p.own
), pt AS (
  SELECT x.table_name, x.subpartitioning_type
  FROM   p, dba_part_tables x
  WHERE  x.owner = p.own
), lg AS (
  SELECT target, start_time, dur_s, auto_job
  FROM  (SELECT t.target, t.start_time,
                EXTRACT(DAY FROM (t.end_time - t.start_time)) * 86400 + EXTRACT(HOUR FROM (t.end_time - t.start_time)) * 3600
                + EXTRACT(MINUTE FROM (t.end_time - t.start_time)) * 60 + EXTRACT(SECOND FROM (t.end_time - t.start_time)) AS dur_s,
                CASE WHEN o.job_name LIKE 'ORA$AT_OS_OPT_SY%' OR t.job_name LIKE 'ORA$AT_OS_OPT_SY%' OR o.operation LIKE '%(auto)'
                     THEN 1 ELSE 0 END AS auto_job,
                ROW_NUMBER() OVER (PARTITION BY t.target ORDER BY t.start_time DESC) AS rn
         FROM   p, dba_optstat_operation_tasks t
                LEFT JOIN dba_optstat_operations o ON o.id = t.opid
         WHERE  t.target_type = 'TABLE' AND t.status = 'COMPLETED'
         AND    t.target LIKE '"' || REPLACE(REPLACE(p.own, '\', '\\'), '_', '\_') || '"."%' ESCAPE '\')
  WHERE  rn = 1
), pr AS (
  -- one row per partition of a partitioned table
  SELECT pf.table_name, s.last_analyzed,
         CASE WHEN pf.tbl_lock IS NULL AND s.stattype_locked IS NOT NULL THEN 1 ELSE 0 END AS is_locked,
         NVL(md.mods, 0) AS mods, NVL(s.num_rows, 0) AS num_rows,
         NVL(pb.blocks, NVL(s.blocks, 0)) AS blocks,
         CASE WHEN sy.partition_name IS NOT NULL THEN 1 ELSE 0 END AS has_syn,
         NVL(sy.old_fmt, 0) AS old_fmt,
         CASE WHEN s.stattype_locked IS NOT NULL AND s.last_analyzed IS NOT NULL
               AND EXISTS (SELECT 1 FROM dba_stat_extensions e
                           WHERE  e.owner = s.owner AND e.table_name = s.table_name
                           AND    NOT EXISTS (SELECT 1 FROM dba_part_col_statistics c
                                              WHERE  c.owner = s.owner AND c.table_name = s.table_name
                                              AND    c.partition_name = s.partition_name AND c.column_name = e.extension_name
                                              AND    c.last_analyzed IS NOT NULL))
              THEN 1 ELSE 0 END AS lacks_ext,
         CASE WHEN UPPER(pf.c_staleness) LIKE '%USE_STALE_PERCENT%' THEN 1 ELSE 0 END AS by_pct,
         CASE WHEN UPPER(pf.c_staleness) LIKE '%USE_LOCKED_STATS%' THEN 1 ELSE 0 END AS use_locked,
         CASE WHEN UPPER(pf.c_staleness) LIKE '%ALLOW_MIXED_FORMAT%' THEN 1 ELSE 0 END AS mixed_ok,
         TO_NUMBER(pf.c_stale DEFAULT 10 ON CONVERSION ERROR) AS stale_pct
  FROM   pf
         JOIN dba_tab_statistics s ON s.owner = pf.own AND s.table_name = pf.table_name AND s.object_type = 'PARTITION'
         LEFT JOIN md ON md.table_name = s.table_name AND md.partition_name = s.partition_name
         LEFT JOIN pblk pb ON pb.table_name = s.table_name AND pb.partition_name = s.partition_name
         LEFT JOIN sy ON sy.table_name = s.table_name AND sy.partition_name = s.partition_name
  WHERE  pf.partitioned = 'YES'
), pc AS (
  SELECT pr.*,
         -- unlocked, analysed, and under the staleness rule in force
         CASE WHEN is_locked = 0 AND last_analyzed IS NOT NULL
               AND ((mods > 0 AND (by_pct = 0 OR num_rows = 0 OR 100 * mods / num_rows > stale_pct))
                    OR (has_syn = 1 AND old_fmt = 1 AND mixed_ok = 0))
              THEN 1 ELSE 0 END AS chg,
         -- locked: no synopsis, a column group without statistics, or DML that USE_LOCKED_STATS does not forgive
         CASE WHEN is_locked = 1 AND (has_syn = 0 OR lacks_ext = 1 OR (mods > 0 AND use_locked = 0))
              THEN 1 ELSE 0 END AS lock_full
  FROM   pr
), ag AS (
  SELECT table_name,
         COUNT(*)                                                                      AS n_parts,
         SUM(CASE WHEN last_analyzed IS NULL THEN 1 ELSE 0 END)                        AS n_nostats,
         SUM(CASE WHEN mods > 0 THEN 1 ELSE 0 END)                                     AS n_dml,
         SUM(blocks)                                                                   AS p_blocks,
         SUM(CASE WHEN is_locked = 0 THEN blocks ELSE 0 END)                           AS unl_blocks,
         -- unlocked partitions a gather reads when the others have their synopses: new, changed, or without a synopsis
         SUM(CASE WHEN is_locked = 0 AND (last_analyzed IS NULL OR chg = 1 OR has_syn = 0) THEN blocks ELSE 0 END) AS nc_blocks,
         SUM(CASE WHEN is_locked = 0 AND (last_analyzed IS NULL OR chg = 1 OR has_syn = 0) THEN 1 ELSE 0 END)      AS nc_parts,
         SUM(has_syn)                                                                  AS n_syn,
         SUM(CASE WHEN is_locked = 0 AND last_analyzed IS NOT NULL AND has_syn = 0 THEN 1 ELSE 0 END) AS n_lack_syn,
         SUM(is_locked)                                                                AS n_locked,
         SUM(CASE WHEN is_locked = 1 AND mods > 0 THEN 1 ELSE 0 END)                   AS n_locked_chg,
         SUM(CASE WHEN is_locked = 1 AND (has_syn = 0 OR lacks_ext = 1) THEN 1 ELSE 0 END) AS n_locked_nosyn,
         SUM(lock_full)                                                                AS n_lock_full
  FROM   pc
  GROUP  BY table_name
), g AS (
  SELECT pf.own, pf.table_name, pf.partitioned, pf.num_rows, pf.last_analyzed, pf.stale_stats, pf.tbl_lock,
         pf.c_inc, pf.c_level, pf.c_publish, pf.c_estimate, pf.c_method_opt, pf.c_stale, pf.c_gran, pf.c_over,
         CASE WHEN pf.partitioned = 'YES' THEN NVL(ag.n_parts, 0) END                       AS n_parts,
         CASE WHEN pf.partitioned = 'YES' THEN NVL(pt.subpartitioning_type, 'NONE') END     AS sub_type,
         CASE WHEN pf.partitioned = 'YES' AND ag.p_blocks IS NOT NULL THEN ag.p_blocks
              ELSE NVL(tblk.blocks, NVL(pf.stat_blocks, 0)) END                             AS blocks,
         NVL(ag.n_nostats, 0) AS n_nostats, NVL(ag.n_dml, 0) AS n_dml, NVL(ag.n_locked, 0) AS n_locked,
         NVL(ag.unl_blocks, 0) AS unl_blocks, NVL(ag.nc_blocks, 0) AS nc_blocks, NVL(ag.nc_parts, 0) AS nc_parts,
         NVL(ag.n_lock_full, 0) AS n_lock_full, NVL(ag.n_lack_syn, 0) AS n_lack_syn,
         NVL(tmd.mods, 0) AS tbl_mods,
         NVL(ix.n_idx, 0) AS n_idx,
         CASE WHEN pe.table_name IS NOT NULL THEN 1 ELSE 0 END AS pending,
         NVL(cs.on_load, 0) AS on_load,
         -- synopses: the dictionary heuristic of collect.sql statement 1
         CASE WHEN pf.partitioned <> 'YES' THEN NULL
              WHEN NVL(ag.n_syn, 0) = 0 THEN 'none'
              WHEN NVL(cs.g_inc, 0) = 1 THEN 'all'
              WHEN NVL(ag.n_lack_syn, 0) = 0 AND (NVL(ag.n_locked_chg, 0) > 0 OR NVL(ag.n_locked_nosyn, 0) > 0) THEN 'all'
              ELSE 'stale' END AS synopses,
         lg.start_time, lg.dur_s, lg.auto_job
  FROM   pf
         LEFT JOIN ag   ON ag.table_name = pf.table_name
         LEFT JOIN tblk ON tblk.table_name = pf.table_name
         LEFT JOIN tmd  ON tmd.table_name = pf.table_name
         LEFT JOIN cs   ON cs.table_name = pf.table_name
         LEFT JOIN ix   ON ix.table_name = pf.table_name
         LEFT JOIN pe   ON pe.table_name = pf.table_name
         LEFT JOIN pt   ON pt.table_name = pf.table_name
         LEFT JOIN lg   ON lg.target = '"' || pf.own || '"."' || pf.table_name || '"'
), h AS (
  SELECT g.*,
         CASE WHEN UPPER(c_inc) = 'TRUE' THEN 1 ELSE 0 END AS inc,
         CASE WHEN UPPER(c_publish) = 'TRUE' THEN 1 ELSE 0 END AS pub,
         CASE WHEN TO_NUMBER(c_estimate DEFAULT NULL ON CONVERSION ERROR) > 0 THEN 1 ELSE 0 END AS est_fixed,
         CASE WHEN REGEXP_LIKE(UPPER(c_method_opt), '^\s*FOR\s+ALL\s+(INDEXED\s+|HIDDEN\s+)?COLUMNS\s+SIZE\s+1\s*$') THEN 'SIZE 1'
              WHEN REGEXP_LIKE(UPPER(c_method_opt), '^\s*FOR\s+ALL\s+(INDEXED\s+|HIDDEN\s+)?COLUMNS\s+SIZE\s+AUTO\s*$') THEN 'AUTO'
              WHEN REGEXP_LIKE(UPPER(c_method_opt), '^\s*FOR\s+ALL\s+(INDEXED\s+|HIDDEN\s+)?COLUMNS\s+SIZE\s+REPEAT\s*$') THEN 'REPEAT'
              WHEN REGEXP_LIKE(UPPER(c_method_opt), '^\s*FOR\s+ALL\s+(INDEXED\s+|HIDDEN\s+)?COLUMNS\s+SIZE\s+SKEWONLY\s*$') THEN 'SKEW'
              WHEN c_method_opt IS NULL THEN '?'
              ELSE 'pinned' END AS mo,
         CASE WHEN tbl_mods = 0 THEN 0 WHEN NVL(num_rows, 0) = 0 THEN 100 ELSE 100 * tbl_mods / num_rows END AS tbl_change
  FROM   g
), k AS (
  SELECT h.*,
         -- the four conditions of incremental statistics (lab A8, G1, N2, X3) plus the granularity that keeps the global statistics
         CASE WHEN partitioned = 'YES' AND inc = 1 AND NVL(UPPER(c_level), 'PARTITION') <> 'TABLE' AND pub = 1 AND est_fixed = 0
                   AND NVL(UPPER(c_gran), 'AUTO') NOT IN ('PARTITION', 'SUBPARTITION')
              THEN 1 ELSE 0 END AS eff_inc
  FROM   h
), e AS (
  SELECT k.*,
         CASE WHEN tbl_lock IS NOT NULL THEN 0
              WHEN partitioned <> 'YES' THEN blocks
              WHEN eff_inc = 0 THEN blocks * CASE WHEN NVL(UPPER(c_gran), 'AUTO') IN ('PARTITION', 'SUBPARTITION') THEN 1 ELSE 2 END
              ELSE (CASE WHEN synopses = 'none' OR (synopses = 'stale' AND n_lack_syn = 0) THEN unl_blocks ELSE nc_blocks END)
                   + CASE WHEN n_lock_full > 0 THEN blocks ELSE 0 END
         END AS est_blocks,
         CASE WHEN tbl_lock IS NOT NULL THEN 'locked: gather raises 20005'
              WHEN partitioned <> 'YES' THEN 'plain table, one pass'
              WHEN eff_inc = 0 AND NVL(UPPER(c_gran), 'AUTO') IN ('PARTITION', 'SUBPARTITION') THEN '1 pass: GRANULARITY ' || UPPER(c_gran)
              WHEN eff_inc = 0 AND inc = 0 THEN '2 passes: not incremental'
              WHEN eff_inc = 0 THEN '2 passes: '
                   || CASE WHEN pub = 0 THEN 'PUBLISH FALSE' WHEN est_fixed = 1 THEN 'fixed ESTIMATE_PERCENT' ELSE 'INCREMENTAL_LEVEL TABLE' END
              WHEN synopses = 'none' OR (synopses = 'stale' AND n_lack_syn = 0) THEN
                   'incr: synopses ' || synopses || ', every partition' || CASE WHEN n_lock_full > 0 THEN ' + full scan (locked)' END
              ELSE 'incr: ' || TO_CHAR(nc_parts) || ' new/changed partitions' || CASE WHEN n_lock_full > 0 THEN ' + full scan (locked)' END
         END AS why
  FROM   k
), r AS (
  SELECT e.*, ROW_NUMBER() OVER (ORDER BY est_blocks DESC, blocks DESC, table_name) AS rn
  FROM   e
), sm AS (
  SELECT p.own, COUNT(r.table_name) AS n_tables,
         SUM(CASE WHEN r.partitioned = 'YES' THEN 1 ELSE 0 END)           AS n_part,
         SUM(CASE WHEN r.inc = 1 THEN 1 ELSE 0 END)                       AS n_inc,
         SUM(CASE WHEN r.stale_stats = 'YES' THEN 1 ELSE 0 END)           AS n_stale,
         SUM(CASE WHEN r.last_analyzed IS NULL THEN 1 ELSE 0 END)         AS n_nostat,
         SUM(CASE WHEN r.tbl_lock IS NOT NULL THEN 1 ELSE 0 END)          AS n_lock,
         SUM(CASE WHEN r.tbl_lock IS NULL AND r.n_locked > 0 THEN 1 ELSE 0 END) AS n_lockp,
         SUM(r.pending)                                                   AS n_pend,
         SUM(r.blocks)                                                    AS t_blocks,
         SUM(r.est_blocks)                                                AS t_est,
         SUM(CASE WHEN r.rn > 200 THEN 1 ELSE 0 END)                      AS n_rest,
         SUM(CASE WHEN r.rn > 200 THEN r.est_blocks ELSE 0 END)           AS rest_est
  FROM   p LEFT JOIN r ON 1 = 1
  GROUP  BY p.own
)
SELECT line
FROM  (-- 1. title
       SELECT 1 AS sec, 0 AS ord,
              '-- Gather survey for schema ' || sm.own || ', ' || TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') || ': ' || TO_CHAR(sm.n_tables)
              || ' tables, ranked by the blocks the next plain GATHER_TABLE_STATS reads (EST.READ, see the header of survey.sql)' AS line
       FROM   sm
       UNION ALL
       SELECT 1, 1, '-- nothing below has been run; for the tables at the top run: @collect.sql ' || sm.own || ' TABLE'
       FROM   sm WHERE sm.n_tables > 0
       UNION ALL
       SELECT 1, 2, '-- no table found for ' || sm.own || ' (check the owner and that this is the PDB that owns it)'
       FROM   sm WHERE sm.n_tables = 0
       UNION ALL
       -- 2. column header
       SELECT 2, 1,
              RPAD('TABLE', 30) || ' ' || 'P' || ' ' || LPAD('PARTS', 6) || ' ' || RPAD('SUB', 5) || ' ' || LPAD('BLOCKS', 12) || ' ' || LPAD('ROWS', 14) || ' '
              || RPAD('INCR', 5) || ' ' || RPAD('EST', 5) || ' ' || RPAD('METHOD', 6) || ' ' || RPAD('PUB', 3) || ' ' || LPAD('STAL', 4) || ' ' || RPAD('GRAN', 5) || ' ' || RPAD('OVR', 3) || ' '
              || RPAD('STATE', 20) || ' ' || RPAD('SYN', 5) || ' ' || LPAD('NOST', 5) || ' ' || LPAD('DMLP', 5) || ' ' || LPAD('LKP', 4) || ' ' || LPAD('CHG%', 7) || ' '
              || LPAD('EST.READ', 12) || ' ' || LPAD('IDX', 4) || ' ' || RPAD('WHY', 44) || ' '
              || RPAD('LAST GATHER', 16) || ' ' || LPAD('SECS', 7) || ' ' || RPAD('BY', 4) || ' ' || 'HINT'
       FROM   sm WHERE sm.n_tables > 0
       UNION ALL
       SELECT 2, 2,
              RPAD('-', 30, '-') || ' ' || '-' || ' ' || RPAD('-', 6, '-') || ' ' || RPAD('-', 5, '-') || ' ' || RPAD('-', 12, '-') || ' ' || RPAD('-', 14, '-') || ' '
              || RPAD('-', 5, '-') || ' ' || RPAD('-', 5, '-') || ' ' || RPAD('-', 6, '-') || ' ' || RPAD('-', 3, '-') || ' ' || RPAD('-', 4, '-') || ' ' || RPAD('-', 5, '-') || ' ' || RPAD('-', 3, '-') || ' '
              || RPAD('-', 20, '-') || ' ' || RPAD('-', 5, '-') || ' ' || RPAD('-', 5, '-') || ' ' || RPAD('-', 5, '-') || ' ' || RPAD('-', 4, '-') || ' ' || RPAD('-', 7, '-') || ' '
              || RPAD('-', 12, '-') || ' ' || RPAD('-', 4, '-') || ' ' || RPAD('-', 44, '-') || ' '
              || RPAD('-', 16, '-') || ' ' || RPAD('-', 7, '-') || ' ' || RPAD('-', 4, '-') || ' ' || RPAD('-', 24, '-')
       FROM   sm WHERE sm.n_tables > 0
       UNION ALL
       -- 3. one line per table, at most 200
       SELECT 3, r.rn,
              RPAD(CASE WHEN LENGTH(r.table_name) > 30 THEN SUBSTR(r.table_name, 1, 29) || '~' ELSE r.table_name END, 30) || ' '
              || CASE WHEN r.partitioned = 'YES' THEN 'P' ELSE '-' END || ' '
              || LPAD(CASE WHEN r.partitioned = 'YES' THEN TO_CHAR(r.n_parts) ELSE '-' END, 6) || ' '
              || RPAD(CASE WHEN r.sub_type IS NULL OR r.sub_type = 'NONE' THEN '-' ELSE SUBSTR(r.sub_type, 1, 5) END, 5) || ' '
              || LPAD(TO_CHAR(r.blocks, 'FM999999999990'), 12) || ' '
              || LPAD(CASE WHEN r.num_rows IS NULL THEN '-' ELSE TO_CHAR(r.num_rows, 'FM99999999999990') END, 14) || ' '
              || RPAD(CASE WHEN r.c_inc IS NULL THEN '?' WHEN r.inc = 1 AND UPPER(r.c_level) = 'TABLE' THEN 'Y-TBL' WHEN r.inc = 1 THEN 'Y' ELSE 'N' END, 5) || ' '
              || RPAD(CASE WHEN r.c_estimate IS NULL THEN '?' WHEN r.est_fixed = 1 THEN SUBSTR(TRIM(r.c_estimate), 1, 5) ELSE 'AUTO' END, 5) || ' '
              || RPAD(r.mo, 6) || ' '
              || RPAD(CASE WHEN r.c_publish IS NULL THEN '?' WHEN r.pub = 1 THEN 'Y' ELSE 'N' END, 3) || ' '
              || LPAD(NVL(SUBSTR(TRIM(r.c_stale), 1, 4), '?'), 4) || ' '
              || RPAD(CASE UPPER(r.c_gran) WHEN 'AUTO' THEN 'AUTO' WHEN 'ALL' THEN 'ALL' WHEN 'PARTITION' THEN 'PART' WHEN 'SUBPARTITION' THEN 'SUBP'
                                           WHEN 'GLOBAL' THEN 'GLOB' WHEN 'GLOBAL AND PARTITION' THEN 'G+P' WHEN 'APPROX_GLOBAL AND PARTITION' THEN 'AG+P'
                                           WHEN 'DEFAULT' THEN 'DFLT' ELSE NVL(SUBSTR(r.c_gran, 1, 5), '?') END, 5) || ' '
              || RPAD(CASE WHEN r.c_over IS NULL THEN '?' WHEN UPPER(r.c_over) = 'TRUE' THEN 'Y' ELSE 'N' END, 3) || ' '
              || RPAD(NVL(TRIM(CASE WHEN r.last_analyzed IS NULL THEN 'NOSTAT ' END
                           || CASE WHEN r.stale_stats = 'YES' THEN 'STALE ' END
                           || CASE WHEN r.on_load = 1 AND r.last_analyzed IS NOT NULL THEN 'LOAD ' END
                           || CASE WHEN r.tbl_lock IS NOT NULL THEN 'LOCK ' END
                           || CASE WHEN r.pending = 1 THEN 'PEND' END), ' '), 20) || ' '
              || RPAD(NVL(r.synopses, '-'), 5) || ' '
              || LPAD(CASE WHEN r.partitioned = 'YES' THEN TO_CHAR(r.n_nostats) ELSE '-' END, 5) || ' '
              || LPAD(CASE WHEN r.partitioned = 'YES' THEN TO_CHAR(r.n_dml) ELSE '-' END, 5) || ' '
              || LPAD(CASE WHEN r.partitioned = 'YES' THEN TO_CHAR(r.n_locked) ELSE '-' END, 4) || ' '
              || LPAD(TO_CHAR(r.tbl_change, 'FM999990.0'), 7) || ' '
              || LPAD(TO_CHAR(r.est_blocks, 'FM999999999990'), 12) || ' '
              || LPAD(TO_CHAR(r.n_idx), 4) || ' '
              || RPAD(SUBSTR(r.why, 1, 44), 44) || ' '
              || RPAD(CASE WHEN r.start_time IS NULL THEN '-' ELSE TO_CHAR(r.start_time, 'YYYY-MM-DD HH24:MI') END, 16) || ' '
              || LPAD(CASE WHEN r.start_time IS NULL THEN '-' ELSE TO_CHAR(r.dur_s, 'FM999990.0') END, 7) || ' '
              || RPAD(CASE WHEN r.start_time IS NULL THEN '-' WHEN r.auto_job = 1 THEN 'auto' ELSE 'call' END, 4) || ' '
              || '@collect.sql ' || r.own || ' ' || r.table_name
       FROM   r WHERE r.rn <= 200
       UNION ALL
       -- 4. the rest
       SELECT 4, 1, '-- ... and ' || TO_CHAR(sm.n_rest) || ' more tables with an estimated ' || TO_CHAR(sm.rest_est, 'FM999999999990') || ' blocks in all (the 200 largest are listed)'
       FROM   sm WHERE sm.n_rest > 0
       UNION ALL
       -- 5. totals
       SELECT 5, 1, ' ' FROM sm WHERE sm.n_tables > 0
       UNION ALL
       SELECT 5, 2, '-- Totals: ' || TO_CHAR(sm.n_tables) || ' tables, ' || TO_CHAR(sm.n_part) || ' partitioned, ' || TO_CHAR(sm.n_inc) || ' with INCREMENTAL TRUE, '
              || TO_CHAR(sm.n_stale) || ' stale, ' || TO_CHAR(sm.n_nostat) || ' without statistics, ' || TO_CHAR(sm.n_lock) || ' locked, '
              || TO_CHAR(sm.n_lockp) || ' with locked partitions, ' || TO_CHAR(sm.n_pend) || ' with pending statistics'
       FROM   sm WHERE sm.n_tables > 0
       UNION ALL
       SELECT 5, 3, '-- Blocks: ' || TO_CHAR(sm.t_blocks, 'FM999999999990') || ' in the tables, an estimated ' || TO_CHAR(sm.t_est, 'FM999999999990')
              || ' read by one plain GATHER_TABLE_STATS per table (indexes not counted)'
       FROM   sm WHERE sm.n_tables > 0
       UNION ALL
       -- 6. why
       SELECT 6, o, txt
       FROM  (SELECT 1 AS o, ' ' AS txt FROM dual
              UNION ALL SELECT 2, '-- Why the ranking is what it is (estimated blocks, simplified from the advisor''s rules; the header of survey.sql has the formula):' FROM dual
              UNION ALL SELECT 3, '--   plain table                 read once, however stale it is: a plain GATHER_TABLE_STATS ignores staleness' FROM dual
              UNION ALL SELECT 4, '--   partitioned, not incremental every partition, then the whole table once more: two passes (lab T0, L1); one pass with GRANULARITY PARTITION' FROM dual
              UNION ALL SELECT 5, '--   incremental, synopses all   only the new or changed partitions; the global statistics come from the synopses' FROM dual
              UNION ALL SELECT 6, '--   incremental, none or stale  every unlocked partition once to build the synopses; stale with some partitions lacking one: those' FROM dual
              UNION ALL SELECT 7, '--   locked partition            with DML (no USE_LOCKED_STATS) or no synopsis: the global statistics need a full scan on every gather (lab C1, V2)' FROM dual
              UNION ALL SELECT 8, '--   table statistics locked     0: the gather raises error 20005 (statistics locked) and the automatic job skips the table' FROM dual
              UNION ALL SELECT 9, '--   IDX is the index count: CASCADE reads each index in full on top of EST.READ (lab F2, F3)' FROM dual
              UNION ALL SELECT 10, '--   LAST GATHER looks at table-level tasks only; BY auto = the automatic job, call = DBMS_STATS called by a session or a job of yours' FROM dual) w
       WHERE EXISTS (SELECT 1 FROM sm WHERE sm.n_tables > 0))
ORDER  BY sec, ord
/

UNDEFINE adv_owner
