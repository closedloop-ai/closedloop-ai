/**
 * @file store-op-router.ts — the store-op interception decision (ISS-5274).
 *
 * Two store ops must not execute in the db-host when a main-process
 * coordinator is available: `packScanner.run` (FEA-3628, the filesystem walk)
 * and `catalog.fetch.run` (ISS-5274, ~20 `gh`/HTTPS calls). Routing them here
 * — inside `invokeStoreOp` — covers EVERY trigger with no call-site edits: for
 * the catalog that is boot, the 24h timer, and the `desktop:db:catalog-refresh`
 * IPC. Each coordinator's own fallback goes through the UN-intercepted
 * `rawStoreOp`, so there is no recursion.
 *
 * WHY THIS IS ITS OWN MODULE. The decision used to live inline in
 * `agent-dashboard-db-host-lifecycle.ts`, which eagerly forks a real db-host
 * utilityProcess and injects no client — so the routing could not be executed
 * in a test, only source-scanned, and AGENTS.md is explicit that a guard test
 * must execute the decision rather than assert a predicate appears somewhere.
 * Extracted, it is a pure function over injected coordinators: if it stops
 * intercepting, `store-op-router.test.ts` goes red instead of boot, the timer,
 * and manual refresh all quietly running on the db-host again.
 *
 * A null coordinator forwards unchanged. That is the real state during the
 * window before the runtime has constructed them (they need `rawStoreOp`, which
 * the lifecycle produces) and permanently in golden mode, where no coordinator
 * is ever built and the in-db-host ops remain the whole implementation.
 */

import type { CatalogFetchCoordinator } from "../packs/catalog-fetch-coordinator.js";
import type { PackScanCoordinator } from "../packs/pack-scan-coordinator.js";

/** Store ops that a main-process coordinator owns when one exists. */
export const RoutedStoreOp = {
  PackScannerRun: "packScanner.run",
  CatalogFetchRun: "catalog.fetch.run",
} as const;
export type RoutedStoreOp = (typeof RoutedStoreOp)[keyof typeof RoutedStoreOp];

export type StoreOpRouterDeps = {
  /** Null until the runtime constructs it, and always null in golden mode. */
  packScanCoordinator: PackScanCoordinator | null;
  /** Null until the runtime constructs it, and always null in golden mode. */
  catalogCoordinator: CatalogFetchCoordinator | null;
  /** Forward to the db-host with NO interception. */
  rawStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
};

/**
 * Route one store op: to its coordinator when that coordinator exists, else
 * straight through to the db-host.
 */
export function routeStoreOp(
  name: string,
  args: unknown[],
  deps: StoreOpRouterDeps
): Promise<unknown> {
  if (name === RoutedStoreOp.PackScannerRun && deps.packScanCoordinator) {
    return deps.packScanCoordinator.run();
  }
  if (name === RoutedStoreOp.CatalogFetchRun && deps.catalogCoordinator) {
    return deps.catalogCoordinator.run();
  }
  return deps.rawStoreOp(name, args);
}
