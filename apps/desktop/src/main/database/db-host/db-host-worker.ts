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

import type {
  TraceComment,
  TraceCommentDraft,
  TraceCommentReplyDraft,
  TraceCommentTarget,
  TraceCommentUpdate,
} from "@repo/api/src/types/comment";
import { resolveBinaryFromLoginShellSync } from "../../../server/shell-path.js";
import { detectBillingMode } from "../../billing-mode-detector.js";
import { backfillActivitySegmentsFromTranscripts } from "../../collectors/parsing/activity-segment-backfill.js";
import { backfillArtifactLinksFromTranscripts } from "../../collectors/parsing/artifact-link-backfill.js";
import {
  type CatalogEntry,
  refreshCatalogContents,
} from "../../packs/catalog-contents.js";
import { runCatalogFetch } from "../../packs/catalog-fetcher.js";
import * as catalogStore from "../../packs/catalog-store.js";
import { runPackScanner } from "../../packs/pack-scanner.js";
import * as planStore from "../../plans/plan-store.js";
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
} from "../../shared-trace-comments-store.js";
import {
  cloudGithubOverlayReadArgsSchema,
  cloudGithubOverlayWriteArgsSchema,
  readCloudGithubBranchOverlays,
  writeCloudGithubBranchOverlays,
} from "../cloud-github-overlay-store.js";
import {
  openSqliteAgentDatabase,
  type SqliteAgentDatabase,
} from "../sqlite.js";
import {
  awaitMemoryPressureClearForAdmission,
  yieldDbHostLoopUnderMemoryPressure,
} from "../yield-db-host-loop.js";
import {
  type HeapWatchdog,
  installProcessCrashLogging,
  measureOp,
  startHeapWatchdog,
} from "./db-host-memory-watchdog.js";
import {
  type DbHostRequest,
  DbHostRequestKind,
  type DbHostResponse,
  DbHostResponseKind,
  type DbHostUserIdentity,
  isDbHostRequest,
  serializeDbHostError,
} from "./db-host-protocol.js";
import { createHeavyOpGate } from "./heavy-op-gate.js";
import { InsightsResultCache, insightsCacheKey } from "./insights-cache.js";

let agentDatabase: SqliteAgentDatabase | null = null;
let currentIdentity: DbHostUserIdentity = null;
let heapWatchdog: HeapWatchdog | null = null;

// FEA-3072 — report OOM-adjacent throws/rejections to main before the process is
// killed. Installed once at module load (utilityProcess entry runs once).
installProcessCrashLogging(childLog);

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

// Shared heavy-op gate: serializes the insights recompute against the heavy
// store-ops/backfill so their peaks never SUM past the single worker's heap
// (the OOM-crash-loop that let the backfill queue grow unbounded). See
// heavy-op-gate.ts for the full rationale.
//
// FEA-3150 (FEA-3132 P1): a memory-aware ADMISSION gate. Serialization bounds
// the peak to a single heavy op, but that single op could still START on top of
// an existing RSS/page-cache high-water. `admit` parks (bounded) BEFORE the op
// runs while the worker is under memory pressure, reusing the SAME signal
// FEA-3140 throttles a running backfill with — so GC/WAL-checkpoint can reclaim
// first. The wait is bounded, so it defers but never deadlocks.
const { runExclusive: runExclusiveHeavyOp } = createHeavyOpGate({
  admit: () => awaitMemoryPressureClearForAdmission({ log: childLog }),
});

/** The insights op intercepted by the cache (dotted runtime path). */
const INSIGHTS_OP = "dashboard.getInsights";

/**
 * Store ops (keyed by the suffix after `store:`) that are memory-heavy corpus
 * scans and MUST serialize against the insights recompute via the shared
 * heavy-op gate so their heap peaks never SUM past the single worker's heap.
 * These are the `*.backfill` jobs that scan thousands of transcripts/sessions.
 *
 * Everything else on the store-op surface — trace-comment create/reply/list,
 * plan confirm/reject, overlay reads/writes, catalog seed, etc. — is cheap and
 * often user-facing, so it runs UNGATED. Gating the whole surface (the earlier
 * approach) queued those interactive ops behind a full backfill for its entire
 * duration, which is exactly what we must avoid.
 */
const HEAVY_STORE_OPS = new Set<string>([
  "artifactLinks.backfill",
  "activitySegments.backfill",
]);

function post(message: DbHostResponse): void {
  process.parentPort.postMessage(message);
}

function childLog(message: string): void {
  post({ kind: DbHostResponseKind.Log, message });
}

/**
 * Prefix marking an `invoke` op as a registered store-op (see `storeOps`) rather
 * than a dotted method path resolved against the runtime.
 */
const STORE_OP_PREFIX = "store:";

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
  "packScanner.run": (db) => runPackScanner(db.prisma),
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
  "catalog.contents.refresh": (db, args) =>
    refreshCatalogContents(db.prisma, args[0] as CatalogEntry),
  "plans.backfill": async (db, args) => {
    const plansDir = typeof args[0] === "string" ? args[0] : "";
    const captures = planStore.extractPlansFromPlansDir(plansDir);
    for (const capture of captures) {
      await planStore.upsertPlan(db.prisma, capture);
    }
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

function requireTraceCommentTarget(value: unknown): TraceCommentTarget {
  if (!(value && typeof value === "object")) {
    throw new Error("Invalid trace comment target.");
  }
  const candidate = value as Partial<TraceCommentTarget>;
  if (
    (candidate.type === "session" || candidate.type === "branch") &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0
  ) {
    return { type: candidate.type, id: candidate.id };
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
    return candidate as TraceCommentDraft;
  }
  throw new Error("Invalid trace comment draft.");
}

function requireTraceCommentReplyDraft(value: unknown): TraceCommentReplyDraft {
  if (!(value && typeof value === "object")) {
    throw new Error("Invalid trace comment reply.");
  }
  const candidate = value as Partial<TraceCommentReplyDraft>;
  if (typeof candidate.body === "string" && candidate.body.length > 0) {
    return { body: candidate.body };
  }
  throw new Error("Invalid trace comment reply.");
}

function requireTraceCommentUpdate(value: unknown): TraceCommentUpdate {
  if (!(value && typeof value === "object")) {
    throw new Error("Invalid trace comment update.");
  }
  const candidate = value as Partial<TraceCommentUpdate>;
  if (typeof candidate.body === "string" && candidate.body.length > 0) {
    return { body: candidate.body };
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

/** Resolve a dotted op path (e.g. "sessions.getAll") to its fn + receiver. */
function resolveOp(
  root: object,
  op: string
): { fn: unknown; thisArg: unknown } {
  const parts = op.split(".");
  let thisArg: unknown;
  let target: unknown = root;
  for (const part of parts) {
    if (typeof target !== "object" || target === null) {
      throw new Error(`db-host op not found: ${op}`);
    }
    thisArg = target;
    target = Reflect.get(target, part);
  }
  return { fn: target, thisArg };
}

async function handleInvoke(op: string, args: unknown[]): Promise<unknown> {
  if (!agentDatabase) {
    throw new Error("db-host not initialized");
  }
  // FEA-3072 — name the op in the log when it allocates heavily or leaves the
  // heap under pressure, so the recurring exit-code-5 OOM stops being anonymous.
  return await measureOp(op, childLog, () => dispatchInvoke(op, args));
}

async function dispatchInvoke(op: string, args: unknown[]): Promise<unknown> {
  if (!agentDatabase) {
    throw new Error("db-host not initialized");
  }
  if (op.startsWith(STORE_OP_PREFIX)) {
    const storeKey = op.slice(STORE_OP_PREFIX.length);
    const storeOp = storeOps[storeKey];
    if (!storeOp) {
      throw new Error(`db-host store op not found: ${op}`);
    }
    const db = agentDatabase;
    const run = () => storeOp(db, args);
    // Only the memory-heavy backfills serialize against the insights recompute
    // (below) via the shared heavy-op gate so their peaks never sum past the
    // worker heap. Lightweight/interactive store ops run immediately so they
    // never queue behind a long-running backfill.
    return HEAVY_STORE_OPS.has(storeKey)
      ? await runExclusiveHeavyOp(run)
      : await run();
  }
  const { fn, thisArg } = resolveOp(agentDatabase, op);
  if (typeof fn !== "function") {
    throw new Error(`db-host op is not callable: ${op}`);
  }
  // Dynamic dispatch boundary: the op path + args are validated against the
  // SqliteAgentDatabase contract on the main-process proxy side.
  const callable = fn as (...callArgs: unknown[]) => unknown;
  // FEA-2055 — gate the heavy insights computation behind the result cache so
  // concurrent dashboard sections / toggles / backfill churn don't stampede the
  // child. A cache MISS calls the SAME native fn verbatim, so the result is
  // byte-identical to an uncached call.
  if (op === INSIGHTS_OP) {
    // The cache handles single-flight + debounce + insights-vs-insights bound;
    // a real (cache-miss) recompute additionally takes the shared heavy-op gate
    // so it can never run concurrently with a backfill/store-op chunk.
    return await insightsCache.get(insightsCacheKey(args), (markReadStart) =>
      runExclusiveHeavyOp(() => {
        // Snapshot the freshness epoch AFTER the gate is acquired — at the true
        // read moment — so a long wait behind a backfill/store-op chunk doesn't
        // back-date the cached entry and trigger needless recomputes.
        markReadStart();
        return Promise.resolve(callable.apply(thisArg, args));
      })
    );
  }
  return await callable.apply(thisArg, args);
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
        const value = await handleInvoke(request.op, request.args);
        post({
          kind: DbHostResponseKind.Result,
          id: request.id,
          ok: true,
          value,
        });
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
      return;
    }
    case DbHostRequestKind.Close: {
      heapWatchdog?.stop();
      heapWatchdog = null;
      try {
        await agentDatabase?.close();
      } catch {
        // Closing best-effort; we exit regardless.
      }
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
