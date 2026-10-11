// The health check: pure TypeScript rules over the typed rows of the collector's DETAIL block.
// Contract: docs/design-health.md. Each section module exports `xSection(ctx)`, which returns a
// HealthSection, or null when its data was not collected; the id then goes to `skipped` with a reason.

import type { Input } from "../defaults";
import type { Detail } from "../detail";
import type { Provenance } from "../setup";
import type { Level } from "../types";
import { extendedSection, histogramsSection, indexesSection, qualitySection } from "./columns";
import { historySection, loadSection, pendingSection, realtimeSection, restoreSection, stalenessSection, subpartitionsSection } from "./table";

export interface HealthFinding { level: Level; text: string; basis: string; fix?: string[] }
export interface HealthSection { id: string; title: string; summary: string; findings: HealthFinding[]; rows?: { head: string[]; body: string[][] } }
export interface HealthReport { collectedAt: string | null; sections: HealthSection[]; skipped: string[] }

/** What a section rule gets. */
export interface HealthContext { input: Input; detail: Detail; prov: Provenance | null }
export type SectionFn = (ctx: HealthContext) => HealthSection | null;

/** Section ids in display order, who fills them, and the line shown when the section returns null. */
export const SECTIONS: readonly { id: string; run: SectionFn; skippedBecause: string }[] = [
  { id: "histograms", run: histogramsSection, skippedBecause: "column statistics were not collected" },
  { id: "extended", run: extendedSection, skippedBecause: "extension and column statistics were not collected" },
  { id: "indexes", run: indexesSection, skippedBecause: "index statistics were not collected" },
  { id: "quality", run: qualitySection, skippedBecause: "column statistics were not collected" },
  { id: "staleness", run: stalenessSection, skippedBecause: "table statistics and DML counters were not collected" },
  { id: "history", run: historySection, skippedBecause: "the statistics history was not collected" },
  { id: "pending", run: pendingSection, skippedBecause: "pending statistics were not collected" },
  { id: "restore", run: restoreSection, skippedBecause: "the statistics history was not collected" },
  { id: "load", run: loadSection, skippedBecause: "the table's statistics notes were not collected" },
  { id: "realtime", run: realtimeSection, skippedBecause: "the real-time statistics settings were not collected" },
  { id: "subpartitions", run: subpartitionsSection, skippedBecause: "subpartition statistics were not collected" },
];

export function health(input: Input, detail: Detail, prov: Provenance | null): HealthReport {
  const ctx: HealthContext = { input, detail, prov };
  const sections: HealthSection[] = [];
  const skipped: string[] = [];
  for (const s of SECTIONS) {
    let r: HealthSection | null = null;
    try { r = s.run(ctx); } catch { r = null; } // one broken rule must not take the report down
    if (r) sections.push(r);
    else skipped.push(`${s.id}: ${s.skippedBecause}`);
  }
  return { collectedAt: detail.collectedAt, sections, skipped };
}
