// Table-level sections of the health check (WP3 fills these in).
import type { HealthContext, HealthSection } from "./index";

// TODO(WP3): staleness: ROWS_CHANGED vs STALE_PERCENT, STALE_STATS, truncation, partitions with stale or zero-row statistics.
export const stalenessSection = (_ctx: HealthContext): HealthSection | null => null;
// TODO(WP3): history: HISTORY and AUTORUN/HFRUN rows, who gathered, how often, what was read.
export const historySection = (_ctx: HealthContext): HealthSection | null => null;
// TODO(WP3): pending: PENDING_ROWS, PENDING_SINCE, OPTIMIZER_USE_PENDING_STATISTICS.
export const pendingSection = (_ctx: HealthContext): HealthSection | null => null;
// TODO(WP3): restore: retention, availability, SYSAUX_OPTSTAT_MB, restore operations in HISTORY.
export const restoreSection = (_ctx: HealthContext): HealthSection | null => null;
// TODO(WP3): load: STATS_ON_LOAD, what a direct-path load leaves behind.
export const loadSection = (_ctx: HealthContext): HealthSection | null => null;
// TODO(WP3): realtime: REALTIME_STATS_PARAM, REALTIME_STATS_NOTES, the high-frequency task.
export const realtimeSection = (_ctx: HealthContext): HealthSection | null => null;
// TODO(WP3): subpartitions: SUBPARTITIONING, SUBPARTITIONS_WITH_STATS, composite granularity.
export const subpartitionsSection = (_ctx: HealthContext): HealthSection | null => null;
