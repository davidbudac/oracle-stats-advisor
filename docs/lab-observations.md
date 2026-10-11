# Incremental statistics lab, Oracle 19.27 (observations behind the advisor rules)

Copied from the explainer repository (`.scratch/statistics-explainer/incremental-lab-2026-10-05/observations.md`, 2026-10-05). The ids below (A1, C1, G2, ...) are the `basis` the advisor cites per finding.

Status: done. Evidence for chapter 8 of the explainer ("Setting it up correctly", Figure 8.11,
"Five tables, five setups"). `explainer/README.md` summarizes it; `tests/explainer/facts.test.mjs`
pins the Figure 8.11 model.

Setup, as SYS in PDB1 (the account is schema-only and is kept for reruns):

    create user stats_lab no authentication default tablespace orastats_ts quota 300m on orastats_ts;
    create table stats_lab.sql_snap (sql_id varchar2(13), child_number number, executions number,
                                     buffer_gets number, rows_processed number, loads number);
    create sequence stats_lab.sale_seq start with 100000000 cache 10000;

Then `./lab.sh` with scripts such as:

    @mk_sales SALES 24 30000
    exec dbms_stats.set_table_prefs('STATS_LAB','SALES','INCREMENTAL','TRUE')
    @mark
    exec dbms_stats.gather_table_stats('STATS_LAB','SALES')
    @rep SALES
    @syn SALES

`@add_load T m rows` adds and loads month m (0 = 2024-01); `@load_month` loads into an existing
month; `@stage_load` loads a staging table; `@locks`, `@hist`, `@idx T first_partition`, `@g T`
print lock, histogram, index and global state.

Method: after each gather, (a) recursive DBMS_STATS statements against the table from V$SQL
(PART = one execution per partition read; GLOBAL = one statement over the whole table; SYN =
synopsis-building; SAMPLE = sample clause), (b) partitions with new LAST_ANALYZED, (c) global
column NOTES / NUM_DISTINCT / HISTOGRAM, (d) synopsis rows in SYS.WRI$_OPTSTAT_SYNOPSIS_HEAD$.
Lab table SALES: range by SALE_DATE, monthly partitions, 30,000 rows each, 24 partitions at
start (later up to 51). PRODUCT_ID: 2,500 distinct per partition, 5,000 global.
Global prefs: all defaults (INCREMENTAL FALSE, ALLOW_MIXED_FORMAT, GRANULARITY AUTO,
AUTO_SAMPLE_SIZE, METHOD_OPT FOR ALL COLUMNS SIZE AUTO, PREFERENCE_OVERRIDES_PARAMETER FALSE).

## Baseline
- T0 INCREMENTAL FALSE, plain gather: 24 PART executions + 1 GLOBAL statement (two passes). PRODUCT_ID NDV 5000 (exact), NOTES blank.
- T1 set INCREMENTAL TRUE, plain gather: 24 PART SYN executions, no GLOBAL. Global NOTES = INCREMENTAL. PRODUCT_ID NDV 4835. All 24 partitions have HLL synopses (partition NOTES HYPERLOGLOG).
- T1b gather again, nothing changed: no recursive SQL against the table.

## Granularity / partname / estimate_percent (each after adding + loading one new month)
- A1 plain call: only new partition analyzed; global updated (NOTES INCREMENTAL).
- A2 partname only (default granularity): that partition analyzed; global updated.
- A3 partname + granularity PARTITION: partition analyzed, synopsis created; global NOT updated (NUM_ROWS unchanged). A3b plain call afterwards: no partition read, global updated (merge only).
- A4 granularity GLOBAL (no partname): 1 PART SYN execution (new partition), global updated, NOTES INCREMENTAL, no GLOBAL scan.
- A5 GLOBAL AND PARTITION: same as A4. A6 ALL: same as A4.
- A7 partname + APPROX_GLOBAL AND PARTITION: 1 PART SYN; global updated; NOTES INCREMENTAL.
- A10 granularity PARTITION without partname: only the new partition read (1 PART SYN), global not updated. A10b plain call: nothing read, global updated.
- A8 estimate_percent=>10 (33 partitions then): 33 PART SAMPLE executions + 1 GLOBAL SAMPLE; all 33 partitions re-analyzed; global NOTES blank (INCREMENTAL gone); 32 old synopses still present in SYSAUX, new partition has none. A8b plain call afterwards: 33 PART SYN executions (all partitions re-read), no global scan; NOTES INCREMENTAL again.
- X3 partname + PARTITION + estimate_percent 10: that partition sampled, no synopsis for it, global untouched; next plain gather re-read only that partition.
- N1 fresh incremental table (no synopses), first call partname + default granularity: all 6 partitions read (PART SYN x6).
- X2 non-incremental table, partname only: that partition + GLOBAL full scan.

## Staleness
- B1 default staleness, 1 row updated in an old partition: that partition re-read.
- B2 INCREMENTAL_STALENESS='USE_STALE_PERCENT' (GET_PREFS then returns exactly USE_STALE_PERCENT, ALLOW_MIXED_FORMAT gone); 300 rows (1%) updated in one old partition and 300 rows inserted into another: nothing re-read; global NUM_ROWS 990,000 while table had 990,300 rows.
- B3 15% more rows in one partition: re-read.
- B3b table pref STALE_PERCENT=1, 2% more rows in one partition: re-read.

## Locks
- C1 lock one old partition (LOCK_PARTITION_STATS), insert 300 rows into it, default staleness, plain gather: 1 GLOBAL full-table statement (NDV, no SYN), no partition re-read; global NOTES blank; NDV exact 5000. C1b gather again: same full scan again.
- X1 same plus a new loaded partition: new partition read (PART SYN x1) + GLOBAL full scan.
- C2 INCREMENTAL_STALENESS='USE_LOCKED_STATS': nothing read; global NOTES INCREMENTAL; global NUM_ROWS excludes the 300 rows.
- C3 unlock that partition, gather: it is re-read (it had DML).
- C4 lock + unlock another partition with no DML, gather: nothing re-read.
- D1 LOCK_TABLE_STATS: STATTYPE_LOCKED = ALL on table row and every partition row, including a partition added after the lock. gather_table_stats (plain, or partname+PARTITION) -> ORA-20005 object statistics are locked.
- D2 UNLOCK_PARTITION_STATS on the new partition while table locked: partition still shows ALL; gathers of that partition (with or without granularity PARTITION) and of the table still ORA-20005.
- D3 force=>TRUE with table locked: incremental gather (1 PART SYN, global updated, NOTES INCREMENTAL); lock remains.
- D4 UNLOCK_TABLE_STATS: nothing locked any more.
- D5 lock one partition, LOCK_TABLE_STATS, UNLOCK_TABLE_STATS: that one partition is still locked (ALL). Plain gather then (partition locked, no DML): nothing to read, NOTES INCREMENTAL.
- V1.7 (prefs USE_STALE_PERCENT,USE_LOCKED_STATS,ALLOW_MIXED_FORMAT) 6 old partitions locked, 20% more rows in one of them: nothing read; global from synopses.
- V1.8 MOVE PARTITION ... COMPRESS on a locked partition: nothing re-read. V1.9 same on an unlocked partition: that partition re-read once.
- V2 COPY_TABLE_STATS into a new empty partition, then LOCK_PARTITION_STATS on it (prefs include USE_LOCKED_STATS), plain gather: GLOBAL full-table scan, global NOTES blank. After load + unlock + gather: 1 partition read, NOTES INCREMENTAL.

## Histograms / column usage / METHOD_OPT (SIZE AUTO unless stated)
- E1 first-time predicates on STATUS (skewed) and SALE_DATE, plain gather: all 34 partitions re-read (PART SYN x34), no global scan (only rowid lookups of histogram endpoints). Global STATUS FREQUENCY (NOTES INCREMENTAL), global SALE_DATE HYBRID with NOTES 'INCREMENTAL HIST_FOR_INCREM_STATS'; partition-level FREQUENCY histograms.
- E2 next new month: only that partition read.
- E3i first-time predicate customer_id = 42 (uniform column): all 35 partitions re-read (PART SYN x35) plus a second sampled pass over every partition; CUSTOMER_ID gets HYBRID histograms in every partition, partition NOTES 'HIST_FOR_INCREM_STATS HYPERLOGLOG', global NOTES 'INCREMENTAL HIST_FOR_INCREM_STATS'.
- R2 (6-partition table) same test: REPORT_GATHER_TABLE_STATS listed all 6 partitions before the gather; gather read every partition twice (PART x6 + PART SYN x6).
- E3ii table pref METHOD_OPT='FOR ALL COLUMNS SIZE REPEAT', gather: nothing re-read. E3iii then new predicates on product_id and amount, gather: nothing re-read.
- V1.6 table pref METHOD_OPT='FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 STATUS' (set before first gather), USE_STALE_PERCENT: 3 rows updated in old partition + first-time predicates on customer_id, product_id, amount: nothing re-read.
- E4 CREATE_EXTENDED_STATS column group (status, product_id), gather: all 35 partitions re-read. E4b gather again: nothing.
- E5 ALTER TABLE ADD (channel varchar2(5) default 'WEB' not null), gather: no partition re-read.
- E6 call with method_opt=>'FOR ALL COLUMNS SIZE 1' (table pref REPEAT): no partition re-read; all histograms gone at global and partition level. E6b plain gather (pref REPEAT): nothing; histograms stay gone.
- F0 METHOD_OPT pref reset to SIZE AUTO, gather: all partitions re-read (usage recorded meanwhile).

## Indexes (local index on PRODUCT_ID, global index on SALE_ID)
- F2 new month loaded, plain gather (default CASCADE): table: 1 PART SYN. Local index: new index partition scanned + whole local index scanned (index-level stats, SAMPLE_SIZE = NUM_ROWS). Global index: whole index scanned.
- F3 gather again, nothing changed: both indexes scanned in full again; no table read.
- F4 cascade=>false: no index work. Then gather_index_stats(partname, granularity=>'APPROX_GLOBAL AND PARTITION'): whole index scanned + the partition.
- F5 gather_index_stats(partname, granularity=>'PARTITION'): only that index partition; index-level stats untouched.
- F6 gather_index_stats(granularity=>'GLOBAL'): one full index scan, index-level stats updated, partitions untouched.
- V1.4 with table pref PREFERENCE_OVERRIDES_PARAMETER=TRUE: gather_index_stats(partname, granularity=>'PARTITION') scanned the whole index too (index-level stats updated) plus the partition.

## PUBLISH, overrides, levels, toggling, deleting
- G1 table pref PUBLISH=FALSE, new month, plain gather: 39 PART (NDV, no SYN) + GLOBAL full scan; results in DBA_TAB_PENDING_STATS; published stats unchanged. G1b again: same two passes again. G1c delete pending, PUBLISH back to default, gather: only the new partition read (1 PART SYN); NOTES INCREMENTAL.
- G2 table pref PREFERENCE_OVERRIDES_PARAMETER=TRUE, call with estimate_percent=>10, granularity=>'PARTITION', method_opt=>'FOR ALL COLUMNS SIZE 1': behaved as plain call: 1 PART SYN, global updated, histograms intact.
- V1.5 same with estimate_percent 10, granularity ALL, method_opt size 1, cascade true (pref CASCADE FALSE): 1 partition read, global updated, histogram intact, no index scan.
- G2b table pref GRANULARITY=PARTITION, plain call: partition read, global not updated.
- N2 fresh table, INCREMENTAL TRUE + INCREMENTAL_LEVEL TABLE on the partitioned table: gather = GLOBAL SYN full scan + PART (NDV) for every partition; one table-level synopsis only; global NOTES HYPERLOGLOG. After adding a month: again every partition + global scan.
- X4 table that had partition synopses, then INCREMENTAL_LEVEL=TABLE: gather reads every partition + whole table; only a table-level synopsis remains; again on a second gather with no change. Set back to PARTITION: every partition re-read once (PART SYN), NOTES INCREMENTAL.
- L1 INCREMENTAL->FALSE, gather: two passes (all partitions + GLOBAL); synopses still present (20 partitions), partition NOTES still HYPERLOGLOG; global NOTES blank. INCREMENTAL->TRUE, gather: all 20 partitions re-read (PART SYN).
- L2 DELETE_TABLE_STATS(partname=>one partition): its synopsis gone (20 -> 19); next gather re-read only that partition.

## GATHER AUTO etc. (GATHER_SCHEMA_STATS on the lab schema; the real automatic job was NOT run)
- G6 new month = 2.3% of table; schema GATHER AUTO: new partition gathered (with synopsis); global NOT updated (NUM_ROWS and LAST_ANALYZED unchanged; table STALE_STATS = NO).
- G6b GATHER STALE: partition without stats not gathered; global unchanged. G6c GATHER EMPTY: partition gathered; global unchanged. G6d plain gather_table_stats: global updated.
- G5b gather_table_stats(options=>'GATHER AUTO') after a new month: partition read, global updated.
- G7 15% more rows in one old partition (0.3% of table), schema GATHER AUTO: that partition re-gathered; global not updated.
- G8 table pref STALE_PERCENT=1, new month 2.2% of table, schema GATHER AUTO: partition gathered, global updated from synopses (no global scan).
- G9 default STALE_PERCENT, five new months = 11% of table, schema GATHER AUTO: 5 partitions gathered, global updated from synopses.

## Exchange (target S2 with INCREMENTAL TRUE, histogram on STATUS; stage created FOR EXCHANGE)
- H1 stage INCREMENTAL TRUE + LEVEL TABLE, SIZE AUTO (no histogram), empty target partition NOT gathered: partition re-read after exchange.
- H2 same but stage has matching histogram; empty target NOT gathered: re-read.
- H3 stage LEVEL TABLE but INCREMENTAL FALSE (no synopsis), matching histogram, target not gathered: re-read.
- H4 no stats on stage: read.
- H5 empty target partition gathered first (partname + PARTITION), stage INCREMENTAL TRUE + LEVEL TABLE + matching histogram: after exchange, gather read NOTHING, global updated.
- H6 as H5 but stage gathered with SIZE AUTO (no histogram on STATUS): re-read.
- H7 as H5 but stage INCREMENTAL_LEVEL default (PARTITION): re-read.
- V3 recipe: same explicit METHOD_OPT table pref on target and stage; empty target gathered; exchange; gather read nothing. V3b next month reusing same stage table: again nothing read.
- Oracle optimizer blog (Bayliss, part 2): "The new partition must have a synopsis before the exchange".

## Partition maintenance (table S2, INCREMENTAL TRUE)
- I1 DROP PARTITION: global NUM_ROWS adjusted immediately by the DDL; next gather read nothing, global re-derived (SALE_DATE NDV dropped).
- I2 TRUNCATE PARTITION: global NUM_ROWS adjusted immediately; next gather: no table scan SQL.
- I3 first SPLIT PARTITION, then gather: 18 partitions re-read (all), and a HYBRID histogram on SALE_DATE (partition key) appeared with NOTES HIST_FOR_INCREM_STATS. I3b a second SPLIT later, gather: only the 2 new partitions read.
- I4 MERGE PARTITIONS: next gather re-read the merged partition. I5 MOVE PARTITION COMPRESS: next gather re-read that partition.
- J composite range-hash (4 hash subpartitions), GRANULARITY AUTO: partition stats + partition-level synopses, no subpartition statistics gathered. 500 rows inserted into one subpartition: whole parent partition re-read (1 PART SYN over the partition).
- K1 COPY_TABLE_STATS to new empty partition: copied NUM_ROWS at partition level, partition column NOTES blank (no synopsis), global unchanged. Plain gather right after (partition still empty): that partition analyzed, NUM_ROWS = 0.

## Staged first build / dry run
- V1.2 12 calls partname + granularity PARTITION: 12 PART SYN executions, global untouched. V1.3 plain call: nothing read, global derived (NOTES INCREMENTAL).
- V5 published loop (FETCH FIRST 4): 4 partitions, then 2, then plain call read nothing.
- R1 REPORT_GATHER_TABLE_STATS after one new month: lists TABLE + that one TABLE PARTITION; reads nothing.

## Documentation quotes (verified in fetched copies)
- Tuning Guide: conditions: PUBLISH true, INCREMENTAL true, "AUTO_SAMPLE_SIZE for ESTIMATE_PERCENT and AUTO for GRANULARITY".
- Best-practice white paper 19c: "GRANULARITY includes GLOBAL, and ESTIMATE_PERCENT is set to AUTO_SAMPLE_SIZE".
- Tuning Guide: automatic job "operates similarly to the GATHER_DATABASE_STATS procedure with the GATHER AUTO option."
- DBMS_STATS reference, options GATHER AUTO: "This option is only applicable to tables that do not have INCREMENTAL enabled."
- Tuning Guide: "the database gathers global index statistics by performing a full index scan."
- Reference: "HIST_FOR_INCREM_STATS: A histogram used to support incremental statistics has been created and it is not used for optimization."
- Tuning Guide: "Even global histograms can be derived from partition histograms."

## Follow-up runs after the independent review of the chapter text
- Ta table pref PREFERENCE_OVERRIDES_PARAMETER=TRUE, call partname + granularity PARTITION: partition read, global updated (granularity overridden, partname honoured). Ta2 partname only: same.
- Tb1 (override FALSE) new month 1.9% of table, schema GATHER AUTO: global not updated. Tb2 same table with override TRUE: partition gathered and global updated from synopses (also on a table with the example 1 preferences). Tb3 override FALSE but INCREMENTAL_STALENESS USE_STALE_PERCENT,USE_LOCKED_STATS: global not updated.
- Tc table with 6 locked partitions (USE_LOCKED_STATS in the preference), new column group: 11 unlocked partitions re-read (PART SYN) + GLOBAL full scan, global NOTES blank; second gather: GLOBAL full scan again.
- Td pinned METHOD_OPT preference, then one more histogram column added to it: every partition read twice (PART x6 + PART SYN x6); real HYBRID histogram (NOTES INCREMENTAL).
- Tf PUBLISH=FALSE, gather, PUBLISH_PENDING_STATS (global NOTES blank), PUBLISH=TRUE, gather: all 7 partitions re-read.
- Tg exchange with SIZE AUTO and no histograms on either side (empty target gathered, stage with table synopsis): gather after exchange read nothing.
- Th dry run (REPORT_GATHER_TABLE_STATS) with one locked partition that had DML, default staleness: lists a single TABLE task; the gather then did a GLOBAL full scan.
- Ti table without INCREMENTAL, 20% more rows in one partition (3% of table), schema GATHER AUTO: that partition gathered, no global scan, global not updated.
- Tj an empty partition gathered under INCREMENTAL: partition column NOTES = HYPERLOGLOG (synopsis rows exist).
- Tl new empty partition with copied statistics, locked: GLOBAL full scan on each of two gathers with USE_LOCKED_STATS, and again without it.
- Every SQL block published in the new sections was run once against a lab copy (STATS_LAB.SHOPSALES) with names substituted; all executed.
- `opatch lsinventory -bugs_fixed` of the lab home does not list bug 31464691 (the METHOD_OPT table-preference patch named in Oracle's optimizer blog).

## Column groups (2026-10-11, 19.27, plain table STATS_LAB.CG1)

- CG1: 200,000 rows, CITY (50 values) nested in COUNTRY (10 values), PRODUCT_ID (7), STATUS (2). Gathered, then
  `SEED_COL_USAGE(NULL, NULL, 300)` and four equality queries: `REPORT_COL_USAGE` lists `(CITY, COUNTRY) : FILTER`,
  `(PRODUCT_ID, STATUS) : FILTER`, `(CITY, COUNTRY, STATUS) : FILTER`; `SYS.COL_GROUP_USAGE$` holds them as column
  position lists (`2,3`, `4,5`, `2,3,5`).
- With `OPTIMIZER_ADAPTIVE_STATISTICS = FALSE` (the 19c default) the queries created no SQL plan directive. With it TRUE
  for the session, two executions each and `DBMS_SPD.FLUSH_SQL_PLAN_DIRECTIVE`: one USABLE `DYNAMIC_SAMPLING`
  directive, `SINGLE TABLE CARDINALITY MISESTIMATE`, objects CITY, COUNTRY and the table with
  `<equality_predicates_only>YES</equality_predicates_only>`. No directive for (PRODUCT_ID, STATUS), which are
  independent, nor for the range query on (SALE_DATE, STATUS).
- collect.sql: `COLUMN_GROUP_CANDIDATE_LIST = CITY,COUNTRY|directive|eq|500` (50 × 10), the three usage sets in
  `COLUMN_GROUP_USAGE_LIST`; the paste merges them into three candidates, (CITY, COUNTRY) with both sources.
- `CREATE_EXTENDED_STATS('STATS_LAB', 'CG1', '(CITY, COUNTRY)')`, no gather yet: `COLUMN_GROUPS = 1`,
  `COLUMN_CHANGE = group`, the set gone from both candidate lists. After `GATHER_TABLE_STATS`: the extension has
  NUM_DISTINCT 50 against the product of 500, no histogram (SIZE AUTO, no usage of the extension yet). The directive
  stays USABLE after the gather.
- SALES (partitioned, 35 partitions) has the lab's `(STATUS, PRODUCT_ID)` group from E4 and a directive on
  (SALE_DATE, STATUS) with `equality_predicates_only = NO`: reported as `|directive|range|6108` and not counted.

## Dictionary observations (2026-10-11, 19.27)

Read-only queries behind the collector's DETAIL block and the health check (PDB1, STATS_LAB, ORASTATS_TEST, SOE). The lab
database could not be modified in this session, so nothing below was gathered or changed.

- Q1 `DBA_OPTSTAT_OPERATION_TASKS.TARGET` is `"OWNER"."TABLE"` for a table task and `"OWNER"."TABLE"."PART"` for a partition task, with
  the double quotes. Task `NOTES` carry `<notes><histograms>A;B;</histograms><xstats>...</xstats></notes>`.
- Q2 The automatic job's row in `DBA_OPTSTAT_OPERATIONS` is `gather_database_stats (auto)` with `JOB_NAME` like `ORA$AT_OS_OPT_SY_n`.
  Its task rows have an empty `JOB_NAME`, so the job is identified from the operation row. Task rows can be duplicated.
- Q3 `DBA_TAB_MODIFICATIONS` for a composite table (STATS_LAB.C1) has only subpartition rows. For partitioned tables it varies:
  SOE.ORDER_ITEMS has a table roll-up row (5.3%, agreeing with `STALE_STATS = NO`, so summing the roll-up and the partition rows
  double-counts to 10.7%); STATS_LAB.A1 has partition rows only.
- Q4 STATS_LAB.C1 (range-hash, 6 x 4) under GRANULARITY AUTO: 6 of 6 partitions analysed, 0 of 24 subpartitions (agrees with J).
- Q5 Function-based-index hidden virtual columns appear in `DBA_STAT_EXTENSIONS` with `CREATOR = SYSTEM` and have column statistics
  (SOE.CUSTOMERS, `LOWER(CUST_LAST_NAME)`). The collector's column-group count therefore excludes expression extensions.
- Q6 `DBA_AUTO_STAT_EXECUTIONS` lists the nightly task's runs too, with `ORIGIN = AUTO_TASK`; the high-frequency task would be
  `HIGH_FREQ_AUTO_TASK` (none ran).
- Q7 `optimizer_real_time_statistics` exists in 19.27, default FALSE. `AUTO_TASK_STATUS` OFF, `AUTO_TASK_INTERVAL` 900,
  `AUTO_TASK_MAX_RUN_TIME` 3600 are the global defaults.
- Q8 `_iut_stat_collection_type` = SAMPLED. `V$INDEX_USAGE_INFO` documents SAMPLED and the 15-minute flush, so `DBA_INDEX_USAGE`
  is a sample: an index with no row is unseen, not proven unused.
- Q9 All five histogram kinds exist: ORASTATS_TEST.CAL_HB_FULL.C is HEIGHT BALANCED.
- Q10 Maintenance windows: MONDAY to FRIDAY_WINDOW start 22:00 and last 4 h; SATURDAY_WINDOW and SUNDAY_WINDOW start 06:00 and last
  20 h; WEEKNIGHT_WINDOW and WEEKEND_WINDOW exist but are disabled.
- Q11 Expression candidates, positive case: after one `SELECT` on ORASTATS_TEST.EXPR_PRED with `UPPER(T_N) = …` and
  `SUBSTR(C_N, 1, 3) = …` filters, collect.sql statement "expression candidates" (V$SQL_PLAN predicates) printed
  `EXPRESSION_CANDIDATES = SUBSTR("C_N",1,3);UPPER("T_N")`, and recommend.sql statement 6 printed the two commented
  CREATE_EXTENDED_STATS lines. The six existing expression extensions on the table were correctly excluded. The same
  query left a USABLE SQL plan directive on (C_N, T_N), which the INPUT block now reports as a directive candidate
  (`|directive|eq|`) with OPTIMIZER_ADAPTIVE_STATISTICS = FALSE at system level, so directives can be created while the
  parameter is FALSE (the Reference: it "does not control the creation of SQL plan directives").
- Q12 End-to-end run of the final collect.sql, recommend.sql and survey.sql (SYSDBA, PDB1) on STATS_LAB.SALES, C1, CG1, A1,
  ORASTATS_TEST.EXPR_PRED, ORDERS and SOE.ORDER_ITEMS: no ORA-/SP2- errors except the expected ORA-20005 of the dry run
  on the locked EXPR_PRED; every output parsed with zero ignored lines and produced all health sections.

Not verified here (listed as limits in `docs/oracle19c-review.md`): GRANULARITY AUTO on LIST or RANGE subpartitions (the lab has
HASH only); anything the high-frequency task does (it did not run); real-time statistics beside gathers (not available on the
lab); a job-driven partition exchange; the missing-privilege path of `REPORT_COL_USAGE` as a non-SYSDBA user.
