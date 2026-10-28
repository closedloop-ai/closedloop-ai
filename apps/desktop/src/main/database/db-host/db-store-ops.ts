/**
 * @file db-store-ops.ts
 * @description ISS-8246 M1 — the `store:` op bodies, which now run on the store
 * worker thread rather than on the db-host's message loop.
 *
 * Moved verbatim from `db-host-worker.ts`. Nothing about WHICH ops exist or WHAT
 * they do changed in this milestone; what changed is the thread they run on, so
 * the doc comments below still describe the same contracts. Two of them still
 * say "this is already the off-main DB host process" — that remains true, and is
 * now true of a thread within it as well.
 *
 * The `log` seam replaces the module-level `childLog` these bodies closed over
 * in the worker. On the store thread a log line is a message to the dispatcher,
 * which relays it to main, so the sink has to be injected rather than imported.
 */

import { backfillActivitySegmentsFromTranscripts } from "../../collectors/parsing/activity-segment-backfill.js";
import { backfillArtifactLinksFromTranscripts } from "../../collectors/parsing/artifact-link-backfill.js";
import {
  type CatalogEntry,
  refreshCatalogContents,
} from "../../packs/catalog-contents.js";
import {
  applyCatalogFetchPlan,
  type CatalogFetchPlan,
  readCatalogFetchRows,
  runCatalogFetch,
} from "../../packs/catalog-fetcher.js";
import { upsertCatalogSeed } from "../../packs/catalog-store.js";
import {
  applyDiscoveredDefinitions,
  collectDefinitionContentFromDefaults,
} from "../../packs/definition-content-collector.js";
import {
  type DefinitionApplyContext,
  resolveDefinitionRoots,
} from "../../packs/definition-discovery.js";
import {
  projectPluginInventory,
  runPackScanPostSteps,
} from "../../packs/pack-scan-post-steps.js";
import type { DefinitionWire } from "../../packs/pack-scan-worker-protocol.js";
import {
  applyPackScan,
  getRecentProjectRoots,
  type PackScanComputeResult,
  runPackScanner,
} from "../../packs/pack-scanner.js";
import {
  confirmPlan,
  extractPlansFromPlansDir,
  rejectPlan,
  upsertPlans,
} from "../../plans/plan-store.js";
import { backfillSessionListTraceProjections } from "../session-list-trace-maintenance.js";
import { SESSION_LIST_TRACE_BACKFILL_STORE_OP } from "../session-list-trace-maintenance-contract.js";
import { repairSkillShadowedCommandInventory } from "../skill-shadow-inventory-maintenance.js";
import type { SqliteAgentDatabase } from "../sqlite.js";
import type { DbHostStoreOpRegistry } from "./db-host-store-op-registry.js";
import { yieldDbHostLoopUnderMemoryPressure } from "./yield-db-host-loop.js";

export type DbStoreOpsDeps = {
  /**
   * The store thread's log sink. Posts a `Log` to the dispatcher, which relays
   * it to main's logger — the same destination the worker's `childLog` reached
   * before the split, one hop further away.
   */
  log: (message: string) => void;
};

/** Build the `store:` op table for one open store runtime. */
export function createDbStoreOps(deps: DbStoreOpsDeps): DbHostStoreOpRegistry {
  const childLog = deps.log;
  /**
   * FEA-2038 — store ops that must EXECUTE in the child because their store
   * function takes a callback (`prisma.write(fn)`) or
   * its filesystem/parse work is offloaded off the main process. A function can't
   * structured-clone across IPC, so main forwards only the serializable args and
   * the whole store fn (preserving transaction atomicity) runs here. Keyed by the
   * suffix after `store:`; called with the live runtime + the verbatim args.
   */
  const storeOps: Record<
    string,
    (db: SqliteAgentDatabase, args: unknown[]) => Promise<unknown>
  > = {
    "artifactLinks.backfill": (db) =>
      // Native transcript parse runs fine here: this is already the off-main DB
      // host process, so no parse-runner / cancel callback is needed (native
      // parse + always-continue defaults apply). Each rederive runs as its own
      // atomic prisma.write($transaction).
      //
      // FEA-2264: pass a child-loop yield as the cooperative delay. Even off the
      // main thread, this backfill scans ~8k transcripts on the SAME JS thread
      // that serves renderer reads, so without yielding it monopolizes the loop
      // and the dashboard stays frozen until it finishes. The base
      // `yieldDbHostLoop` returns control to the poll phase between writes (and on
      // a fixed cadence for skip-heavy rescans) without the real per-write sleep
      // the main-side delay applies. FEA-3132: the wrapper used here,
      // `yieldDbHostLoopUnderMemoryPressure`, is the documented exception — under
      // "high" memory pressure it additionally real-sleeps in bounded ticks to
      // throttle the backfill (sleep-free at "ok" pressure).
      backfillArtifactLinksFromTranscripts(db.prisma, {
        log: childLog,
        cooperativeDelay: () =>
          yieldDbHostLoopUnderMemoryPressure({ log: childLog }),
      }),
    // ISS-5260: delete phantom `(command, /X)` inventory rows that a RESOLVED
    // `(skill, X)` shadows, and park the sessions holding their invocations so the
    // data-revision rebuild that follows re-points them onto the skill. A store op
    // rather than a `SqliteAgentDatabase` method because it issues `prisma.write`
    // callbacks, which cannot cross the db-host method proxy. Bounded work (a few
    // indexed statements over the inventory), so it is deliberately NOT in
    // HEAVY_STORE_OPS — it must not queue behind the two transcript backfills when
    // the rebuild is waiting on it.
    "skillShadowInventory.repair": (db) =>
      repairSkillShadowedCommandInventory(db.prisma, childLog),
    // FEA-2267: re-derive the activity-segment tiling for sessions not yet scanned
    // at the current ACTIVITY_CLASSIFIER_VERSION. Same off-main, atomic-per-session
    // contract as artifactLinks.backfill; shares the FEA-2264 child-loop yield so a
    // full re-tile doesn't freeze the dashboard either.
    "activitySegments.backfill": (db) =>
      backfillActivitySegmentsFromTranscripts(db.prisma, {
        log: childLog,
        cooperativeDelay: () =>
          yieldDbHostLoopUnderMemoryPressure({ log: childLog }),
      }),
    [SESSION_LIST_TRACE_BACKFILL_STORE_OP]: (db) =>
      backfillSessionListTraceProjections(db.prisma, {
        log: childLog,
        cooperativeDelay: () =>
          yieldDbHostLoopUnderMemoryPressure({ log: childLog }),
      }),
    // FEA-3628 fallback: run the WHOLE scan (heavy compute + writes) in this
    // db-host process. Used only when the main-process compute worker is
    // unavailable — normal scans go through packScanner.recentRoots +
    // packScanner.apply so the filesystem walk never runs here (which starves
    // renderer DB reads). Kept so a missing worker still yields a completed scan.
    "packScanner.run": async (db) => {
      const summary = await runPackScanner(db.prisma);
      await runPackScanPostSteps(db.prisma);
      return summary;
    },
    // FEA-3628: the scanner's single DB read, surfaced so the main-process compute
    // worker (which owns no DB connection) can be fed the recent project roots.
    "packScanner.recentRoots": (db) => getRecentProjectRoots(db.prisma),
    // FEA-3628: replay a plan computed by the main-process worker on the SOLE
    // SQLite writer, then attach definition content. `scanStartedAt` bounds the
    // prune; the main process stamps it at compute start.
    "packScanner.apply": async (db, args) => {
      const compute = args[0] as PackScanComputeResult;
      const scanStartedAt = args[1] as string;
      const summary = await applyPackScan(db.prisma, compute, scanStartedAt);
      // ISS-5274: the definition walk is NOT run here. The coordinator drives it
      // through the compute worker (definitionRoots → computeDefinitions →
      // applyDefinitions) straight after this op returns; walking here too would
      // put the recursive readdirSync sweep back on the db-host thread, which is
      // the cost this ticket removes. Plugin/MCP discovery still runs — bounded
      // config reads, not recursive walks.
      await runPackScanPostSteps(db.prisma, { skipDefinitionContent: true });
      return summary;
    },
    // ISS-5274: resolve the definition scan roots AND the scope context together,
    // in the process that owns the environment and the project-root read. The
    // worker deliberately reads no env: a divergent `CLAUDE_HOME`/`CODEX_HOME`/
    // OpenCode config home there would silently change the scanned set, and a
    // divergent `homeDir` would change the persisted `agent_components.scope`.
    "packScanner.definitionRoots": async (db) =>
      resolveDefinitionRoots(await getRecentProjectRoots(db.prisma)),
    // ISS-5274: apply a definition set the compute worker walked. Presence of a
    // payload asserts completeness (the worker omits rather than truncates), so
    // this writes it exactly as the on-host walk would — same single writer.
    "packScanner.applyDefinitions": async (db, args) => {
      const summary = await applyDiscoveredDefinitions(
        db.prisma,
        args[0] as DefinitionWire[],
        args[1] as DefinitionApplyContext
      );
      // ISS-6094: the definition pass runs AFTER the post-scan settle steps, so a
      // child it just created would carry a NULL `pack_id` — and a zero plugin
      // rollup — until the next whole scan. Re-project (idempotent) so the stamp
      // lands in the same pass.
      await projectPluginInventory(db.prisma);
      return summary;
    },
    // ISS-5274: the complete-or-fall-back path — the full on-host walk, used when
    // the worker failed or omitted an over-budget payload. Slow, but it converges.
    "packScanner.collectDefinitions": (db) =>
      collectDefinitionContentFromDefaults(db.prisma),
    "catalog.seed": (db, args) =>
      upsertCatalogSeed(
        db.prisma,
        args[0] as Parameters<typeof upsertCatalogSeed>[1]
      ),
    // FEA-2038: the GitHub stats fetch + contents refresh both end in
    // `prisma.write` (applyFetchResult / applyContentsFetch), which can't run over
    // the method proxy — so they execute wholly here. The GitHub REST I/O
    // runs in this process, mirroring packScanner.run's filesystem work; the cadence
    // is light (≤ daily for stats, on-demand for contents).
    "catalog.fetch.run": (db) => runCatalogFetch(db.prisma),
    // ISS-5274: the fetch's single catalog read, so the REST/HTTPS calls that
    // consume it can run in the main process instead of occupying this op queue
    // for 13s. Bounded — the catalog is ~10 rows.
    "catalog.fetch.rows": (db) => readCatalogFetchRows(db.prisma),
    // ISS-5274: write a plan the main process collected. Skips any entry whose
    // catalog row changed source mid-fetch, so one source's stars can never land
    // on another source's row.
    "catalog.fetch.apply": (db, args) =>
      applyCatalogFetchPlan(db.prisma, args[0] as CatalogFetchPlan),
    "catalog.contents.refresh": (db, args) =>
      refreshCatalogContents(db.prisma, args[0] as CatalogEntry),
    "plans.backfill": async (db, args) => {
      const plansDir = typeof args[0] === "string" ? args[0] : "";
      const captures = extractPlansFromPlansDir(plansDir);
      // FEA-4154: persist the captured plans via upsertPlans, which batches them
      // into bounded write-queue chunks instead of a per-file upsertPlan call
      // (which each opened its own write-queue entry). Each chunk is ONE
      // prisma.write — a single write-queue entry (queue.run serialization), not a
      // DB $transaction: statements autocommit and synchronous=NORMAL doesn't fsync
      // the WAL per commit. This collapses the per-file queue round-trips into
      // ~N/chunk while keeping the sole writer from being held for the whole sweep.
      await upsertPlans(db.prisma, captures);
      return captures.length;
    },
    "plans.confirm": (db, args) => confirmPlan(db.prisma, String(args[0])),
    "plans.reject": (db, args) => rejectPlan(db.prisma, String(args[0])),
  };

  return storeOps;
}
