/**
 * @file usage-reconciliation.ts
 * @description Reconciles our transcript-DERIVED session cost against Claude
 * Code's AUTHORITATIVE `total_cost_usd` (captured from the stream-json `result`
 * envelope — see {@link HarnessResult} in `token-usage.ts`).
 *
 * Our derived cost is a reconstruction: re-parse the JSONL, dedup repeated
 * per-content-block usage snapshots, and price with genai-prices. Claude Code
 * accumulates its number live, once per API response, so it needs no dedup and
 * already includes web-search + fast-mode pricing. When both exist we can
 * compare them: a match validates the whole derived pipeline; a drift is a
 * live correctness signal (a dedup-key regression or a pricing gap) that would
 * otherwise ship silently.
 *
 * The `result` envelope only exists for harness stdout captures, so for
 * imported/interactive sessions the status is deterministically `unavailable`.
 */
import { LoopReconciliationStatus } from "@closedloop-ai/loops-api/events";

/** Absolute-dollar floor below which a delta is always considered a match. */
const ABSOLUTE_TOLERANCE_USD = 0.01;
/** Relative tolerance (of the authoritative total) above the absolute floor. */
const RELATIVE_TOLERANCE = 0.02;

export type ReconciliationTolerance = {
  /** Absolute-dollar floor. A delta at or under this is always a match. */
  absoluteUsd: number;
  /** Fraction of the authoritative total, applied above the absolute floor. */
  relative: number;
};

/**
 * The DEFAULT profile, used for every runtime comparison of our derived total
 * against Claude Code's `result.total_cost_usd`.
 *
 * Why it is this loose: PRD-538 records a known one-sided asymmetry — Claude
 * Code's total includes auxiliary API calls that are not always serialized to
 * the transcript, so a correct derived number can sit slightly BELOW the
 * authoritative one by design. Exact equality would therefore report false
 * drift on healthy sessions, and an oracle that cries wolf gets muted. The
 * $0.01 floor keeps sub-cent rounding on trivially cheap sessions from
 * tripping; the 2% band absorbs the auxiliary-call gap on expensive ones.
 *
 * This profile is calibrated for derived-vs-HARNESS comparison only. Do not
 * reuse it to compare two numbers that share a pricing engine — see
 * `CORPUS_ORACLE_TOLERANCE` in the golden cost-oracle suite for that case.
 */
export const HARNESS_RECONCILIATION_TOLERANCE: ReconciliationTolerance = {
  absoluteUsd: ABSOLUTE_TOLERANCE_USD,
  relative: RELATIVE_TOLERANCE,
};

/**
 * Re-exported under the local name so every existing importer keeps its path.
 * The canonical definition lives in `@closedloop-ai/loops-api/events` because this value
 * set crosses the desktop→cloud wire in the completed-loop event.
 */
export const ReconciliationStatus = LoopReconciliationStatus;
export type ReconciliationStatus = LoopReconciliationStatus;

export type ReconciliationInput = {
  /** Our genai-prices-derived session total, or null when not priced. */
  derivedCostUsd: number | null;
  /** Claude Code's authoritative `result.total_cost_usd`, or null when absent. */
  authoritativeCostUsd: number | null;
};

export type ReconciliationResult = {
  status: ReconciliationStatus;
  /** `derived - authoritative`; null when either side is missing. */
  deltaUsd: number | null;
  /** `|delta| / authoritative`; null when not computable. */
  relativeDelta: number | null;
};

/**
 * Compare derived vs authoritative session cost. `unavailable` when no
 * authoritative total exists (the common case for imported transcripts);
 * `matched` when within
 * `max(tolerance.absoluteUsd, tolerance.relative × auth)`; otherwise `drifted`.
 *
 * `tolerance` defaults to {@link HARNESS_RECONCILIATION_TOLERANCE}, so every
 * existing caller — and every runtime path — keeps its current behavior
 * unchanged. The parameter exists so the golden-corpus test oracle (PRD-538 R3)
 * can compare two same-engine numbers under a far tighter band without
 * loosening, or being loosened by, the runtime profile.
 */
export function reconcileSessionCost(
  input: ReconciliationInput,
  tolerance: ReconciliationTolerance = HARNESS_RECONCILIATION_TOLERANCE
): ReconciliationResult {
  const { derivedCostUsd, authoritativeCostUsd } = input;

  if (authoritativeCostUsd === null || !Number.isFinite(authoritativeCostUsd)) {
    return {
      status: ReconciliationStatus.Unavailable,
      deltaUsd: null,
      relativeDelta: null,
    };
  }

  // Authoritative exists but we failed to derive a price → a real gap.
  if (derivedCostUsd === null || !Number.isFinite(derivedCostUsd)) {
    return {
      status: ReconciliationStatus.Drifted,
      deltaUsd: null,
      relativeDelta: null,
    };
  }

  const deltaUsd = derivedCostUsd - authoritativeCostUsd;
  const absDelta = Math.abs(deltaUsd);
  const relativeDelta =
    authoritativeCostUsd > 0 ? absDelta / authoritativeCostUsd : null;
  const toleranceUsd = Math.max(
    tolerance.absoluteUsd,
    tolerance.relative * authoritativeCostUsd
  );

  return {
    status:
      absDelta <= toleranceUsd
        ? ReconciliationStatus.Matched
        : ReconciliationStatus.Drifted,
    deltaUsd,
    relativeDelta,
  };
}
