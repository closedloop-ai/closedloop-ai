/**
 * @file activity-breakdown-residual.ts
 * @description ISS-5128: reconcile the Activity breakdown's Derived mode against
 * the session's own cost by carrying whatever spend the phase tiling did not
 * attribute in an explicit `unattributed` row.
 *
 * THE DEFECT. `resolveActivitySegments` returns `Derived` whenever the priced
 * `activitySegments` carry ANY positive cost, and the panel then reports
 * `sum(segments)` as the session total. But those segments and the session's own
 * cost come from DIFFERENT sources, so they can disagree: the segments are
 * `buildActivitySegments(tiling, tokenEvents)` over the token events the detail
 * read supplies, while `estimatedCost` is a separately-sourced rollup (on desktop
 * `attachEstimatedCosts` re-queries `cost_usd_estimated` outright). When the
 * detail read supplies fewer events than that rollup was computed over, the sum
 * under-reports and the panel presents it as the total anyway: $4.46 against a
 * Properties/API cost of $508.75, a 114x gap with nothing on screen explaining it
 * (production VQA, session `019f8bc3` — codex, 1511 turns, transcript `syncing`).
 *
 * NOT a phase-attribution gap. The aggregator never DROPS a token event — one
 * falling outside every span lands in `other` and is still counted — so an event
 * the panel was handed always reaches the total. The shortfall is upstream of it,
 * in which events the detail read hands over at all (ISS-5075's capped
 * session-detail events read is a candidate on a session this size, not something
 * this change proves). Which is why the fix reconciles against the session's own
 * cost rather than trying to re-attribute anything.
 *
 * The honest fallback already existed but could not engage here. It lives on the
 * OTHER side of the mode split: `Empty` (no tiling at all) synthesizes one
 * `unattributed` row priced from the session totals, and `CostUnavailable`
 * (tiling present, all costs 0) heads the panel with `session.estimatedCost`.
 * Both reconcile. Only `Derived` — *some* attribution — asserted a total it had
 * not verified, so two sessions disagreed about what "Activity breakdown $X"
 * means depending on how much of them happened to be attributed.
 *
 * WHY A ROW AND NOT A HEADER SWAP. Heading the panel with `session.estimatedCost`
 * while the column still sums to less would reconcile the number and break the
 * decomposition — the reader would see a total that is provably not the sum of
 * the rows beneath it, which is the ISS-4446 complaint in the other direction.
 * Adding the residual as a row keeps "the header is the sum of the column" true
 * AND makes the missing spend visible and named.
 */

import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels";
import type {
  ActivitySegment,
  AgentSessionDetail,
} from "@repo/api/src/types/agent-session";
import { toDisplayCents } from "@repo/app/shared/lib/reconciled-cost-cents";
import { UNATTRIBUTED_KEY } from "@repo/lib/branches/activity-rollup";

/**
 * The smallest residual worth a row, in whole DISPLAY cents. The Cost column
 * renders whole cents, so a residual that renders as $0.00 would add a row the
 * reader cannot see the value of, and sub-cent drift between the per-phase sum
 * and the session rollup is already redistributed by
 * `reconcileDisplayedCostCents` (ISS-5000). Only a residual the column can
 * actually show earns a row.
 */
const MIN_RESIDUAL_CENTS = 1;

/** {@link ActivityBreakdownResidual.residualIndex} when no row carries one. */
export const NO_RESIDUAL_INDEX = -1;

/**
 * The segments to render, plus WHICH row carries unattributed spend.
 *
 * The index is part of the contract rather than "it is the last one" (wongk,
 * #4395): the residual is FOLDED into an existing `unattributed` segment when
 * the producer already sent one, so it is not always appended. The renderer
 * needs the index anyway, because the residual row is the one row whose zero
 * Time / zero Tokens means UNKNOWN rather than measured.
 */
export type ActivityBreakdownResidual = {
  segments: ActivitySegment[];
  /** Index into `segments`, or {@link NO_RESIDUAL_INDEX} when none was added. */
  residualIndex: number;
};

/**
 * Carry the spend the phase segments did not attribute in an explicit
 * `unattributed` row, so the breakdown total always reconciles with the cost
 * shown elsewhere on the same screen.
 *
 * Returns `segments` UNCHANGED, and {@link NO_RESIDUAL_INDEX}, when there is
 * nothing honest to add:
 *  - the residual is under a display cent (nothing the column could show);
 *  - the session carries no cost of its own to reconcile against
 *    (`estimatedCost` null/0, an unpriced session, where the attributed sum is
 *    all anyone knows);
 *  - the attributed sum is not a finite number, so the difference would be
 *    meaningless. The upstream token-event aggregation preserves whatever it was
 *    handed, so this is reachable data rather than a type-forbidden input, and
 *    the same rule applies as in `reconcileDisplayedCostCents`: degrade instead
 *    of emitting a plausible-but-wrong figure;
 *  - the residual is NEGATIVE, i.e. the segments attribute MORE than the session
 *    rollup. That is a real inconsistency, but it is over-attribution rather
 *    than dropped spend, and a negative row would be a fabricated value rather
 *    than a disclosure. Left alone deliberately for its own investigation.
 *
 * The threshold is measured in DISPLAY cents on BOTH totals independently
 * (wongk, #4395), never on the raw difference. `4.465 - 4.46` lands at
 * `0.004999999999999893` in binary, which rounds to 0 cents and suppressed the
 * row, while the 2dp formatter renders the same two numbers as $4.47 and $4.46.
 * The panel would then have hidden a discrepancy the reader can see with their
 * own eyes on the Properties strip. Quantizing each total the way the formatter
 * does, then subtracting, asks the question the reader is actually asking.
 *
 * Callers pass only `Derived`-mode, UNTRUNCATED segments: `Empty` already
 * synthesizes this exact row from the session totals and `CostUnavailable` heads
 * the panel with the session cost, so both already reconcile and a second
 * residual would double-count; and on a truncated session the shortfall is the
 * cost of phases that were attributed fine and merely cut off, which is not
 * unattributed spend at all.
 */
export function withUnattributedResidual(
  segments: readonly ActivitySegment[],
  session: AgentSessionDetail
): ActivityBreakdownResidual {
  const unchanged: ActivityBreakdownResidual = {
    residualIndex: NO_RESIDUAL_INDEX,
    segments: [...segments],
  };
  const sessionCostUsd = session.estimatedCost ?? 0;
  if (!(sessionCostUsd > 0)) {
    return unchanged;
  }
  const attributedCostUsd = sumBy(segments, (segment) => segment.costUsd);
  if (!Number.isFinite(attributedCostUsd)) {
    return unchanged;
  }
  const residualCents =
    toDisplayCents(sessionCostUsd) - toDisplayCents(attributedCostUsd);
  if (residualCents < MIN_RESIDUAL_CENTS) {
    return unchanged;
  }
  const residualCostUsd = sessionCostUsd - attributedCostUsd;
  // The producer can already send a segment under this key: `phase` is a bounded
  // FREE STRING on the wire, not the closed taxonomy, so a classifier that tiled
  // an `unattributed` span puts one in `activitySegments` (wongk, #4395).
  // Appending a second would render two rows meaning the same thing under one
  // React key, so the residual folds into the row that already exists.
  const existingIndex = segments.findIndex(
    (segment) => segment.key === UNATTRIBUTED_KEY
  );
  if (existingIndex >= 0) {
    const folded = [...segments];
    folded[existingIndex] = foldResidualInto(
      folded[existingIndex],
      segments,
      session,
      residualCostUsd
    );
    return { residualIndex: existingIndex, segments: folded };
  }
  return {
    residualIndex: segments.length,
    segments: [
      ...segments,
      buildResidualSegment(segments, session, residualCostUsd),
    ],
  };
}

/**
 * The residual row. Tokens are the session's own totals minus what the segments
 * already account for, floored at 0: a negative token residual means the same
 * over-attribution the cost guard above declines to act on, and rendering a
 * negative token count would assert something impossible.
 *
 * `durationMs` is 0 on purpose. This spend has no attributable TIME, which is
 * precisely what makes it unattributed, and synthesizing a span would invent
 * wall-clock the classifier never saw. Derived mode divides its shares by cost
 * (the panel only falls back to a time basis when cost is unavailable), so a
 * zero-duration row still carries an honest, non-zero share of the column.
 *
 * That 0 is a placeholder for UNKNOWN, not a measurement, and the renderer is
 * told so via {@link ActivityBreakdownResidual.residualIndex} rather than by
 * this module inventing a value. `ActivitySegment.durationMs` is a wire-contract
 * `number`, so "unknown" cannot live in the field itself; the row identity is
 * what carries it, and `BreakdownRow` renders a dash instead of "0s".
 */
function buildResidualSegment(
  segments: readonly ActivitySegment[],
  session: AgentSessionDetail,
  residualCostUsd: number
): ActivitySegment {
  return {
    // Same key/label pair the Empty-mode fallback uses, read from the canonical
    // map rather than re-spelled. ISS-4790 is the ticket for this bucket having
    // been spelled three different ways.
    key: UNATTRIBUTED_KEY,
    label: ACTIVITY_PHASE_LABEL.unattributed,
    inputTokens: residualTokens(segments, session, "inputTokens"),
    outputTokens: residualTokens(segments, session, "outputTokens"),
    cacheReadTokens: residualTokens(segments, session, "cacheReadTokens"),
    cacheWriteTokens: residualTokens(segments, session, "cacheWriteTokens"),
    costUsd: residualCostUsd,
    durationMs: 0,
    confidence: null,
    source: null,
    isUnclassified: true,
  };
}

/**
 * Fold the residual into an `unattributed` segment the producer already sent.
 *
 * Everything else on that row is kept: its duration and confidence were measured
 * from real tiled spans, and discarding them to re-synthesize the row would lose
 * attribution the classifier did do. Only the amounts grow, and they grow to the
 * session's own totals exactly as the appended row would have, because
 * `residualTokens` subtracts the attributed sum this segment is already part of.
 */
function foldResidualInto(
  existing: ActivitySegment,
  segments: readonly ActivitySegment[],
  session: AgentSessionDetail,
  residualCostUsd: number
): ActivitySegment {
  return {
    ...existing,
    cacheReadTokens:
      existing.cacheReadTokens +
      residualTokens(segments, session, "cacheReadTokens"),
    cacheWriteTokens:
      existing.cacheWriteTokens +
      residualTokens(segments, session, "cacheWriteTokens"),
    costUsd: existing.costUsd + residualCostUsd,
    inputTokens:
      existing.inputTokens + residualTokens(segments, session, "inputTokens"),
    isUnclassified: true,
    outputTokens:
      existing.outputTokens + residualTokens(segments, session, "outputTokens"),
  };
}

/** Session total minus attributed, floored at 0, for one token dimension. */
function residualTokens(
  segments: readonly ActivitySegment[],
  session: AgentSessionDetail,
  field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
): number {
  const sessionTotal = session[field] ?? 0;
  const attributed = sumBy(segments, (segment) => segment[field]);
  return Math.max(0, sessionTotal - attributed);
}

function sumBy<T>(items: readonly T[], read: (item: T) => number): number {
  let total = 0;
  for (const item of items) {
    total += read(item);
  }
  return total;
}
