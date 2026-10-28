/**
 * @file catchup-cache.ts
 * @description Per-file (mtime, size) cache shared by every harness importer
 * (FEA-1503; ported from the vendor `catchup-cache.js`, logic preserved). The
 * boot import + catchup poll re-list files cheaply: an unchanged file is skipped
 * with one stat() call instead of a full parse. When constructed with an
 * `IngestStorePort` the cache survives process restarts (ISS-9838: a row in the
 * local SQLite store, best-effort), so a cold-start boot import skips unchanged
 * history with a single stat() each.
 */
import { type Stats, statSync } from "node:fs";
import type {
  IngestStorePort,
  IngestStoreSnapshot,
} from "./ingest-store-port.js";

/**
 * Bump this whenever parser/import semantics change in a way that must
 * re-process files whose mtime/size are unchanged. A persisted cache with a
 * different version is discarded wholesale, forcing a one-time full reimport.
 *
 * v2: FEA-1459 — usage dedup, subagent merge, token_events, codex delta
 * semantics. Historical sessions parsed by the v1 pipeline carry inflated
 * totals and missing token_events; they must be reparsed once.
 *
 * DB-row re-derivation is versioned independently by DATA_REVISION in
 * data-revision.ts (FEA-1785) — see its doc comment for which lever to bump.
 */
const PERSIST_VERSION = 2;

type SeenEntry = {
  mtimeMs: number;
  size: number;
  /** FEA-1459 Fix 11: Optional extra mtime (e.g., max subagent file mtime). */
  extraMtimeMs?: number;
  /**
   * ISS-12036: this source's last pass parsed it to NO session, at these bytes.
   *
   * A Codex root rollout dropped by the burst classifier, or one carrying no
   * usable timestamp, returns an empty session list BY DESIGN — so no row will
   * ever exist under the id `sessionIdForSource` derives from its path, and the
   * orphan self-heal (`isOrphanedFromDb`) readmitted it on every scan forever.
   * Measured as a backfill that never drained: `sources_remaining` flat at 66
   * for 48h. ISS-7306 closed the same loop for a folded CHILD rollout, which the
   * scan recognises as a burst ARTIFACT ahead of the orphan check; a root has no
   * parent, so nothing recognised it.
   *
   * Scoped to the fingerprint above, which is what keeps it from becoming a
   * permanent drop: a transcript that grows past the burst window, or gains a
   * timestamp, changes its mtime/size and is re-parsed from scratch. A change to
   * how the parser decides the zero — the burst thresholds included — is a
   * parser-semantics change and is retired by {@link PERSIST_VERSION}, the lever
   * that already exists for exactly that. A change to the collector's RUNTIME
   * parse settings (the Codex burst env vars) is retired by
   * {@link SeenEntry.noSessionKey} instead.
   */
  noSession?: boolean;
  /**
   * The collector's `zeroSessionParseKey` when {@link SeenEntry.noSession} was
   * stamped. Codex re-reads its burst thresholds on every parse, so raising
   * the record minimum can turn a dropped burst into a valid session with no
   * change to the file; the mark is honoured only while this still matches.
   */
  noSessionKey?: string;
};

export type CatchupCache = {
  /**
   * ISS-12036: `yieldedNoSession` reports the {@link SeenEntry.noSession} mark,
   * and only ever alongside `unchanged: true` — the mark describes a specific set
   * of bytes, so it is meaningless once the fingerprint has moved. Answered here,
   * off the one fingerprint comparison this function already makes, so no caller
   * re-derives freshness to read it.
   */
  isUnchanged(
    filePath: string,
    extraMtimeMs?: number | null
  ): { unchanged: boolean; stat: Stats | null; yieldedNoSession: boolean };
  markSeen(filePath: string): void;
  markSeenWith(
    filePath: string,
    stat: Stats | null,
    extraMtimeMs?: number | null,
    options?: { yieldedNoSession?: boolean }
  ): void;
  pruneTo(currentPaths: string[]): void;
  flush(): void;
  size(): number;
  clear(): void;
  readonly persisted: boolean;
};

/** Parse a persisted SeenEntry from disk data, preserving extraMtimeMs when present. */
function parseSeenEntry(value: unknown): SeenEntry | null {
  const v = value as Partial<SeenEntry> | null;
  if (!v || typeof v.mtimeMs !== "number" || typeof v.size !== "number") {
    return null;
  }
  const entry: SeenEntry = { mtimeMs: v.mtimeMs, size: v.size };
  if (typeof v.extraMtimeMs === "number") {
    entry.extraMtimeMs = v.extraMtimeMs;
  }
  // ISS-12036: additive and version-skew safe. An entry persisted before the
  // mark shipped loads without it and behaves exactly as it did — readmitted by
  // the orphan self-heal until a pass re-parses the source to zero and stamps it.
  if (v.noSession === true) {
    entry.noSession = true;
  }
  if (typeof v.noSessionKey === "string") {
    entry.noSessionKey = v.noSessionKey;
  }
  return entry;
}

export function createCatchupCache(
  options: {
    store?: IngestStorePort;
    /** See {@link SeenEntry.noSessionKey}; read live on every check and mark. */
    zeroSessionParseKey?: () => string;
  } = {}
): CatchupCache {
  const store = options.store ?? null;
  const zeroSessionParseKey = options.zeroSessionParseKey ?? (() => "");

  const seen = new Map<string, SeenEntry>();
  let dirty = false;

  // ISS-9837 R1: `hydrated` was resolved before this constructor ran, so the
  // load stays synchronous. R3: discard a snapshot written by a different
  // PERSIST_VERSION WHOLE — entries from an older parser pipeline would skip
  // files the new pipeline must reparse.
  const hydrated = store?.hydrated ?? null;
  const entries =
    hydrated?.version === PERSIST_VERSION ? hydrated.entries : undefined;
  if (entries) {
    for (const [key, value] of Object.entries(entries)) {
      const entry = parseSeenEntry(value);
      if (entry) {
        seen.set(key, entry);
      }
    }
  }

  function isUnchanged(
    filePath: string,
    extraMtimeMs?: number | null
  ): {
    unchanged: boolean;
    stat: Stats | null;
    yieldedNoSession: boolean;
  } {
    let stat: Stats;
    try {
      stat = statSync(filePath);
    } catch {
      return { unchanged: false, stat: null, yieldedNoSession: false };
    }
    const cached = seen.get(filePath);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      // FEA-1459 Fix 11: Also check the extra mtime (e.g. max subagent mtime).
      //
      // ISS-7198: DIFFERENT, not GREATER. Collectors fold several independent
      // clocks into this one number — the Claude one sums its subagent clock and
      // its Desktop-sidecar clock — so it is a FINGERPRINT, not a timestamp, and
      // it moves DOWN whenever one of those inputs goes away. Under a `>` test a
      // decrease read as "unchanged", which is how a DELETED input kept its
      // stale enrichment alive: a removed Desktop sidecar lowered the fold, the
      // source was skipped, and the session kept serving a `claudeDesktopOrigin`
      // whose file no longer existed until the transcript itself changed. Any
      // difference is a real change to a real input, and a re-import is
      // idempotent, so treating it as one converges rather than oscillating.
      if (extraMtimeMs != null) {
        const cachedExtra = cached.extraMtimeMs ?? 0;
        if (extraMtimeMs !== cachedExtra) {
          return { unchanged: false, stat, yieldedNoSession: false };
        }
      }
      return {
        unchanged: true,
        stat,
        yieldedNoSession:
          cached.noSession === true &&
          (cached.noSessionKey ?? "") === zeroSessionParseKey(),
      };
    }
    return { unchanged: false, stat, yieldedNoSession: false };
  }

  function markSeenWith(
    filePath: string,
    stat: Stats | null,
    extraMtimeMs?: number | null,
    options?: { yieldedNoSession?: boolean }
  ): void {
    if (stat) {
      const entry: SeenEntry = { mtimeMs: stat.mtimeMs, size: stat.size };
      if (extraMtimeMs != null) {
        entry.extraMtimeMs = extraMtimeMs;
      }
      // ISS-12036: written only when TRUE, so re-marking a source that now
      // yields a session clears the mark by replacing the whole entry rather
      // than carrying a stale `false` — the entry is rebuilt here on every mark.
      if (options?.yieldedNoSession === true) {
        entry.noSession = true;
        const key = zeroSessionParseKey();
        if (key !== "") {
          entry.noSessionKey = key;
        }
      }
      seen.set(filePath, entry);
      dirty = true;
    }
  }

  function markSeen(filePath: string): void {
    let stat: Stats;
    try {
      stat = statSync(filePath);
    } catch {
      return;
    }
    seen.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
    dirty = true;
  }

  function pruneTo(currentPaths: string[]): void {
    const keep = new Set(currentPaths);
    for (const key of seen.keys()) {
      if (!keep.has(key)) {
        seen.delete(key);
        dirty = true;
      }
    }
  }

  function flush(): void {
    if (!(store && dirty)) {
      return;
    }
    dirty = false;
    const snapshot: IngestStoreSnapshot = {
      version: PERSIST_VERSION,
      entries: {},
    };
    for (const [key, value] of seen) {
      snapshot.entries[key] = value;
    }
    try {
      // Deliberately NOT retried (ISS-5302): `dirty` is already cleared above, so
      // an unaccepted write is dropped rather than re-flushed. Unlike the
      // quarantine, a lost fingerprint costs one re-import of an unchanged
      // source, never a re-parse of a poison one.
      store.save(snapshot).catch(() => {
        // The port contract says `save` never rejects; terminating the chain
        // keeps a port that breaks it from becoming an unhandled rejection.
      });
    } catch {
      /* best-effort persistence — cache stays correct in memory */
    }
  }

  function size(): number {
    return seen.size;
  }

  function clear(): void {
    if (seen.size > 0) {
      dirty = true;
    }
    seen.clear();
  }

  return {
    isUnchanged,
    markSeen,
    markSeenWith,
    pruneTo,
    flush,
    size,
    clear,
    persisted: store != null,
  };
}

/**
 * How often the catchup cache is flushed to disk DURING a long import pass, so a
 * kill/restart resumes near where it left off rather than re-processing every
 * source. The end-of-pass flush still runs; this only bounds the lost progress.
 */
export const CACHE_FLUSH_INTERVAL_MS = 10_000;

/**
 * Mark sources seen during one import pass, flushing to disk on a throttle.
 *
 * Extracted from the import loop (which sits at the file-size ceiling) because
 * the throttle carries STATE — the last flush time — across every source in the
 * pass, and a bare helper would have made the caller hold and thread it. Built
 * once per pass, so its clock starts when the pass does.
 */
export function createPassSeenWriter(
  cache: CatchupCache,
  intervalMs: number = CACHE_FLUSH_INTERVAL_MS,
  now: () => number = Date.now
): {
  markSeen(
    filePath: string,
    stat: Stats | null,
    extraMtimeMs: number | null,
    options?: { yieldedNoSession?: boolean }
  ): void;
} {
  let lastFlushAt = now();
  return {
    markSeen(filePath, stat, extraMtimeMs, options): void {
      cache.markSeenWith(filePath, stat, extraMtimeMs, options);
      const at = now();
      if (at - lastFlushAt >= intervalMs) {
        lastFlushAt = at;
        cache.flush();
      }
    },
  };
}
