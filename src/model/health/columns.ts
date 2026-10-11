// Column and index sections of the health check (WP2 fills these in).
import type { HealthContext, HealthSection } from "./index";

// TODO(WP2): histograms: columns with a histogram nobody filters on, skewed columns used in predicates without one, bucket counts vs NDV.
export const histogramsSection = (_ctx: HealthContext): HealthSection | null => null;
// TODO(WP2): extended: column groups and expression statistics present, unused, without statistics; EXPRESSION_CANDIDATES.
export const extendedSection = (_ctx: HealthContext): HealthSection | null => null;
// TODO(WP2): indexes: clustering factor, stale or unusable indexes, unused indexes (DBA_INDEX_USAGE), redundant prefixes.
export const indexesSection = (_ctx: HealthContext): HealthSection | null => null;
// TODO(WP2): quality: sample sizes, NDV vs rows, low/high values outside the data, columns without statistics.
export const qualitySection = (_ctx: HealthContext): HealthSection | null => null;
