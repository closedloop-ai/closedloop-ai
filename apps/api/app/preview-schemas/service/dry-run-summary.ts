/**
 * The dry-run report line for `previewSchemaCleanupService.runDryRun`. A
 * private internal of `app/preview-schemas/service.ts`, split out per the
 * nested-service pattern in `apps/api/AGENTS.md`.
 */

import type { CategoryCounters } from "@repo/database/scripts/cleanup-preview-schemas-lib";

/**
 * Builds the dry-run summary string. Uses explicit `would-drop` / `kept-active`
 * language so operators reading the workflow log don't confuse a dry-run
 * preview with a real reap outcome.
 */
export function buildDryRunSummary(input: {
  wouldDropStale: string[];
  wouldDropOrphaned: string[];
  wouldDropOrphanBranch: string[];
  wouldKeepInGrace: string[];
  withheldByMassDropCap: string[];
  keptActive: string[];
  counters: CategoryCounters;
}): string {
  const totalWouldDrop =
    input.wouldDropStale.length +
    input.wouldDropOrphaned.length +
    input.wouldDropOrphanBranch.length;
  return (
    `[dry-run] summary: would-drop=${totalWouldDrop} ` +
    `(ttl-expired=${input.wouldDropStale.length} orphan=${input.wouldDropOrphaned.length} orphan-branch=${input.wouldDropOrphanBranch.length}); ` +
    `would-keep-in-grace=${input.wouldKeepInGrace.length}; ` +
    `withheld-by-mass-drop-cap=${input.withheldByMassDropCap.length}; ` +
    `kept-active=${input.keptActive.length}; ` +
    `observation-read[errored=${input.counters.orphan.errored}] ` +
    `registry-read[errored=${input.counters.registryReadErrored}]`
  );
}
