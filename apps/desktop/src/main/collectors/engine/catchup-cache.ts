/**
 * @file catchup-cache.ts
 * @description Per-file (mtime, size) cache shared by every harness importer
 * (FEA-1503; ported from the vendor `catchup-cache.js`, logic preserved). The
 * boot import + catchup poll re-list files cheaply: an unchanged file is skipped
 * with one stat() call instead of a full parse. When constructed with a
 * `persistPath` the cache survives process restarts (best-effort JSON file), so a
 * cold-start boot import skips unchanged history with a single stat() each.
 */
import {
  mkdirSync,
  readFileSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

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
};

export type CatchupCache = {
  isUnchanged(
    filePath: string,
    extraMtimeMs?: number | null
  ): { unchanged: boolean; stat: Stats | null };
  markSeen(filePath: string): void;
  markSeenWith(
    filePath: string,
    stat: Stats | null,
    extraMtimeMs?: number | null
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
  return entry;
}

export function createCatchupCache(
  options: { persistPath?: string } = {}
): CatchupCache {
  const persistPath =
    typeof options.persistPath === "string" && options.persistPath.length > 0
      ? options.persistPath
      : null;

  const seen = new Map<string, SeenEntry>();
  let dirty = false;

  if (persistPath) {
    try {
      const parsed = JSON.parse(readFileSync(persistPath, "utf8")) as {
        version?: number;
        entries?: Record<string, unknown>;
      };
      // Discard caches written by a different PERSIST_VERSION: entries from an
      // older parser pipeline would skip files the new pipeline must reparse.
      const entries =
        parsed?.version === PERSIST_VERSION ? parsed.entries : undefined;
      if (entries && typeof entries === "object") {
        for (const [key, value] of Object.entries(entries)) {
          const entry = parseSeenEntry(value);
          if (entry) {
            seen.set(key, entry);
          }
        }
      }
    } catch {
      /* missing or corrupt cache file — start empty, non-fatal */
    }
  }

  function isUnchanged(
    filePath: string,
    extraMtimeMs?: number | null
  ): {
    unchanged: boolean;
    stat: Stats | null;
  } {
    let stat: Stats;
    try {
      stat = statSync(filePath);
    } catch {
      return { unchanged: false, stat: null };
    }
    const cached = seen.get(filePath);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      // FEA-1459 Fix 11: Also check extra mtime (e.g., max subagent mtime).
      // If the extra mtime is newer than what we saw last, it's changed.
      if (extraMtimeMs != null) {
        const cachedExtra = cached.extraMtimeMs ?? 0;
        if (extraMtimeMs > cachedExtra) {
          return { unchanged: false, stat };
        }
      }
      return { unchanged: true, stat };
    }
    return { unchanged: false, stat };
  }

  function markSeenWith(
    filePath: string,
    stat: Stats | null,
    extraMtimeMs?: number | null
  ): void {
    if (stat) {
      const entry: SeenEntry = { mtimeMs: stat.mtimeMs, size: stat.size };
      if (extraMtimeMs != null) {
        entry.extraMtimeMs = extraMtimeMs;
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
    if (!(persistPath && dirty)) {
      return;
    }
    dirty = false;
    try {
      mkdirSync(path.dirname(persistPath), { recursive: true });
      const entries: Record<string, SeenEntry> = {};
      for (const [key, value] of seen) {
        entries[key] = value;
      }
      writeFileSync(
        persistPath,
        JSON.stringify({ version: PERSIST_VERSION, entries })
      );
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
    persisted: persistPath != null,
  };
}
