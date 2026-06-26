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

import { resolveBinaryFromLoginShellSync } from "../../../server/shell-path.js";
import { detectBillingMode } from "../../billing-mode-detector.js";
import { backfillArtifactLinksFromTranscripts } from "../../collectors/artifact-link-backfill.js";
import {
  type CatalogEntry,
  refreshCatalogContents,
} from "../../packs/catalog-contents.js";
import { runCatalogFetch } from "../../packs/catalog-fetcher.js";
import * as catalogStore from "../../packs/catalog-store.js";
import { runPackScanner } from "../../packs/pack-scanner.js";
import * as planStore from "../../plans/plan-store.js";
import {
  openSqliteAgentDatabase,
  type SqliteAgentDatabase,
} from "../sqlite.js";
import {
  type DbHostRequest,
  DbHostRequestKind,
  type DbHostResponse,
  DbHostResponseKind,
  type DbHostUserIdentity,
  isDbHostRequest,
  serializeDbHostError,
} from "./db-host-protocol.js";
import { InsightsResultCache, insightsCacheKey } from "./insights-cache.js";

let agentDatabase: SqliteAgentDatabase | null = null;
let currentIdentity: DbHostUserIdentity = null;

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

/** The insights op intercepted by the cache (dotted runtime path). */
const INSIGHTS_OP = "dashboard.getInsights";

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
    // host process, so no parse-runner / cooperative-delay / cancel callbacks
    // are needed (the defaults — native parse, no pause, always-continue —
    // apply). Each rederive runs as its own atomic prisma.write($transaction).
    backfillArtifactLinksFromTranscripts(db.prisma, { log: childLog }),
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
};

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
  return await dispatchInvoke(op, args);
}

async function dispatchInvoke(op: string, args: unknown[]): Promise<unknown> {
  if (!agentDatabase) {
    throw new Error("db-host not initialized");
  }
  if (op.startsWith(STORE_OP_PREFIX)) {
    const storeOp = storeOps[op.slice(STORE_OP_PREFIX.length)];
    if (!storeOp) {
      throw new Error(`db-host store op not found: ${op}`);
    }
    return await storeOp(agentDatabase, args);
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
    return await insightsCache.get(insightsCacheKey(args), () =>
      Promise.resolve(callable.apply(thisArg, args))
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
    getUserIdentity: () => currentIdentity,
    // FEA-2038: resolve the git/gh binary ONCE and memoize. These spawn a
    // synchronous interactive login shell (`zsh -l -i`), which on a heavy shell
    // profile blocks the db-host main thread for seconds. `onPostImport` calls
    // resolveGitPath()/resolveGhPath() on EVERY session imported during backfill,
    // so without memoization the backfill fires hundreds of synchronous
    // login-shell spawns — freezing the event loop (no mem tick for seconds) and
    // crashing the db-host (exit code 5). The resolved path is stable for the
    // process lifetime, so caching the first result is safe.
    resolveGitPath: () => resolveCachedBinaryPath("git"),
    resolveGhPath: () => resolveCachedBinaryPath("gh"),
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
