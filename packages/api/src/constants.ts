/** Regex for YYYY-MM-DD date-only strings. */
export const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Score characterization cutoffs used by judge analytics. */
export const JUDGE_THRESHOLDS = {
  stubbornness: { stubborn: 0.1, openMinded: 0.3 },
  optimism: { optimistic: 0.65, critical: 0.35 },
  certainty: { decisive: 0.6, uncertain: 0.5 },
  polarity: { polarizing: 0.65 },
  minScoreCount: 10,
} as const;

/** Canonical constants for judge radar-axis calculations and documentation text. */
export const JUDGE_RADAR_METRICS = {
  certainty: {
    extremeHighScore: 0.7,
    extremeLowScore: 0.3,
  },
  stubbornness: {
    stdDevNormalizationDivisor: 0.5,
  },
} as const;

/**
 * ISS-7229: the exclusive upper bound, in USD, on a Claude-reported session cost
 * that can be stored end to end.
 *
 * It is the CLOUD COLUMN'S width that sets it — `SessionDetail.authoritativeCostUsd`
 * is `Decimal(14,6)`, so a figure at or past 100,000,000 does not fit. Shared
 * rather than restated because the two ends that must agree about it cannot
 * import each other: the desktop OTel normalizer rejects an oversized data point
 * before it can be summed into `sessions.authoritative_cost_usd`, and the cloud's
 * session sync schema (`desktop-agent-sessions-schema.ts`) drops one arriving
 * from a desktop sync. Two copies of this number is two chances for a value that one side
 * stores and the other reads back as absent.
 *
 * REJECTED, NOT CLAMPED, at both ends. A clamped cost is a confident wrong
 * measurement; absence is honest about a figure we cannot store.
 */
export const MAX_AUTHORITATIVE_COST_USD = 100_000_000;

/**
 * Whether a figure survives a round trip through a column of
 * `MAX_AUTHORITATIVE_COST_USD`'s width — `Decimal(14, 6)`, eight integer digits.
 *
 * IT ROUNDS BEFORE COMPARING, which a bare `< MAX_AUTHORITATIVE_COST_USD` does
 * not, and that difference is the whole reason this is a function. Every writer
 * stores `value.toFixed(6)`, so 99999999.9999995 clears an unrounded bound and
 * then rounds UP to 100000000.000000 — nine integer digits, and a 22003 raised
 * by the driver inside the very transaction the bound exists to keep open. The
 * gap is narrow but it is squarely where a summed rollup lands, which is the
 * only way a cost gets near the ceiling at all.
 *
 * SIGN IS NOT ITS BUSINESS. This answers "does it fit", so each caller still
 * states its own sign policy: the wire schema refuses a negative outright, and
 * the read parse tolerates one it may already have stored.
 *
 * Shared because ISS-7229 shipped four separate spellings of this bound and the
 * reviewers found them already disagreeing. A predicate the guards import cannot
 * drift the way four copies of an inequality did.
 */
export function canStoreAuthoritativeCostUsd(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Math.abs(Number(value.toFixed(6))) < MAX_AUTHORITATIVE_COST_USD
  );
}
