# Oracle Database 19c fact sheet for the gather advisor

Purpose: a citable `basis` for advisor findings. Each fact has the exact Oracle sentence(s), URL + section, and where useful
the lab observation (19.27 EE, PDB1, `dbmint`, read-only queries run 2026-10-11).

Conventions
- **Quote**: copied from the fetched page (whitespace collapsed). Not paraphrased.
- **Status**: `DOCUMENTED` (quote exists), `PARTLY` (docs say less than the claim), `NOT DOCUMENTED` (docs silent; lab check or
  external source noted), `DOCS CONFLICT` (two Oracle pages disagree), `LAB` (observed on 19.27).
- Base URL `B` = `https://docs.oracle.com/en/database/oracle/oracle-database/19/`. Pages are the live "19" docs fetched
  2026-10-11; they include later release-update material (e.g. `OPTIMIZER_REAL_TIME_STATISTICS` "available starting with ... 19.10",
  `WAIT_TIME_TO_UPDATE_STATS`), so a page may describe more than base 19.0.
- Book abbreviations: **TG** = SQL Tuning Guide (`B`tgsql/), **PLS** = PL/SQL Packages and Types Reference, `DBMS_STATS`
  (`B`arpls/DBMS_STATS.html, section numbers 179.7.x), **REF** = Database Reference (`B`refrn/), **ADM** = Administrator's Guide
  (`B`admin/), **LIC** = Licensing Information User Manual (`B`dblic/Licensing-Information.html).
- Fetch/parse recipe is at the end (appendix). Lab queries are listed in the appendix.

---------------------------------------------------------------------------------------------------------------------------------

## 1. Histograms

Source for 1.1-1.8: TG ch. 11 "Histograms", `B`tgsql/histograms.html.

**1.1 Kinds.** DOCUMENTED. Section "Histograms" (intro).
> "The types of histograms are as follows: Frequency histograms and top frequency histograms; Height-Balanced histograms (legacy); Hybrid histograms"

`DBA_TAB_COL_STATISTICS.HISTOGRAM` values (REF `ALL_TAB_COL_STATISTICS`, `B`refrn/ALL_TAB_COL_STATISTICS.html): `NONE`, `FREQUENCY`,
`HEIGHT BALANCED`, `HYBRID`, `TOP-FREQUENCY` (note the hyphen in TOP-FREQUENCY, the space in HEIGHT BALANCED).

**1.2 Decision variables.** DOCUMENTED. Section "How Oracle Database Chooses the Histogram Type".
> "NDV: This represents the number of distinct values in a column." / "n: This variable represents the number of histogram buckets. The default is 254." / "p: This variable represents an internal percentage threshold that is equal to (1-(1/ n )) * 100. For example, if n = 254, then p is 99.6." / "An additional criterion is whether the estimate_percent parameter in the DBMS_STATS statistics gathering procedure is set to AUTO_SAMPLE_SIZE (default)."

**1.3 Frequency.** DOCUMENTED. Section "Criteria For Frequency Histograms".
> "NDV is less than or equal to n , where n is the number of histogram buckets (default 254 )." and "The estimate_percent parameter in the DBMS_STATS statistics gathering procedure is set to either a user-specified value or to AUTO_SAMPLE_SIZE ."

> "Starting in Oracle Database 12c , if the sampling size is the default of AUTO_SAMPLE_SIZE , then the database creates frequency histograms from a full table scan. For all other sampling percentage specifications, the database derives frequency histograms from a sample."

**1.4 Top-frequency.** DOCUMENTED. Section "Criteria For Top Frequency Histograms".
> "NDV is greater than n , where n is the number of histogram buckets (default 254 )." / "The percentage of rows occupied by the top n frequent values is equal to or greater than threshold p , where p is (1-(1/ n ))*100 ." / "The estimate_percent parameter in the DBMS_STATS statistics gathering procedure is set to AUTO_SAMPLE_SIZE ."

**1.5 Height-balanced (legacy).** DOCUMENTED. Section "Criteria for Height-Balanced Histograms".
> "NDV is greater than n , where n is the number of histogram buckets (default 254 )." / "The estimate_percent parameter in the DBMS_STATS statistics gathering procedure is not set to AUTO_SAMPLE_SIZE ." / "It follows that if Oracle Database 12c creates new histograms, and if the sampling percentage is AUTO_SAMPLE_SIZE , then the histograms are either top frequency or hybrid, but not height-balanced."

Replacement on regather (same section): "If the sampling percentage is AUTO_SAMPLE_SIZE , then the database creates either hybrid or frequency histograms." / "If the sampling percentage is not AUTO_SAMPLE_SIZE , then the database creates either height-balanced or frequency histograms." Simulating 11g: "To simulate Oracle Database 11g behavior, which is necessary to create a height-based histogram, set estimate_percent to a nondefault value."

**1.6 Hybrid.** DOCUMENTED. Section "Criteria for Hybrid Histograms".
> "NDV is greater than n , where n is the number of histogram buckets (default is 254 )." / "The criteria for top frequency histograms do not apply." / "The estimate_percent parameter in the DBMS_STATS statistics gathering procedure is set to AUTO_SAMPLE_SIZE ." / "If users specify their own percentage, then the database creates frequency or height-balanced histograms."

**1.7 Sample size used for the build.** PARTLY. Intro: "In some cases, when creating a histogram, the database samples an internally predetermined number of rows." The number (about 5,500) is NOT DOCUMENTED.
LAB: `SAMPLE_SIZE` of HYBRID histograms on 100,000-row tables: 5,442 (CAL_HYBRID.C), 5,530 (CAL_HB.C), 5,546 (CAL_NOHIST.C_HYB), 5,528 (HCAL_EQ.DOM30); FREQUENCY and TOP-FREQUENCY on the same tables: 100,000 (full table). So HYBRID is built from a ~5.5k-row sample, FREQUENCY/TOP-FREQUENCY from all rows (AUTO_SAMPLE_SIZE).

**1.8 Lab: all five kinds exist.** LAB. `ORASTATS_TEST`: FREQUENCY 58 columns; HYBRID 28; TOP-FREQUENCY 2 (CAL_TOPFREQ.C, CAL_NOHIST.C_TOP: 254 buckets, NDV 300); **HEIGHT BALANCED 1** (`CAL_HB_FULL.C`: 254 buckets, NDV 1,500, SAMPLE_SIZE 20,000 = whole 20,000-row table; the gather call that made it was not recorded, consistent with a non-AUTO estimate). CAL_HB.C is HYBRID (sample 5,530), as expected for AUTO_SAMPLE_SIZE.

**1.9 Maximum buckets.** PARTLY. PLS `GATHER_TABLE_STATS` (179.7.54), `method_opt`; same text in GATHER_SCHEMA/DATABASE/DICTIONARY_STATS and in the SET_*_PREFS METHOD_OPT entries.
> "integer : Number of histogram buckets. Must be in the range [1,2048]."

Preference form (SET_DATABASE_PREFS, 179.7.114): "integer — Specifies the number of histogram buckets. The number must be between 1 and 2048." The statement that 2048 is new in 12c (11g: 254) is NOT DOCUMENTED on these pages.

**1.10 SIZE clauses.** DOCUMENTED. PLS `GATHER_TABLE_STATS` `method_opt`, `B`arpls/DBMS_STATS.html.
> "size_clause is defined as size_clause := SIZE {integer | REPEAT | AUTO | SKEWONLY}" / "REPEAT : Collects histograms only on the columns that already have histograms." / "AUTO : Oracle determines the columns on which to collect histograms based on data distribution and the workload of the columns." / "SKEWONLY : Oracle determines the columns on which to collect histograms based on the data distribution of the columns." / "The default is FOR ALL COLUMNS SIZE AUTO ."

**1.11 SIZE AUTO uses SYS.COL_USAGE$.** DOCUMENTED. TG "Histograms", section "When Oracle Database Creates Histograms".
> "If DBMS_STATS gathers statistics for a table, and if queries have referenced the columns in this table, then Oracle Database creates histograms automatically as needed according to the previous query workload."
> "The database notes the predicates in the preceding query and updates the data dictionary table SYS.COL_USAGE$ ." / "You run DBMS_STATS again, causing DBMS_STATS to query SYS.COL_USAGE$ to determine which columns require histograms based on the previous query workload."
> "If you gather statistics for a table and do not query the table, then the database does not create histograms for columns in this table. For the database to create the histograms automatically, you must run one or more queries to populate the column usage information in SYS.COL_USAGE$ ."

The exact phrase "referenced in predicates" is **not** on the page; use the quotes above ("queries have referenced the columns", "notes the predicates"). Which predicate types count is NOT DOCUMENTED in the Tuning Guide; the `REPORT_COL_USAGE` legend (TG "Managing Extended Statistics", "Detecting Useful Column Groups for a Specific Workload") names the usage kinds recorded: `EQ`, `RANGE`, `LIKE`, `NULL`, `EQ_JOIN`, `NONEQ_JOIN`, `FILTER`, `JOIN`, `GROUP_BY` ("EQ : Used in single table EQuality predicate", ...).
Purpose of a histogram (TG "Purpose of Histograms"): "For columns that contain data skew (a nonuniform distribution of data within the column), a histogram enables the optimizer to generate accurate cardinality estimates for filter and join predicates that involve these columns." The sentence "a histogram on a column with no predicate usage is useless" is an inference, not an Oracle sentence.
Also: "As queries change over time, DBMS_STATS may change which statistics it gathers. For example, even if the data in a table does not change, queries and DBMS_STATS operations can cause the plans for queries that reference these tables to change."
LAB: `SYS.COL_USAGE$` has 4,777 rows in PDB1.

**1.12 DBA_TAB_COL_STATISTICS columns for histograms.** DOCUMENTED. REF `ALL_TAB_COL_STATISTICS` (DBA_ view: "Its columns are the same as those in ALL_TAB_COL_STATISTICS", `B`refrn/DBA_TAB_COL_STATISTICS.html).
> `NUM_BUCKETS`: "Number of buckets in histogram for the column"
> `DENSITY`: "If a histogram is available on COLUMN_NAME , then this column displays the selectivity of a value that spans fewer than 2 endpoints in the histogram. It does not represent the selectivity of values that span 2 or more endpoints." / "If a histogram is not available on COLUMN_NAME , then the value of this column is 1 / NUM_DISTINCT ."
> `SAMPLE_SIZE`: "Sample size used in analyzing this column"
> `GLOBAL_STATS`: "GLOBAL_STATS will be YES if statistics are gathered or incrementally maintained, otherwise it will be NO" ; `USER_STATS`: "Indicates whether statistics were entered directly by the user ( YES ) or not ( NO )"

LAB: FREQUENCY NUM_BUCKETS = NUM_DISTINCT (e.g. 12/12, 200/200); HYBRID, TOP-FREQUENCY and HEIGHT BALANCED have 254 (or the requested SIZE; CAL_HYB_SMALL.C: 32 buckets, NDV 989).

**1.13 NOTES = HIST_FOR_INCREM_STATS.** DOCUMENTED, but on a different view than asked. REF `ALL_PART_COL_STATISTICS`, `B`refrn/ALL_PART_COL_STATISTICS.html:
> "HIST_FOR_INCREM_STATS : A histogram used to support incremental statistics has been created and it is not used for optimization."

The 19c `ALL_TAB_COL_STATISTICS` page lists only `INCREMENTAL` ("A value of INCREMENTAL indicates that the global statistics are derived from synopses, that is, the global statistics are incrementally maintained.") and `STATS_ON_CONVENTIONAL_LOAD` for NOTES. Same list on the partition page: `ADAPTIVE_SAMPLING`, `HISTOGRAM_ONLY` ("Table statistics were gathered using the GATHER AUTO option and histograms were gathered without re-gathering other table and column statistics."), `HYPERLOGLOG`, `INCREMENTAL` ("The column has synopses."), `STATS_ON_LOAD` ("Online statistics were gathered during direct path load.").
LAB: `DBA_TAB_COL_STATISTICS.NOTES` distinct values in PDB1: blank (43,952), `HYPERLOGLOG` 48, `STATS_ON_LOAD` 47, `INCREMENTAL` 39, `INCREMENTAL HIST_FOR_INCREM_STATS` 5. So the value does occur at table-level column rows, combined with INCREMENTAL (space separated).

**1.14 Histograms after online (bulk-load) statistics.** DOCUMENTED. TG ch. 10 "Histogram Creation After Bulk Loads", `B`tgsql/optimizer-statistics-concepts.html: "After gathering online statistics, the database does not automatically create histograms." and "If histograms are required, then after the bulk load Oracle recommends running DBMS_STATS.GATHER_TABLE_STATS with options=>GATHER AUTO ."

---------------------------------------------------------------------------------------------------------------------------------

## 2. Extended statistics

Source: TG ch. 14 "Managing Extended Statistics", `B`tgsql/managing-extended-statistics.html, unless noted.

**2.1 What they are.** DOCUMENTED. Intro: "An extension is either a column group or an expression. Column group statistics can improve cardinality estimates when multiple columns from the same table occur together in a SQL statement. Expression statistics improves optimizer estimates when predicates use expressions, for example, built-in or user-defined functions."
Restriction (same page, Note): "You cannot create extended statistics on virtual columns."

**2.2 Which predicates a column group helps.** DOCUMENTED (positive list). Section "About Statistics on Column Groups", Note:
> "The optimizer uses column group statistics for equality predicates, inlist predicates, and for estimating the GROUP BY cardinality."

"Not used for range predicates": there is **no sentence** saying range predicates cannot use a group. The nearest Oracle text is TG ch. 10 "Dynamic Statistics ... Insufficient statistics" (`B`tgsql/optimizer-statistics-concepts.html): "The optimizer can use dynamic statistics to compensate for the lack of extended statistics or when it cannot use extended statistics, for example, for non-equality predicates." Cite that, and phrase it as the equality/IN-list/GROUP BY list.
PLS overview ("Extended Statistics"): "if a query has predicates c1=1 and c2=1 and if there are statistics on column group (c1, c2), the optimizer uses these statistics for estimating the combined cardinality of the predicates. The optimizer uses the expression statistics to estimate cardinality of predicates on those expressions."

**2.3 Expression statistics.** DOCUMENTED. Section "About Expression Statistics":
> "For an expression in the form ( function ( col )= constant ) applied to a WHERE clause column, the optimizer does not know how this function affects predicate cardinality unless a function-based index exists. However, you can gather expression statistics on the expression ( function ( col ) itself."

Section intro: "The type of extended statistics known as expression statistics improve optimizer estimates when a WHERE clause has predicates that use expressions."

**2.4 Limit on extensions.** DOCUMENTED, wording ambiguous. PLS `CREATE_EXTENDED_STATS` (179.7.12), Usage Notes:
> "The total number of extensions in a table cannot be greater than a maximum of (20, 10% of number of non-virtual columns in the table)."

The page writes "a maximum of (20, 10% ...)"; "the greater of 20 and 10%" is the reading of max(); Oracle never says "greater". Other restrictions from the same list: "The extension cannot contain a virtual column." / "Extensions cannot be created on tables owned by SYS." / "Extensions cannot be created on cluster tables, index organized tables, temporary tables, or external tables." / "The number of columns in a column group must be in the range [2, 32]." / "A column cannot appear more than once in a column group." / "The extension can contain an expression only if a corresponding virtual column has been created." / "An expression must contain at least one column." / "An expression cannot contain a subquery." / "The COMPATIBLE parameter must be 11.0.0.0.0 or greater." Exceptions: "ORA-20007 : Extension already exists", "ORA-20008 : Reached the upper limit on number of extensions". Not tested in the lab (would need DDL).

**2.5 Signature.** DOCUMENTED, LAB-confirmed (`ALL_ARGUMENTS`). `CREATE_EXTENDED_STATS(ownname, tabname, extension) RETURN VARCHAR2` and `CREATE_EXTENDED_STATS(ownname, tabname) RETURN CLOB` (no extension: "This second form of this function creates statistics extensions based on the column group usage recorded by the SEED_COL_USAGE Procedure . This function returns a report of extensions created."). Also: "The database gathers statistics for this extension when a user-initiated or automatic statistics gathering job gathers statistics for the table."
`DROP_EXTENDED_STATS(ownname, tabname, extension)`: "This function drops the statistics entry that is created for the user specified extension." / "If no extended statistics set is created for the extension, this function throws an error." (179.7.31).
`SHOW_EXTENDED_STATS_NAME(ownname, tabname, extension) RETURN VARCHAR2`: "This function returns the name of the statistics entry that is created for the user-specified extension. It raises an error if no extension has been created." (179.7.123).

**2.6 Workflow SEED_COL_USAGE -> REPORT_COL_USAGE -> CREATE_EXTENDED_STATS.** DOCUMENTED.
TG "Detecting Useful Column Groups for a Specific Workload": "You can use DBMS_STATS.SEED_COL_USAGE and REPORT_COL_USAGE to determine which column groups are required for a table based on a specified workload. This technique is useful when you do not know which extended statistics to create. **This technique does not work for expression statistics.**"
TG Table 14-1: "To determine the appropriate column groups, the database must observe a representative workload. You do not need to run the queries themselves during the monitoring period. Instead, you can run EXPLAIN PLAN for some longer-running queries in your workload to ensure that the database is recording column group information for these queries." / REPORT_COL_USAGE: "Generates a report that lists the columns that were seen in filter predicates, join predicates, and GROUP BY clauses in the workload."
PLS `SEED_COL_USAGE` (179.7.111): "This procedure also records group of columns. You can create extensions for the recorded group of columns using the CREATE_EXTENDED_STATS Function procedure." / "This monitoring procedure records different information from the traditional column usage information that is visible in SYS.COL_USAGE$ . The procedure stores information in SYS.COL_GROUP_USAGE$ ." Signature `SEED_COL_USAGE(sqlset_name, owner_name, time_limit POSITIVE DEFAULT NULL)`; "If this parameter and owner_name are both null, then the procedure monitors all statements in the database for the specified time limit." Privileges: "you must have the ANALYZE ANY privilege and the ANALYZE ANY DICTIONARY privilege."
PLS `REPORT_COL_USAGE` (179.7.90): "This function reports the recorded column (group) usage information." Privilege: "you need to have the SYSDBA administrative privilege or both ANALYZE ANY DICTIONARY and ANALYZE ANY system privileges."
So: SEED_COL_USAGE records **column groups** only for CREATE_EXTENDED_STATS; expressions are not proposed (TG quote). LAB: `SYS.COL_GROUP_USAGE$` has 229 rows. `REPORT_COL_USAGE('ORASTATS_TEST','EXPR_PRED')` lists the six existing expression virtual columns with `EQ RANGE NULL`; that is ordinary `COL_USAGE$` usage of already-created expression columns, not evidence that SEED_COL_USAGE proposes expressions.

**2.7 AUTO_STAT_EXTENSIONS.** DOCUMENTED. PLS prefs (179.7.114/115): "ON — When applicable, a SQL plan directive can trigger the creation of column group statistics based on usage of columns in the predicates in the workload." / "OFF — The database does not create column group statistics automatically. The database creates them only when the CREATE_EXTENDED_STATS function is executed, or when extended statistics are specified explicitly in the METHOD_OPT clause of DBMS_STATS . This is the default." TG: "If the DBMS_STATS preference AUTO_STAT_EXTENSIONS is set to ON (by default it is OFF ), then a SQL plan directive can automatically trigger the creation of column group statistics based on usage of predicates in the workload."
LAB: `GET_PREFS('AUTO_STAT_EXTENSIONS')` = `OFF`.

**2.8 Function-based index and the hidden virtual column.** PARTLY. Oracle does **not** state in the 19c docs that creating a function-based index creates a hidden virtual column with column statistics. The documented pieces:
- TG 2.3 above ("unless a function-based index exists").
- SQL Language Reference, CREATE INDEX (`B`sqlrf/CREATE-INDEX.html): "After creating a function-based index, collect statistics on both the index and its base table using the DBMS_STATS package. Such statistics will enable Oracle Database to correctly decide when to use the index."
- ADM "Managing Indexes", "Virtual Columns" (`B`admin/managing-indexes.html): "A table index defined on a virtual column is equivalent to a function-based index on the table."
- REF `ALL_STAT_EXTENSIONS`: `CREATOR` "Creator of the extension: USER / SYSTEM"; `DROPPABLE` "Indicates whether the extension is droppable using DBMS_STATS.DROP_EXTENDED_STATS ( YES ) or not ( NO )".
LAB (19.27): `SOE.CUSTOMERS` has hidden virtual columns `SYS_NC00017$` = `LOWER("CUST_LAST_NAME")` and `SYS_NC00018$` = `LOWER("CUST_FIRST_NAME")` (`DBA_TAB_COLS`: HIDDEN_COLUMN YES, VIRTUAL_COLUMN YES). `DBA_STAT_EXTENSIONS` lists both with `CREATOR = SYSTEM` (user-created extensions on ORASTATS_TEST show `CREATOR = USER`; 43 SYSTEM rows, 19 USER rows in PDB1). `DBA_TAB_COL_STATISTICS` has statistics for them (NDV 1,000, HYBRID, 254 buckets). `DBA_IND_EXPRESSIONS` shows the one index `CUST_FUNC_LOWER_NAME_IX` (a two-expression FBI) with `LOWER("CUST_LAST_NAME")` position 1 and `LOWER("CUST_FIRST_NAME")` position 2. Conclusion for the advisor: an expression extension on the same expression as an existing FBI is redundant (docs imply it via "unless a function-based index exists"; the lab shows the FBI's hidden column in DBA_STAT_EXTENSIONS with statistics). CREATE_EXTENDED_STATS "The extension cannot contain a virtual column" is about extensions that reference a virtual column, not about the FBI's own column. A column group listing the FBI's hidden column is unverified.

---------------------------------------------------------------------------------------------------------------------------------

## 3. Index statistics

**3.1 Clustering factor.** DOCUMENTED. TG ch. 10 "Index Clustering Factor" (`B`tgsql/optimizer-statistics-concepts.html):
> "For a B-tree index, the index clustering factor measures the physical grouping of rows in relation to an index value, such as last name." / "A clustering factor that is close to the number of blocks in a table indicates that the rows are physically ordered in the table blocks by the index key." / "A clustering factor that is close to the number of rows indicates that the rows are scattered randomly across the database blocks in relation to the index key." / "The clustering factor is a property of a specific index, not a table."

REF `ALL_IND_STATISTICS` / `ALL_INDEXES` `CLUSTERING_FACTOR`: "Indicates the amount of order of the rows in the table based on the values of the index." / "If the value is near the number of blocks, then the table is very well ordered. In this case, the index entries in a single leaf block tend to point to rows in the same data blocks." / "If the value is near the number of rows, then the table is very randomly ordered." (ALL_INDEXES adds: "For bitmap indexes, this column is not applicable.")

**3.2 TABLE_CACHED_BLOCKS.** PARTLY. PLS SET_TABLE_PREFS / SET_*_PREFS / GET_PREFS, the whole 19c text:
> "TABLE_CACHED_BLOCKS: Specifies the average number of blocks assumed to be cached in the buffer cache when calculating the index clustering factor."

The range "0..255 or AUTO" and the meaning of the value are NOT DOCUMENTED on the 19c DBMS_STATS page (no "255" anywhere in it; no "AUTO" value listed). LAB: `GET_PREFS('TABLE_CACHED_BLOCKS')` = `1` (global) and `1` for `SOE.CUSTOMERS`, i.e. default 1 observed. (The 0-255/AUTO range comes from non-19c-doc sources: lab-check by `SET_GLOBAL_PREFS` was not done, DDL-like.)

**3.3 When AUTO_CASCADE gathers index statistics.** NOT DOCUMENTED beyond the constant. PLS `GATHER_TABLE_STATS` (179.7.54) `cascade`:
> "Determines whether to collect index statistics as part of gathering table statistics. Specifying this option is equivalent to running the GATHER_INDEX_STATS procedure on each index of the table. Use the constant DBMS_STATS.AUTO_CASCADE to enable the database to determine whether index statistics need to be collected. This is the default."

No criteria are given. Defaults: LAB `GET_PREFS('CASCADE')` = `DBMS_STATS.AUTO_CASCADE`. `docs/lab-observations.md` F2/F3 observed every index scanned in full on every gather under AUTO_CASCADE.
TG (incremental): "If a table uses incremental statistics, and if this table has a locally partitioned index, then the database gathers index statistics at the global level and for modified (not unmodified) index partitions. The database does not generate global index statistics from the partition-level index statistics. Rather, the database gathers global index statistics by performing a full index scan." (TG "Considerations for Incremental Statistics Maintenance", `B`tgsql/gathering-optimizer-statistics.html.)

**3.4 DBA_INDEX_USAGE and index usage tracking.** DOCUMENTED (view); sampling PARTLY documented.
REF `DBA_INDEX_USAGE` (`B`refrn/DBA_INDEX_USAGE.html): "DBA_INDEX_USAGE displays cumulative statistics for each index." `TOTAL_ACCESS_COUNT` "Total number of times the index has been accessed"; `TOTAL_EXEC_COUNT` "Total executions the index has participated in"; `TOTAL_ROWS_RETURNED` "Total rows returned by the index."; `LAST_USED` "Time that the index was last used"; buckets: "Index usage is categorized into buckets of different ranges. Each bucket has a range of values for access count and rows returned." (`BUCKET_0_ACCESS_COUNT` "The index has not been accessed", ... `BUCKET_1000_PLUS_ROWS_RETURNED` "The index has returned more than 1000 rows".)
REF `V$INDEX_USAGE_INFO` (`B`refrn/V-INDEX_USAGE_INFO.html) **does** document the sampling and the flush:
> "V$INDEX_USAGE_INFO keeps track of index usage since the last flush. A flush occurs every 15 minutes. After each flush, ACTIVE_ELEM_COUNT is reset to 0 and LAST_FLUSH_TIME is updated to the current time."
> `INDEX_STATS_COLLECTION_TYPE`: "0 : Indicates the ALL collection type. With this type of collection, the statistics are collected for each execution that has index access. Selecting this statistics collection type may have some impact on performance." / "1 : Indicates the SAMPLED collection type. With this type of collection, the statistics are collected based on sampling (only a few of the executions are considered when collecting the statistics). This is the default statistics collection type." / "Index statistics collected with the SAMPLED collection type are less accurate than index statistics collected with the ALL collection type."

NOT in the docs: the hidden parameter name `_iut_stat_collection_type` (SAMPLED/ALL). LAB: `x$ksppi/x$ksppcv` in PDB1: `_iut_enable` TRUE, `_iut_max_entries` 30000, `_iut_stat_collection_type` **SAMPLED** (default); `V$INDEX_USAGE_INFO`: INDEX_STATS_ENABLED 1, INDEX_STATS_COLLECTION_TYPE 1, MAX_ELEM_COUNT 30000, FLUSH_COUNT 44. `DBA_INDEX_USAGE` has 30 rows (LAST_USED 2026-08-29 .. 2026-10-10); example of a sampled miss: `ORASTATS_TEST.ORDERS_CUSTOMER_IX` TOTAL_ACCESS_COUNT 0 with TOTAL_EXEC_COUNT 345. Other index-monitoring route: ADM "Monitoring Index Usage": `ALTER INDEX index MONITORING USAGE` + `USER_OBJECT_USAGE` ("The view contains a USED column whose value is YES or NO"; not used by the advisor).

**3.5 Unusable and invisible indexes; their statistics.** Behaviour DOCUMENTED, statistics NOT DOCUMENTED. ADM "Understand When to Use Unusable or Invisible Indexes" (`B`admin/managing-indexes.html):
> "An unusable index is ignored by the optimizer and is not maintained by DML." / "An invisible index is ignored by the optimizer unless you explicitly set the OPTIMIZER_USE_INVISIBLE_INDEXES initialization parameter to TRUE at the session or system level. Unlike unusable indexes, an invisible index is maintained during DML statements."

REF `ALL_INDEXES`: `STATUS` "Indicates whether a nonpartitioned index is VALID or UNUSABLE" (partitioned shows N/A: LAB `EVENTS_TYPE_IX` STATUS N/A); `VISIBILITY` "Indicates whether the index is VISIBLE or INVISIBLE to the optimizer". The 19c DBMS_STATS and Tuning Guide pages do not say whether `GATHER_*_STATS` skips unusable indexes or gathers invisible ones: NOT DOCUMENTED; lab check needed (no UNUSABLE or INVISIBLE index in ORASTATS_TEST/SOE; a broader lookup timed out on the flaky lab link and was not completed).

---------------------------------------------------------------------------------------------------------------------------------

## 4. Staleness and the automatic task

**4.1 STALE_PERCENT rule.** DOCUMENTED. PLS prefs (179.7.115) and SET_SCHEMA_PREFS / SET_TABLE_PREFS:
> "STALE_PERCENT: Determines the percentage of rows in a table that must change before the statistics on that table are stale and need to be regathered." / "The valid domain for stale_percent is non-negative numbers. The default value is 10 , which means that a table having more than 10% of changes is considered stale."

SET_TABLE_PREFS adds: "Note that if you set stale_percent to zero the AUTO STATS gathering job will gather statistics for this table every time a row in the table is modified."
TG ch. 13 "Gathering Schema and Table Statistics" (`B`tgsql/gathering-optimizer-statistics.html): "If a monitored table has been modified more than 10%, then the database considers these statistics stale and gathers them again." LAB: `GET_PREFS('STALE_PERCENT')` = 10.

**4.2 DBA_TAB_MODIFICATIONS and STALE_STATS.** DOCUMENTED. TG "Determining When Optimizer Statistics Are Stale":
> "Monitoring tracks the approximate number of DML operations on a table and whether the table has been truncated since the most recent statistics collection. To check whether statistics are stale, query the STALE_STATS column in DBA_TAB_STATISTICS and DBA_IND_STATISTICS . This column is based on data in the DBA_TAB_MODIFICATIONS view and the STALE_PERCENT preference for DBMS_STATS ."
> `STALE_STATS` values: "YES: The statistics are stale." / "NO: The statistics are not stale." / "null: The statistics are not collected." (LAB: 2 YES, 450 NO, 24 NULL among ORASTATS_TEST/SOE/STATS_LAB rows.)

REF `ALL_TAB_MODIFICATIONS`: "describes tables accessible to the current user that have been modified since the last time statistics were gathered on the tables." `INSERTS` "Approximate number of inserts since the last time statistics were gathered" (same for UPDATES, DELETES); `TRUNCATED` "Indicates whether the table has been truncated since the last analyze ( YES ) or not ( NO )"; `DROP_SEGMENTS` "Number of partition and subpartition segments dropped since the last analyze".
Also TG: "Because the database does not permit data manipulation against external tables, the database never marks statistics on external tables as stale."

**4.3 When monitoring info is flushed.** PARTLY. TG, same section, Note:
> "Starting in Oracle Database 12c Release 2 (12.2), you no longer need to use DBMS_STATS.FLUSH_DATABASE_MONITORING_INFO to ensure that view metadata is current. The statistics shown in the DBA_TAB_STATISTICS , DBA_IND_STATISTICS , and DBA_TAB_MODIFICATIONS views are obtained from both disk and memory."

PLS `FLUSH_DATABASE_MONITORING_INFO` (179.7.46): "This procedure saves monitoring information for all tables in the dictionary. The database immediately updates corresponding entries in the *_TAB_MODIFICATIONS , *_TAB_STATISTICS and *_IND_STATISTICS views." The "SMON every ~15 minutes" interval is NOT DOCUMENTED in the 19c books fetched. (The only 15-minute flushes in the docs are SQL plan directives and `V$INDEX_USAGE_INFO`.)

**4.4 Maintenance windows.** DOCUMENTED; the brief's WEEKNIGHT/WEEKEND names are the 10g windows. ADM ch. 26 Table 26-1 "Predefined Maintenance Windows" (`B`admin/managing-automated-database-maintenance-tasks.html): "MONDAY_WINDOW: Starts at 10 p.m. on Monday and ends at 2 a.m." (same for TUESDAY..FRIDAY), "SATURDAY_WINDOW: Starts at 6 a.m. on Saturday and is 20 hours long." (and SUNDAY_WINDOW). "The weekend maintenance windows, SATURDAY_WINDOW and SUNDAY_WINDOW , are longer in duration than the weekday maintenance windows. The window group MAINTENANCE_WINDOW_GROUP consists of these seven windows."
LAB (`DBA_SCHEDULER_WINDOWS`): MONDAY..FRIDAY `freq=daily;byday=XXX;byhour=22;byminute=0; bysecond=0`, duration `+000 04:00:00`; SATURDAY/SUNDAY `byhour=6`, `+000 20:00:00`; all ENABLED. `WEEKNIGHT_WINDOW` (duration +000 08:00:00, 22:00 Mon-Fri) and `WEEKEND_WINDOW` (+002 00:00:00, Sat 00:00) exist but are **disabled**; WEEKNIGHT is 8 h, not 4. `DBA_AUTOTASK_CLIENT`: `auto optimizer stats collection` ENABLED, window group `ORA$AT_WGRP_OS`.
ADM also: "In the case of a very long maintenance window, all automated maintenance tasks except Automatic SQL Tuning Advisor are restarted every four hours." LAB: SATURDAY_WINDOW (20 h) job history for the stats client shows runs started 14:19, 18:29 and 22:29 local on 2026-10-10, durations 4-11 s.

**4.5 What the task gathers and AUTOSTATS_TARGET.** DOCUMENTED.
ADM 26.1: "Automatic Optimizer Statistics Collection— Collects optimizer statistics for all schema objects in the database for which there are no statistics or only stale statistics."
TG ch. 13 "About Automatic Optimizer Statistics Collection": "To collect the optimizer statistics, the database calls an internal procedure that operates similarly to the GATHER_DATABASE_STATS procedure with the GATHER AUTO option. Automatic statistics collection honors all preferences set in the database."
PLS (SET_GLOBAL_PREFS, 179.7.115): "AUTOSTATS_TARGET: Controls the objects considered for statistics collection. It takes the following values: 'ALL' - Statistics collected for all objects in system / 'ORACLE' - Statistics collected for all Oracle owned objects / 'AUTO' - Oracle decides on which objects to collect statistics / This preference is applicable only for automatic statistics collection." LAB: `AUTOSTATS_TARGET` = `AUTO`.

**4.6 Priority order.** PARTLY. TG "About Automatic Optimizer Statistics Collection":
> "The principal difference between manual and automatic collection is that the latter prioritizes database objects that need statistics. Before the maintenance window closes, automatic collection assesses all objects and prioritizes objects that have no statistics or very old statistics."

Oracle says "no statistics or very old statistics", not "most stale". Tools: "you can reproduce the object prioritization of automatic collection by using the DBMS_AUTO_TASK_IMMEDIATE package." REF `DBA_OPTSTAT_OPERATION_TASKS`: STATUS `SKIPPED` "Task has been skipped, as it does not exist any more, or its stats are not stale (applies only to only automatic statistics gathering)"; `PENDING` "Task is queued for processing". PLS REPORT_SINGLE_STATS_OPERATION detail ALL includes "rank in the target list" and "reason for including the object in the target list (applies to only automatic statistics gathering operation tasks)".

**4.7 DBA_AUTOTASK_* views.** DOCUMENTED. ADM Table 26-2 "Automated Maintenance Tasks Database Dictionary Views": `DBA_AUTOTASK_CLIENT_JOB`, `DBA_AUTOTASK_CLIENT` ("Provides statistical data for each automated maintenance task over 7-day and 30-day periods."), `DBA_AUTOTASK_JOB_HISTORY` ("Lists the history of automated maintenance task job runs. Jobs are added to this view after they finish executing."), `DBA_AUTOTASK_WINDOW_CLIENTS`, `DBA_AUTOTASK_CLIENT_HISTORY`. Task is enabled via `DBMS_AUTO_TASK_ADMIN.ENABLE/DISABLE(client_name => 'auto optimizer stats collection', operation => NULL, window_name => NULL)`.
LAB: operation name in `DBA_OPTSTAT_OPERATIONS` is `gather_database_stats (auto)` (50 COMPLETED, last 2026-10-11 05:29 UTC, params `cascade NULL`, `concurrent TRUE`, `estimate_percent DEFAULT_ESTIMATE_PERCENT`, `granularity DEFAULT_GRANULARITY`, `method_opt DEFAULT_METHOD_OPT`); `DBA_AUTO_STAT_EXECUTIONS`: 50 rows, all `AUTO_TASK`/`COMPLETED`.

**4.8 When the window closes before the task finishes.** NOT DOCUMENTED ("resumes next window" is not stated in the ADM or TG pages fetched). What is documented is the status:
> REF `DBA_OPTSTAT_OPERATIONS` STATUS: "TIMED OUT : Maintenance window was not enough to complete this operation (applies only to automatic statistics gathering)"; `DBA_OPTSTAT_OPERATION_TASKS`: "TIMED OUT : Maintenance window was not enough to complete this task (applies only to automatic statistics gathering)"; `DBA_AUTO_STAT_EXECUTIONS`: "TIMED OUT : The operation timed out because the time allocated for the maintenance window was not sufficient for the operation to complete".

Prioritising (4.6) is what makes a next-window continuation work in practice (objects still lacking or having old statistics rank first again), but Oracle does not say so. LAB: no TIMED OUT operation exists in PDB1 (`DBA_OPTSTAT_OPERATIONS` statuses: COMPLETED, FAILED, IN PROGRESS; tasks: 9,270 COMPLETED, 57 FAILED).

---------------------------------------------------------------------------------------------------------------------------------

## 5. High-frequency automatic statistics and licensing

**5.1 What it is and gathers.** DOCUMENTED. TG ch. 13 "Configuring High-Frequency Automatic Optimizer Statistics Collection" (`B`tgsql/gathering-optimizer-statistics.html):
> "High-frequency automatic optimizer statistics collection complements the standard statistics collection job. By default, the collection occurs every 15 minutes, meaning that statistics have less time in which to be stale." / "The high-frequency task is "lightweight" and only gathers stale statistics. It does not perform actions such as purging statistics for non-existent objects or invoking Optimizer Statistics Advisor. The standard automated job performs these additional tasks." / "The high-frequency task may execute in maintenance windows, but it will not execute while the maintenance window auto stats gathering job is executing. You can monitor the tasks by querying DBA_AUTO_STAT_EXECUTIONS ."

TG ch. 10: "Oracle Database 19c introduces high-frequency automatic optimizer statistics collection . This lightweight task periodically gathers statistics for stale objects. The default interval is 15 minutes."

**5.2 Preferences.** DOCUMENTED. TG (same section) and PLS SET_GLOBAL_PREFS (179.7.115):
> "AUTO_TASK_STATUS: Enables or disables the high-frequency automatic optimizer statistics collection . Values are: ON ... OFF — Disables high-frequency automatic optimizer statistics collection . This is the default."
> "AUTO_TASK_MAX_RUN_TIME: Configures the maximum runtime in seconds of an execution of the the high-frequency automatic statistics collection. The default is 3600 but varies among Oracle Database platforms." (TG: "The maximum value is 3600 (equal to 1 hour), which is the default.")
> "AUTO_TASK_INTERVAL: Specifies the interval in seconds between executions of high-frequency automatic optimizer statistics collection . The minimum value is 60 . The default is 900 (equal to 15 minutes)."

The two Oracle pages differ on AUTO_TASK_MAX_RUN_TIME ("maximum value is 3600 ... default" vs "default is 3600 but varies among platforms"). LAB: `AUTO_TASK_STATUS` OFF, `AUTO_TASK_INTERVAL` 900, `AUTO_TASK_MAX_RUN_TIME` 3600.

**5.3 DBA_AUTO_STAT_EXECUTIONS.** DOCUMENTED. REF (`B`refrn/DBA_AUTO_STAT_EXECUTIONS.html): "DBA_AUTO_STAT_EXECUTIONS displays information about automatic optimizer statistics collection tasks, which are executed by the automated maintenance tasks infrastructure (known as AutoTask)." `ORIGIN`: "AUTO_TASK : A standard automatic optimizer statistics collection task ..." / "HIGH_FREQ_AUTO_TASK : A high-frequency automatic optimizer statistics collection task, which is executed at frequent intervals and complements the standard automatic optimizer statistics collection tasks"; `STATUS`: IN PROGRESS / COMPLETED / FAILED / TIMED OUT; counters COMPLETED, FAILED, TIMED_OUT, IN_PROGRESS. "This view is available starting with Oracle Database 19c." LAB: columns OPID, ORIGIN, STATUS, START_TIME, END_TIME, COMPLETED, FAILED, TIMED_OUT, IN_PROGRESS (match).

**5.4 Licensing (LIC).** DOCUMENTED. `B`dblic/Licensing-Information.html, "Table 1-8 Performance" (columns: SE2, EE, EE-ES, BaseDB SE, BaseDB EE, BaseDB EE-HP, BaseDB EE-EP, ExaDB):
- Row "Real-Time Statistics": `N N Y N N N N Y`, note "EE-ES : Available on Exadata. Not available on Oracle Database Appliance."
- Row "High-Frequency Automatic Optimizer Statistics Collection": `N N Y N N N N Y`, note "EE-ES : Available on Exadata. Not available on Oracle Database Appliance."
- Same pattern for "Automatic Indexing" and "SQL Quarantine".

So in 19c both are Y only for Enterprise Edition on Engineered Systems (Exadata) and ExaDB; N for plain EE and all Base Database. The 19.22 relaxation note in the manual applies to Automatic SQL Plan Management, not to these rows. TG ch. 10 "Real-Time Statistics" carries the pointer "Oracle Database Licensing Information User Manual for details on which features are supported for different editions and services". LAB: the parameters and prefs exist on the plain-EE VM (`optimizer_real_time_statistics`, `AUTO_TASK_*`), which does not make them licensed.

---------------------------------------------------------------------------------------------------------------------------------

## 6. Real-time statistics

**6.1 What and how.** DOCUMENTED. TG ch. 10 "Real-Time Statistics" (`B`tgsql/optimizer-statistics-concepts.html):
> "Oracle Database can automatically gather real-time statistics during conventional DML operations." / "Oracle Database 19c introduces real-time statistics , which extend online support to conventional DML statements." / "Whereas bulk load operations gather all necessary statistics, real-time statistics augment rather than replace traditional statistics. For this reason, you must continue to gather statistics regularly using DBMS_STATS , preferably using the AutoTask job." / "When a DML operation is currently modifying a table, Oracle Database dynamically computes values for the most essential statistics."

Which statistics: only "the most essential statistics" is stated. The worked example (TG "Real-Time Statistics: Example") shows, for the table level, `NUM_ROWS` (918,843 -> 1,837,686) with `BLOCKS` unchanged (3,315) and, per column, `LOW_VALUE`/`HIGH_VALUE` merged with the gathered ones, sample size about 1% of the inserted rows ("The sample size is 9073, which is roughly 1% of the 918,843 rows inserted."). No NDV, histogram or index statistics. The plan shows `OPTIMIZER STATISTICS GATHERING` under `LOAD TABLE CONVENTIONAL`. Statistics are table-level only: "Note that partition-level statistics are not supported, so the only table-level views show real-time statistics."

**6.2 NOTES value: DOCS CONFLICT.** Tuning Guide (Table 10-4, example): "Real-time statistics are indicated by STATS_ON_CONVENTIONAL_DML in the NOTES column and SHARED in the SCOPE column." REF `ALL_TAB_COL_STATISTICS`: "A value of STATS_ON_CONVENTIONAL_LOAD indicates that the statistics are obtained by online statistics gathering for conventional DML. Footnote: The STATS_ON_CONVENTIONAL_LOAD value is available starting with Oracle Database 19c." (`ALL_TAB_STATISTICS` NOTES says the same `...LOAD`.) Neither value can be observed in the lab (RT statistics off, no table with the NOTES); real value needs DML + `ALTER SESSION SET optimizer_real_time_statistics=true` (not run). The advisor text uses `STATS_ON_CONVENTIONAL_DML` (Tuning Guide).

**6.3 Parameter.** DOCUMENTED + LAB. REF `OPTIMIZER_REAL_TIME_STATISTICS` (`B`refrn/OPTIMIZER_REAL_TIME_STATISTICS.html): "When this parameter is set to true , the database automatically gathers real-time statistics during conventional DML operations. The default setting is false , which means real-time statistics are disabled." Boolean, modifiable `ALTER SESSION, ALTER SYSTEM`, modifiable in a PDB. "This parameter is available starting with Oracle Database 19c, Release Update 19.10." LAB `V$PARAMETER`: `optimizer_real_time_statistics` = FALSE, ISDEFAULT TRUE, "optimizer real time statistics on conventional DML".

**6.4 Hint and DBMS_STATS.** DOCUMENTED. TG: "The NO_GATHER_OPTIMIZER_STATISTICS hint prevents the collection of real-time statistics ." "By default, DBMS_STATS subprograms include real-time statistics . You can also specify parameters to include only these statistics." (`stat_category` value `REALTIME_STATS` on EXPORT/IMPORT/DELETE; `DIFF_TABLE_STATS_IN_HISTORY` and `DIFF_TABLE_STATS_IN_STATTAB` "The statistics always include real-time statistics".) LAB `GET_PREFS('STAT_CATEGORY')` = `OBJECT_STATS, REALTIME_STATS` (PLS says the default is `OBJECT_STATS, SYNOPSES, REALTIME_STATS, MODELS`, a difference between the doc and what GET_PREFS returns on 19.27).

---------------------------------------------------------------------------------------------------------------------------------

## 7. Pending statistics

Source: TG ch. 15 "Publishing Pending Optimizer Statistics" (`B`tgsql/controlling-the-use-of-optimizer-statistics.html) and PLS.

**7.1 Concept.** DOCUMENTED. "By default, the database automatically publishes statistics when the statistics collection ends. Alternatively, you can use pending statistics to save the statistics and not publish them immediately after the collection." / "By default, the optimizer uses published statistics. You can change the default behavior by setting the OPTIMIZER_USE_PENDING_STATISTICS initialization parameter to true (the default is false )." / "The best practice is to set this parameter at the session level rather than at the database level."
PLS prefs: "PUBLISH: Determines whether the database publishes newly gathered statistics after the gathering job completes." LAB: `PUBLISH` = TRUE; `optimizer_use_pending_statistics` = FALSE (default). REF `OPTIMIZER_USE_PENDING_STATISTICS`: Boolean, default false, ALTER SESSION/SYSTEM.
Views: `DBA_TAB_PENDING_STATS` ("describes pending statistics for tables, partitions, and subpartitions in the database"), `DBA_COL_PENDING_STATS`, `DBA_IND_PENDING_STATS`.

**7.2 Procedures.**
- `PUBLISH_PENDING_STATS(ownname DEFAULT USER, tabname, no_invalidate DEFAULT, force BOOLEAN DEFAULT FALSE)`: "This procedure is used to publish the statistics gathered and stored as pending." / "If the parameter tabname is NULL then publish applies to all tables of the specified schema." / force "If TRUE , will override the lock". LAB `ALL_ARGUMENTS`: OWNNAME defaulted, **TABNAME not defaulted**, NO_INVALIDATE and FORCE defaulted.
- `DELETE_PENDING_STATS(ownname DEFAULT USER, tabname)`: "This procedure is used to delete the pending statistics that have been collected but have not been published." / "If the parameter tabname is NULL delete applies to all tables of the specified schema." LAB: both parameters defaulted (TABNAME too).
- `DIFF_TABLE_STATS_IN_PENDING` (179.7.28): "This function compares pending statistics to either the current statistics in the data dictionary, or user-specified historical statistics." Documented signature: `DIFF_TABLE_STATS_IN_PENDING(ownname IN VARCHAR2, tabname IN VARCHAR2, timestamp IN TIMESTAMP WITH TIME ZONE, pctthreshold IN NUMBER DEFAULT 10) RETURN DiffRepTab pipelined`; "If the timestamp is NULL , then this function compares the current statistics in the dictionary with the pending statistics (default)." `pctthreshold`: "The function reports difference in statistics only if it exceeds the specified limit. The default value is 10 ." **LAB differs from the doc**: `ALL_ARGUMENTS` shows the third parameter is named `TIME_STAMP` (not `timestamp`) and is **defaulted** (`defaulted = Y`), `PCTTHRESHOLD` defaulted; return type is a PL/SQL table (`DiffRepTab`), usable as `TABLE(DBMS_STATS.DIFF_TABLE_STATS_IN_PENDING(owner, tab))` and with named `time_stamp =>`.
- `EXPORT_PENDING_STATS` exists (TG Table 15-1).

---------------------------------------------------------------------------------------------------------------------------------

## 8. Statistics history and restore

**8.1 Retention.** DOCUMENTED + LAB. TG ch. 16 (`B`tgsql/managing-historical-optimizer-statistics.html) "Managing Optimizer Statistics Retention": "By default, the database retains optimizer statistics for 31 days, after which time the statistics are scheduled for purging." PLS `ALTER_STATS_HISTORY_RETENTION(retention IN NUMBER)` (179.7.1): "The retention time in days. The statistics history will be retained for at least these many number of days.The valid range is [1,365000]. Also you can use the following values for special purposes: -1: Statistics history is never purged by automatic purge / 0: Old statistics are never saved. The automatic purge will delete all statistics history / NULL : Change statistics history retention to default value". "Statistics history retention is used by both the automatic purge and PURGE_STATS Procedure." LAB `GET_STATS_HISTORY_RETENTION` = 31; `GET_STATS_HISTORY_AVAILABILITY` = 2026-09-10 05:29 UTC.
`PURGE_STATS(before_timestamp)` (179.7.87): "Versions of statistics saved before this timestamp are purged. If NULL , it uses the purging policy used by automatic purge. The automatic purge deletes all history older than the older of (current time - statistics history retention) and (time of recent analyze in the system - 1). The statistics history retention value can be changed using ALTER_STATS_HISTORY_RETENTION Procedure.The default is 31 days." LAB: `purge_stats` operations (100 COMPLETED) recorded, the latest at the same time as the auto gather.

**8.2 Views and restore.** DOCUMENTED. REF `ALL_TAB_STATS_HISTORY`: "provides a history of table statistics modifications for all tables accessible to the current user." (DBA_ view columns OWNER, TABLE_NAME, PARTITION_NAME, SUBPARTITION_NAME, STATS_UPDATE_TIME; LAB-confirmed.) TG: "Whenever statistics in the data dictionary are modified, the database automatically saves old versions of statistics." `RESTORE_TABLE_STATS(ownname, tabname, as_of_timestamp, restore_cluster_index DEFAULT FALSE, force DEFAULT FALSE, no_invalidate DEFAULT ...)` (179.7.108): "This procedure restores statistics of a table as of a specified timestamp ( as_of_timestamp ). It also restores statistics of associated indexes and columns." / "If the table statistics were locked at the specified timestamp the procedure will lock the statistics. The procedure will not restore user defined statistics." / force "Restores statistics even if the table statistics are locked. If the table statistics were not locked at the specified timestamp, it unlocks the statistics." / "ORA-20006 : Unable to restore statistics, statistics history not available". TG restrictions: "Old versions of statistics are not stored when the ANALYZE command has been used for collecting statistics." / "Dropping a table removes the workload data used by the automatic histogram feature and the statistics history used by DBMS_STATS.RESTORE_*_STATS ."

**8.3 DIFF_TABLE_STATS_IN_HISTORY.** DOCUMENTED, LAB-confirmed. `DIFF_TABLE_STATS_IN_HISTORY(ownname IN VARCHAR2, tabname IN VARCHAR2, time1 IN TIMESTAMP WITH TIME ZONE, time2 IN TIMESTAMP WITH TIME ZONE DEFAULT NULL, pctthreshold IN NUMBER DEFAULT 10) RETURN DiffRepTab pipelined` (179.7.27). "pctthreshold: Specifies the threshold limit. The function reports differences in statistics only if the change percentage exceeds this limit. The default value is 10 ." "If the second timestamp is NULL , then the function compares the current statistics in the data dictionary with the statistics as of the first timestamp." PLS overview: "The threshold can be specified as an argument to the function, with a default of 10%. The database uses the statistics corresponding to the first source ( stattab1 or time1 ) as a basis for computing the differential percentage."

**8.4 SYSAUX occupant.** NOT DOCUMENTED on the DBMS_STATS/Tuning pages (REF `V$SYSAUX_OCCUPANTS` documents the columns only). LAB: `V$SYSAUX_OCCUPANTS`: `SM/OPTSTAT` = "Server Manageability - Optimizer Statistics History", schema SYS, 154,304 KB (the synopses of incremental statistics also live in SYSAUX per TG: "The database stores synopses in data dictionary tables WRI$_OPTSTAT_SYNOPSIS_HEAD$ and WRI$_OPTSTAT_SYNOPSIS$ in the SYSAUX tablespace.").

**8.5 Operation history and reports.** DOCUMENTED. REF `DBA_OPTSTAT_OPERATIONS`: "contains a history of statistics operations performed at the schema and database level using the DBMS_STATS package." Columns ID, OPERATION, TARGET, START_TIME, END_TIME, STATUS (IN PROGRESS, COMPLETED, FAILED, TIMED OUT), JOB_NAME, SESSION_ID, NOTES. `DBA_OPTSTAT_OPERATION_TASKS`: "displays the history of tasks that are performed as part of statistics operations ... Each task represents a target object to be processed in the corresponding parent operation." (columns OPID, TARGET, TARGET_OBJN, TARGET_TYPE, TARGET_SIZE, START_TIME, END_TIME, STATUS PENDING/IN PROGRESS/COMPLETED/FAILED/SKIPPED/TIMED OUT, JOB_NAME, ESTIMATED_COST ("This column is populated only when concurrency is on."), BATCHING_COEFF.)
`REPORT_STATS_OPERATIONS(detail_level DEFAULT 'TYPICAL', format DEFAULT 'TEXT', latestN DEFAULT NULL, since, until, auto_only BOOLEAN DEFAULT FALSE, container_ids) RETURN CLOB` (179.7.98): "This function generates a report of all statistics operations that take place between two timestamps which may or may not have been provided." `REPORT_SINGLE_STATS_OPERATION(opid NUMBER, detail_level DEFAULT 'TYPICAL', format DEFAULT 'TEXT', container_id DEFAULT NULL) RETURN CLOB` (179.7.97; the doc's syntax block misspells it `REPORT_SINGLE_STATS_OPERATIONS` and drops a comma; LAB `ALL_ARGUMENTS` confirms `REPORT_SINGLE_STATS_OPERATION`). Detail levels BASIC / TYPICAL / ALL; formats XML / HTML / TEXT. Privileges: "you need the ANALYZE ANY privilege and the ANALYZE ANY DICTIONARY privilege." LAB: `DBA_OPTSTAT_OPERATIONS` holds about 1,800 rows (gather_table_stats 882 COMPLETED, 13 FAILED; gather_database_stats (auto) 50); 13 `lock_partition_stats` rows are stuck at IN PROGRESS since 2026-10-05.

---------------------------------------------------------------------------------------------------------------------------------

## 9. Online statistics gathering for bulk loads

Source: TG ch. 10 "Online Statistics Gathering", `B`tgsql/optimizer-statistics-concepts.html.

**9.1 When it happens.** DOCUMENTED. "The database can gather table statistics automatically during the following types of bulk loads: INSERT INTO ... SELECT using a direct path insert, and CREATE TABLE AS SELECT ." / "By default, a parallel insert uses a direct path insert. You can force a direct path insert by using the /*+APPEND*/ hint." / "By default, the database gathers statistics during bulk loads." / hints: "You can enable the feature at the statement level by using the GATHER_OPTIMIZER_STATISTICS hint. You can disable the feature at the statement level by using the NO_GATHER_OPTIMIZER_STATISTICS hint."

**9.2 Restrictions.** DOCUMENTED. "Specifically, bulk loads do not gather statistics automatically when any of the following conditions applies to the target table, partition, or subpartition: The object contains data. Bulk loads only gather online statistics automatically when the object is empty. / It is in an Oracle-owned schema such as SYS . / It is one of the following types of tables: nested table, index-organized table (IOT), external table, or global temporary table defined as ON COMMIT DELETE ROWS . / It has a PUBLISH preference set to FALSE . / Its statistics are locked. / It is loaded using a multitable INSERT statement." (Note: "The database does gather online statistics automatically for the internal partitions of a hybrid partitioned table .")

**9.3 Partitioned tables.** DOCUMENTED. "When inserting rows into a partitioned table, the database gathers global statistics during the insert. For example, if sales is a partitioned table, and if you run INSERT INTO sales SELECT , then the database gathers global statistics. However, the database does not gather partition-level statistics." / "Assume a different case in which you use partition-extended syntax to insert rows into a specific partition or subpartition. The database gathers statistics on the partition during the insert. However, the database does not gather global statistics." / "If the INCREMENTAL preference is enabled for sales , then the database also gathers a synopsis for sales_q4_2000 ." / "if you roll back the transaction, then the database automatically deletes statistics gathered during the bulk load."

**9.4 Histograms and index statistics.** Histograms DOCUMENTED (see 1.14): none are created; GATHER AUTO fills in. "The preceding PL/SQL program only gathers missing or stale statistics. The database does not gather table and basic column statistics collected during the bulk load." PLS: "GATHER AUTO — Gathers all necessary statistics automatically. Oracle recommends setting GATHER AUTO on tables that undergo bulk load operations that gather statistics. This option is only applicable to tables that do not have INCREMENTAL enabled. Running GATHER_TABLE_STATS procedure on these tables with the GATHER AUTO option skips regathering the already fresh statistics." and `GATHER_TABLE_STATS` usage note: "If the GATHER AUTO option is used then frequency histograms will be created using a sample rather than a full scan." Index statistics during the load: NOT DOCUMENTED (the chapter speaks of "table statistics" and basic column statistics only; the TG example creates indexes after the CTAS). NOTES values: `STATS_ON_LOAD` (REF `ALL_PART_COL_STATISTICS`: "Online statistics were gathered during direct path load."); the TG example shows `STATS_ON_LOAD` / `HISTOGRAM_ONLY` after GATHER AUTO. LAB: 47 columns with `STATS_ON_LOAD`.
Partition maintenance operations also gather online (TG "Online Statistics Gathering for Partition Maintenance Operations"): for MOVE, COALESCE, MERGE "The database generates fresh statistics for the resulting partition."; for TRUNCATE or DROP PARTITION "the database updates the BLOCKS and NUM_ROWS values in the global table statistics".

---------------------------------------------------------------------------------------------------------------------------------

## 10. Statistics quality concepts

**10.1 LOW_VALUE / HIGH_VALUE / NUM_NULLS / DENSITY.** REF `ALL_TAB_COL_STATISTICS`: "Low value in the column", "High value in the column", NUM_NULLS "Number of NULLs in the column", `DENSITY` as in 1.12. TG ch. 10 "Column Statistics": "For example, statistics in DBA_TAB_COL_STATISTICS track the following: Number of distinct values; Number of nulls; High and low values; Histogram-related information".
Out-of-range predicates: NOT DOCUMENTED. No sentence in TG ch. 10/11/13, REF or PLS describes how the optimizer treats a predicate beyond HIGH_VALUE/LOW_VALUE (grepped for "out-of-range", "outside", "extrapolat"). It is mentioned only implicitly by real-time statistics ("the high and low values combine the manually gathered statistics and the real-time statistics"). Lab check needed (EXPLAIN PLAN of a predicate above HIGH_VALUE; not run, needs a PLAN_TABLE insert).

**10.2 GLOBAL_STATS / USER_STATS.** DOCUMENTED (quotes in 1.12). Also REF `ALL_TAB_STATISTICS` `STATTYPE_LOCKED` ("Type of statistics lock: DATA, CACHE, ALL").

**10.3 Locks.** DOCUMENTED. TG "Locking and Unlocking Optimizer Statistics": "After statistics are locked, you cannot make modifications to the statistics until the statistics have been unlocked." / "When you lock statistics on a table, all dependent statistics are locked. The locked statistics include table statistics, column statistics, histograms, and dependent index statistics. To overwrite statistics even when they are locked, you can set the value of the FORCE argument in various DBMS_STATS procedures, for example, DELETE_*_STATS and RESTORE_*_STATS , to true ."
PLS `LOCK_TABLE_STATS` (179.7.81): "The SET_*, DELETE_*, IMPORT_*, GATHER_* procedures that modify statistics in the dictionary of an individual table, index or column will raise an error if statistics of the object is locked. Procedures that operates on multiple objects (such as GATHER_SCHEMA_STATS ) will skip modifying the statistics of an object if it is locked. Many procedures have force argument to override the lock." / "When you invoke the LOCK_TABLE_STATS Procedure , it sets the statistics lock bit at the table level. In that case, you cannot gather statistics on dependent objects such as partitions and indexes." / "The locked or unlocked state is not exported along with the table statistics when using EXPORT_*_STATS procedures." Signature (LAB): `LOCK_TABLE_STATS(ownname, tabname, stattype DEFAULT)`.
`ORA-20005 : Object statistics are locked` is listed under the exceptions of `SET_COLUMN_STATS`, `DELETE_COLUMN_STATS`, `DELETE_INDEX_STATS`, `DELETE_TABLE_STATS`, `IMPORT_*`; `GATHER_TABLE_STATS` lists only ORA-20000 and ORA-20001 in its Exceptions block, so "gather on a locked table raises ORA-20005" rests on the LOCK_TABLE_STATS text plus `docs/lab-observations.md` D1 ("gather_table_stats ... -> ORA-20005 object statistics are locked", with `force=>TRUE` D3 overriding).
Force: `GATHER_TABLE_STATS` `force` "Gather statistics of table even if it is locked"; `PUBLISH_PENDING_STATS` force "If TRUE , will override the lock"; `COPY_TABLE_STATS` force "When value of this argument is TRUE copy statistics even if the destination [sub]partition is locked".
Locked and incremental (PLS INCREMENTAL_STALENESS): "USE_LOCKED_STATS —Locked partitions or subpartitions statistics are never considered stale, regardless of DML changes."

**10.4 COPY_TABLE_STATS.** DOCUMENTED. PLS (179.7.10): "This procedure copies statistics of all dependent object such as columns and local indexes. If the statistics for source are not available then nothing is copied. It can optionally scale the statistics (such as the number of blks , or number of rows) based on the given scale_factor ." Signature `COPY_TABLE_STATS(ownname, tabname, srcpartname, dstpartname, scale_factor DEFAULT 1, flags DEFAULT NULL, force DEFAULT FALSE)`. Adjustments: "This procedure updates the minimum and maximum values of destination partition for the first partitioning column as follows: If the partitioning type is HASH , then the minimum and maximum values of the destination partition are same as that of the source partition. ... If the partitioning type is RANGE , then ... The minimum value of the destination partition is set to the high bound of previous partition unless the destination partition is the first partition. ... The maximum value of the destination partition is set to the high bound of the destination partition unless the high bound of the destination partition is MAXVALUE , in which case the maximum value of the destination partition is set to the high bound of the previous partition." / "If the minimum and maximum values are different for a column after modifications, and if the number of distinct values is less than 1, then the number of distinct values is updated as 2." / "If the source or destination is a partition of a composite partitioned table, then this procedure does not copy statistics of the underlying subpartitions."
LAB: `docs/lab-observations.md` K1/V2: after COPY_TABLE_STATS into a new empty partition "partition column NOTES blank (no synopsis)".

---------------------------------------------------------------------------------------------------------------------------------

## 11. Composite partitioned tables and GRANULARITY

**11.1 Granularity values.** DOCUMENTED. PLS `GATHER_TABLE_STATS` (179.7.54) `granularity` ("Granularity of statistics to collect (only pertinent if the table is partitioned)."):
> 'ALL' - Gathers all (subpartition, partition, and global) statistics
> 'APPROX_GLOBAL AND PARTITION' - similar to 'GLOBAL AND PARTITION' but in this case the global statistics are aggregated from partition level statistics. This option will aggregate all statistics except the number of distinct values for columns and number of distinct keys of indexes. The existing histograms of the columns at the table level are also aggregated. The aggregation will use only partitions with statistics, so to get accurate global statistics, users should make sure to have statistics for all partitions. Global statistics are gathered if partname is NULL or if the aggregation cannot be performed (for example, if statistics for one of the partitions is missing).
> 'AUTO' - Determines the granularity based on the partitioning type. This is the default value.
> 'DEFAULT' - Gathers global and partition-level statistics. This option is obsolete, and while currently supported, it is included in the documentation for legacy reasons only. You should use the ' GLOBAL AND PARTITION ' for this functionality. Note that the default value is now ' AUTO '.
> 'GLOBAL' - Gathers global statistics
> ' GLOBAL AND PARTITION ' - Gathers the global and partition level statistics. No subpartition level statistics are gathered even if it is a composite partitioned object.
> 'PARTITION '- Gathers partition-level statistics
> 'SUBPARTITION' - Gathers subpartition-level statistics.

The preference form (`GRANULARITY`, SET_*_PREFS) lists ALL, AUTO, DEFAULT, GLOBAL, GLOBAL AND PARTITION, PARTITION, SUBPARTITION (no APPROX_GLOBAL AND PARTITION). LAB: `GET_PREFS('GRANULARITY')` = `AUTO`.
`partname`: "Name of the partition." That is the whole text; a subpartition name is NOT DOCUMENTED (the advisor already says this).

**11.2 What AUTO does for composite tables.** LAB-RESOLVED. PLS: "Determines the granularity based on the partitioning type." TG ch. 13 "Guideline for Partitioned Objects": "Similarly, for composite partitioning, DBMS_STATS can gather separate statistics for subpartitions, partitions, and the entire table or index. To determine the type of partitioning statistics to be gathered, specify the granularity argument to the DBMS_STATS procedures. Oracle recommends setting granularity to the default value of AUTO to gather subpartition, partition, or global statistics, depending on partition type. The ALL setting gathers statistics for all types."
LAB: `STATS_LAB.C1` (RANGE-HASH, 6 partitions x 4 hash subpartitions, `GRANULARITY` pref AUTO, `INCREMENTAL` TRUE): 6/6 partitions and the table analyzed, **0/24 subpartitions analyzed**. So AUTO on RANGE-HASH gathered no subpartition level (the docs do not say which composite types would). `docs/lab-observations.md` J: same, plus partition-level synopses.
LAB (2026-10-11, 19.27, "Composite tables, second run"): AUTO gathered **9/9 subpartitions** on RANGE-LIST and RANGE-RANGE (CP1, CP2; tasks 1 TABLE + 3 PARTITION + 9 SUBPARTITION) and 0/12 on RANGE-HASH (CP3). ALL behaved like AUTO on LIST and RANGE (CP7); ALL or SUBPARTITION on HASH was not run.

**11.3 Incremental statistics and subpartitions.** DOCUMENTED. TG ch. 13 "Considerations for Incremental Statistics Maintenance": "If a table uses composite partitioning, then the database only gathers statistics for modified subpartitions. The database does not gather statistics at the subpartition level for unmodified subpartitions. In this way, the database reduces work by skipping unmodified partitions."
PLS `INCREMENTAL_LEVEL`: "PARTITION — Gathers partition-level synopses. This is the default value. If PARTITION is set on a nonpartitioned table, then the database does not gather synopses." / "TABLE — Gathers table-level synopses." TG "Partition-Level Synopses": "Each partition maintains a synopsis in incremental mode."; the docs do not mention subpartition-level synopses. Staleness: `INCREMENTAL_STALENESS` "Specifies when a partition or subpartition is considered stale." (`USE_STALE_PERCENT`: "A partition or subpartition is not considered stale when DML changes are below the threshold set by the STALE_PERCENT preference." / `USE_LOCKED_STATS`: "Locked partitions or subpartitions statistics are never considered stale, regardless of DML changes." / `NULL`: "A partition or subpartition is considered stale when it has any DML changes.") Conditions for incremental: "The INCREMENTAL value for the partitioned table is set to TRUE . / The PUBLISH value for the partitioned table is set to TRUE . / The user specifies AUTO_SAMPLE_SIZE for ESTIMATE_PERCENT and AUTO for GRANULARITY when gathering statistics on the table."
**Docs vs lab:** the Tuning Guide sentence ("only gathers statistics for modified subpartitions") describes the subpartition level; LAB J (`docs/lab-observations.md`): 500 rows into one hash subpartition under AUTO re-read the whole parent partition (1 PART SYN) because only partition-level stats/synopses exist. Both can hold: no subpartition statistics under AUTO means the partition is the unit.
LAB (CP5, CP6, CP7): on LIST and RANGE composites under INCREMENTAL, DML in one subpartition made the gather read the whole parent partition plus the modified subpartition, skipping the unmodified ones; synopses stayed partition-level (CP4, CP7: 12 heads = 3 partitions x 4 columns).
Concurrency tasks (REF `DBA_OPTSTAT_OPERATION_TASKS.TARGET_TYPE`): "TABLE SUBPARTITION", "INDEX SUBPARTITION" exist.

---------------------------------------------------------------------------------------------------------------------------------

## Appendix A. Facts the brief assumed that Oracle's pages do not support

| Brief | Finding |
|---|---|
| Windows "WEEKNIGHT 22:00 4 h, WEEKEND 06:00 20 h" | 19c ADM Table 26-1: seven per-day windows, Mon-Fri 22:00-02:00 (4 h), Sat/Sun 06:00 for 20 h. WEEKNIGHT_WINDOW (8 h) and WEEKEND_WINDOW exist on the lab but are disabled. |
| "most stale" first | TG: "objects that have no statistics or very old statistics". |
| Window closes -> "resumes next window; quote" | Not documented. Only TIMED OUT status text exists. |
| SMON flush every ~15 min | Not documented (12.2+ views read memory + disk). |
| TABLE_CACHED_BLOCKS 0..255 or AUTO | Not on the 19c DBMS_STATS page. Lab default 1. |
| Column groups "not used for range predicates (quote)" | No such sentence; positive list "equality predicates, inlist predicates, and ... GROUP BY cardinality" and "non-equality predicates" for dynamic sampling. |
| FBI creates a virtual column with statistics (quote) | No explicit sentence. Lab: hidden virtual columns SYS_NC...$ listed in DBA_STAT_EXTENSIONS (CREATOR=SYSTEM) with column statistics. |
| 2048 buckets new in 12c | Range [1,2048] documented; the version note is not. |
| `_iut_stat_collection_type` | Hidden parameter, not in docs; V$INDEX_USAGE_INFO documents SAMPLED/ALL and the 15-minute flush. Lab value SAMPLED. |
| Real-time NOTES = STATS_ON_CONVENTIONAL_DML | TG says ..._DML, REF says STATS_ON_CONVENTIONAL_LOAD. |
| DIFF_TABLE_STATS_IN_PENDING(timestamp required) | Lab: parameter TIME_STAMP, defaulted. |
| Out-of-range predicates | Not documented. |

## Appendix B. Fetch recipe and lab queries

```
B=https://docs.oracle.com/en/database/oracle/oracle-database/19
curl -sL "$B/tgsql/histograms.html" -o h.html     # also arpls/DBMS_STATS.html, refrn/<VIEW>.html, dblic/Licensing-Information.html, admin/managing-automated-database-maintenance-tasks.html
python3 -I h2t.py h.html > h.txt                  # strip script/style/tags, unescape, collapse whitespace
```
Pages used: tgsql/{histograms, optimizer-statistics-concepts, gathering-optimizer-statistics, managing-extended-statistics, controlling-the-use-of-optimizer-statistics, managing-historical-optimizer-statistics}.html; arpls/DBMS_STATS.html; refrn/{ALL_TAB_COL_STATISTICS, ALL_PART_COL_STATISTICS, ALL_TAB_STATISTICS, ALL_IND_STATISTICS, ALL_INDEXES, ALL_TAB_MODIFICATIONS, ALL_STAT_EXTENSIONS, ALL_IND_EXPRESSIONS, DBA_INDEX_USAGE, V-INDEX_USAGE_INFO, DBA_AUTO_STAT_EXECUTIONS, DBA_OPTSTAT_OPERATIONS, DBA_OPTSTAT_OPERATION_TASKS, ALL_TAB_STATS_HISTORY, DBA_TAB_PENDING_STATS, OPTIMIZER_REAL_TIME_STATISTICS, OPTIMIZER_USE_PENDING_STATISTICS, V-SYSAUX_OCCUPANTS}.html; dblic/Licensing-Information.html; admin/{managing-automated-database-maintenance-tasks, managing-indexes}.html; sqlrf/CREATE-INDEX.html; cncpt/indexes-and-index-organized-tables.html.

Lab (read-only, `ALTER SESSION SET CONTAINER = PDB1`, 19.27 Release Update 37642901): `GET_PREFS` for 24 preferences; `V$PARAMETER`; `DBA_SCHEDULER_WINDOWS`, `DBA_AUTOTASK_CLIENT`; `V$SYSAUX_OCCUPANTS`; `V$INDEX_USAGE_INFO` and `x$ksppi/x$ksppcv` for `_iut%`; `ALL_ARGUMENTS` for 16 DBMS_STATS subprograms; `DBA_TAB_COL_STATISTICS` (histograms, NOTES); `DBA_STAT_EXTENSIONS`, `DBA_IND_EXPRESSIONS`, `DBA_TAB_COLS`; `DBA_INDEXES`, `DBA_INDEX_USAGE`; `DBA_OPTSTAT_OPERATIONS`, `DBA_OPTSTAT_OPERATION_TASKS`, `DBA_AUTO_STAT_EXECUTIONS`, `DBA_AUTOTASK_JOB_HISTORY`; `DBA_TAB_SUBPARTITIONS` for STATS_LAB.C1; `DBMS_STATS.REPORT_COL_USAGE`. Not run (would write): gathers, `CREATE_EXTENDED_STATS`, prefs changes, real-time statistics DML, PLAN_TABLE inserts. Note: `scp`/`ssh` to the lab hung intermittently; retries succeeded.
