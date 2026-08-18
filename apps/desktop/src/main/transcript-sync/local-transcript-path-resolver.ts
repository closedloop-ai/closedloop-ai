/**
 * @file local-transcript-path-resolver.ts
 * @description Resolve the on-disk `.jsonl` path for a `(externalSessionId,
 * fileKey)` transcript, independent of the archive/sync lane. Used by the
 * cloud-transcript read bridge's graceful LOCAL fallback (see
 * `transcript-read-ipc.ts`): when the cloud (S3) copy failed or is not readable,
 * the bridge serves the local file instead.
 *
 * WHY store-INDEPENDENT: the transcript-sync fingerprint store only holds a row
 * once the archive lane has observed the file, which requires the sync feature
 * flag to be ON and a discovery sweep / hook to have run. The local fallback,
 * however, must work regardless of sync state — a signed-in user whose bytes
 * simply haven't uploaded yet (or who has sync disabled entirely) should still
 * see their local transcript. So this resolver:
 *   1. tries the sync store first (fast, no disk enumeration) when available, then
 *   2. falls back to a fresh `discoverTranscriptFiles()` enumeration of the
 *      collector roots — the SAME source the sync sweep uses — matched by
 *      `(externalSessionId, fileKey)`.
 *
 * The returned path is still a CANDIDATE only; the caller MUST re-anchor it
 * through `resolveTrustedClaudeTranscriptPath` before reading a byte (SSRF /
 * traversal guard). This module never trusts renderer input — its only inputs
 * are the ids from the (main-authorized) read request and the trusted collector
 * roots.
 */

import type { TranscriptFileRef } from "./transcript-sync-types.js";

/** Minimal store shape this resolver needs (the fingerprint lookup only). */
export type FingerprintLookup = {
  get(
    externalSessionId: string,
    fileKey: string
  ): Promise<{ sourcePath: string } | null>;
};

export type LocalTranscriptPathResolverDeps = {
  /**
   * The transcript-sync fingerprint store, or null when the archive lane / db
   * host is not up (e.g. sync flag off, or DB not ready). Null just skips the
   * fast path — discovery still resolves the file.
   */
  getStore: () => FingerprintLookup | null;
  /**
   * Enumerate every local transcript file mapped to its `(externalSessionId,
   * fileKey)` identity — the same `discoverTranscriptFiles()` the sync sweep
   * uses. Injected (rather than imported) so the collector modules stay off the
   * desktop-boot static-import graph (agent-dashboard boundary) and so this is
   * unit-testable without the filesystem.
   */
  discover: () => Promise<readonly TranscriptFileRef[]>;
};

/**
 * Build the `{ getStore, discover }` deps for {@link resolveLocalTranscriptPath}
 * with the lazy `discoverTranscriptFiles` import wired once. Both the read-bridge
 * (`app.ts`) and the detail-gating resolver
 * (`agent-dashboard-design-system-runtime.ts`) call this so the lazy-import
 * plumbing lives in a single place. The dynamic `import()` keeps the
 * collector-backed discovery module (and its collector imports) off the
 * desktop-boot static-import graph, satisfying the agent-dashboard boundary
 * guard. `getStore` stays a caller-supplied thunk — the fingerprint store is
 * reached lazily and can be null until the db host is ready.
 *
 * `stateDir` (FEA-3932) binds the materialized-OpenCode enumerator into the
 * discovery pass — the SAME override the transcript-sync sweep's `discover`
 * passes. Without it, `discoverTranscriptFiles()` falls back to the default no-op
 * OpenCode enumerator (`() => []`) and the local read fallback silently never
 * resolves an OpenCode projection, so an OpenCode transcript whose cloud copy is
 * unreadable (or was never synced) has no local fallback. Omit `stateDir` only
 * for Claude/Codex-only callers.
 */
export function createLocalTranscriptResolverDeps(
  getStore: () => FingerprintLookup | null,
  stateDir?: string
): LocalTranscriptPathResolverDeps {
  return {
    getStore,
    discover: async () => {
      if (stateDir === undefined) {
        const module = await import("./transcript-discovery.js");
        return module.discoverTranscriptFiles();
      }
      const [discoveryModule, materializedModule] = await Promise.all([
        import("./transcript-discovery.js"),
        import("./opencode-materialized-discovery.js"),
      ]);
      return discoveryModule.discoverTranscriptFiles({
        listOpencodeMaterializedFiles: () =>
          materializedModule.listOpencodeMaterializedFiles(stateDir),
      });
    },
  };
}

/**
 * Resolve the candidate local path for `(externalSessionId, fileKey)`, or null
 * when no local file matches. Store-first, then discovery. Any store or
 * discovery failure degrades to the next source (and ultimately null) rather
 * than throwing — a failed local lookup must never crash the read bridge; it
 * just means "no local fallback available".
 */
export async function resolveLocalTranscriptPath(
  deps: LocalTranscriptPathResolverDeps,
  externalSessionId: string,
  fileKey: string
): Promise<string | null> {
  // Fast path: the sync store already knows the path (sync enabled + observed).
  const store = deps.getStore();
  if (store) {
    try {
      const fingerprint = await store.get(externalSessionId, fileKey);
      if (fingerprint?.sourcePath) {
        return fingerprint.sourcePath;
      }
    } catch {
      // Store lookup failed — fall through to discovery.
    }
  }

  // Store-independent path: enumerate the collector roots and match by identity.
  // Covers sync-flag-off and not-yet-observed (freshly-run) sessions.
  try {
    const refs = await deps.discover();
    const match = refs.find(
      (ref) =>
        ref.externalSessionId === externalSessionId && ref.fileKey === fileKey
    );
    return match?.sourcePath ?? null;
  } catch {
    return null;
  }
}

/** `fileKey` of the main conversation — always first in the switcher order. */
const MAIN_TRANSCRIPT_FILE_KEY = "main";

/**
 * ISS-4677: every local transcript `fileKey` belonging to `externalSessionId` —
 * the main conversation plus each subagent sidechain — main first, then the
 * sidechains in a stable numeric-aware order.
 *
 * The desktop session detail previously probed for `main` ALONE, so a
 * desktop-local session could never report more than one transcript file and the
 * shared file switcher (which needs `> 1`) never rendered: a local session's
 * subagent sidechains were unreachable on desktop even though the files were
 * sitting on disk. Enumeration widens only the availability GATE — no path
 * crosses to the renderer, and the read bridge still re-anchors every path
 * through the SSRF guard before a byte is read.
 *
 * The store fast path cannot answer "which files exist" (it is a per-key
 * lookup), so this is discovery-first. When discovery does not surface a `main`
 * for the session — it failed, or the collector roots are not readable — it
 * degrades to the pre-existing store `main` probe rather than reporting no
 * transcript at all. That degradation reads the store DIRECTLY rather than going
 * through {@link resolveLocalTranscriptPath}, whose own discovery fallback would
 * run a SECOND full sweep on the (common) miss.
 *
 * Callers on a polled path MUST wrap `deps.discover` in
 * {@link createMemoizedDiscover} — see its docstring for why.
 */
export async function listLocalTranscriptFileKeys(
  deps: LocalTranscriptPathResolverDeps,
  externalSessionId: string
): Promise<string[]> {
  const discovered = new Set<string>();
  try {
    for (const ref of await deps.discover()) {
      if (ref.externalSessionId === externalSessionId) {
        discovered.add(ref.fileKey);
      }
    }
  } catch {
    // Discovery failed — fall through to the store main probe below.
  }

  // The store may know a main file discovery could not see (sync observed it
  // from a root no longer enumerated), so always reconcile the two.
  if (!discovered.has(MAIN_TRANSCRIPT_FILE_KEY)) {
    const store = deps.getStore();
    if (store) {
      try {
        const fingerprint = await store.get(
          externalSessionId,
          MAIN_TRANSCRIPT_FILE_KEY
        );
        if (fingerprint?.sourcePath) {
          discovered.add(MAIN_TRANSCRIPT_FILE_KEY);
        }
      } catch {
        // Store lookup failed — the session simply reports no main file.
      }
    }
  }

  const sidechains = [...discovered]
    .filter((fileKey) => fileKey !== MAIN_TRANSCRIPT_FILE_KEY)
    .sort((left, right) =>
      left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
  return discovered.has(MAIN_TRANSCRIPT_FILE_KEY)
    ? [MAIN_TRANSCRIPT_FILE_KEY, ...sidechains]
    : sidechains;
}

/**
 * How long a memoized discovery sweep may be reused before it is recomputed.
 * The sweep is an availability GATE, not the byte read, so a newly-created
 * sidechain appearing one window late is acceptable; serving a stale path is
 * not a risk because the read bridge re-resolves and re-anchors every path
 * itself before reading.
 */
export const DISCOVERY_MEMO_TTL_MS = 30_000;

/**
 * Wrap a `discover` implementation so a burst of callers shares ONE sweep.
 *
 * `discoverTranscriptFiles()` is a full recursive walk of every collector root
 * (all Claude project/session/subagent trees, all Codex rollouts including a
 * synchronous read per rollout file). That is fine for a one-shot read and
 * ruinous on a polled one: the desktop session-detail IPC refetches every few
 * seconds, so an unmemoized enumeration turns an O(1) indexed lookup into an
 * O(entire local corpus) sweep per poll, in the Electron MAIN process.
 *
 * Two collapses, both bounded:
 *  - a completed sweep is reused for {@link DISCOVERY_MEMO_TTL_MS};
 *  - concurrent callers arriving mid-sweep share the in-flight promise instead
 *    of each starting their own.
 *
 * State is a single entry held in the returned closure, so it cannot grow. A
 * failed sweep is NOT cached — the rejection propagates and the next call
 * retries, so a transient FS error does not blind the gate for a whole window.
 */
export function createMemoizedDiscover(
  discover: () => Promise<readonly TranscriptFileRef[]>,
  options: { ttlMs?: number; now?: () => number } = {}
): () => Promise<readonly TranscriptFileRef[]> {
  const ttlMs = options.ttlMs ?? DISCOVERY_MEMO_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; refs: readonly TranscriptFileRef[] } | null = null;
  let inFlight: Promise<readonly TranscriptFileRef[]> | null = null;

  return () => {
    if (cached && now() - cached.at < ttlMs) {
      return Promise.resolve(cached.refs);
    }
    if (inFlight) {
      return inFlight;
    }
    const pending = discover()
      .then((refs) => {
        cached = { at: now(), refs };
        return refs;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = pending;
    return pending;
  };
}
