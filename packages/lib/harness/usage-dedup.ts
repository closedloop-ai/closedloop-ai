/**
 * @file usage-dedup.ts
 * @description Shared dedup accumulator for Claude token usage (FEA-1459).
 *
 * Claude Code writes one JSONL line per content block, all sharing the same
 * `message.id` and `requestId` with identical usage snapshots. Naive per-line
 * sums inflate 2.8-68x. This module provides the single canonical dedup key
 * formula and accumulator, consumed by both the Claude parser (boot import) and
 * `database/transcript.ts` (desktop live-hook path).
 *
 * Design: callers own I/O and line-shape handling, then feed normalized fields
 * into `recordUsageLine`; the module accumulates and `foldDedupMap` produces
 * the final tokensByModel + tokenSeries arrays. Claude transcript-entry UUIDs
 * remain source evidence for the existing groups; an exact UUID replay is the
 * only case that does not retain the prior last-occurrence behavior.
 */

import {
  TOKEN_SOURCE_IDENTITY_MAX_IDENTIFIERS,
  type TokenSourceIdentity,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
  tokenSourceIdentitySchema,
} from "@repo/api/src/types/token-cost-provenance";
import { z } from "zod";
import { addStorageTokenCounts } from "./token-counts";
import type {
  CacheWriteTtl,
  NormalizedTokenCounts,
  NormalizedTokenRecord,
} from "./types";

/**
 * A single dedup entry keyed by `${messageId ?? lineUuid ?? timestamp}|${requestId ?? ""}`.
 * Last-occurrence-wins for usage values from distinct source entries (corpus
 * shows identical values today; last-wins is future-proof if progressive
 * snapshots ever appear). Exact UUID replay is idempotent. Keeps `firstTs` for
 * turn-start attribution.
 */
export type UsageDedupEntry = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * FEA-3419: validated cache-write TTL subdivision of `cacheWrite` — never
   * additive to it, so it never feeds the canonical token totals. `undefined`
   * means the provider never reported a breakdown for this turn (or the
   * reported breakdown failed validation and was rejected whole).
   */
  cacheWriteTtl?: CacheWriteTtl;
  firstTs: string;
  /**
   * FEA-3597: round-trip provenance for this dedup key (see
   * `NormalizedTokenRecord.subagentId`). Absent means the PARENT session.
   *
   * Resolution is **parent-beats-subagent**, NOT first- or last-wins: a
   * round-trip visible in the parent's own transcript is a parent round-trip,
   * so any parent-attributed occurrence CLEARS a previously-recorded subagent
   * id. That makes attribution independent of the order lines are read, which
   * matters because the parent and its in-line sidechain records share ONE
   * dedup map.
   */
  subagentId?: string;
  /** Ordered Claude JSONL entry UUIDs collapsed into this usage record. */
  sourceRecordIds: string[];
  /** Recent over-cap UUIDs retained for bounded retry replay suppression. */
  overflowReplaySourceRecordIds: Set<string>;
  /** Permanent degradation when any contributing entry lacks valid identity. */
  sourceIdentityUnavailableReason?: TokenSourceIdentityUnavailableReason;
};

/**
 * The raw, not-yet-validated cache-write TTL breakdown as extracted from a
 * transcript line. Readers pass raw values through untouched; validation
 * happens exactly once, inside `recordUsageLine` (the shared chokepoint for
 * BOTH the historical parser and the desktop live-hook path).
 */
export type RawCacheWriteTtl = {
  fiveM: unknown;
  oneH: unknown;
};

/**
 * FEA-3419: extract the RAW cache-write TTL breakdown from a `cache_creation`
 * value, or undefined when no breakdown object is present ("absent"
 * provenance). Shared by the Claude parser and the desktop transcript reader —
 * raw values only; validation happens once, inside `recordUsageLine` via
 * `validateCacheWriteTtl`.
 */
export function readRawCacheWriteTtl(
  cacheCreation: unknown
): RawCacheWriteTtl | undefined {
  if (
    typeof cacheCreation !== "object" ||
    cacheCreation === null ||
    Array.isArray(cacheCreation)
  ) {
    return undefined;
  }
  const record = cacheCreation as Record<string, unknown>;
  return {
    fiveM: record.ephemeral_5m_input_tokens,
    oneH: record.ephemeral_1h_input_tokens,
  };
}

/**
 * FEA-3419: accumulate a validated `CacheWriteTtl` source into an existing
 * target's optional `cacheWriteTtl`. Initializes to `{0,0}` on first
 * contribution. Mutates `target` in place.
 */
export function accumulateCacheWriteTtl(
  target: { cacheWriteTtl?: CacheWriteTtl },
  source: CacheWriteTtl
): void {
  const agg = target.cacheWriteTtl ?? { fiveM: 0, oneH: 0 };
  agg.fiveM += source.fiveM;
  agg.oneH += source.oneH;
  target.cacheWriteTtl = agg;
}

/** Parameters for a single usage line to be recorded into the dedup map. */
export type UsageLineParams = {
  messageId: string | null;
  /** Raw UUID field so absent and present-but-malformed values stay distinct. */
  lineUuid: unknown;
  requestId: string | null;
  timestamp: string;
  /**
   * ISS-6738: the stamp BEFORE normalization, kept for identity only — the same
   * reason `lineUuid` above is `unknown`.
   *
   * When a line carries neither `messageId` nor `lineUuid`, the timestamp IS the
   * dedup identity. `toIso` answers `null` for text no `Date` can read, which the
   * caller stores as `""`, so two lines with DIFFERENT unreadable stamps would
   * collapse onto the same key and last-occurrence-wins would drop the earlier
   * line's tokens outright. The normalizer that preceded it echoed the raw text
   * back, which kept them apart by accident (whitlockk, ISS-6738 review).
   *
   * Identity only: it never reaches `firstTs`, so an unreadable stamp still does
   * not become a stored timestamp.
   */
  rawTimestamp?: unknown;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * FEA-3419: raw `cache_creation` breakdown when the line carried one;
   * omit entirely when the provider reported no breakdown ("absent").
   */
  cacheWriteTtlRaw?: RawCacheWriteTtl;
  /**
   * FEA-3597: the subagent this line belongs to, or omitted for a parent line.
   * See the precedence note on `UsageDedupEntry.subagentId`.
   */
  subagentId?: string;
};

/**
 * FEA-3419: validate a raw cache-write TTL breakdown against the entry's
 * canonical `cacheWrite` total. ONE rule for every malformed case: a member
 * that is negative, non-integer, or non-numeric, OR a sum exceeding
 * `cacheWrite`, rejects the ENTIRE split to absent (`undefined`). Members are
 * never coerced to 0 individually — `{0,0}` is reserved for genuinely-reported
 * zero splits, and a fabricated partial split would corrupt provenance. Never
 * throws.
 */
export function validateCacheWriteTtl(
  raw: RawCacheWriteTtl | undefined,
  cacheWrite: number
): CacheWriteTtl | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const { fiveM, oneH } = raw;
  if (
    typeof fiveM !== "number" ||
    !Number.isInteger(fiveM) ||
    fiveM < 0 ||
    typeof oneH !== "number" ||
    !Number.isInteger(oneH) ||
    oneH < 0 ||
    fiveM + oneH > cacheWrite
  ) {
    return undefined;
  }
  return { fiveM, oneH };
}

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
 * Record one usage line into the dedup map. Distinct source entries retain
 * last-occurrence-wins usage values and the first-seen timestamp; exact UUID
 * replay is idempotent.
 */
export function recordUsageLine(
  map: Map<string, UsageDedupEntry>,
  params: UsageLineParams
): void {
  const dedupLineUuid =
    typeof params.lineUuid === "string" && params.lineUuid.length > 0
      ? params.lineUuid
      : null;
  const dedupKey = buildUsageDedupKey(
    params.messageId,
    dedupLineUuid,
    params.requestId,
    dedupIdentityTimestamp(params)
  );

  const cacheWriteTtl = validateCacheWriteTtl(
    params.cacheWriteTtlRaw,
    params.cacheWrite
  );

  const existing = map.get(dedupKey);
  if (existing) {
    const sourceIdentity = recordSourceIdentity(existing, params.lineUuid);
    if (sourceIdentity === "replay") {
      recordSubagentAttribution(existing, params.subagentId);
      return;
    }
    // Last-occurrence-wins for usage values; keep firstTs.
    existing.input = params.input;
    existing.output = params.output;
    existing.cacheRead = params.cacheRead;
    existing.cacheWrite = params.cacheWrite;
    existing.cacheWriteTtl = cacheWriteTtl;
    // FEA-3597: provenance is parent-beats-subagent, so a parent occurrence
    // must actively CLEAR a subagent id recorded earlier — merely declining to
    // write here would leave a subagent-first record marked forever, which is
    // the order-dependent first-wins behaviour this rule replaces. A subagent
    // occurrence never overwrites an already-parent (absent) attribution.
    recordSubagentAttribution(existing, params.subagentId);
  } else {
    const sourceIdentityState = initialSourceIdentityState(params.lineUuid);
    map.set(dedupKey, {
      model: params.model,
      input: params.input,
      output: params.output,
      cacheRead: params.cacheRead,
      cacheWrite: params.cacheWrite,
      cacheWriteTtl,
      firstTs: params.timestamp,
      ...sourceIdentityState,
      ...(params.subagentId === undefined
        ? {}
        : { subagentId: params.subagentId }),
    });
  }
}

/** Project one shared accumulator entry into its canonical token record. */
export function buildUsageTokenRecord(
  entry: UsageDedupEntry
): NormalizedTokenRecord | null {
  if (!entry.firstTs) {
    return null;
  }
  return {
    timestamp: entry.firstTs,
    model: entry.model,
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead,
    cacheWrite: entry.cacheWrite,
    ...(entry.cacheWriteTtl
      ? { cacheWriteTtl: { ...entry.cacheWriteTtl } }
      : {}),
    sourceIdentity: buildSourceIdentity(entry),
    ...(entry.subagentId === undefined ? {} : { subagentId: entry.subagentId }),
  };
}

/**
 * Fold a dedup map into tokensByModel totals and tokenSeries arrays.
 */
export function foldDedupMap(map: Map<string, UsageDedupEntry>): {
  tokensByModel: Record<string, NormalizedTokenCounts>;
  tokenSeries: NormalizedTokenRecord[];
} {
  // ISS-8235: accumulate into a null-prototype object so a model literally
  // named `__proto__` cannot reach `Object.prototype` at all — see
  // `ensureModelCounts` for what the plain literal did instead.
  const tokensByModel: Record<string, NormalizedTokenCounts> =
    Object.create(null);
  const tokenSeries: NormalizedTokenRecord[] = [];
  for (const entry of map.values()) {
    const counts = ensureModelCounts(tokensByModel, entry.model);
    counts.input = addStorageTokenCounts(
      counts.input,
      entry.input,
      "input_tokens"
    );
    counts.output = addStorageTokenCounts(
      counts.output,
      entry.output,
      "output_tokens"
    );
    counts.cacheRead = addStorageTokenCounts(
      counts.cacheRead,
      entry.cacheRead,
      "cache_read_input_tokens"
    );
    counts.cacheWrite = addStorageTokenCounts(
      counts.cacheWrite,
      entry.cacheWrite,
      "cache_creation_input_tokens"
    );
    if (entry.cacheWriteTtl) {
      accumulateCacheWriteTtl(counts, entry.cacheWriteTtl);
    }

    const record = buildUsageTokenRecord(entry);
    if (record) {
      tokenSeries.push(record);
    }
  }
  // Spread restores a normal prototype for downstream consumers (object spread
  // defines rather than assigns, so an own `__proto__` key survives the copy).
  return { tokensByModel: { ...tokensByModel }, tokenSeries };
}

/**
 * ISS-5426 (codex + whitlockk review, PR #4715): the entries of `map` whose usage
 * has NOT already been folded into a target, marking each returned entry's key
 * as folded on the way out.
 *
 * FEA-1459 established `${messageId ?? lineUuid ?? timestamp}|${requestId}` as
 * the identity of one API round-trip, and the dedup map enforces it WITHIN one
 * transcript. It cannot enforce it ACROSS transcripts, and the desktop shell
 * folds two of them into one session: the parent `.jsonl` (whose own map already
 * carries a delegated turn written down as an inline `isSidechain` entry) and
 * that same sub-agent's `subagents/agent-*.jsonl` sidecar. Merging the sidecar's
 * fold on top then billed that turn twice.
 *
 * `foldedKeys` is the caller-owned, deliberately MUTABLE record of what the
 * target has booked — seeded from the parent's own fold and extended by every
 * sidecar, exactly like the `countedDiffToolUseIds` set that guards the LINE
 * fold. That symmetry is the point: the two folds must agree on what one turn
 * is, or a session counts its LOC once and its cost twice.
 */
export function takeUnfoldedUsage(
  map: Map<string, UsageDedupEntry>,
  foldedKeys: Set<string>
): Map<string, UsageDedupEntry> {
  const unfolded = new Map<string, UsageDedupEntry>();
  for (const [key, entry] of map) {
    if (foldedKeys.has(key)) {
      continue;
    }
    foldedKeys.add(key);
    unfolded.set(key, entry);
  }
  return unfolded;
}

function recordSourceIdentity(
  entry: UsageDedupEntry,
  lineUuid: unknown
): "recorded" | "replay" {
  const parsedUuid = claudeTranscriptEntryUuidSchema.safeParse(lineUuid);
  if (!parsedUuid.success) {
    entry.sourceIdentityUnavailableReason =
      lineUuid === undefined
        ? (entry.sourceIdentityUnavailableReason ??
          TokenSourceIdentityUnavailableReason.MissingSourceRecordId)
        : TokenSourceIdentityUnavailableReason.Malformed;
    return "recorded";
  }
  if (
    entry.sourceRecordIds.includes(parsedUuid.data) ||
    entry.overflowReplaySourceRecordIds.has(parsedUuid.data)
  ) {
    return "replay";
  }
  // Every accumulated id already cleared `claudeTranscriptEntryUuidSchema`
  // above and the scheme is a fixed constant, so the identifier cap is the only
  // clause a full re-parse of the grown array could newly fail. Check it
  // directly instead of re-validating up to 64 strings per usage-bearing line.
  if (entry.sourceRecordIds.length < TOKEN_SOURCE_IDENTITY_MAX_IDENTIFIERS) {
    entry.sourceRecordIds.push(parsedUuid.data);
  } else {
    entry.sourceIdentityUnavailableReason =
      TokenSourceIdentityUnavailableReason.Malformed;
    rememberOverflowReplayIdentity(
      entry.overflowReplaySourceRecordIds,
      parsedUuid.data
    );
  }
  return "recorded";
}

function initialSourceIdentityState(
  lineUuid: unknown
): Pick<
  UsageDedupEntry,
  | "sourceRecordIds"
  | "overflowReplaySourceRecordIds"
  | "sourceIdentityUnavailableReason"
> {
  const parsedUuid = claudeTranscriptEntryUuidSchema.safeParse(lineUuid);
  if (parsedUuid.success) {
    return {
      sourceRecordIds: [parsedUuid.data],
      overflowReplaySourceRecordIds: new Set(),
    };
  }
  return {
    sourceRecordIds: [],
    overflowReplaySourceRecordIds: new Set(),
    sourceIdentityUnavailableReason:
      lineUuid === undefined
        ? TokenSourceIdentityUnavailableReason.MissingSourceRecordId
        : TokenSourceIdentityUnavailableReason.Malformed,
  };
}

/** Retain only the recent retry window once source evidence exceeds its cap. */
function rememberOverflowReplayIdentity(
  identities: Set<string>,
  sourceRecordId: string
): void {
  identities.add(sourceRecordId);
  if (identities.size <= MAX_OVERFLOW_REPLAY_SOURCE_IDENTITIES) {
    return;
  }
  const oldest = identities.values().next().value;
  if (oldest !== undefined) {
    identities.delete(oldest);
  }
}

function buildSourceIdentity(entry: UsageDedupEntry): TokenSourceIdentity {
  if (entry.sourceIdentityUnavailableReason !== undefined) {
    return {
      availability: TokenSourceIdentityAvailability.Unavailable,
      reason: entry.sourceIdentityUnavailableReason,
    };
  }
  return tokenSourceIdentitySchema.parse({
    availability: TokenSourceIdentityAvailability.Available,
    scheme: claudeTranscriptEntryUuidScheme,
    sourceRecordIds: [...entry.sourceRecordIds],
  });
}

function recordSubagentAttribution(
  entry: UsageDedupEntry,
  subagentId: string | undefined
): void {
  if (subagentId === undefined) {
    entry.subagentId = undefined;
  } else if (entry.subagentId !== undefined) {
    entry.subagentId = subagentId;
  }
}

/** Stable scheme name for Claude transcript-entry UUID provenance. */
export const claudeTranscriptEntryUuidScheme =
  "claude.transcript.entry.uuid" as const;

const claudeTranscriptEntryUuidSchema = z.uuid();
const MAX_OVERFLOW_REPLAY_SOURCE_IDENTITIES = 64;

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
    // ISS-8235: `target.tokensByModel` is caller-owned and normally
    // prototyped, so a `__proto__` model — which `foldDedupMap` now emits as a
    // real own key rather than dropping — must be DEFINED, not assigned.
    const targetCounts = ensureModelCounts(target.tokensByModel, model);
    targetCounts.input = addStorageTokenCounts(
      targetCounts.input,
      counts.input,
      "input_tokens"
    );
    targetCounts.output = addStorageTokenCounts(
      targetCounts.output,
      counts.output,
      "output_tokens"
    );
    targetCounts.cacheRead = addStorageTokenCounts(
      targetCounts.cacheRead,
      counts.cacheRead,
      "cache_read_input_tokens"
    );
    targetCounts.cacheWrite = addStorageTokenCounts(
      targetCounts.cacheWrite,
      counts.cacheWrite,
      "cache_creation_input_tokens"
    );
    if (counts.cacheWriteTtl) {
      accumulateCacheWriteTtl(targetCounts, counts.cacheWriteTtl);
    }
  }
  target.tokenSeries.push(...source.tokenSeries);
}

/**
 * The timestamp component of the dedup key: the normalized stamp when there is
 * one, else a stable rendering of the RAW stamp.
 *
 * Only reached when a line carries neither `messageId` nor `lineUuid`; see
 * {@link UsageLineParams.rawTimestamp} for why the fallback exists. A raw value
 * that is neither a non-empty string nor a finite number carries no identity, so
 * it yields `""` — the same collapse as before, but now only for stamps that
 * genuinely say nothing rather than for every unreadable one.
 */
function dedupIdentityTimestamp(params: UsageLineParams): string {
  if (params.timestamp.length > 0) {
    return params.timestamp;
  }
  const raw = params.rawTimestamp;
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  return "";
}

/**
 * The own `tokensByModel` bucket for `model`, zero-initialized on first write.
 *
 * ISS-8235: a model is a raw transcript string — `parse-claude-assistant.ts`
 * reads `message.model` verbatim — so `__proto__` (and `constructor`,
 * `toString`, `valueOf`) reaches here. Both halves below are load-bearing, and
 * a plain `=== undefined` check over a plain literal failed both: it read
 * `Object.prototype` back as an already-initialized record, skipped the
 * initializer, and then assigned the running total onto `Object.prototype`
 * itself — after which every plain object in the process inherits an `input`,
 * and `readStorageTokenCountAlias` returns that fabricated count for unrelated
 * sessions that never contained the poisoned name.
 *
 * `Object.hasOwn` is the only presence check that cannot mistake an inherited
 * member for an initialized record, and `defineProperty` DEFINES the key
 * instead of assigning it, so the bucket lands as an own data property rather
 * than invoking `Object.prototype`'s `__proto__` setter (which would discard
 * that model's whole spend). The attributes match what a plain assignment
 * creates, so a normal model name is unaffected.
 */
function ensureModelCounts(
  tokensByModel: Record<string, NormalizedTokenCounts>,
  model: string
): NormalizedTokenCounts {
  if (!Object.hasOwn(tokensByModel, model)) {
    Object.defineProperty(tokensByModel, model, {
      value: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return tokensByModel[model];
}
