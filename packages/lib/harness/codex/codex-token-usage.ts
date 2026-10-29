/**
 * @file codex-token-usage.ts
 * @description Cumulative Codex token reading and the per-turn delta math
 * derived from it, plus the FEA-3526 authoritative `last_token_usage` snapshot
 * reconciliation and the fork-replay usage identity.
 *
 * Split out of `parse-codex.ts` for ISS-7623 (pure code motion, no behavior
 * change), mirroring `../claude/claude-usage.ts`.
 */

import {
  InvalidTokenCountError,
  readStorageTokenCountAlias,
  subtractStorageTokenCounts,
} from "../token-counts";
import { asRecord } from "../type-guards";
import type {
  NormalizedCodexTokenSnapshot,
  NormalizedTokenCountsBare,
} from "../types";
import type { Rec } from "./codex-accumulator";

export type CodexTokenTotals = {
  input: number;
  cached: number;
  /** Already includes reasoning_output_tokens (subset, not additive). */
  output: number;
  /**
   * FEA-3527: `reasoning_output_tokens` — a SUBDIVISION of `output` (never
   * additive to it or to any total). Read separately as metadata; must NEVER be
   * folded back into `output`, `input`, or a grand total (double-counting).
   */
  reasoningOutput: number;
  cacheWrite: number;
  nonCachedInput: number;
};

/**
 * Read cumulative Codex token totals with canonical aliases taking precedence.
 *
 * Codex (OpenAI) reports `input_tokens` as an INCLUSIVE total (cached is a
 * subset). To satisfy the canonical fresh shape (see NormalizedTokenCounts),
 * `nonCachedInput = input - cached` is what we store as `input`, with `cached`
 * kept separately as `cacheRead`. This is the one parser that must subtract;
 * native-fresh sources (Claude, OpenCode, Cursor, Copilot) store input verbatim.
 */
export function readCodexTokenTotals(
  totals: Rec,
  context: string
): CodexTokenTotals {
  const input = readStorageTokenCountAlias(totals, `${context}.input`, [
    "input_tokens",
    "inputTokens",
  ]);
  const cached = readStorageTokenCountAlias(totals, `${context}.cache_read`, [
    "cached_input_tokens",
    "cachedInputTokens",
  ]);
  const output = readStorageTokenCountAlias(totals, `${context}.output`, [
    "output_tokens",
    "outputTokens",
  ]);
  // FEA-3527: reasoning_output_tokens is a SUBSET of output_tokens. Read it as a
  // SEPARATE metadata value only — it is deliberately NOT added to `output`
  // above (or to any total below); folding it in would double-count reasoning
  // against the canonical output figure it is already part of.
  const reasoningOutput = readStorageTokenCountAlias(
    totals,
    `${context}.reasoning_output`,
    ["reasoning_output_tokens", "reasoningOutputTokens"]
  );
  const cacheWrite = readStorageTokenCountAlias(
    totals,
    `${context}.cache_write`,
    [
      "cache_write_tokens",
      "cacheWriteTokens",
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
    ]
  );
  return {
    input,
    cached,
    output,
    reasoningOutput,
    cacheWrite,
    nonCachedInput: subtractStorageTokenCounts(
      input,
      cached,
      `${context}.non_cached_input`
    ),
  };
}

/** Per-turn token deltas derived from successive cumulative Codex totals. */
export type CodexTokenDeltas = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * CR-2: compute a per-turn delta from cumulative Codex totals. With no prior
 * snapshot the current cumulative value IS the delta; otherwise subtract the
 * previous cumulative totals (clamped at 0 inside subtractStorageTokenCounts).
 *
 * FEA-3359: detect raw cumulative resets before per-field subtraction.
 * `nonCachedInput` is derived (input − cached), so asymmetric drops in the raw
 * counters can make it INCREASE despite a genuine counter reset — inflating the
 * session. Checking the raw counters first catches this: if any raw cumulative
 * dropped, the entire snapshot is a process restart or subagent fold and all
 * deltas are zero.
 */
export function computeTokenDeltas(
  current: CodexTokenTotals,
  previousTotals: Rec | null
): CodexTokenDeltas {
  if (!previousTotals) {
    return {
      input: current.nonCachedInput,
      output: current.output,
      cacheRead: current.cached,
      cacheWrite: current.cacheWrite,
    };
  }
  const previous = readCodexTokenTotals(previousTotals, "codex.previous");
  if (
    current.input < previous.input ||
    current.output < previous.output ||
    current.cached < previous.cached ||
    current.cacheWrite < previous.cacheWrite
  ) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  return {
    input: subtractStorageTokenCounts(
      current.nonCachedInput,
      previous.nonCachedInput,
      "codex.delta_input"
    ),
    output: subtractStorageTokenCounts(
      current.output,
      previous.output,
      "codex.delta_output"
    ),
    cacheRead: subtractStorageTokenCounts(
      current.cached,
      previous.cached,
      "codex.delta_cache_read"
    ),
    cacheWrite: subtractStorageTokenCounts(
      current.cacheWrite,
      previous.cacheWrite,
      "codex.delta_cache_write"
    ),
  };
}

/**
 * FEA-3526: Codex `token_count` events carry an authoritative per-turn
 * `last_token_usage` snapshot next to the `total_token_usage` cumulative object
 * the parser derives deltas from. This reads that snapshot with the SAME
 * hardened reader path as the cumulative totals (`readCodexTokenTotals` /
 * `InvalidTokenCountError` tolerance) and reconciles it against the delta the
 * parser derived for the same event, mirroring the "authoritative vs derived"
 * posture (PRD-538). Pure metadata: it never feeds `tokenSeries` and must not
 * alter the canonical cumulative-derived totals. Returns null when the field
 * is absent or malformed (drop-and-continue).
 */
export function readCodexLastTokenSnapshot(
  info: Rec,
  model: string,
  iso: string | null,
  delta: CodexTokenDeltas
): NormalizedCodexTokenSnapshot | null {
  const last =
    asRecord(info.last_token_usage) ?? asRecord(info.lastTokenUsage) ?? null;
  if (!last) {
    return null;
  }
  let totals: CodexTokenTotals;
  try {
    totals = readCodexTokenTotals(last, "codex.last");
  } catch (error) {
    if (error instanceof InvalidTokenCountError) {
      // Same drop-this-snapshot-keep-parsing tolerance as the cumulative reader:
      // a malformed per-turn snapshot must never abort the rollout.
      return null;
    }
    throw error;
  }
  const lastTokenUsage: NormalizedTokenCountsBare = {
    input: totals.nonCachedInput,
    output: totals.output,
    cacheRead: totals.cached,
    cacheWrite: totals.cacheWrite,
  };
  return {
    timestamp: iso,
    model,
    lastTokenUsage,
    // `CodexTokenDeltas` is structurally the bare four-counter shape, so the
    // parser-derived delta is the `derivedDelta` verbatim.
    derivedDelta: delta,
    drifted: codexSnapshotDrifted(lastTokenUsage, delta),
  };
}

/**
 * FEA-3526: True when the authoritative per-turn `last_token_usage` disagrees
 * with the parser-derived cumulative delta beyond a small tolerance, on any of
 * the four canonical counters. A conservative absolute floor absorbs the
 * off-by-one rounding of the input=inclusive→non-cached subtraction; anything
 * larger is a genuine delta-reconstruction drift signal (e.g. a dropped or
 * out-of-order cumulative snapshot). Non-breaking: the flag is metadata, it does
 * not change any token total.
 */
const CODEX_SNAPSHOT_DRIFT_TOLERANCE = 1;
function codexSnapshotDrifted(
  last: NormalizedTokenCountsBare,
  delta: CodexTokenDeltas
): boolean {
  return (
    Math.abs(last.input - delta.input) > CODEX_SNAPSHOT_DRIFT_TOLERANCE ||
    Math.abs(last.output - delta.output) > CODEX_SNAPSHOT_DRIFT_TOLERANCE ||
    Math.abs(last.cacheRead - delta.cacheRead) >
      CODEX_SNAPSHOT_DRIFT_TOLERANCE ||
    Math.abs(last.cacheWrite - delta.cacheWrite) >
      CODEX_SNAPSHOT_DRIFT_TOLERANCE
  );
}

export function codexUsageSnapshotIdentity(
  model: string | null,
  totals: CodexTokenTotals
): string {
  return [
    model ?? "",
    totals.nonCachedInput,
    totals.cached,
    totals.output,
    totals.cacheWrite,
  ].join(":");
}
