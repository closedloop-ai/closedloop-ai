import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import {
  recordUsageLine,
  type UsageDedupEntry,
} from "../collectors/engine/usage-dedup.js";
import {
  addStorageTokenCounts,
  readStorageTokenCount,
} from "../token-counts.js";

const TRANSCRIPT_CACHE_MAX = 200;
const LARGE_FILE_SIZE_BYTES = 200 * 1024 * 1024;

type CacheEntry = {
  mtimeMs: number;
  fileSize: number;
  dedupMap: Map<string, UsageDedupEntry>;
  latestModel: string | null;
  compactionCount: number;
};

/**
 * Per-model token totals extracted from a single Claude hook transcript file
 * (the hook path is Claude-only — Codex hooks were removed, PRD-431).
 * Values are the CUMULATIVE sum across every usage-bearing line in the
 * file as it exists right now. Hook transcripts are append-only (compaction
 * appends a summary line rather than rewriting the file), so the latest
 * derivation is authoritative and the token-usage store plain-overwrites
 * (FEA-1459 / PR #1511 review).
 *
 * This parses the absolute `transcript_path` supplied on a hook payload. It is
 * intentionally separate from `src/main/token-usage.ts` `parseTokenUsage`,
 * which resolves a symphony-loop run output directory (`claude-output*.jsonl`)
 * rather than an arbitrary hook transcript path.
 *
 * FEA-1459: Token usage is now deduped by (message.id, requestId) to prevent
 * 2.8-68x inflation from Claude Code's one-line-per-content-block format.
 * Also returns per-key records for the live-hook path to insert token_events.
 */
export type TranscriptTokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** FEA-1459: Per-dedup-key record for token_events insertion (Fix 5). */
export type TranscriptTokenRecord = {
  timestamp: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type TranscriptExtract = {
  /** model id -> summed token counts across the transcript. */
  tokensByModel: Map<string, TranscriptTokenCounts>;
  /** Most recent non-synthetic model id seen, for session model sync. */
  latestModel: string | null;
  /** Count of compaction-summary lines seen (drives compaction analytics later). */
  compactionCount: number;
  /** FEA-1459: Per-dedup-key records for token_events insertion. */
  records: TranscriptTokenRecord[];
};

type UsageRecord = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
};

function asUsage(value: unknown): UsageRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as UsageRecord;
}

/**
 * Normalize entry.timestamp to an ISO string. Handles string pass-through,
 * epoch-number conversion, and missing values.
 */
function normalizeTimestamp(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "number") {
    return new Date(raw).toISOString();
  }
  return "";
}

/**
 * Read and parse a transcript JSONL file, accumulating per-model token usage.
 * Returns `null` when the file is missing/unreadable so callers can no-op.
 * Malformed lines are skipped. A model id of `<synthetic>` (Claude's
 * placeholder for non-API turns) is ignored.
 *
 * FEA-1459: Uses the shared usage-dedup module for the canonical dedup key
 * formula and (message.id, requestId) dedup to prevent inflation from
 * repeated usage blocks across content-block lines.
 */
export function extractTranscriptTokens(
  transcriptPath: string
): TranscriptExtract | null {
  // FEA-3132 (B1): size-admission before buffering the whole transcript.
  // `readFileSync` + `split("\n")` materializes the entire file (and its line
  // array) into the db-host heap at once — a cold-path OOM contributor for a
  // pathologically large file. Real transcripts are a few MB, so skipping token
  // extraction above LARGE_FILE_SIZE_BYTES only ever fires on a runaway file and
  // trades that one file's token stats for not OOM-ing the whole worker.
  try {
    if (statSync(transcriptPath).size > LARGE_FILE_SIZE_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  let content: string;
  try {
    content = readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  const dedupMap = new Map<string, UsageDedupEntry>();
  let latestModel: string | null = null;
  let compactionCount = 0;

  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.isCompactSummary === true) {
      compactionCount += 1;
    }

    // The usage block lives on `message` for assistant turns; some shapes carry
    // it on the entry directly. Mirror the vendor extractor's `message || entry`.
    const message =
      (entry.message as Record<string, unknown> | undefined) ?? entry;
    const model =
      typeof message.model === "string" && message.model.length > 0
        ? message.model
        : undefined;
    const usage = asUsage(message.usage);
    if (!model || model === "<synthetic>" || !usage) {
      continue;
    }

    latestModel = model;

    const messageId =
      typeof message.id === "string" && message.id.length > 0
        ? message.id
        : null;
    const requestId =
      typeof entry.requestId === "string" && entry.requestId.length > 0
        ? entry.requestId
        : null;
    const lineUuid =
      typeof entry.uuid === "string" && entry.uuid.length > 0
        ? entry.uuid
        : null;
    const ts = normalizeTimestamp(entry.timestamp);

    recordUsageLine(dedupMap, {
      messageId,
      lineUuid,
      requestId,
      timestamp: ts,
      model,
      input: readUsageCount(usage.input_tokens, "input_tokens"),
      output: readUsageCount(usage.output_tokens, "output_tokens"),
      cacheRead: readUsageCount(
        usage.cache_read_input_tokens,
        "cache_read_input_tokens"
      ),
      cacheWrite: readUsageCount(
        usage.cache_creation_input_tokens,
        "cache_creation_input_tokens"
      ),
    });
  }

  // Fold dedup map into tokensByModel totals and per-key records.
  const tokensByModel = new Map<string, TranscriptTokenCounts>();
  const records: TranscriptTokenRecord[] = [];
  for (const entry of dedupMap.values()) {
    const existing = tokensByModel.get(entry.model);
    if (existing) {
      existing.input = addStorageTokenCounts(
        existing.input,
        entry.input,
        "input_tokens"
      );
      existing.output = addStorageTokenCounts(
        existing.output,
        entry.output,
        "output_tokens"
      );
      existing.cacheRead = addStorageTokenCounts(
        existing.cacheRead,
        entry.cacheRead,
        "cache_read_input_tokens"
      );
      existing.cacheWrite = addStorageTokenCounts(
        existing.cacheWrite,
        entry.cacheWrite,
        "cache_creation_input_tokens"
      );
    } else {
      tokensByModel.set(entry.model, {
        input: entry.input,
        output: entry.output,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
      });
    }
    if (entry.firstTs) {
      records.push({
        timestamp: entry.firstTs,
        model: entry.model,
        input: entry.input,
        output: entry.output,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
      });
    }
  }

  return { tokensByModel, latestModel, compactionCount, records };
}

function buildExtractFromDedupMap(
  dedupMap: Map<string, UsageDedupEntry>,
  latestModel: string | null,
  compactionCount: number
): TranscriptExtract {
  const tokensByModel = new Map<string, TranscriptTokenCounts>();
  const records: TranscriptTokenRecord[] = [];
  for (const entry of dedupMap.values()) {
    const existing = tokensByModel.get(entry.model);
    if (existing) {
      existing.input = addStorageTokenCounts(
        existing.input,
        entry.input,
        "input_tokens"
      );
      existing.output = addStorageTokenCounts(
        existing.output,
        entry.output,
        "output_tokens"
      );
      existing.cacheRead = addStorageTokenCounts(
        existing.cacheRead,
        entry.cacheRead,
        "cache_read_input_tokens"
      );
      existing.cacheWrite = addStorageTokenCounts(
        existing.cacheWrite,
        entry.cacheWrite,
        "cache_creation_input_tokens"
      );
    } else {
      tokensByModel.set(entry.model, {
        input: entry.input,
        output: entry.output,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
      });
    }
    if (entry.firstTs) {
      records.push({
        timestamp: entry.firstTs,
        model: entry.model,
        input: entry.input,
        output: entry.output,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
      });
    }
  }
  return { tokensByModel, latestModel, compactionCount, records };
}

/**
 * Read a byte range from a file synchronously.
 * Uses low-level `readSync` to avoid materialising the entire file as a string.
 */
function readFileRangeSync(path: string, start: number, end: number): string {
  const fd = openSync(path, "r");
  try {
    const length = end - start;
    if (length <= 0) {
      return "";
    }
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return "";
    }
    return buffer.toString("utf-8", 0, lastNewline + 1);
  } finally {
    closeSync(fd);
  }
}

/**
 * Promote a Map entry to the most-recently-used position (delete + re-set).
 */
function promoteLruEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  if (map.size >= TRANSCRIPT_CACHE_MAX) {
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
  map.set(key, value);
}

/**
 * Process raw JSONL content into an existing dedup map.
 * Returns the updated latestModel and compactionCount.
 */
function processLinesIntoMap(
  content: string,
  dedupMap: Map<string, UsageDedupEntry>,
  initialModel: string | null,
  initialCompactionCount: number
): { latestModel: string | null; compactionCount: number } {
  let modelOut = initialModel;
  let compactionOut = initialCompactionCount;
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.isCompactSummary === true) {
      compactionOut += 1;
    }

    const message =
      (entry.message as Record<string, unknown> | undefined) ?? entry;
    const model =
      typeof message.model === "string" && message.model.length > 0
        ? message.model
        : undefined;
    const usage = asUsage(message.usage);
    if (!model || model === "<synthetic>" || !usage) {
      continue;
    }

    modelOut = model;

    const messageId =
      typeof message.id === "string" && message.id.length > 0
        ? message.id
        : null;
    const requestId =
      typeof entry.requestId === "string" && entry.requestId.length > 0
        ? entry.requestId
        : null;
    const lineUuid =
      typeof entry.uuid === "string" && entry.uuid.length > 0
        ? entry.uuid
        : null;
    const ts = normalizeTimestamp(entry.timestamp);

    recordUsageLine(dedupMap, {
      messageId,
      lineUuid,
      requestId,
      timestamp: ts,
      model,
      input: readUsageCount(usage.input_tokens, "input_tokens"),
      output: readUsageCount(usage.output_tokens, "output_tokens"),
      cacheRead: readUsageCount(
        usage.cache_read_input_tokens,
        "cache_read_input_tokens"
      ),
      cacheWrite: readUsageCount(
        usage.cache_creation_input_tokens,
        "cache_creation_input_tokens"
      ),
    });
  }

  return { latestModel: modelOut, compactionCount: compactionOut };
}

/**
 * Create a cached version of the transcript token extractor.
 *
 * Maintains an LRU cache (default 200 entries) keyed by file path. Each
 * entry stores the parsed dedup map together with the file's mtime and size
 * at last read. On the next call:
 *   - stat unchanged → reconstruct result from cached dedup map (no I/O)
 *   - file grew (same mtime, larger size) → incremental read of new bytes
 *   - mtime or size changed without growth → full re-read (compaction rewrite)
 *   - cache miss → full re-read
 *
 * The returned function has the same signature as `extractTranscriptTokens`
 * so it can be injected directly into `deps.extractTranscript`.
 */
export function createTranscriptCache(): (
  path: string
) => TranscriptExtract | null {
  const cache = new Map<string, CacheEntry>();

  return (path: string) => {
    let st: ReturnType<typeof getFileStat>;
    try {
      st = statSync(path);
    } catch {
      return null;
    }

    const cached = cache.get(path);

    // FEA-3132 (B1): size-admission caps EVERY path, not just the cold full
    // read. A 200MB+ file buffers/accumulates more than the db-host heap can
    // safely materialize. Enforcing this before the branch dispatch below also
    // covers the warm incremental-growth branch — a cached file that grows past
    // the cap is evicted and skipped, instead of reading the appended range and
    // letting the dedup map grow unbounded. (An oversized file is never admitted
    // into the cache, so the exact-hit rebuild below never legitimately fires
    // for one.) Skips instead of only warning and reading anyway (prior behavior).
    if (st.size > LARGE_FILE_SIZE_BYTES) {
      if (cached) {
        cache.delete(path);
      }
      return null;
    }

    if (
      cached &&
      cached.mtimeMs === st.mtimeMs &&
      cached.fileSize === st.size
    ) {
      promoteLruEntry(cache, path, cached);
      return buildExtractFromDedupMap(
        cached.dedupMap,
        cached.latestModel,
        cached.compactionCount
      );
    }

    if (cached && cached.mtimeMs === st.mtimeMs && st.size > cached.fileSize) {
      const newBytes = readFileRangeSync(path, cached.fileSize, st.size);
      if (newBytes.length > 0) {
        const result = processLinesIntoMap(
          newBytes,
          cached.dedupMap,
          cached.latestModel,
          cached.compactionCount
        );
        cached.latestModel = result.latestModel;
        cached.compactionCount = result.compactionCount;
      }
      cached.fileSize = st.size;
      promoteLruEntry(cache, path, cached);
      return buildExtractFromDedupMap(
        cached.dedupMap,
        cached.latestModel,
        cached.compactionCount
      );
    }

    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      const removed = cache.get(path);
      if (removed) {
        cache.delete(path);
      }
      return null;
    }

    const dedupMap = new Map<string, UsageDedupEntry>();
    const result = processLinesIntoMap(content, dedupMap, null, 0);

    const entry: CacheEntry = {
      mtimeMs: st.mtimeMs,
      fileSize: st.size,
      dedupMap,
      latestModel: result.latestModel,
      compactionCount: result.compactionCount,
    };

    promoteLruEntry(cache, path, entry);

    return buildExtractFromDedupMap(
      dedupMap,
      result.latestModel,
      result.compactionCount
    );
  };
}

function getFileStat(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function readUsageCount(value: unknown, fieldName: string): number {
  return readStorageTokenCount(value, `transcript.${fieldName}`);
}
