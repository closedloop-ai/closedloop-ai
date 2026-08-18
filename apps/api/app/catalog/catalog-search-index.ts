import {
  type SearchProjectionInput,
  searchIndexService,
} from "@/app/search/search-index-service";

/**
 * FEA-4011 Slice A: flush the accumulated component search projections through
 * the fail-open, post-commit BATCH index hook. Called AFTER the catalog write
 * transaction commits so a projection failure can never roll back the catalog
 * write.
 *
 * Uses the single multi-row upsert (`indexManyAfterCommit`) rather than a
 * per-projection loop: a pack import can accumulate hundreds of pending
 * projections, and one `indexAfterCommit` per row would borrow one pooled pg
 * connection each and re-open the 2026-07-15 pool-exhaustion outage (FEA-3299).
 * The batch hook is itself best-effort (scheduled via `waitUntil`, logged, never
 * rethrown) and a no-op for an empty batch.
 *
 * Extracted from `service.ts` (grandfathered, shrink-only) so the search-index
 * plumbing lives in its own module.
 */
export function flushCatalogSearchIndex(
  pending: SearchProjectionInput[]
): void {
  searchIndexService.indexManyAfterCommit(pending);
}
