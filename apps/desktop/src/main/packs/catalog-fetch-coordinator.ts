/**
 * @file catalog-fetch-coordinator.ts — main-process orchestrator for the Agent
 * Pack Catalog fetch (ISS-5274).
 *
 * Same read→compute→apply dance the pack scan uses (FEA-3628), for the same
 * reason: `catalog.fetch.run` did its ~20 `gh`/HTTPS calls INSIDE the db-host,
 * measured at 13.4s of a store op whose budget is 100ms, during which renderer
 * DB reads queue behind it.
 *
 *   1. read    — `catalog.fetch.rows` (bounded; the catalog is ~10 rows)
 *   2. collect — `collectCatalogFetchPlan` here in the main process (network)
 *   3. apply   — `catalog.fetch.apply` on the db-host (the sole SQLite writer)
 *
 * FALLBACK BOUNDARY. `catalog.fetch.run` is retried ONLY when the read or the
 * collect failed — never once apply has begun. Re-running after a successful
 * collect would repeat every network call *inside* the db-host (reintroducing
 * the exact stall this removes) and could double-apply over partially-written
 * rows, since `applyFetchResult` writes per row. An apply error surfaces and
 * the next trigger retries.
 *
 * Its three triggers — boot, the 24h timer, and the manual refresh IPC — are
 * coalesced through the shared single-flight primitive, so they can never
 * overlap into concurrent GitHub fetches racing each other's applies.
 */

import { gatewayLog } from "../logging/gateway-logger.js";
import {
  type CatalogFetchRow,
  type CatalogFetchTransport,
  collectCatalogFetchPlan,
} from "./catalog-fetcher.js";
import { createSingleFlightRunner } from "./single-flight-runner.js";

type RawStoreOp = (name: string, args?: unknown[]) => Promise<unknown>;

export type CatalogFetchCoordinator = {
  /** Trigger a fetch. Coalesces with any in-flight fetch; resolves when settled. */
  run(): Promise<void>;
  /** Refuse further fetches; subsequent `run()` calls resolve immediately. */
  stop(): void;
};

export function createCatalogFetchCoordinator(deps: {
  rawStoreOp: RawStoreOp;
  /**
   * Whether the local `gh` CLI is usable.
   *
   * INJECTED, and asynchronous, on purpose: the catalog fetcher's own
   * `ghCliAvailable()` resolves through a SYNCHRONOUS login shell (2,667ms in
   * the perf baseline). Calling that here would move a multi-second freeze onto
   * the Electron MAIN thread — strictly worse than the db-host stall this
   * coordinator exists to remove — while leaving every test green. Production
   * must supply the async resolver.
   */
  resolveGhAvailable: () => Promise<boolean>;
  log?: (message: string) => void;
  /** Test seam for the GitHub calls; production uses the real transport. */
  transport?: CatalogFetchTransport;
}): CatalogFetchCoordinator {
  const log =
    deps.log ??
    ((message: string) => {
      gatewayLog.warn("catalog-fetch-coordinator", message);
    });

  const executeOnce = async (): Promise<void> => {
    let plan: Awaited<ReturnType<typeof collectCatalogFetchPlan>>;
    try {
      const rows = (await deps.rawStoreOp(
        "catalog.fetch.rows"
      )) as CatalogFetchRow[];
      const ghAvailable = await deps.resolveGhAvailable();
      plan = await collectCatalogFetchPlan(rows, {
        ghAvailable,
        transport: deps.transport,
        // Teardown must actually stop the network work. This runs in the main
        // process now, so — unlike when it lived in the db-host, whose exit
        // killed the requests — nothing else cancels it.
        shouldStop: () => singleFlight.isStopped(),
      });
    } catch (error) {
      if (singleFlight.isStopped()) {
        return;
      }
      log(
        `catalog fetch collect failed; falling back to in-db-host fetch: ${errMsg(error)}`
      );
      if (singleFlight.isStopped()) {
        return;
      }
      await deps.rawStoreOp("catalog.fetch.run");
      return;
    }
    if (singleFlight.isStopped()) {
      return;
    }
    await deps.rawStoreOp("catalog.fetch.apply", [plan]);
  };

  const singleFlight = createSingleFlightRunner({
    execute: executeOnce,
    onError: (error) => log(`catalog fetch failed: ${errMsg(error)}`),
  });

  return {
    run: () => singleFlight.run(),
    stop: () => singleFlight.stop(),
  };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
