/**
 * @file frustration-score.ts
 * @description FEA-3928 — the pure, versioned session-frustration scoring
 * primitive. `computeFrustrationRaw` folds a session's per-turn language
 * heuristic (frustration words + shouting + pleading punctuation), its
 * nearby-error spikes, and its already-derived trace signals (steering
 * episodes, corrections, phase loopbacks, throttles) into a single UNBOUNDED
 * additive integer.
 *
 * The value is deliberately NOT clamped to 100: it is the raw signal that gets
 * persisted (SessionDetail.frustration_raw). Normalization to a 0–100 score
 * happens downstream at Insights aggregation time, against the org population's
 * observed max raw value — which drifts as more sessions land, so freezing a
 * pre-normalized score on the row would go stale (Mike's operator decision on
 * PLN-1481). `FRUSTRATION_SCORE_VERSION` stamps the scorer that produced the
 * value so a later scorer bump can re-derive stale rows.
 *
 * The version stamp (`FRUSTRATION_SCORE_VERSION`) and the persisted int4 bound
 * (`FRUSTRATION_RAW_MAX`) are the shared desktop/cloud CONTRACT and live in
 * `@repo/api` (`frustration-score-contract.ts`) so the cloud side does not
 * duplicate the literal or import across an app boundary; callers that stamp the
 * version import it from that contract module directly (this module consumes
 * `FRUSTRATION_RAW_MAX` to keep the raw signal int4-safe).
 *
 * This module lives in `src/shared/` (a neutral owner both the main process and
 * the renderer depend on) rather than `src/main/database/`, so the renderer's
 * coaching lookback (`frustrationScore` / `countNearbyErrors`, reused verbatim
 * to keep `computePeakFrustration` behavior unchanged) can import it without
 * reaching into the main-process database tree. It is pure and DB-free — it
 * depends only on the shared `ERROR_EVENT_PATTERN` classifier — so both the
 * renderer and the future sync/collector pass can import it, and it is
 * unit-testable without the store or the harness.
 */

import { ERROR_EVENT_PATTERN } from "@repo/api/src/agent-session-events";
import { FRUSTRATION_RAW_MAX } from "@repo/api/src/frustration-score-contract";

// Events this many positions on either side of a user turn count toward its
// nearby-error spike (events are chronologically ordered). Kept identical to
// the renderer's peak-frustration window so the two derivations agree.
const FRUSTRATION_ERROR_WINDOW = 3;

const FRUSTRATION_WORD_PATTERN =
  /\b(?:stop|again|no+|wrong|broken|revert|undo|please|ugh|argh|seriously|already|still|frustrat\w*)\b/gi;
const ALL_CAPS_RUN_PATTERN = /\b[A-Z]{4,}\b/g;
const REPEATED_PUNCTUATION_PATTERN = /[!?]{2,}/g;

/** A single chronologically-ordered event the frustration heuristic scans. */
type FrustrationEvent = {
  eventType: string;
};

/**
 * A user turn plus its position in the event stream. `text` is the turn's
 * human-visible content; `index` is its position in `events` so nearby errors
 * can be counted around it.
 */
type FrustrationUserTurn = {
  index: number;
  text: string;
};

/**
 * The already-derived, non-negative trace signal COUNTS folded into the raw
 * score. Each is a scalar count, treated as 0 when absent so a session with no
 * trace enrichment still scores on its language signal. A future collector
 * caller derives these from the session trace presentation
 * (`packages/lib/session-trace/derivation.ts`): `steeringEpisodes` is already a
 * scalar count there, while `correctionSources`, `phaseLoopbacks`, and
 * `throttles` are arrays — so the caller passes their `.length` (the type here
 * demands a number, so an array cannot be passed by mistake).
 */
type FrustrationTraceSignals = {
  steeringEpisodes?: number | null;
  correctionCount?: number | null;
  phaseLoopbacks?: number | null;
  throttles?: number | null;
};

type ComputeFrustrationRawInput = {
  /** Chronologically-ordered session events (for nearby-error windows). */
  events: readonly FrustrationEvent[];
  /** The human/user turns in the session, each with its event index. */
  userTurns: readonly FrustrationUserTurn[];
  /** Optional already-derived trace signals; absent counts as 0. */
  trace?: FrustrationTraceSignals;
};

/**
 * Heuristic frustration intensity for a single user turn: distinct frustration
 * words, shouting runs, and pleading punctuation. Distinct-word counting avoids
 * one repeated token dominating the score. Extracted from the renderer coaching
 * lookback (FEA-3399) so both callers score turns identically. Each summand is a
 * non-negative integer count, so the result is a non-negative integer.
 */
export function frustrationScore(text: string): number {
  const words = new Set(
    (text.toLowerCase().match(FRUSTRATION_WORD_PATTERN) ?? []).map((word) =>
      word.trim()
    )
  );
  const shouts = text.match(ALL_CAPS_RUN_PATTERN)?.length ?? 0;
  const pleas = text.match(REPEATED_PUNCTUATION_PATTERN)?.length ?? 0;
  return words.size + shouts + pleas;
}

/**
 * Count error/fail events within FRUSTRATION_ERROR_WINDOW of the user turn at
 * `centerIndex` (excluding the turn itself). Extracted from the renderer
 * coaching lookback (FEA-3399); the classifier is the shared
 * `ERROR_EVENT_PATTERN` SSOT so web and desktop agree on what an error is.
 */
export function countNearbyErrors(
  events: readonly FrustrationEvent[],
  centerIndex: number
): number {
  const start = Math.max(0, centerIndex - FRUSTRATION_ERROR_WINDOW);
  const end = Math.min(
    events.length - 1,
    centerIndex + FRUSTRATION_ERROR_WINDOW
  );
  let count = 0;
  for (let index = start; index <= end; index += 1) {
    if (index === centerIndex) {
      continue;
    }
    if (ERROR_EVENT_PATTERN.test(events[index].eventType)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Fold a session's language heuristic, nearby-error spikes, and derived trace
 * signals into a single UNBOUNDED-at-100, non-negative raw frustration signal.
 *
 * The result is the additive sum of: every user turn's `frustrationScore` plus
 * the error events near it, and the trace signal counts. It is monotonic in
 * each input (more of any signal never lowers the score) and is NOT clamped to
 * 100 — the population-relative 0–100 normalization is a downstream Insights
 * concern. It IS kept int4-safe: `nonNegativeInt` floors every contribution to a
 * non-negative integer ≤ int4 max, and the running sum saturates at
 * `FRUSTRATION_RAW_MAX` so a pathological transcript can never overflow the
 * `SessionDetail.frustration_raw` Postgres `Int` column and reject the whole
 * sync batch.
 */
export function computeFrustrationRaw(
  input: ComputeFrustrationRawInput
): number {
  let signal = 0;
  for (const turn of input.userTurns) {
    signal = addSaturating(signal, nonNegativeInt(frustrationScore(turn.text)));
    signal = addSaturating(
      signal,
      nonNegativeInt(countNearbyErrors(input.events, turn.index))
    );
  }
  const trace = input.trace;
  if (trace) {
    signal = addSaturating(signal, nonNegativeInt(trace.steeringEpisodes));
    signal = addSaturating(signal, nonNegativeInt(trace.correctionCount));
    signal = addSaturating(signal, nonNegativeInt(trace.phaseLoopbacks));
    signal = addSaturating(signal, nonNegativeInt(trace.throttles));
  }
  return signal;
}

/**
 * Coerce an optional/nullable count to a non-negative int4-safe integer
 * contribution: non-finite → 0, negatives floored to 0, fractions floored to the
 * integer below, and anything above int4 max capped at `FRUSTRATION_RAW_MAX` so
 * one contribution alone cannot overflow the persisted column.
 */
function nonNegativeInt(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), FRUSTRATION_RAW_MAX);
}

/** Add two non-negative int4-safe values, saturating at `FRUSTRATION_RAW_MAX`. */
function addSaturating(current: number, contribution: number): number {
  return Math.min(current + contribution, FRUSTRATION_RAW_MAX);
}

// FEA-4022: classify a session event's `eventType` as a human/user turn. Kept
// identical to the renderer coaching lookback's `USER_EVENT_PATTERN` (FEA-3399)
// so the sync-time raw score and the renderer's peak-frustration surface agree
// on what a user turn is.
const USER_EVENT_PATTERN = /user|prompt|steer/i;

/**
 * A raw session-event row as it exists at sync-source assembly: the chronological
 * `eventType`, plus the human-visible turn text carried on `summary` (falling back
 * to a string `data` payload). Deliberately loose so both the desktop sync path
 * and unit tests can build it without importing the store row type.
 */
type FrustrationSourceEvent = {
  eventType: string;
  summary?: string | null;
  data?: unknown;
};

/**
 * FEA-4022: derive the {@link computeFrustrationRaw} input from a session's
 * chronologically-ordered event rows plus its already-derived trace-signal
 * counts. Extracts user turns (events whose type matches `USER_EVENT_PATTERN`,
 * carrying non-empty text) with their event index so nearby errors can be
 * counted around each. Pure + DB-free so the desktop assembly and its tests share
 * one derivation. The trace arrays are passed as `.length` counts (the scorer
 * only sums counts), matching `computeFrustrationRaw`'s `trace` contract.
 */
export function deriveFrustrationInput(
  events: readonly FrustrationSourceEvent[],
  trace?: FrustrationTraceSignals
): ComputeFrustrationRawInput {
  const userTurns: FrustrationUserTurn[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!USER_EVENT_PATTERN.test(event.eventType)) {
      continue;
    }
    const text = frustrationTurnText(event);
    if (text.length === 0) {
      continue;
    }
    userTurns.push({ index, text });
  }
  return { events, userTurns, trace };
}

/** Human-visible turn text: `summary`, else a string `data` payload, trimmed. */
function frustrationTurnText(event: FrustrationSourceEvent): string {
  if (typeof event.summary === "string" && event.summary.trim().length > 0) {
    return event.summary.trim();
  }
  if (typeof event.data === "string") {
    return event.data.trim();
  }
  return "";
}

export type {
  ComputeFrustrationRawInput,
  FrustrationEvent,
  FrustrationSourceEvent,
  FrustrationTraceSignals,
  FrustrationUserTurn,
};
