/**
 * Canonical autonomy-tier contract for the Agent Sessions surfaces: the tier
 * vocabulary, the score boundaries, the classifier, and the filter-facet
 * options derived from them.
 *
 * Split out of `agent-session-filters.ts` (FEA-3781), which stays the home of
 * the other session filter dimensions (cost buckets, quality, change presence,
 * PR association). Autonomy earns its own module because its boundaries are a
 * calibrated, evidence-backed decision with a documented history — and because
 * it has consumers, notably `@repo/lib/session-trace/autonomy`, that want the
 * tier vocabulary and nothing else.
 */

/** Autonomy is an integer 0–100 synced from the desktop (FEA-2094). */
export type AutonomyTier = "high" | "mixed" | "guided" | "unknown";

/**
 * Inclusive lower bound of each scored autonomy tier. The one place the tier
 * threshold boundaries are defined: `@repo/app/agents/lib/autonomy` re-exports
 * the classifier, `autonomyTierRange` below derives the filter predicate from
 * it, and `getAutonomyLabel` in `@repo/lib/session-trace/autonomy` maps its
 * own label vocabulary onto the same tiers — so the sessions-list column, the
 * detail Properties panel, and the Autonomy filter facet cannot disagree.
 *
 * FEA-3781: back to 70/35, from the 88/70 that FEA-3266 set. Those cutoffs were
 * calibrated for a distribution that no longer exists. FEA-3266 was correcting a
 * DEAD TIER: the old scoring compressed every discrete-prompt run into a
 * [60, 100] band, so `guided` was unreachable and 88/70 carved three live tiers
 * out of what was left. FEA-3781 replaced that scoring with attended-time
 * attribution, which spans the full range — and against the real distribution it
 * produces, 88/70 leaves `mixed` EMPTY (the same defect, one tier over). Sweep
 * over the 116 SCORED sessions of a 119-session corpus (the other 3 are
 * null-autonomy `unknown` and fall in no tier — `pnpm -C apps/desktop
 * calibrate:autonomy`):
 *
 *   high >= 88, mixed >= 70   ->  high 78, mixed  0, guided 38   <- dead tier
 *   high >= 80, mixed >= 50   ->  high 78, mixed 10, guided 28
 *   high >= 70, mixed >= 35   ->  high 78, mixed 19, guided 19   <- chosen
 *
 * Read that table honestly: `high` is 78 in every row, so this corpus holds
 * nothing at all in [70, 88) and dropping the high cutoff from 88 to 70 moved no
 * session. The boundary that actually did work is `mixed`, 70 -> 35. Keep that in
 * mind when re-calibrating — the high cutoff is currently unconstrained by
 * evidence and a future corpus may well pin it somewhere else.
 *
 * 70/35 splits the low band evenly and puts both boundaries in sparse regions of
 * the histogram rather than through a cluster. It also realigns this repo with
 * the tier boundaries the ancestor implementation in `closedloop-ai/workflow`
 * uses, narrowing the cross-repo divergence to the score itself rather than the
 * score AND the buckets. Re-run the harness before moving these again — a tier
 * boundary set against an imagined distribution is how both previous
 * calibrations went wrong.
 *
 * ROLLOUT WINDOW (FEA-3781, accepted): unlike FEA-3266 this is NOT a pure
 * read-time reclassification, because the score itself changed too. The formula
 * stamp that drives the desktop re-walk is desktop-local
 * (`sync_state.autonomy_formula_version`); nothing on the wire tells the cloud
 * which formula produced a given `AgentSession.autonomy`. So until every
 * installation upgrades and finishes its re-walk, these cutoffs are applied to a
 * mix of old and new scores, and old scores — which bottomed out at 60 — nearly
 * all read as `high`. Two sessions with identical behavior can show different
 * tiers purely by whether their desktop has re-synced yet. This is transient and
 * self-healing; versioning the score on the wire was considered and declined,
 * because it would leave the cloud carrying a calibration per formula forever to
 * fix a window that closes on its own.
 */
export const AUTONOMY_TIER_MIN_SCORE = {
  high: 70,
  mixed: 35,
  guided: 0,
} as const;

/** Classify a raw autonomy score into its tier; null/undefined = "unknown". */
export function classifyAutonomyTier(
  value: number | null | undefined
): AutonomyTier {
  if (value == null) {
    return "unknown";
  }
  if (value >= AUTONOMY_TIER_MIN_SCORE.high) {
    return "high";
  }
  if (value >= AUTONOMY_TIER_MIN_SCORE.mixed) {
    return "mixed";
  }
  return "guided";
}

/** True when a session's autonomy score falls in the requested tier. */
export function matchesAutonomyTier(
  value: number | null | undefined,
  tier: string
): boolean {
  return classifyAutonomyTier(value) === tier;
}

/**
 * The autonomy-score range for a tier, as a half-open interval `[gte, lt)`.
 * Derived from `AUTONOMY_TIER_MIN_SCORE` so the tier adjacency (mixed capped by
 * the high threshold, guided capped by the mixed threshold) lives in exactly one
 * place. `isNull` marks the null-autonomy "unknown" tier; returns null for an
 * unrecognized tier id. The cloud query builder maps this to a Prisma predicate;
 * the desktop matcher classifies with {@link classifyAutonomyTier} directly.
 */
export type AutonomyTierRange = { gte?: number; lt?: number; isNull?: boolean };

export function autonomyTierRange(tier: string): AutonomyTierRange | null {
  switch (tier) {
    case "high":
      return { gte: AUTONOMY_TIER_MIN_SCORE.high };
    case "mixed":
      return {
        gte: AUTONOMY_TIER_MIN_SCORE.mixed,
        lt: AUTONOMY_TIER_MIN_SCORE.high,
      };
    case "guided":
      return {
        gte: AUTONOMY_TIER_MIN_SCORE.guided,
        lt: AUTONOMY_TIER_MIN_SCORE.mixed,
      };
    case "unknown":
      return { isNull: true };
    default:
      return null;
  }
}

export type SessionAutonomyTierFilterOption = {
  value: AutonomyTier;
  label: string;
};

/** Fixed Autonomy facet options (a scored SSOT enum, like the Status facet). */
export const SESSION_AUTONOMY_TIER_FILTER_OPTIONS: readonly SessionAutonomyTierFilterOption[] =
  [
    { value: "high", label: "High" },
    { value: "mixed", label: "Mixed" },
    { value: "guided", label: "Guided" },
    { value: "unknown", label: "Unknown" },
  ];
