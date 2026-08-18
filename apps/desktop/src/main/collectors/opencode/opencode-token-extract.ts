/**
 * @file opencode-token-extract.ts
 * @description Token-count extraction for the OpenCode parser. Reads the
 * per-message / per-step / session-column token shapes OpenCode emits and
 * normalizes them to `NormalizedTokenCounts`. Split out of `opencode-parser.ts`
 * (ISS-4380) so the grandfathered parser shrinks rather than accumulating this
 * cohesive concern.
 *
 * OpenCode reports `input` as FRESH/uncached with `cache_read`/`cache_write` as
 * separate additive fields, so they are read verbatim — no subtraction.
 */
import {
  addStorageTokenCounts,
  readStorageTokenCountAlias,
} from "../../cost/token-counts.js";
import type { NormalizedTokenCounts } from "../types.js";

const INPUT_ALIASES = [
  "input",
  "inputTokens",
  "input_tokens",
  "prompt_tokens",
  "tokens_input",
] as const;

const OUTPUT_ALIASES = [
  "output",
  "outputTokens",
  "output_tokens",
  "completion_tokens",
  "tokens_output",
] as const;

// FEA-3728: these aliases are reasoning counted SEPARATELY from output, so
// folding them in is correct. `reasoning_output_tokens` is deliberately EXCLUDED
// — it is the OpenAI/Codex field FEA-3126/FEA-3527 proved is a SUBSET of
// `output_tokens` (already inside the output figure), so an OpenAI-backed
// OpenCode payload that reports it would double-count reasoning into output.
const REASONING_ALIASES = [
  "reasoning",
  "reasoningTokens",
  "reasoning_tokens",
  "tokens_reasoning",
] as const;

// The SQLite `session` token columns and other flat shapes use these aliases.
const CACHE_READ_ALIASES = [
  "cacheRead",
  "cache_read",
  "cacheReadTokens",
  "cache_read_tokens",
  "cached_input_tokens",
  "tokens_cache_read",
] as const;

const CACHE_WRITE_ALIASES = [
  "cacheWrite",
  "cache_write",
  "cacheWriteTokens",
  "cache_write_tokens",
  "cache_creation_input_tokens",
  "tokens_cache_creation",
  "tokens_cache_write",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True when at least one of `keys` is present (non-null) on `record`. */
function hasAnyKey(
  record: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return keys.some((key) => record[key] != null);
}

/**
 * Read one cache leg (`read`/`write`), preferring the flat aliases and falling
 * back to the nested `cache: { read, write }` object OpenCode emits per message
 * / step (ISS-4380).
 *
 * The flat aliases win when ANY of them is PRESENT — including an explicit `0`,
 * which `readStorageTokenCountAlias` deliberately preserves. Falling back on a
 * truthy check would let a version-skewed payload carrying both a flat
 * `cache_read: 0` and a nested `cache.read: N` silently record the nested value
 * despite the stated flat-first precedence, so the fallback keys off PRESENCE,
 * not the parsed count. When no flat alias is present, the nested object (when
 * present) supplies the value; otherwise the count is `0`. Old/flat-only shapes
 * therefore round-trip exactly as before.
 */
function readCacheLeg(
  raw: Record<string, unknown>,
  nestedCache: Record<string, unknown> | null,
  context: string,
  flatAliases: readonly string[],
  nestedKey: "read" | "write"
): number {
  if (hasAnyKey(raw, flatAliases)) {
    return readStorageTokenCountAlias(
      raw,
      `${context}.${nestedKey}`,
      flatAliases
    );
  }
  return nestedCache
    ? readStorageTokenCountAlias(nestedCache, `${context}.cache.${nestedKey}`, [
        nestedKey,
      ])
    : 0;
}

/**
 * Normalize an OpenCode token payload (message `data.tokens`, step-finish part
 * `tokens`, or a session token-column row) to `NormalizedTokenCounts`, or `null`
 * when no counter is present.
 */
export function extractOpenCodeTokenCounts(
  raw: Record<string, unknown>,
  context: string
): NormalizedTokenCounts | null {
  const input = readStorageTokenCountAlias(
    raw,
    `${context}.input`,
    INPUT_ALIASES
  );
  const output = addStorageTokenCounts(
    readStorageTokenCountAlias(raw, `${context}.output`, OUTPUT_ALIASES),
    readStorageTokenCountAlias(raw, `${context}.reasoning`, REASONING_ALIASES),
    `${context}.output_with_reasoning`
  );
  // ISS-4380: real OpenCode message/step token payloads nest cache counts under
  // a `cache: { read, write }` object; the SQLite session columns use the flat
  // aliases. `readCacheLeg` prefers flat-by-presence, then the nested object.
  const nestedCache = isObject(raw.cache) ? raw.cache : null;
  const cacheRead = readCacheLeg(
    raw,
    nestedCache,
    context,
    CACHE_READ_ALIASES,
    "read"
  );
  const cacheWrite = readCacheLeg(
    raw,
    nestedCache,
    context,
    CACHE_WRITE_ALIASES,
    "write"
  );
  if (input || output || cacheRead || cacheWrite) {
    return { input, output, cacheRead, cacheWrite };
  }
  return null;
}
