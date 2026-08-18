import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { resolveAttributedBranchCost } from "@repo/api/src/types/branch-cost";
import {
  IDLE_PHASE_KEY,
  OTHER_PHASE_KEY,
} from "../sessions/activity-segment-aggregation";
import { microCentsToUsd, usdToMicroCents } from "./activity-attribution";

/**
 * FEA-2276 — the branch activity rollup: a pure fold of each session's priced
 * `activitySegments` (produced ONCE by the shared `activity-attribution` kernel on
 * whichever surface served the detail) into a per-activity cost breakdown for the
 * branch. Replaces the coarse 2-state `partitionBuildVsRework` split. Pure over
 * `BranchPageDetail` — no clock, no DB, no surface imports — so web and desktop
 * render an identical rollup from an identical DTO (the authenticated-parity
 * requirement reduces to this + the shared attribution kernel feeding it).
 *
 * Lives in `@repo/lib` (React-free, Node-safe) alongside the sibling `merged-trace`
 * / `value-per-dollar` branch kernels so the cross-surface parity fixture can
 * import it and assert both surfaces produce the same rollup.
 */

/**
 * Canonical FEA-2269 taxonomy render order. `phase` on the wire is a bounded free
 * string (never a closed union — a taxonomy change is a classifier-version bump,
 * not a contract change), so unknown phases are NOT dropped: they roll up under
 * their normalized key and sort AFTER the known set (alphabetically). `idle` and
 * `other` are first-class honest buckets — surfaced as their own rows, never
 * folded into an active activity.
 */
export const BRANCH_ACTIVITY_ORDER = [
  "explore",
  "plan",
  "implement",
  "review",
  "validate",
  "rework",
  "other",
  "idle",
] as const;

/**
 * Rollup-only residual key for branch spend with NO per-segment attribution. It is
 * NEVER a persisted taxonomy value and is distinct from the classifier's `other`
 * (a tiled-but-unclassifiable span carrying real spend): `unattributed` is spend
 * whose owning session had no tiling at all (older builds / pre-backfill) or a
 * within-session gap. Kept separate so we never claim the classifier tiled spend
 * it never saw.
 */
export const UNATTRIBUTED_KEY = "unattributed";

/** Active-work excludes honest non-work buckets from the "% active" denominator. */
const NON_ACTIVE_PHASES = new Set<string>([
  OTHER_PHASE_KEY,
  IDLE_PHASE_KEY,
  UNATTRIBUTED_KEY,
]);

export type BranchActivityAggregate = {
  /** Normalized taxonomy phase key (lowercase) or `unattributed`. */
  phase: string;
  /** Priced spend for this activity; `null` (never 0) when nothing prices. */
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Number of classifier segments folded into this activity. */
  segmentCount: number;
  /** Number of distinct sessions contributing to this activity. */
  sessionCount: number;
};

export type BranchActivityRollup = {
  /**
   * Per-activity aggregates for the taxonomy phases actually present, in
   * `BRANCH_ACTIVITY_ORDER` (unknown phases after, alphabetically). Excludes the
   * `unattributed` residual (carried separately).
   */
  activities: BranchActivityAggregate[];
  /**
   * Residual bucket reconciling the rollup to the branch total: `totalCostUsd −
   * Σ(activities)`, clamped ≥ 0. Captures both no-segment sessions and
   * within-session gaps so `Σ(activities) + unattributed == totalCostUsd`.
   */
  unattributed: BranchActivityAggregate;
  /** Canonical branch-attributed total the rollup reconciles to. */
  totalCostUsd: number | null;
  /**
   * True when at least one contributing session carried a non-empty
   * `activitySegments` tiling. When false the branch has spend but no attribution
   * yet (pre-backfill) — the panel shows an honest "attribution pending" note
   * rather than a single fabricated Build bar.
   */
  hasAnySegments: boolean;
};

type MutableAggregate = {
  phase: string;
  microCents: number;
  anyPriced: boolean;
  inputTokens: number;
  outputTokens: number;
  segmentCount: number;
  sessions: Set<string>;
};

function normalizePhase(phase: string): string {
  return phase.trim().toLowerCase();
}

/**
 * The session's even-split divisor: how many active-write branches its spend is
 * shared across (`branchCount`, set by both producers from the SAME count the
 * branch total is even-split by). Absent / non-positive collapses to 1 (touches
 * only this branch). Only COST is divided — per-session tokens stay raw on both
 * surfaces, so the token residual reconciles without a divisor.
 */
function branchDivisor(session: BranchPageDetail["sessions"][number]): number {
  return session.branchCount != null && session.branchCount > 0
    ? session.branchCount
    : 1;
}

function taxonomyRank(phase: string): number {
  const index = BRANCH_ACTIVITY_ORDER.indexOf(
    phase as (typeof BRANCH_ACTIVITY_ORDER)[number]
  );
  // Known phases keep their taxonomy order; unknown phases sort after the whole
  // known set (then alphabetically, applied by the caller's tiebreak).
  return index === -1 ? BRANCH_ACTIVITY_ORDER.length : index;
}

/**
 * Fold a branch's per-session `activitySegments` into per-activity aggregates plus
 * an `unattributed` residual. Uses the canonical `attributedCostUsd` when an
 * upgraded producer sends it, falling back to raw `estimatedCostUsd` only when an
 * older producer omits the additive field. Explicit null and zero remain
 * authoritative so the rollup never invents availability or spend.
 */
export function rollupBranchActivity(
  detail: Pick<
    BranchPageDetail,
    "attributedCostUsd" | "estimatedCostUsd" | "sessions"
  >
): BranchActivityRollup {
  const byPhase = new Map<string, MutableAggregate>();
  let hasAnySegments = false;
  let attributedInputTokens = 0;
  let attributedOutputTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Fold each DISTINCT session once. A branch can carry several `session_pr` link
  // rows for the same session, so the cloud producer's `sessions` array (and thus
  // `detail.sessions`) can repeat one session; the even-split branch total dedups
  // (`distinctSessionCosts`) but this array does not. Folding a duplicate would
  // inflate every per-activity $/token (`sessionCount` stays right — it's a Set —
  // masking it). First-seen wins; every duplicate carries identical data.
  const dedupedSessions = dedupeSessionsById(detail.sessions);

  for (const session of dedupedSessions) {
    totalInputTokens += session.inputTokens;
    totalOutputTokens += session.outputTokens;

    const segments = session.activitySegments;
    if (segments == null || segments.length === 0) {
      // No tiling for this session — its whole spend/tokens fall to `unattributed`.
      continue;
    }
    hasAnySegments = true;
    const divisor = branchDivisor(session);

    for (const segment of segments) {
      const phase = normalizePhase(segment.phase);
      const agg =
        byPhase.get(phase) ??
        ({
          phase,
          microCents: 0,
          anyPriced: false,
          inputTokens: 0,
          outputTokens: 0,
          segmentCount: 0,
          sessions: new Set<string>(),
        } satisfies MutableAggregate);
      byPhase.set(phase, agg);
      agg.segmentCount += 1;
      agg.sessions.add(session.sessionId);
      agg.inputTokens += segment.inputTokens;
      agg.outputTokens += segment.outputTokens;
      attributedInputTokens += segment.inputTokens;
      attributedOutputTokens += segment.outputTokens;
      if (segment.costUsd != null) {
        // Even-split the attributed cost by the session's branch count so a
        // session shared with other branches contributes only THIS branch's share
        // — matching the canonical branch-attributed reconciliation total.
        // This is the one cost division in the rollup; the top-level attributed
        // total is never divided again. Tokens stay raw on both surfaces.
        agg.microCents += usdToMicroCents(segment.costUsd / divisor);
        agg.anyPriced = true;
      }
    }
  }

  let activities = [...byPhase.values()].map(finalizeAggregate).sort((a, b) => {
    const rankDelta = taxonomyRank(a.phase) - taxonomyRank(b.phase);
    return rankDelta === 0 ? a.phase.localeCompare(b.phase) : rankDelta;
  });

  // Reconciliation precondition: the canonical attributed total and the activity
  // sum (from `token_events`) come from DIFFERENT cost pipelines. The invariant
  // `Σ(activities) + unattributed == total` holds when they agree — which they do
  // in normal operation. Two producer-inconsistency edges the caller tolerates:
  //   - total null but segments priced → unattributed stays null (the panel shows
  //     the empty state off the authoritative null total, never a priced bar under
  //     a "—"; see branch-cost-to-merge.tsx).
  //   - attributed > total → activity costs scale down proportionally to the
  //     authoritative total so bars and residual still reconcile exactly.
  const totalCostUsd = resolveAttributedBranchCost(detail);
  let activityCostUsd = activities.reduce(
    (sum, activity) => sum + (activity.costUsd ?? 0),
    0
  );
  if (
    totalCostUsd != null &&
    activityCostUsd > totalCostUsd &&
    activityCostUsd > 0
  ) {
    const scale = totalCostUsd / activityCostUsd;
    activities = activities.map((activity) => ({
      ...activity,
      costUsd: activity.costUsd == null ? null : activity.costUsd * scale,
    }));
    activityCostUsd = totalCostUsd;
  }
  const unattributedCostUsd =
    totalCostUsd == null ? null : Math.max(0, totalCostUsd - activityCostUsd);

  const unattributed: BranchActivityAggregate = {
    phase: UNATTRIBUTED_KEY,
    costUsd: unattributedCostUsd,
    inputTokens: Math.max(0, totalInputTokens - attributedInputTokens),
    outputTokens: Math.max(0, totalOutputTokens - attributedOutputTokens),
    segmentCount: 0,
    // Sessions with zero attribution — the honest "N sessions couldn't be
    // attributed" count (a partial within-session gap is folded into the residual
    // cost but does not inflate this count). Deduped like the fold above.
    sessionCount: dedupedSessions.filter(
      (session) =>
        session.activitySegments == null ||
        session.activitySegments.length === 0
    ).length,
  };

  return { activities, unattributed, totalCostUsd, hasAnySegments };
}

/** Distinct sessions by `sessionId`, first-seen order preserved. */
function dedupeSessionsById(
  sessions: BranchPageDetail["sessions"]
): BranchPageDetail["sessions"] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.sessionId)) {
      return false;
    }
    seen.add(session.sessionId);
    return true;
  });
}

function finalizeAggregate(agg: MutableAggregate): BranchActivityAggregate {
  return {
    phase: agg.phase,
    costUsd: agg.anyPriced ? microCentsToUsd(agg.microCents) : null,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    segmentCount: agg.segmentCount,
    sessionCount: agg.sessions.size,
  };
}

/** Whether a rollup phase key counts toward "active work" (excludes other/idle/unattributed). */
export function isActiveActivityPhase(phase: string): boolean {
  return !NON_ACTIVE_PHASES.has(normalizePhase(phase));
}
