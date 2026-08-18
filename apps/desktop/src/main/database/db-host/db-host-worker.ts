/**
 * FEA-2038 — DB host utilityProcess entry. Owns the single SQLite instance: it
 * opens the real `openSqliteAgentDatabase` runtime (SQLite + migrations + Prisma
 * + all stores) and serves `invoke` requests from the main process by resolving
 * the dotted op path against the runtime and calling it natively. Because the
 * heavy import write loop (`importer.importSession`) runs here, the 6–20 GB
 * backfill never touches the main thread.
 *
 * Reverse channel: `emit`/`log` are pushed to main as notifications;
 * `getUserIdentity` is synchronous in the runtime, so main forwards the current
 * identity via `set-user-identity` and this process serves it from a cache.
 */

import { randomUUID } from "node:crypto";
import {
  type TraceComment,
  type TraceCommentDraft,
  type TraceCommentReplyDraft,
  TraceCommentSurface,
  TraceCommentTargetType,
  type TraceCommentUpdate,
} from "@repo/api/src/types/comment";
import { resolveBinaryFromLoginShellSync } from "../../../server/shell-path.js";
import type {
  ScheduledReviewRequest,
  ScheduledReviewResult,
} from "../../../shared/scheduled-review-contract.js";
import type { SharedTraceCommentStoreTarget } from "../../../shared/shared-trace-comments-contract.js";
import { backfillActivitySegmentsFromTranscripts } from "../../collectors/parsing/activity-segment-backfill.js";
import { backfillArtifactLinksFromTranscripts } from "../../collectors/parsing/artifact-link-backfill.js";
import { detectBillingMode } from "../../cost/billing-mode-detector.js";
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
import * as catalogStore from "../../packs/catalog-store.js";
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
import * as planStore from "../../plans/plan-store.js";
import { startDbHostProfiling } from "../../profiling/db-host-profiling.js";
import {
  createLocalTraceComment,
  createLocalTraceCommentReply,
  deleteLocalTraceComment,
  listLocalTraceComments,
  listPendingLocalTraceCommentOperations,
  listPendingLocalTraceComments,
  listPendingLocalTraceCommentTargets,
  markLocalTraceCommentDeleted,
  markLocalTraceCommentReplySyncFailed,
  markLocalTraceCommentReplyUploaded,
  markLocalTraceCommentSyncFailed,
  markLocalTraceCommentUploaded,
  type UserIdentity,
  updateLocalTraceComment,
  upsertCloudTraceComments,
} from "../../trace-comments/shared-trace-comments-store.js";
import {
  cloudGithubOverlayReadArgsSchema,
  cloudGithubOverlayWriteArgsSchema,
  readCloudGithubBranchOverlays,
  writeCloudGithubBranchOverlays,
} from "../cloud-github-overlay-store.js";
import { repairSkillShadowedCommandInventory } from "../skill-shadow-inventory-maintenance.js";
import {
  openSqliteAgentDatabase,
  type SqliteAgentDatabase,
} from "../sqlite.js";
import {
  type DbHostInvokeDeps,
  dispatchDbHostInvoke,
} from "./db-host-invoke-dispatch.js";
import {
  type HeapWatchdog,
  installProcessCrashLogging,
  measureOp,
  startHeapWatchdog,
} from "./db-host-memory-watchdog.js";
import { createDbHostOpLanes } from "./db-host-op-lanes.js";
import {
  type DbHostRequest,
  DbHostRequestKind,
  type DbHostResponse,
  DbHostResponseKind,
  type DbHostUserIdentity,
  isDbHostRequest,
  serializeDbHostError,
} from "./db-host-protocol.js";
import { dispatchDbHostStoreOp } from "./db-host-store-op-registry.js";
import { InsightsResultCache, insightsCacheKey } from "./insights-cache.js";
import { createSessionOwnerClaimTracker } from "./session-owner-claim-tracker.js";
import {
  awaitMemoryPressureClearForAdmission,
  yieldDbHostLoopUnderMemoryPressure,
} from "./yield-db-host-loop.js";

let agentDatabase: SqliteAgentDatabase | null = null;
let currentIdentity: DbHostUserIdentity = null;
// ISS-6168 — repair unowned sessions when an identity arrives AFTER the store
// opened (the normal cold-start case: main's resolver answers null on its first
// call and warms `/me` in the background). The tracker owns the retry policy and
// its rationale; `claim` is late-bound because a push can precede the open.
const sessionOwnerClaimTracker = createSessionOwnerClaimTracker({
  claim: (identity) => agentDatabase?.claimSessionOwnerIdentity(identity),
  log: (message) => post({ kind: DbHostResponseKind.Log, message }),
});
// FEA-4143 — pending scheduled-review runs proxied to main, keyed by request id.
// A due `review` task's dispatch posts a ScheduledReviewRun to main and parks
// here until main replies with the correlated ScheduledReviewResult.
//
// Tzqf1 — the reverse-RPC `id` counter below restarts at 1 with every forked
// worker, so `id` alone cannot distinguish this worker's request from the same
// `id` in a previous (crashed) worker. `WORKER_GENERATION` is minted ONCE per
// worker instance (the module body runs once per fork) and stamped on every
// ScheduledReviewRun; main echoes it back verbatim, and the reply handler drops
// any result whose generation ≠ ours. A late reply for a crashed worker's audit
// therefore can never resolve an unrelated same-`id` review in this worker.
const WORKER_GENERATION = randomUUID();
let nextScheduledReviewId = 1;
const pendingScheduledReviews = new Map<
  number,
  {
    resolve: (value: ScheduledReviewResult) => void;
    reject: (error: Error) => void;
  }
>();
let heapWatchdog: HeapWatchdog | null = null;

// FEA-3072 — report OOM-adjacent throws/rejections to main before the process is
// killed. Installed once at module load (utilityProcess entry runs once).
installProcessCrashLogging(childLog);

// ISS-4430 — env-gated profiling. `utilityProcess.fork` inherits the parent env,
// so the gate is read off `process.env` here rather than threaded through the
// fork options or Init. `null` (production default) makes the `measureOp` call
// below pass `undefined` — exactly what it passed before profiling existed.
const dbHostProfiling = startDbHostProfiling(process.env, childLog);

/**
 * FEA-2038: memoized git/gh binary path resolution. `resolveBinaryFromLoginShellSync`
 * spawns a synchronous interactive login shell, which is expensive on a heavy
 * shell profile; the path never changes for the process lifetime, so resolve each
 * binary at most once. A failed resolution is NOT cached so a transient failure
 * can be retried on the next call.
 */
const cachedBinaryPaths = new Map<string, string>();
function resolveCachedBinaryPath(binary: "git" | "gh"): string {
  const cached = cachedBinaryPaths.get(binary);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = resolveBinaryFromLoginShellSync(binary).path;
  cachedBinaryPaths.set(binary, resolved);
  return resolved;
}

/**
 * FEA-2055 — caches `dashboard.getInsights` results, invalidates them on each
 * committed write (via the emit boundary below → `bumpDataEpoch`), debounces
 * recompute during backfill, and single-flights + concurrency-bounds the heavy
 * computation so concurrent dashboard sections can't stampede the child into OOM.
 */
const insightsCache = new InsightsResultCache();

// The worker's admission lanes. Which ops are exclusive, which take the bounded
// read lane, and which run ungated is decided in `db-host-op-lanes.ts` — the
// policy lives there, with its full rationale, because this module registers a
// `process.parentPort` listener at load and so cannot be imported by a test.
//
// Every lane shares the one FEA-3150 `admit` gate below: a bounded, memory-aware
// pre-admission wait that keeps a heavy op from starting on top of an existing
// RSS/heap high-water. It defers, never deadlocks.
//
// `onBoundedTiming` is the ISS-4430 lane split and is present ONLY under
// `CLOSEDLOOP_PROFILE_DIR`: absent, the lane reads no clock, so the capture
// cannot cost anything on a production launch.
const opLanes = createDbHostOpLanes({
  admit: () => awaitMemoryPressureClearForAdmission({ log: childLog }),
  onBoundedTiming: dbHostProfiling?.onBoundedTiming,
});

function post(message: DbHostResponse): void {
  process.parentPort.postMessage(message);
}

function childLog(message: string): void {
  post({ kind: DbHostResponseKind.Log, message });
}

/**
 * FEA-4143 — proxy a scheduled review run to the main process. Posts a
 * ScheduledReviewRun and awaits main's correlated ScheduledReviewResult. This is
 * the child→main hop: the daemon's dispatch (in this process) cannot run the
 * cascade itself — no access token, no shell PATH, and it must never touch the
 * live checkout — so main composes it through the on-demand AuditService.
 */
function runScheduledReview(
  request: ScheduledReviewRequest
): Promise<ScheduledReviewResult> {
  const id = nextScheduledReviewId++;
  return new Promise<ScheduledReviewResult>((resolve, reject) => {
    pendingScheduledReviews.set(id, { resolve, reject });
    post({
      kind: DbHostResponseKind.ScheduledReviewRun,
      id,
      generation: WORKER_GENERATION,
      request,
    });
  });
}

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
    catalogStore.upsertCatalogSeed(
      db.prisma,
      args[0] as Parameters<typeof catalogStore.upsertCatalogSeed>[1]
    ),
  // FEA-2038: the GitHub stats fetch + contents refresh both end in
  // `prisma.write` (applyFetchResult / applyContentsFetch), which can't run over
  // the method proxy — so they execute wholly here. The GitHub I/O (gh CLI / REST)
  // runs in this process, mirroring packScanner.run's filesystem work; the cadence
  // is light (≤ daily for stats, on-demand for contents).
  "catalog.fetch.run": (db) => runCatalogFetch(db.prisma),
  // ISS-5274: the fetch's single catalog read, so the ~20 gh/HTTPS calls that
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
    const captures = planStore.extractPlansFromPlansDir(plansDir);
    // FEA-4154: persist the captured plans via upsertPlans, which batches them
    // into bounded write-queue chunks instead of a per-file upsertPlan call
    // (which each opened its own write-queue entry). Each chunk is ONE
    // prisma.write — a single write-queue entry (queue.run serialization), not a
    // DB $transaction: statements autocommit and synchronous=NORMAL doesn't fsync
    // the WAL per commit. This collapses the per-file queue round-trips into
    // ~N/chunk while keeping the sole writer from being held for the whole sweep.
    await planStore.upsertPlans(db.prisma, captures);
    return captures.length;
  },
  "plans.confirm": (db, args) =>
    planStore.confirmPlan(db.prisma, String(args[0])),
  "plans.reject": (db, args) =>
    planStore.rejectPlan(db.prisma, String(args[0])),
  "traceComments.list": (db, args) =>
    listLocalTraceComments(
      db.prisma,
      requireTraceCommentTarget(args[0]),
      requireUserIdentity(args[1])
    ),
  "traceComments.create": (db, args) =>
    createLocalTraceComment(
      db.prisma,
      requireTraceCommentTarget(args[0]),
      requireTraceCommentDraft(args[1]),
      requireUserIdentity(args[2])
    ),
  "traceComments.reply": (db, args) =>
    createLocalTraceCommentReply(
      db.prisma,
      requireTraceCommentTarget(args[0]),
      requireString(args[1], "trace comment id"),
      requireTraceCommentReplyDraft(args[2]),
      requireUserIdentity(args[3])
    ),
  "traceComments.update": (db, args) =>
    updateLocalTraceComment(
      db.prisma,
      requireTraceCommentTarget(args[0]),
      requireString(args[1], "trace comment id"),
      requireTraceCommentUpdate(args[2]),
      requireUserIdentity(args[3])
    ),
  "traceComments.delete": (db, args) =>
    deleteLocalTraceComment(
      db.prisma,
      requireTraceCommentTarget(args[0]),
      requireString(args[1], "trace comment id"),
      requireUserIdentity(args[2])
    ),
  "traceComments.upsertCloud": (db, args) =>
    upsertCloudTraceComments(
      db.prisma,
      requireTraceCommentTarget(args[0]),
      requireTraceCommentArray(args[1]),
      requireUserIdentity(args[2])
    ),
  "traceComments.listPending": (db, args) =>
    listPendingLocalTraceComments(
      db.prisma,
      requireTraceCommentTarget(args[0]),
      requireUserIdentity(args[1])
    ),
  "traceComments.listPendingOperations": (db, args) =>
    listPendingLocalTraceCommentOperations(
      db.prisma,
      requireTraceCommentTarget(args[0]),
      requireUserIdentity(args[1])
    ),
  "traceComments.listPendingTargets": (db, args) =>
    listPendingLocalTraceCommentTargets(
      db.prisma,
      requireUserIdentity(args[0])
    ),
  "traceComments.markUploaded": (db, args) =>
    markLocalTraceCommentUploaded(
      db.prisma,
      requireString(args[0], "trace comment id"),
      requireTraceComment(args[1])
    ),
  "traceComments.markReplyUploaded": (db, args) =>
    markLocalTraceCommentReplyUploaded(
      db.prisma,
      requireString(args[0], "trace comment id"),
      requireString(args[1], "trace reply id"),
      requireTraceComment(args[2])
    ),
  "traceComments.markSyncFailed": (db, args) =>
    markLocalTraceCommentSyncFailed(
      db.prisma,
      requireString(args[0], "trace comment id"),
      requireString(args[1], "sync error"),
      requireTraceCommentSyncOperation(args[2])
    ),
  "traceComments.markReplySyncFailed": (db, args) =>
    markLocalTraceCommentReplySyncFailed(
      db.prisma,
      requireString(args[0], "trace comment id"),
      requireString(args[1], "trace reply id"),
      requireString(args[2], "sync error")
    ),
  "traceComments.markDeleted": (db, args) =>
    markLocalTraceCommentDeleted(
      db.prisma,
      requireString(args[0], "trace comment id")
    ),
  "cloudGithubOverlays.read": (db, args) => {
    const [identityKey, repoNames] =
      cloudGithubOverlayReadArgsSchema.parse(args);
    return readCloudGithubBranchOverlays(db.prisma, identityKey, repoNames);
  },
  "cloudGithubOverlays.write": (db, args) => {
    const [identityKey, repoNames, overlays, lastSyncedAt] =
      cloudGithubOverlayWriteArgsSchema.parse(args);
    return writeCloudGithubBranchOverlays(
      db.prisma,
      identityKey,
      repoNames,
      overlays,
      lastSyncedAt
    );
  },
};

function requireTraceCommentTarget(
  value: unknown
): SharedTraceCommentStoreTarget {
  if (!(value && typeof value === "object")) {
    throw new Error("Invalid trace comment target.");
  }
  const candidate = value as Partial<SharedTraceCommentStoreTarget>;
  if (
    (candidate.type === TraceCommentTargetType.Session ||
      candidate.type === TraceCommentTargetType.Branch) &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0
  ) {
    const surface = (value as { surface?: unknown }).surface;
    return {
      type: candidate.type,
      id: candidate.id,
      ...(candidate.type === TraceCommentTargetType.Branch
        ? {
            surface:
              surface === TraceCommentSurface.BranchTimeline
                ? TraceCommentSurface.BranchTimeline
                : TraceCommentSurface.BranchDetail,
          }
        : {}),
    };
  }
  throw new Error("Invalid trace comment target.");
}

function requireTraceCommentDraft(value: unknown): TraceCommentDraft {
  if (!(value && typeof value === "object")) {
    throw new Error("Invalid trace comment draft.");
  }
  const candidate = value as Partial<TraceCommentDraft>;
  if (
    typeof candidate.body === "string" &&
    candidate.body.length > 0 &&
    candidate.anchor &&
    typeof candidate.anchor === "object"
  ) {
    // Sanitize `mentions` for parity with the reply/update validators
    // (FEA-3518): a present-but-non-array value degrades to an empty list
    // rather than passing through raw and crashing normalizeMentions.
    const mentions = optionalMentionIds(candidate.mentions);
    return {
      ...(candidate as TraceCommentDraft),
      ...(mentions ? { mentions } : {}),
    };
  }
  throw new Error("Invalid trace comment draft.");
}

// Preserve the optional @-mention user-ID list across the IPC boundary
// (FEA-3490). Returns `undefined` when the field is omitted so downstream
// edit handling can distinguish "no change" from an explicit empty list; a
// present-but-non-array value is treated as no mentions rather than rejected.
function optionalMentionIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
}

function requireTraceCommentReplyDraft(value: unknown): TraceCommentReplyDraft {
  if (!(value && typeof value === "object")) {
    throw new Error("Invalid trace comment reply.");
  }
  const candidate = value as Partial<TraceCommentReplyDraft>;
  if (typeof candidate.body === "string" && candidate.body.length > 0) {
    const mentions = optionalMentionIds(candidate.mentions);
    return { body: candidate.body, ...(mentions ? { mentions } : {}) };
  }
  throw new Error("Invalid trace comment reply.");
}

function requireTraceCommentUpdate(value: unknown): TraceCommentUpdate {
  if (!(value && typeof value === "object")) {
    throw new Error("Invalid trace comment update.");
  }
  const candidate = value as Partial<TraceCommentUpdate>;
  if (typeof candidate.body === "string" && candidate.body.length > 0) {
    const mentions = optionalMentionIds(candidate.mentions);
    return { body: candidate.body, ...(mentions ? { mentions } : {}) };
  }
  throw new Error("Invalid trace comment update.");
}

function requireTraceComment(value: unknown): TraceComment {
  if (!(value && typeof value === "object")) {
    throw new Error("Invalid trace comment.");
  }
  const candidate = value as Partial<TraceComment>;
  if (
    typeof candidate.id === "string" &&
    typeof candidate.threadId === "string" &&
    typeof candidate.body === "string" &&
    candidate.anchor &&
    typeof candidate.anchor === "object" &&
    candidate.target
  ) {
    return candidate as TraceComment;
  }
  throw new Error("Invalid trace comment.");
}

function requireTraceCommentArray(value: unknown): TraceComment[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid trace comment array.");
  }
  return value.map(requireTraceComment);
}

function requireUserIdentity(value: unknown): UserIdentity {
  if (value === null || value === undefined) {
    return null;
  }
  if (!(typeof value === "object")) {
    throw new Error("Invalid user identity.");
  }
  const candidate = value as Partial<NonNullable<UserIdentity>>;
  return {
    profileId:
      typeof candidate.profileId === "string" ? candidate.profileId : null,
    computeTargetId:
      typeof candidate.computeTargetId === "string"
        ? candidate.computeTargetId
        : null,
    userId: typeof candidate.userId === "string" ? candidate.userId : null,
    organizationId:
      typeof candidate.organizationId === "string"
        ? candidate.organizationId
        : null,
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Invalid ${label}.`);
}

function requireTraceCommentSyncOperation(
  value: unknown
): "create" | "update" | "delete" {
  if (value === "update" || value === "delete") {
    return value;
  }
  return "create";
}

/**
 * ISS-5941 — the dispatch body lives in `db-host-invoke-dispatch.ts` so a test
 * can drive the real routing branches; this module cannot be imported (it
 * registers a `parentPort` listener at load). Everything the dispatch needs
 * from here is injected below.
 *
 * `deliver` is the success-result post, and the dispatch calls it INSIDE the
 * op's lane permit so the permit spans the structured clone — see that file's
 * header for why the heap bound depends on it.
 */
function invokeDeps(deliver: (value: unknown) => void): DbHostInvokeDeps {
  return {
    lanes: opLanes,
    getRoot: () => agentDatabase,
    runStoreOp: (op: string, args: unknown[]) => {
      const db = agentDatabase;
      if (!db) {
        throw new Error("db-host not initialized");
      }
      return dispatchDbHostStoreOp(storeOps, db, op, args);
    },
    getInsights: (args, compute) =>
      insightsCache.get(insightsCacheKey(args), compute),
    deliver,
  };
}

async function handleInvoke(
  op: string,
  args: unknown[],
  deliver: (value: unknown) => void,
  // ISS-6079: forwarded from the request. Absent => interactive.
  options?: { background?: boolean }
): Promise<void> {
  // FEA-3072 — name the op in the log when it allocates heavily or leaves the
  // heap under pressure, so the recurring exit-code-5 crash stops being
  // anonymous.
  // ISS-4430 — the same wrapper records per-op wall time when profiling is on.
  const run = () =>
    dispatchDbHostInvoke(op, args, invokeDeps(deliver), options);
  await measureOp(op, childLog, run, dbHostProfiling?.measureOpOptions);
}

async function openDatabase(
  dataDir: string,
  staleMinutes: number | undefined,
  identity: DbHostUserIdentity
): Promise<void> {
  currentIdentity = identity;
  agentDatabase = await openSqliteAgentDatabase({
    dataDir,
    staleMinutes,
    detectBillingMode,
    emit: (sessionId: string) => {
      // FEA-2055 — a committed write is the cache-invalidation boundary: advance
      // the data epoch so any cached insights computed before this write are
      // marked stale (the backfill debounce then governs WHEN they recompute).
      insightsCache.bumpDataEpoch();
      agentDatabase?.sessions
        .handleSessionMutation(sessionId)
        .catch(() => undefined);
      post({ kind: DbHostResponseKind.Emit, sessionId });
    },
    onSessionTerminal: (notice) =>
      post({
        kind: DbHostResponseKind.SessionTerminal,
        sessionId: notice.sessionId,
        status: notice.status,
      }),
    // FEA-3814 (PRD-553 M2): the crewd scheduler changed its tasks/runs; main
    // forwards desktop:scheduled-tasks:changed so the read-only UI refetches.
    onSchedulerChanged: () =>
      post({ kind: DbHostResponseKind.SchedulerChanged }),
    // FEA-4143: the child→main proxy the scheduler's review dispatch uses to run
    // a scheduled review through the main-process AuditService.
    runScheduledReview,
    getUserIdentity: () => currentIdentity,
    // FEA-2038: resolve the git binary ONCE and memoize. This spawns a
    // synchronous interactive login shell (`zsh -l -i`), which on a heavy shell
    // profile blocks the db-host main thread for seconds. `onPostImport` calls
    // resolveGitPath() for imported sessions, so without memoization the backfill
    // can fire hundreds of synchronous login-shell spawns. The resolved path is
    // stable for the process lifetime, so caching the first result is safe.
    resolveGitPath: () => resolveCachedBinaryPath("git"),
    log: (message: string) => post({ kind: DbHostResponseKind.Log, message }),
  });
}

async function handleMessage(request: DbHostRequest): Promise<void> {
  switch (request.kind) {
    case DbHostRequestKind.Init: {
      try {
        await openDatabase(
          request.options.dataDir,
          request.options.staleMinutes,
          request.options.identity ?? null
        );
        // FEA-3072 — begin heap-pressure sampling once the DB is open (the heavy
        // backfill/sync/read work starts after Ready). Re-init after a restart
        // replaces any prior watchdog.
        heapWatchdog?.stop();
        heapWatchdog = startHeapWatchdog({
          log: childLog,
          snapshotDir: request.options.dataDir,
          // ISS-4823 — publish this worker's pressure level to main. The
          // main-process DATA_REVISION rebuild's adaptive write-pause gate
          // declares a db-host-pressure arm that nothing could satisfy before
          // this: `getMemoryPressure()` reads THIS process's memory, and the
          // rebuild's writes reach the writer through the generic invoke path,
          // which takes neither the heavy-op gate's pre-admission wait nor
          // `yieldDbHostLoopUnderMemoryPressure`. So the rebuild really does need
          // its own back-pressure signal rather than inheriting one from the db
          // host. (ISS-5941 gave the generic path a bounded READ lane that DOES
          // take the pre-admission wait, but only for `BOUNDED_READ_OPS` — the
          // rebuild's writes are not in it, so this still holds.)
          onPressureChange: (level) =>
            post({ kind: DbHostResponseKind.MemoryPressure, level }),
        });
        post({ kind: DbHostResponseKind.Ready, id: request.id });
      } catch (error) {
        post({
          kind: DbHostResponseKind.Ready,
          id: request.id,
          error: serializeDbHostError(error),
        });
      }
      return;
    }
    case DbHostRequestKind.Invoke: {
      try {
        // ISS-5941 — the success post is handed DOWN so it happens inside the
        // op's lane permit: the value it clones is the corpus-sized result the
        // lane's heap bound is meant to cover.
        await handleInvoke(
          request.op,
          request.args,
          (value) => {
            post({
              kind: DbHostResponseKind.Result,
              id: request.id,
              ok: true,
              value,
            });
          },
          { background: request.background === true }
        );
      } catch (error) {
        post({
          kind: DbHostResponseKind.Result,
          id: request.id,
          ok: false,
          error: serializeDbHostError(error),
        });
      }
      return;
    }
    case DbHostRequestKind.SetUserIdentity: {
      currentIdentity = request.identity;
      sessionOwnerClaimTracker.onIdentity(request.identity);
      return;
    }
    case DbHostRequestKind.ScheduledReviewResult: {
      // FEA-4143 — main replied to a proxied scheduled review; resolve/reject the
      // parked dispatch by correlated id.
      //
      // Tzqf1 — drop a reply stamped with a DIFFERENT worker generation: the
      // `id` restarts at 1 per worker, so a late result from a crashed worker's
      // audit could otherwise carry this worker's live `id` and cross-talk into
      // an unrelated review. A generation mismatch means the result belongs to a
      // dead worker; ignore it (this worker's parked promise, if any, stays
      // parked and is failed on its own Close path) rather than mis-resolving.
      if (request.generation !== WORKER_GENERATION) {
        return;
      }
      const pending = pendingScheduledReviews.get(request.id);
      if (!pending) {
        return;
      }
      pendingScheduledReviews.delete(request.id);
      if (request.ok && request.value) {
        pending.resolve(request.value);
      } else {
        pending.reject(
          new Error(request.error?.message ?? "scheduled review failed")
        );
      }
      return;
    }
    case DbHostRequestKind.Close: {
      // FEA-4143 — fail any in-flight proxied reviews so the daemon's dispatch
      // rejects cleanly instead of hanging across shutdown.
      for (const pending of pendingScheduledReviews.values()) {
        pending.reject(new Error("db-host closing"));
      }
      pendingScheduledReviews.clear();
      heapWatchdog?.stop();
      heapWatchdog = null;
      try {
        await agentDatabase?.close();
      } catch {
        // Closing best-effort; we exit regardless.
      }
      // ISS-4430 — `process.exit(0)` below would race the profile write, and
      // this is the only graceful path out of the process. No-op when off.
      await dbHostProfiling?.stop();
      post({ kind: DbHostResponseKind.Result, id: request.id, ok: true });
      process.exit(0);
      return;
    }
    default:
      return;
  }
}

process.parentPort.on("message", (messageEvent) => {
  const data: unknown = messageEvent.data;
  if (!isDbHostRequest(data)) {
    return;
  }
  handleMessage(data).catch((error: unknown) => {
    post({
      kind: DbHostResponseKind.Log,
      message: serializeDbHostError(error).message,
    });
  });
});
