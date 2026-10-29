import { BRANCH_METRIC_SPARKLINE_FEATURE_FLAG_KEY } from "@repo/api/src/types/branch-metric-sparkline-flag";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";

/**
 * ISS-10544 — the DESKTOP host's answer to "does this shell serve the Branches
 * metric-card trend sparkline?", and it is the flag's answer.
 *
 * The operator's 2026-09-17 ruling graduated
 * `branches-metric-card-trend-sparkline` on web and kept it GATED here, so this
 * is the one read site the key has left. It lives in its own module rather than
 * in `branches-view.tsx` for the reason the source gate gives for every read:
 * the consumer that needs the flag reads it itself, and the value this returns
 * is a shell capability rather than a flag boolean handed on — the same shape
 * `useMetricDeltaTreatment` uses to reach `MetricCard`'s `deltaTreatment` prop.
 *
 * Answers NO until the key resolves true, and for a signed-out reader it never
 * will: `useDesktopPostHogFlagAssignment` settles a session with no account to
 * `flags: {}` (`closedWith`, via the `!authedUserId` branch) and adopts only the
 * ISS-11945 anonymous keys after it, and
 * `DesktopFeatureFlagProvider`'s adapter reads `flags[key] === true`. No rollout
 * percentage reaches a guest, which is why the web half was graduated instead of
 * flipped.
 *
 * `useFeatureFlagEnabledOptional` rather than the throwing reader: a desktop
 * subtree mounted without the provider (its own suites do this) resolves false
 * and renders the shipped card, instead of crashing over a capability question.
 */
export function useDesktopBranchMetricSparkline(): boolean {
  return (
    useFeatureFlagEnabledOptional(BRANCH_METRIC_SPARKLINE_FEATURE_FLAG_KEY) ===
    true
  );
}
