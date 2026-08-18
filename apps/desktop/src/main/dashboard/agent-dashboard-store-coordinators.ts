/**
 * @file agent-dashboard-store-coordinators.ts — construction and lifecycle of
 * the two MAIN-PROCESS coordinators that the store-op router routes to
 * (FEA-3628, ISS-5274).
 *
 * Both exist for one reason: a `store:` op whose real work is a filesystem walk
 * or a pile of network calls must not execute inside the db-host, where it
 * blocks the single JS thread and starves renderer DB reads.
 *
 *   - pack scan — `packScanner.run` → a compute worker (the recursive walk)
 *   - catalog fetch — `catalog.fetch.run` → this process (~20 gh/HTTPS calls)
 *
 * Golden mode builds NEITHER: it runs an in-process collector model and does no
 * network egress, so both ops stay on their in-db-host implementations. That is
 * why `catalog` is nullable and `packScan` takes a null runner factory.
 *
 * All three catalog triggers — boot, the 24h timer, and the
 * `desktop:db:catalog-refresh` IPC — reach the coordinator through the router's
 * interception, which is why arming the first two here changes no call site.
 *
 * Extracted from `agent-dashboard-design-system-runtime.ts` rather than added
 * to it: that file sat just under the 1,000-line ceiling, and AGENTS.md
 * requires splitting by responsibility instead of piling on (or grandfathering)
 * when a change would push a file over.
 */

import { resolveBinaryFromLoginShell } from "../../server/shell-path.js";
import {
  type CatalogFetchCoordinator,
  createCatalogFetchCoordinator,
} from "../packs/catalog-fetch-coordinator.js";
import { scheduleCatalogFetch } from "../packs/catalog-fetcher.js";
import {
  createPackScanCoordinator,
  type PackScanCoordinator,
} from "../packs/pack-scan-coordinator.js";
import { createUtilityProcessPackScanRunner } from "../packs/utility-process-pack-scan-runner.js";

export type AgentDashboardStoreCoordinators = {
  packScan: PackScanCoordinator;
  /** Null in golden mode — `catalog.fetch.run` then stays on the db-host. */
  catalog: CatalogFetchCoordinator | null;
  /** Clear the catalog timer and refuse further fetches. Idempotent. */
  stopCatalog: () => void;
};

/**
 * `gh` availability for the main process.
 *
 * The ASYNC resolver, always. The catalog fetcher's own `ghCliAvailable()`
 * spawns a SYNCHRONOUS login shell — 2,667ms of `resolveExecutablesOnPathSync`
 * in the perf baseline — which on this thread is a hard UI freeze, strictly
 * worse than the db-host stall this whole change removes.
 */
function resolveGhAvailable(): Promise<boolean> {
  return resolveBinaryFromLoginShell("gh").then(
    (result) =>
      result.source !== "fallback" && result.source !== "override_invalid"
  );
}

export function createAgentDashboardStoreCoordinators(deps: {
  golden: unknown;
  /** The UN-intercepted forwarder the coordinators drive the db-host with. */
  rawStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
  /** The INTERCEPTED forwarder — this is what routes a trigger to a coordinator. */
  invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
  runAfterInitialBackgroundWorkAllowed: (
    label: string,
    task: () => Promise<void>
  ) => void;
  waitForBackgroundSlot: () => Promise<void>;
  log: (scope: string, message: string) => void;
}): AgentDashboardStoreCoordinators {
  // Built eagerly — before the deferred startup scan runs — so even the FIRST
  // scan goes through the worker rather than the in-db-host fallback.
  const packScan = createPackScanCoordinator({
    rawStoreOp: deps.rawStoreOp,
    createRunner: deps.golden
      ? () => null
      : () =>
          createUtilityProcessPackScanRunner({
            log: (message) => deps.log("pack-scan", message),
          }),
    log: (message) => deps.log("pack-scan", message),
  });

  if (deps.golden) {
    return { packScan, catalog: null, stopCatalog: () => {} };
  }

  const catalog = createCatalogFetchCoordinator({
    rawStoreOp: deps.rawStoreOp,
    resolveGhAvailable,
    log: (message) => deps.log("catalog-fetch", message),
  });

  deps.runAfterInitialBackgroundWorkAllowed(
    "Initial catalog fetch",
    async () => {
      await deps.waitForBackgroundSlot();
      await deps.invokeStoreOp("catalog.fetch.run");
    }
  );
  let timer: ReturnType<typeof setInterval> | null = scheduleCatalogFetch(() =>
    deps.invokeStoreOp("catalog.fetch.run")
  );

  return {
    packScan,
    catalog,
    stopCatalog: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Clearing the timer alone would leave an in-flight run free to schedule
      // its trailing rerun and then apply into a db-host that is closing.
      catalog.stop();
    },
  };
}
