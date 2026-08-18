import { asRecord } from "../parser-utils";
import { InvalidTokenCountError, readStorageTokenCount } from "../token-counts";
import type { NormalizedTokenCounts } from "../types";
import {
  readRawCacheWriteTtl,
  recordUsageLine,
  type UsageDedupEntry,
} from "../usage-dedup";
import { deriveSidechainSubagentId } from "./parse-claude-subagents";

/** Mirror the vendor's lenient timestamp handling: epoch number → ISO, string as-is. */
export function isoTs(ts: unknown): string | null {
  if (ts == null) {
    return null;
  }
  if (typeof ts === "number") {
    // `toISOString` THROWS for a number no Date can represent — Infinity (which
    // `JSON.parse` yields for an overflowing literal), NaN, and any epoch past
    // ±8.64e15. One such record used to abort the whole scan, which desktop then
    // retried on every pass and the cloud renderer showed as a blank transcript.
    // An unreadable stamp is an unknown one, and null is already how this
    // function says that.
    const date = new Date(ts);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof ts === "string") {
    // An empty string is not a timestamp. Returning it verbatim made every
    // `?? fallback` keep it while every `|| fallback` replaced it, so the same
    // absent value behaved differently depending on which operator a caller
    // happened to use — and a record stamped `""` sorted before all real ones.
    return ts.length > 0 ? ts : null;
  }
  return null;
}

/** Parse a JSON string, returning `undefined` on failure. */
export function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function tokenCount(value: unknown, fieldName: string): number {
  return readStorageTokenCount(value, fieldName);
}

/**
 * Read a Claude `message.usage` record into canonical fresh-shape token counts,
 * or DROP it (return `null`) when any counter fails the JS-safe storage
 * contract.
 *
 * Graceful degradation (cloud-transcript render): a single assistant `usage`
 * snapshot whose counters are fractional / negative / JS-unsafe trips
 * `readStorageTokenCount`'s `InvalidTokenCountError`. Aborting the whole
 * transcript would blank every message, tool, and timeline entry over one bad
 * usage snapshot — the same failure mode the parser already tolerates for a
 * malformed JSONL line (it drops that turn's usage and continues). So drop THIS
 * event's usage and keep parsing; the message text/model are still emitted, and
 * the missing counts are a small token-total gap, not a lost conversation. This
 * mirrors the CODEX parser's `token_count` degradation (parse-codex.ts).
 */
function readClaudeUsageCounts(
  usage: Record<string, unknown>
): NormalizedTokenCounts | null {
  try {
    return {
      input: tokenCount(usage.input_tokens, "input_tokens"),
      output: tokenCount(usage.output_tokens, "output_tokens"),
      cacheRead: tokenCount(
        usage.cache_read_input_tokens,
        "cache_read_input_tokens"
      ),
      cacheWrite: tokenCount(
        usage.cache_creation_input_tokens,
        "cache_creation_input_tokens"
      ),
    };
  } catch (error) {
    if (error instanceof InvalidTokenCountError) {
      return null;
    }
    throw error;
  }
}

/**
 * FEA-1459: Extract deduped token usage from a stream of parsed JSONL entries.
 * Uses the shared usage-dedup module for the canonical dedup key formula and
 * accumulation logic. Returns the dedup map; caller folds via `foldDedupMap`.
 *
 * FEA-3597 `subagentIdOverride`: when the entries come from a SIDECAR file
 * (`subagents/agent-*.jsonl`), every record in it belongs to that sidecar, so
 * the caller passes its relId and it applies to the whole file. That is
 * file-authoritative and beats the per-entry derivation — which matters twice:
 * a sidecar's own records are `isSidechain`, and a NESTED workflow agent's
 * relId (`workflows__<wf>__agent-<uuid>`) differs from the bare `agent-<uuid>`
 * the per-entry rule would produce, so without the override its records would
 * not match its own `NormalizedSubagent.id`.
 *
 * Omit it for the MAIN transcript, where provenance is derived per entry: the
 * parent's own turns and its in-line sidechain turns share this one dedup map.
 */
export function extractDedupedUsage(
  entries: Array<{ entry: Record<string, unknown>; iso: string | null }>,
  subagentIdOverride?: string
): Map<string, UsageDedupEntry> {
  const dedupMap = new Map<string, UsageDedupEntry>();
  for (const { entry, iso } of entries) {
    const msg = asRecord(entry.message);
    const msgModel = typeof msg.model === "string" ? msg.model : null;
    if (!msgModel || msgModel === "<synthetic>" || !msg.usage) {
      continue;
    }
    const usage = asRecord(msg.usage);
    const messageId =
      typeof msg.id === "string" && msg.id.length > 0 ? msg.id : null;
    const requestId =
      typeof entry.requestId === "string" && entry.requestId.length > 0
        ? entry.requestId
        : null;
    // Canonical fresh shape (see NormalizedTokenCounts): Anthropic reports
    // `input_tokens` as FRESH/uncached with cache_read/cache_creation as
    // separate additive fields, so we store them verbatim — no subtraction.
    // Graceful degradation: a bad usage snapshot drops THIS line's usage and
    // keeps parsing the rest of the transcript (see `readClaudeUsageCounts`).
    const counts = readClaudeUsageCounts(usage);
    if (!counts) {
      continue;
    }
    // TTL breakdown rides the same dedup to prevent per-line inflation.
    const cacheWriteTtlRaw = readRawCacheWriteTtl(usage.cache_creation);
    // FEA-3597: file-authoritative override wins; otherwise derive per entry.
    const subagentId = subagentIdOverride ?? deriveSidechainSubagentId(entry);
    recordUsageLine(dedupMap, {
      messageId,
      lineUuid: entry.uuid,
      requestId,
      timestamp: iso ?? "",
      model: msgModel,
      input: counts.input,
      output: counts.output,
      cacheRead: counts.cacheRead,
      cacheWrite: counts.cacheWrite,
      ...(cacheWriteTtlRaw ? { cacheWriteTtlRaw } : {}),
      ...(subagentId === undefined ? {} : { subagentId }),
    });
  }
  return dedupMap;
}
