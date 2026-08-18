import { DECLARED_EVIDENCE_LAYER } from "@repo/api/src/activity-evidence-layers";
import {
  ACTIVITY_PHASE_LABEL,
  UNKNOWN_ACTIVITY_PHASE_LABEL,
} from "@repo/api/src/activity-phase-labels";
import type {
  ActivitySegment,
  SyncedActivitySegmentRow,
  SyncedAgentSessionTokenEvent,
} from "@repo/api/src/types/agent-session";
import { SessionTracePhaseSourceType } from "@repo/api/src/types/agent-session";
import { labelize } from "@repo/api/src/utils/string";

/**
 * FEA-2275 — the single shared aggregation that turns the raw activity-segment
 * tiling (`SyncedActivitySegmentRow[]`, FEA-3568) plus the session's token
 * events into the derived per-phase {@link ActivitySegment} breakdown.
 *
 * It lives in `@repo/lib` (React-free, importable from the desktop main process,
 * `apps/api`, and the renderer) and is called identically by the cloud detail
 * projection (`apps/api`) and the desktop `mapDetail` (`apps/desktop/src/main`),
 * so web and desktop render identical breakdowns by construction — PLN-1198
 * Amendment v3 item 3. It never re-classifies: the raw tiling is authoritative
 * for phase spans/provenance, and per-phase tokens/cost come only from binning
 * the already-priced token events into those spans.
 */

/** The literal phase key that carries the honest unclassified remainder. */
export const OTHER_PHASE_KEY = "other";
/** The literal phase key that carries non-working wall-time. */
export const IDLE_PHASE_KEY = "idle";
const EXPLICIT_SOURCE = SessionTracePhaseSourceType.Explicit;
const INFERRED_SOURCE = SessionTracePhaseSourceType.LoopPerf;

/**
 * A session token event reduced to exactly what the aggregation needs: a
 * timestamp, the already-priced USD cost, and the four token-count components.
 * Both projections map their own token-event shape onto this before calling
 * {@link buildActivitySegments}, so the aggregation itself stays surface-neutral
 * and the two callers cannot drift on how a phase is priced.
 */
export type ActivitySegmentTokenEvent = {
  /** Event timestamp in epoch-ms. */
  tMs: number;
  /** Already-priced per-event cost in USD (0 when unpriced). */
  costUsd: number;
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Map the canonical synced token-event wire rows onto the aggregation input.
 * The desktop detail projection feeds its `session.tokenEvents` through this so
 * the raw wire shape → aggregation-input mapping lives in one place; the cloud
 * projection maps its Prisma rows (Decimal cost / BigInt counts) to the same
 * {@link ActivitySegmentTokenEvent} shape inline. A non-parsable `createdAt`
 * yields a NaN timestamp, which {@link buildActivitySegments} skips.
 */
export function toActivitySegmentTokenEvents(
  events: readonly SyncedAgentSessionTokenEvent[]
): ActivitySegmentTokenEvent[] {
  return events.map((event) => ({
    tMs: Date.parse(event.createdAt),
    costUsd: event.estimatedCostUsd ?? 0,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
  }));
}

type PhaseAccumulator = {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  /** Earliest row start; +Infinity for a synthesized remainder with no rows. */
  minStartMs: number;
  /** Σ(confidence × duration) over confidence-bearing rows, for a weighted mean. */
  weightedConfidence: number;
  /** Σ(duration) over confidence-bearing rows (the weight denominator). */
  confidenceWeight: number;
  /** Σ(duration) of rows whose evidence was declared. */
  declaredDurationMs: number;
  /** Σ(duration) of rows whose evidence was present but not declared. */
  inferredDurationMs: number;
};

/**
 * Aggregate the raw tiling + token events into per-phase {@link ActivitySegment}
 * rows — one per distinct phase key, ordered chronologically by the phase's
 * earliest span (the synthesized `other` remainder, if any, sorts last).
 *
 * Reconciliation invariant: every token event is assigned to exactly one phase
 * (the phase whose half-open `[startMs, endMs)` span contains its timestamp, or
 * the honest `other` remainder when no span does), so the per-phase `costUsd`
 * and token-count sums equal the totals of `tokenEvents` exactly.
 *
 * Returns `[]` when there is no tiling; the renderer applies the single honest
 * catch-all "= 100%" fallback in that case (it owns the session totals needed to
 * price it).
 */
export function buildActivitySegments(
  rows: readonly SyncedActivitySegmentRow[],
  tokenEvents: readonly ActivitySegmentTokenEvent[]
): ActivitySegment[] {
  if (rows.length === 0) {
    return [];
  }

  const accumulators = new Map<string, PhaseAccumulator>();
  const accumulatorFor = (key: string): PhaseAccumulator => {
    let accumulator = accumulators.get(key);
    if (!accumulator) {
      accumulator = createAccumulator(key);
      accumulators.set(key, accumulator);
    }
    return accumulator;
  };

  // Fold each row's span + provenance into its phase. Duration and the
  // declared/inferred + confidence signals are properties of the tiling, not of
  // the token events, so they are accumulated here.
  const spans = normalizeSpans(rows);
  for (const span of spans) {
    const accumulator = accumulatorFor(span.key);
    accumulator.durationMs += span.durationMs;
    accumulator.minStartMs = Math.min(accumulator.minStartMs, span.startMs);
    if (span.durationMs > 0) {
      accumulator.weightedConfidence += span.confidence * span.durationMs;
      accumulator.confidenceWeight += span.durationMs;
    }
    if (span.declared) {
      accumulator.declaredDurationMs += span.durationMs;
    } else if (span.hasEvidence) {
      accumulator.inferredDurationMs += span.durationMs;
    }
  }

  // Bin each token event into the phase whose span contains it; events landing
  // in a gap (or beyond the tiling) accrue to the honest `other` remainder.
  for (const event of tokenEvents) {
    if (!Number.isFinite(event.tMs)) {
      continue;
    }
    const containing = findContainingSpan(spans, event.tMs);
    const key = containing ? containing.key : OTHER_PHASE_KEY;
    const accumulator = accumulatorFor(key);
    accumulator.inputTokens += finiteOrZero(event.inputTokens);
    accumulator.outputTokens += finiteOrZero(event.outputTokens);
    accumulator.cacheReadTokens += finiteOrZero(event.cacheReadTokens);
    accumulator.cacheWriteTokens += finiteOrZero(event.cacheWriteTokens);
    accumulator.costUsd += finiteOrZero(event.costUsd);
  }

  return [...accumulators.values()].sort(byChronology).map(toActivitySegment);
}

type NormalizedSpan = {
  key: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  confidence: number;
  declared: boolean;
  hasEvidence: boolean;
};

/**
 * Coerce the raw rows to sane, sorted spans: half-open `[startMs, endMs)` with a
 * non-negative duration, confidence clamped to `[0, 1]`, and the declared /
 * has-evidence flags derived from `evidenceLayers`. Sorted by start so the
 * event→span lookup can binary-search.
 */
function normalizeSpans(
  rows: readonly SyncedActivitySegmentRow[]
): NormalizedSpan[] {
  return rows
    .map((row): NormalizedSpan => {
      const startMs = finiteOrZero(row.startMs);
      const endMs = finiteOrZero(row.endMs);
      const durationMs = Math.max(0, endMs - startMs);
      const evidenceLayers = Array.isArray(row.evidenceLayers)
        ? row.evidenceLayers
        : [];
      return {
        key: row.phase,
        startMs,
        endMs,
        durationMs,
        confidence: clamp01(row.confidence),
        declared: evidenceLayers.includes(DECLARED_EVIDENCE_LAYER),
        hasEvidence: evidenceLayers.length > 0,
      };
    })
    .sort((left, right) => left.startMs - right.startMs);
}

/**
 * The span whose half-open `[startMs, endMs)` contains `tMs`, or null when the
 * timestamp falls in a gap / outside the tiling. Binary-searches the
 * start-sorted spans for the last span starting at/before `tMs`, then confirms
 * the exclusive upper bound.
 */
function findContainingSpan(
  spans: readonly NormalizedSpan[],
  tMs: number
): NormalizedSpan | null {
  let low = 0;
  let high = spans.length - 1;
  let candidateIndex = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (spans[mid]!.startMs <= tMs) {
      candidateIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // Walk back over any equal/overlapping starts to find one that truly contains
  // the timestamp (non-overlapping tilings resolve on the first check).
  for (let index = candidateIndex; index >= 0; index--) {
    const span = spans[index]!;
    if (tMs < span.endMs && span.startMs <= tMs) {
      return span;
    }
    // Once a span starts strictly after nothing can contain tMs earlier by
    // start order — but overlapping spans may still qualify, so keep scanning
    // only while starts remain ≤ tMs.
    if (span.startMs > tMs) {
      break;
    }
  }
  return null;
}

function toActivitySegment(accumulator: PhaseAccumulator): ActivitySegment {
  const confidence =
    accumulator.confidenceWeight > 0
      ? accumulator.weightedConfidence / accumulator.confidenceWeight
      : null;
  return {
    key: accumulator.key,
    label: phaseLabel(accumulator.key),
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    cacheReadTokens: accumulator.cacheReadTokens,
    cacheWriteTokens: accumulator.cacheWriteTokens,
    costUsd: accumulator.costUsd,
    durationMs: accumulator.durationMs,
    confidence,
    source: resolveSource(accumulator),
    ...(accumulator.key === OTHER_PHASE_KEY ? { isUnclassified: true } : {}),
  };
}

/**
 * Fold a phase's declared vs inferred span-duration into the single
 * inferred-vs-declared discriminator: whichever provenance covers more of the
 * phase's wall-time wins (declared breaks ties as the stronger signal); `null`
 * when the phase carries no evidence at all (e.g. `idle`, or a synthesized
 * `other` remainder).
 */
function resolveSource(
  accumulator: PhaseAccumulator
): SessionTracePhaseSourceType | null {
  if (
    accumulator.declaredDurationMs === 0 &&
    accumulator.inferredDurationMs === 0
  ) {
    return null;
  }
  return accumulator.declaredDurationMs >= accumulator.inferredDurationMs
    ? EXPLICIT_SOURCE
    : INFERRED_SOURCE;
}

/**
 * Display label for a phase key, serialized onto the wire as
 * {@link ActivitySegment.label}.
 *
 * ISS-4790: known keys resolve through the canonical
 * {@link ACTIVITY_PHASE_LABEL} map — the SAME map the renderer's two display
 * maps read — so the wire label and the UI label are one string rather than two
 * that merely happen to agree. Before this the aggregator hardcoded
 * "Other / unclassified" here while the UI said "Other", so an API consumer
 * rendering the documented `label` field named the bucket differently from the
 * product UI.
 *
 * Unknown/future keys (the classifier taxonomy can grow via a version bump) are
 * titleized through the SAME shared `labelize` the two display maps use, so a
 * compound key like `auto-review` reads "Auto Review" on the wire and on both
 * surfaces rather than three spellings of one key. A key with no word in it
 * (empty, or only separators) takes the canonical unnameable label.
 */
function phaseLabel(key: string): string {
  const canonical = getCanonicalPhaseLabel(key);
  if (canonical !== undefined) {
    return canonical;
  }
  return labelize(key) || UNKNOWN_ACTIVITY_PHASE_LABEL;
}

function createAccumulator(key: string): PhaseAccumulator {
  return {
    key,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    durationMs: 0,
    minStartMs: Number.POSITIVE_INFINITY,
    weightedConfidence: 0,
    confidenceWeight: 0,
    declaredDurationMs: 0,
    inferredDurationMs: 0,
  };
}

function byChronology(left: PhaseAccumulator, right: PhaseAccumulator): number {
  if (left.minStartMs !== right.minStartMs) {
    return left.minStartMs - right.minStartMs;
  }
  if (left.key < right.key) {
    return -1;
  }
  if (left.key > right.key) {
    return 1;
  }
  return 0;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * The canonical label map widened to a string index so an arbitrary wire phase
 * key can be looked up without a cast.
 */
const CANONICAL_PHASE_LABELS: Readonly<Record<string, string>> =
  ACTIVITY_PHASE_LABEL;

/**
 * The canonical label for `key`, or `undefined` when the key is outside the
 * known taxonomy. Guarded with `Object.hasOwn` so an inherited
 * `Object.prototype` member (`constructor`, `toString`, …) arriving as a phase
 * key from the wire cannot resolve to a non-label value.
 */
function getCanonicalPhaseLabel(key: string): string | undefined {
  if (Object.hasOwn(CANONICAL_PHASE_LABELS, key)) {
    return CANONICAL_PHASE_LABELS[key];
  }
  return;
}
