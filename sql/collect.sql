-- collect.sql: input for the gather advisor (oracle-stats-advisor)
--
-- STATUS 2026-10-08: UNTESTED. Written for Oracle 19c but not yet run against a database.
-- Read it before you run it; it issues no DDL or DML. Works for partitioned and plain tables.
--
-- Usage, in the PDB that owns the table, as a DBA (or any user who can read the DBA_* views
-- and execute DBMS_STATS):
--
--     sqlplus / as sysdba
--     SQL> alter session set container = PDB1;
--     SQL> @collect.sql SHOP SALES
--
-- Reads the dictionary only. Two calls need extra privileges and are skipped without them:
-- DBMS_STATS.FLUSH_DATABASE_MONITORING_INFO (ANALYZE ANY), which makes DBA_TAB_MODIFICATIONS
-- current, and DBMS_STATS.REPORT_COL_USAGE, which lists the columns queries have filtered on.
--
-- Paste everything between "ADVISOR INPUT BEGIN" and "ADVISOR INPUT END" into the advisor.
-- The detail after the END marker is for you: one line per partition that matters, and the
-- REPORT_GATHER_TABLE_STATS dry run, which lists the partitions the next gather would read
-- (it reads nothing). Compare its TABLE PARTITION tasks with the advisor's partition count.
--
-- Where each value comes from:
--   PARTITIONED           DBA_TABLES.PARTITIONED
--   PARTITIONS            DBA_TAB_PARTITIONS (1 for a plain table)
--   BLOCKS_PER_PARTITION  DBA_SEGMENTS blocks of the partition segments, averaged;
--                         DBA_TAB_STATISTICS blocks where a partition has no segment;
--                         the table's own blocks for a plain table
--   NUM_ROWS              DBA_TAB_STATISTICS, the TABLE row
--   COLUMNS, INDEXES      DBA_TAB_COLS (visible columns), DBA_INDEXES; LOCAL_INDEXES from DBA_PART_INDEXES
--   HISTOGRAMS            1 when any global column statistic has a histogram
--   COLUMN_USAGE          1 when DBMS_STATS.REPORT_COL_USAGE lists at least one column (1 when unavailable)
--   TABLE_STATS           gathered | none (no LAST_ANALYZED) | load (column NOTES say STATS_ON_LOAD)
--   TABLE_CHANGE_PERCENT  the table-level row of DBA_TAB_MODIFICATIONS relative to NUM_ROWS
--   the preferences       DBMS_STATS.GET_PREFS(name, owner, table): the value in force
--   SYNOPSES              DBA_PART_COL_STATISTICS NOTES with HYPERLOGLOG or ADAPTIVE_SAMPLING
--                         (that partition has a synopsis) and DBA_TAB_COL_STATISTICS NOTES with
--                         INCREMENTAL (the global statistics were merged from synopses)
--   NEW_PARTITIONS        partitions with no statistics (LAST_ANALYZED is null), plus unlocked
--                         analysed partitions without a synopsis when the table has synopses
--   CHANGED_PARTITIONS    unlocked analysed partitions with rows in DBA_TAB_MODIFICATIONS
--   CHANGE_PERCENT        the largest change among them, relative to the partition's NUM_ROWS
--   LOCKED_*              DBA_TAB_STATISTICS STATTYPE_LOCKED per partition (counted only when the
--                         table itself is not locked: under a table lock every partition shows ALL)
--   TABLE_LOCKED          STATTYPE_LOCKED on the table row
--   COLUMN_CHANGE         group: DBA_STAT_EXTENSIONS has an extension that some analysed partition
--                         has no statistics for; usage: REPORT_COL_USAGE lists a column whose global
--                         HISTOGRAM is NONE; else none
--
-- Oracle 19c. The rules the advisor applies to this input were observed on 19.27 (see
-- docs/lab-observations.md) or come from the 19c documentation.

SET SERVEROUTPUT ON SIZE UNLIMITED FORMAT WRAPPED
SET FEEDBACK OFF VERIFY OFF HEADING OFF PAGESIZE 0 LINESIZE 32767 TRIMOUT ON TRIMSPOOL ON LONG 1000000
WHENEVER SQLERROR CONTINUE

DEFINE adv_owner = &1
DEFINE adv_table = &2

DECLARE
  own          CONSTANT VARCHAR2(128) := UPPER(TRIM(BOTH '"' FROM '&adv_owner'));
  tab          CONSTANT VARCHAR2(128) := UPPER(TRIM(BOTH '"' FROM '&adv_table'));
  v_version    VARCHAR2(60) := 'unknown';
  v_partitioned VARCHAR2(3);
  is_part      BOOLEAN;
  v_count      PLS_INTEGER;
  v_num_rows   NUMBER;
  v_last_an    DATE;
  n_cols       PLS_INTEGER := 0;
  n_idx        PLS_INTEGER := 0;
  n_local      PLS_INTEGER := 0;
  has_hist     BOOLEAN := FALSE;
  usage_any    BOOLEAN := TRUE;
  tbl_stats    VARCHAR2(10) := 'gathered';
  tbl_mods     NUMBER := 0;
  tbl_change   NUMBER := 0;

  -- table level
  n_parts        PLS_INTEGER := 0;
  blocks_seg     NUMBER;        -- average segment blocks per partition
  blocks_stats   NUMBER;        -- average BLOCKS from the partition statistics
  blocks_per     NUMBER;
  table_locked   BOOLEAN := FALSE;
  global_incr    BOOLEAN := FALSE;  -- global column NOTES say INCREMENTAL
  flushed        BOOLEAN := FALSE;

  -- per partition tallies
  n_no_stats     PLS_INTEGER := 0;  -- LAST_ANALYZED null
  n_with_stats   PLS_INTEGER := 0;
  n_with_syn     PLS_INTEGER := 0;
  n_lack_syn     PLS_INTEGER := 0;  -- analysed, unlocked, no synopsis
  n_changed      PLS_INTEGER := 0;  -- analysed, unlocked, DML since the last gather
  max_change_pct NUMBER := 0;
  n_locked       PLS_INTEGER := 0;
  n_locked_chg   PLS_INTEGER := 0;
  locked_no_syn  BOOLEAN := FALSE;
  name_new       VARCHAR2(128);
  name_changed   VARCHAR2(128);
  name_locked    VARCHAR2(128);

  synopses       VARCHAR2(10);
  new_parts      PLS_INTEGER;
  column_change  VARCHAR2(10) := 'none';
  col_detail     VARCHAR2(4000);

  -- preferences
  TYPE t_names IS TABLE OF VARCHAR2(40);
  pref_names   CONSTANT t_names := t_names('INCREMENTAL', 'INCREMENTAL_LEVEL', 'INCREMENTAL_STALENESS',
                                           'PUBLISH', 'ESTIMATE_PERCENT', 'GRANULARITY', 'METHOD_OPT',
                                           'CASCADE', 'NO_INVALIDATE', 'OPTIONS', 'DEGREE',
                                           'STALE_PERCENT', 'PREFERENCE_OVERRIDES_PARAMETER');
  pref_value   VARCHAR2(4000);
  pref_incremental VARCHAR2(40) := 'FALSE';

  -- detail lines (kept short: only partitions that matter, at most 60)
  TYPE t_lines IS TABLE OF VARCHAR2(400);
  detail        t_lines := t_lines();
  n_detail_more PLS_INTEGER := 0;

  -- column usage report
  usage_clob   CLOB;
  usage_line   VARCHAR2(4000);
  usage_col    VARCHAR2(128);
  pos          PLS_INTEGER;
  nxt          PLS_INTEGER;
  v_hist       VARCHAR2(30);
  v_ndv        NUMBER;
  v_rows       NUMBER;

  dry_run      CLOB;

  PROCEDURE p(s IN VARCHAR2) IS BEGIN DBMS_OUTPUT.PUT_LINE(s); END;
  PROCEDURE kv(k IN VARCHAR2, v IN VARCHAR2) IS BEGIN DBMS_OUTPUT.PUT_LINE(k || ' = ' || v); END;
  FUNCTION yn(b IN BOOLEAN) RETURN VARCHAR2 IS BEGIN RETURN CASE WHEN b THEN '1' ELSE '0' END; END;
  PROCEDURE note(s IN VARCHAR2) IS
  BEGIN
    IF detail.COUNT < 60 THEN detail.EXTEND; detail(detail.COUNT) := s; ELSE n_detail_more := n_detail_more + 1; END IF;
  END;
  PROCEDURE put_clob(c IN CLOB) IS
    l_pos PLS_INTEGER := 1;
    l_nl  PLS_INTEGER;
    l_len PLS_INTEGER := DBMS_LOB.GETLENGTH(c);
  BEGIN
    WHILE l_pos <= l_len LOOP
      l_nl := DBMS_LOB.INSTR(c, CHR(10), l_pos);
      IF l_nl = 0 THEN
        p(DBMS_LOB.SUBSTR(c, LEAST(l_len - l_pos + 1, 4000), l_pos));
        EXIT;
      END IF;
      p(DBMS_LOB.SUBSTR(c, LEAST(l_nl - l_pos, 4000), l_pos));
      l_pos := l_nl + 1;
    END LOOP;
  END;
BEGIN
  -- ---------------------------------------------------------------- the table
  BEGIN  -- dynamic, so a missing privilege on V$INSTANCE is a runtime exception, not a compile error
    EXECUTE IMMEDIATE 'SELECT version_full FROM v$instance' INTO v_version;
  EXCEPTION WHEN OTHERS THEN
    BEGIN EXECUTE IMMEDIATE 'SELECT version FROM product_component_version WHERE ROWNUM = 1' INTO v_version; EXCEPTION WHEN OTHERS THEN NULL; END;
  END;

  BEGIN
    SELECT partitioned INTO v_partitioned FROM dba_tables WHERE owner = own AND table_name = tab;
  EXCEPTION WHEN NO_DATA_FOUND THEN
    p('-- ERROR: table ' || own || '.' || tab || ' not found in this container. Run in the PDB that owns it, as a user who can read DBA_TABLES.');
    RETURN;
  END;
  is_part := v_partitioned = 'YES';

  IF is_part THEN
    SELECT COUNT(*) INTO n_parts FROM dba_tab_partitions WHERE table_owner = own AND table_name = tab;
    SELECT ROUND(SUM(blocks) / NULLIF(COUNT(*), 0)) INTO blocks_seg
    FROM   dba_segments
    WHERE  owner = own AND segment_name = tab AND segment_type IN ('TABLE PARTITION', 'TABLE SUBPARTITION');
    SELECT ROUND(AVG(blocks)) INTO blocks_stats
    FROM   dba_tab_statistics
    WHERE  owner = own AND table_name = tab AND object_type = 'PARTITION' AND blocks IS NOT NULL;
  ELSE
    n_parts := 1;
    SELECT SUM(blocks) INTO blocks_seg FROM dba_segments WHERE owner = own AND segment_name = tab AND segment_type = 'TABLE';
    SELECT MAX(blocks) INTO blocks_stats FROM dba_tab_statistics WHERE owner = own AND table_name = tab AND object_type = 'TABLE';
  END IF;
  blocks_per := GREATEST(NVL(blocks_seg, NVL(blocks_stats, 1)), 1);

  SELECT MAX(num_rows), MAX(last_analyzed) INTO v_num_rows, v_last_an
  FROM   dba_tab_statistics WHERE owner = own AND table_name = tab AND object_type = 'TABLE';
  SELECT COUNT(*) INTO n_cols FROM dba_tab_cols WHERE owner = own AND table_name = tab AND hidden_column = 'NO';
  SELECT COUNT(*) INTO n_idx FROM dba_indexes WHERE table_owner = own AND table_name = tab;
  BEGIN
    SELECT COUNT(*) INTO n_local FROM dba_part_indexes WHERE owner = own AND table_name = tab AND locality = 'LOCAL';
  EXCEPTION WHEN OTHERS THEN n_local := 0;
  END;
  SELECT COUNT(*) INTO v_count FROM dba_tab_col_statistics WHERE owner = own AND table_name = tab AND histogram IS NOT NULL AND histogram <> 'NONE';
  has_hist := v_count > 0;
  IF v_last_an IS NULL THEN
    tbl_stats := 'none';
  ELSE
    SELECT COUNT(*) INTO v_count FROM dba_tab_col_statistics WHERE owner = own AND table_name = tab AND notes LIKE '%STATS_ON_LOAD%';
    IF v_count > 0 THEN tbl_stats := 'load'; END IF;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM   dba_tab_statistics
  WHERE  owner = own AND table_name = tab AND object_type = 'TABLE' AND stattype_locked IS NOT NULL;
  table_locked := v_count > 0;

  SELECT COUNT(*) INTO v_count
  FROM   dba_tab_col_statistics
  WHERE  owner = own AND table_name = tab AND notes LIKE '%INCREMENTAL%';
  global_incr := v_count > 0;

  -- make DBA_TAB_MODIFICATIONS current (needs ANALYZE ANY; skipped otherwise)
  BEGIN
    DBMS_STATS.FLUSH_DATABASE_MONITORING_INFO;
    flushed := TRUE;
  EXCEPTION WHEN OTHERS THEN
    flushed := FALSE;
  END;

  SELECT NVL(SUM(NVL(inserts, 0) + NVL(updates, 0) + NVL(deletes, 0)), 0) INTO tbl_mods
  FROM   dba_tab_modifications
  WHERE  table_owner = own AND table_name = tab AND partition_name IS NULL;
  tbl_change := CASE WHEN tbl_mods = 0 THEN 0 WHEN NVL(v_num_rows, 0) = 0 THEN 100 ELSE ROUND(100 * tbl_mods / v_num_rows, 2) END;

  -- ---------------------------------------------------------------- the partitions
  FOR r IN (
    SELECT s.partition_name, s.partition_position, s.num_rows, s.blocks, s.last_analyzed, s.stattype_locked, s.stale_stats,
           NVL(m.inserts, 0) + NVL(m.updates, 0) + NVL(m.deletes, 0) AS mods,
           CASE WHEN EXISTS (SELECT 1 FROM dba_part_col_statistics c
                             WHERE  c.owner = s.owner AND c.table_name = s.table_name
                             AND    c.partition_name = s.partition_name
                             AND   (c.notes LIKE '%HYPERLOGLOG%' OR c.notes LIKE '%ADAPTIVE_SAMPLING%'))
                THEN 1 ELSE 0 END AS has_syn
    FROM   dba_tab_statistics s
           LEFT JOIN dba_tab_modifications m
                  ON m.table_owner = s.owner AND m.table_name = s.table_name
                 AND m.partition_name = s.partition_name AND m.subpartition_name IS NULL
    WHERE  s.owner = own AND s.table_name = tab AND s.object_type = 'PARTITION' AND v_partitioned = 'YES'
    ORDER  BY s.partition_position
  ) LOOP
    DECLARE
      is_locked BOOLEAN := (NOT table_locked) AND r.stattype_locked IS NOT NULL;
      is_new    BOOLEAN := r.last_analyzed IS NULL;
      pct       NUMBER  := CASE WHEN r.mods = 0 THEN 0
                                WHEN NVL(r.num_rows, 0) = 0 THEN 100
                                ELSE ROUND(100 * r.mods / r.num_rows, 1) END;
      flags     VARCHAR2(200) := '';
    BEGIN
      IF r.has_syn = 1 THEN n_with_syn := n_with_syn + 1; END IF;
      IF is_new THEN
        n_no_stats := n_no_stats + 1;
        IF name_new IS NULL THEN name_new := r.partition_name; END IF;
        flags := 'no statistics';
      ELSE
        n_with_stats := n_with_stats + 1;
      END IF;
      IF is_locked THEN
        n_locked := n_locked + 1;
        IF name_locked IS NULL THEN name_locked := r.partition_name; END IF;
        flags := flags || CASE WHEN flags IS NULL THEN '' ELSE ', ' END || 'locked (' || r.stattype_locked || ')';
        IF r.mods > 0 THEN
          n_locked_chg := n_locked_chg + 1;
          name_locked := r.partition_name;  -- prefer a locked partition that changed
        END IF;
        IF NOT is_new AND r.has_syn = 0 THEN locked_no_syn := TRUE; flags := flags || ', no synopsis'; END IF;
      ELSIF NOT is_new THEN
        IF r.has_syn = 0 THEN n_lack_syn := n_lack_syn + 1; flags := flags || CASE WHEN flags IS NULL THEN '' ELSE ', ' END || 'no synopsis'; END IF;
        IF r.mods > 0 THEN
          n_changed := n_changed + 1;
          IF pct > max_change_pct THEN max_change_pct := pct; name_changed := r.partition_name; END IF;
          IF name_changed IS NULL THEN name_changed := r.partition_name; END IF;
        END IF;
      END IF;
      IF r.mods > 0 THEN
        flags := flags || CASE WHEN flags IS NULL THEN '' ELSE ', ' END
                 || TO_CHAR(r.mods, 'FM999,999,999,990') || ' rows changed (' || TO_CHAR(pct, 'FM9990.0') || '% of ' || TO_CHAR(NVL(r.num_rows, 0), 'FM999,999,999,990') || ')';
      END IF;
      IF flags IS NOT NULL THEN
        note('--   ' || RPAD(r.partition_name, 32) || ' ' || flags
             || CASE WHEN r.stale_stats IS NOT NULL THEN '; STALE_STATS=' || r.stale_stats END);
      END IF;
    END;
  END LOOP;

  -- ---------------------------------------------------------------- synopsis state
  IF n_with_syn = 0 THEN
    synopses := 'none';
    new_parts := n_no_stats;
  ELSIF global_incr THEN
    synopses := 'all';
    new_parts := n_no_stats + n_lack_syn;
  ELSE
    synopses := 'stale';
    new_parts := n_no_stats;
  END IF;

  -- ---------------------------------------------------------------- column changes
  -- a column group (or other extension) that some analysed partition has no statistics for
  BEGIN
    SELECT COUNT(*) INTO v_count
    FROM   dba_stat_extensions e
    WHERE  e.owner = own AND e.table_name = tab
    AND    EXISTS (SELECT 1 FROM dba_tab_statistics s
                   WHERE  s.owner = e.owner AND s.table_name = e.table_name AND s.object_type = 'PARTITION'
                   AND    s.last_analyzed IS NOT NULL
                   AND    NOT EXISTS (SELECT 1 FROM dba_part_col_statistics c
                                      WHERE  c.owner = s.owner AND c.table_name = s.table_name
                                      AND    c.partition_name = s.partition_name AND c.column_name = e.extension_name
                                      AND    c.last_analyzed IS NOT NULL));
    IF v_count > 0 THEN
      column_change := 'group';
      col_detail := TO_CHAR(v_count) || ' extension(s) without statistics in some analysed partition';
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- a column that queries filtered on and that has no global histogram yet
  IF column_change = 'none' THEN
    BEGIN
      usage_any := FALSE;
      usage_clob := DBMS_STATS.REPORT_COL_USAGE(own, tab);
      pos := 1;
      WHILE pos <= NVL(DBMS_LOB.GETLENGTH(usage_clob), 0) LOOP
        nxt := DBMS_LOB.INSTR(usage_clob, CHR(10), pos);
        IF nxt = 0 THEN nxt := DBMS_LOB.GETLENGTH(usage_clob) + 1; END IF;
        usage_line := DBMS_LOB.SUBSTR(usage_clob, LEAST(nxt - pos, 4000), pos);
        pos := nxt + 1;
        -- report lines look like "1. CUSTOMER_ID                     : EQ"
        usage_col := REGEXP_SUBSTR(usage_line, '^\s*\d+\.\s+(\S+)\s*:', 1, 1, NULL, 1);
        IF usage_col IS NOT NULL THEN
          usage_any := TRUE;
          BEGIN
            SELECT histogram, num_distinct, (SELECT num_rows FROM dba_tab_statistics t
                                             WHERE t.owner = own AND t.table_name = tab AND t.object_type = 'TABLE')
            INTO   v_hist, v_ndv, v_rows
            FROM   dba_tab_col_statistics
            WHERE  owner = own AND table_name = tab AND column_name = usage_col;
            -- a column with every value distinct gets no histogram; everything else used in a predicate does
            IF NVL(v_hist, 'NONE') = 'NONE' AND NOT (v_ndv IS NOT NULL AND v_rows IS NOT NULL AND v_ndv >= v_rows) THEN
              column_change := 'usage';
              col_detail := col_detail || CASE WHEN col_detail IS NULL THEN '' ELSE ', ' END || usage_col;
            END IF;
          EXCEPTION WHEN NO_DATA_FOUND THEN NULL;
          END;
        END IF;
      END LOOP;
      IF column_change = 'usage' THEN col_detail := 'used in predicates, no histogram yet: ' || col_detail; END IF;
    EXCEPTION WHEN OTHERS THEN
      usage_any := TRUE;
      col_detail := 'REPORT_COL_USAGE not available (' || SQLERRM || '); COLUMN_CHANGE assumed none, COLUMN_USAGE assumed 1';
    END;
  END IF;

  -- ---------------------------------------------------------------- output
  p('-- Gather advisor input for ' || own || '.' || tab);
  p('-- collected ' || TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') || ' on Oracle ' || v_version
    || '; paste from BEGIN to END into the advisor');
  p('-- ADVISOR INPUT BEGIN');
  kv('OWNER', own);
  kv('TABLE_NAME', tab);
  kv('PARTITIONED', CASE WHEN is_part THEN 'YES' ELSE 'NO' END);
  kv('PARTITIONS', TO_CHAR(n_parts));
  kv('BLOCKS_PER_PARTITION', TO_CHAR(blocks_per));
  kv('NUM_ROWS', TO_CHAR(NVL(v_num_rows, 0)));
  kv('COLUMNS', TO_CHAR(n_cols));
  kv('INDEXES', TO_CHAR(n_idx));
  kv('LOCAL_INDEXES', TO_CHAR(n_local));
  kv('HISTOGRAMS', yn(has_hist));
  kv('COLUMN_USAGE', yn(usage_any));
  kv('TABLE_STATS', tbl_stats);
  kv('TABLE_CHANGE_PERCENT', TO_CHAR(tbl_change, 'FM9999990.00'));
  FOR i IN 1 .. pref_names.COUNT LOOP
    BEGIN
      pref_value := DBMS_STATS.GET_PREFS(pref_names(i), own, tab);
    EXCEPTION WHEN OTHERS THEN
      pref_value := NULL;
    END;
    IF pref_names(i) = 'INCREMENTAL' THEN pref_incremental := NVL(pref_value, 'FALSE'); END IF;
    kv(pref_names(i), NVL(pref_value, 'NULL'));
  END LOOP;
  kv('SYNOPSES', synopses);
  kv('NEW_PARTITIONS', TO_CHAR(new_parts));
  kv('NEW_PARTITION', name_new);
  kv('CHANGED_PARTITIONS', TO_CHAR(n_changed));
  kv('CHANGED_PARTITION', name_changed);
  kv('CHANGE_PERCENT', TO_CHAR(CASE WHEN n_changed = 0 THEN 0 ELSE GREATEST(max_change_pct, 0.1) END, 'FM9990.0'));
  kv('LOCKED_PARTITIONS', TO_CHAR(n_locked));
  kv('LOCKED_CHANGED', TO_CHAR(n_locked_chg));
  kv('LOCKED_PARTITION', name_locked);
  kv('LOCKED_NO_SYNOPSIS', yn(locked_no_syn));
  kv('TABLE_LOCKED', yn(table_locked));
  kv('COLUMN_CHANGE', column_change);
  p('-- ADVISOR INPUT END');
  p('--');
  p('-- Detail (not parsed by the advisor)');
  IF is_part THEN
    p('--   ' || n_parts || ' partitions, ' || n_with_stats || ' with statistics, ' || n_no_stats || ' without, '
      || n_with_syn || ' with a synopsis; global column NOTES ' || CASE WHEN global_incr THEN 'say INCREMENTAL' ELSE 'do not say INCREMENTAL' END);
  ELSE
    p('--   not partitioned: the partition keys above are placeholders; TABLE_STATS and TABLE_CHANGE_PERCENT describe the table');
  END IF;
  p('--   table-level DML since the last gather: ' || TO_CHAR(tbl_mods, 'FM999,999,999,990') || ' rows (' || TO_CHAR(tbl_change, 'FM9999990.00') || '% of NUM_ROWS)');
  p('--   blocks per partition: ' || NVL(TO_CHAR(blocks_seg), 'n/a') || ' from DBA_SEGMENTS, '
    || NVL(TO_CHAR(blocks_stats), 'n/a') || ' from the partition statistics');
  IF NOT flushed THEN
    p('--   DBA_TAB_MODIFICATIONS was NOT flushed (FLUSH_DATABASE_MONITORING_INFO needs ANALYZE ANY): changes of the last few minutes may be missing');
  END IF;
  IF col_detail IS NOT NULL THEN p('--   column change: ' || col_detail); END IF;
  IF n_lack_syn > 0 AND synopses = 'all' THEN
    p('--   ' || n_lack_syn || ' analysed partition(s) have no synopsis and are counted in NEW_PARTITIONS: the next gather reads them to build one');
  END IF;
  IF synopses = 'stale' THEN
    p('--   synopses exist but the global NOTES lack INCREMENTAL: the last gather was not incremental, or a staged build has not been merged yet. Either way the next plain gather reads every unlocked partition once.');
  END IF;
  IF n_changed > 1 THEN
    p('--   CHANGE_PERCENT is the largest change among the ' || n_changed || ' changed partitions; the advisor applies one figure to all of them');
  END IF;
  IF pref_incremental <> 'TRUE' THEN
    p('--   INCREMENTAL is not TRUE: synopsis columns above are informational only');
  END IF;
  IF detail.COUNT > 0 THEN
    p('--   Partitions that matter (new, changed, locked or without a synopsis):');
    FOR i IN 1 .. detail.COUNT LOOP p(detail(i)); END LOOP;
    IF n_detail_more > 0 THEN p('--   ... and ' || n_detail_more || ' more'); END IF;
  ELSE
    p('--   No partition is new, changed, locked or without a synopsis.');
  END IF;

  -- ---------------------------------------------------------------- dry run
  p('--');
  p('-- Dry run: DBMS_STATS.REPORT_GATHER_TABLE_STATS lists what the next gather would read (reads nothing).');
  p('-- Compare its TABLE PARTITION tasks with the partitions the advisor says are read.');
  BEGIN
    dry_run := DBMS_STATS.REPORT_GATHER_TABLE_STATS(ownname => own, tabname => tab, detail_level => 'TYPICAL', format => 'TEXT');
    put_clob(dry_run);
  EXCEPTION WHEN OTHERS THEN
    p('-- (dry run not available: ' || SQLERRM || ')');
  END;
END;
/

UNDEFINE adv_owner
UNDEFINE adv_table
