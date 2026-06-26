/**
 * @file usage-dedup.ts
 * @description Shared dedup accumulator for Claude token usage (FEA-1459).
 *
 * Claude Code writes one JSONL line per content block, all sharing the same
 * `message.id` and `requestId` with identical usage snapshots. Naive per-line
 * sums inflate 2.8-68x. This module provides the single canonical dedup key
 * formula and accumulator, consumed by both `claude-parser.ts` (boot import)
 * and `database/transcript.ts` (live-hook path).
 *
 * Design: callers own I/O and line-shape handling, then feed normalized fields
 * into `recordUsageLine`; the module accumulates and `foldDedupMap` produces
 * the final tokensByModel + tokenSeries arrays.
 */

import { addStorageTokenCounts } from "../token-counts.js";
import type { NormalizedTokenCounts, NormalizedTokenRecord } from "./types.js";

/**
 * A single dedup entry keyed by `${messageId ?? lineUuid ?? timestamp}|${requestId ?? ""}`.
 * Last-occurrence-wins for usage values (corpus shows identical values today;
 * last-wins is future-proof if progressive snapshots ever appear). Keeps
 * `firstTs` for turn-start attribution.
 */
export type UsageDedupEntry = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  firstTs: string;
};

/** Parameters for a single usage line to be recorded into the dedup map. */
export type UsageLineParams = {
  messageId: string | null;
  lineUuid: string | null;
  requestId: string | null;
  timestamp: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Build the canonical dedup key for a Claude usage line.
 * Exported for testing; callers normally use `recordUsageLine`.
 */
export function buildUsageDedupKey(
  messageId: string | null,
  lineUuid: string | null,
  requestId: string | null,
  timestamp: string
): string {
  return `${messageId ?? lineUuid ?? timestamp}|${requestId ?? ""}`;
}

/**
 * Record one usage line into the dedup map. Last-occurrence-wins for usage
 * values; first-seen timestamp is preserved.
 */
export function recordUsageLine(
  map: Map<string, UsageDedupEntry>,
  params: UsageLineParams
): void {
  const dedupKey = buildUsageDedupKey(
    params.messageId,
    params.lineUuid,
    params.requestId,
    params.timestamp
  );

  const existing = map.get(dedupKey);
  if (existing) {
    // Last-occurrence-wins for usage values; keep firstTs.
    existing.input = params.input;
    existing.output = params.output;
    existing.cacheRead = params.cacheRead;
    existing.cacheWrite = params.cacheWrite;
  } else {
    map.set(dedupKey, {
      model: params.model,
      input: params.input,
      output: params.output,
      cacheRead: params.cacheRead,
      cacheWrite: params.cacheWrite,
      firstTs: params.timestamp,
    });
  }
}

/**
 * Fold a dedup map into tokensByModel totals and tokenSeries arrays.
 */
export function foldDedupMap(map: Map<string, UsageDedupEntry>): {
  tokensByModel: Record<string, NormalizedTokenCounts>;
  tokenSeries: NormalizedTokenRecord[];
} {
  const tokensByModel: Record<string, NormalizedTokenCounts> = {};
  const tokenSeries: NormalizedTokenRecord[] = [];
  for (const entry of map.values()) {
    if (tokensByModel[entry.model] === undefined) {
      tokensByModel[entry.model] = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    }
    tokensByModel[entry.model].input = addStorageTokenCounts(
      tokensByModel[entry.model].input,
      entry.input,
      "input_tokens"
    );
    tokensByModel[entry.model].output = addStorageTokenCounts(
      tokensByModel[entry.model].output,
      entry.output,
      "output_tokens"
    );
    tokensByModel[entry.model].cacheRead = addStorageTokenCounts(
      tokensByModel[entry.model].cacheRead,
      entry.cacheRead,
      "cache_read_input_tokens"
    );
    tokensByModel[entry.model].cacheWrite = addStorageTokenCounts(
      tokensByModel[entry.model].cacheWrite,
      entry.cacheWrite,
      "cache_creation_input_tokens"
    );

    if (entry.firstTs) {
      tokenSeries.push({
        timestamp: entry.firstTs,
        model: entry.model,
        input: entry.input,
        output: entry.output,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
      });
    }
  }
  return { tokensByModel, tokenSeries };
}

/**
 * Merge folded usage from a source (e.g. subagent) into a target's
 * tokensByModel and tokenSeries. Mutates target in place.
 */
export function mergeFoldedUsage(
  target: {
    tokensByModel: Record<string, NormalizedTokenCounts>;
    tokenSeries: NormalizedTokenRecord[];
  },
  source: {
    tokensByModel: Record<string, NormalizedTokenCounts>;
    tokenSeries: NormalizedTokenRecord[];
  }
): void {
  for (const [model, counts] of Object.entries(source.tokensByModel)) {
    if (target.tokensByModel[model] === undefined) {
      target.tokensByModel[model] = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    }
    target.tokensByModel[model].input = addStorageTokenCounts(
      target.tokensByModel[model].input,
      counts.input,
      "input_tokens"
    );
    target.tokensByModel[model].output = addStorageTokenCounts(
      target.tokensByModel[model].output,
      counts.output,
      "output_tokens"
    );
    target.tokensByModel[model].cacheRead = addStorageTokenCounts(
      target.tokensByModel[model].cacheRead,
      counts.cacheRead,
      "cache_read_input_tokens"
    );
    target.tokensByModel[model].cacheWrite = addStorageTokenCounts(
      target.tokensByModel[model].cacheWrite,
      counts.cacheWrite,
      "cache_creation_input_tokens"
    );
  }
  target.tokenSeries.push(...source.tokenSeries);
}
