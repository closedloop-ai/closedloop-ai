"use client";

import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";

/**
 * ISS-9730 — resolve whether a not-computable metric card hides entirely.
 *
 * `MetricCard` lives in `packages/design-system`, which is gated from reading
 * app feature flags, so the primitive takes the decision as a PROP and every
 * consuming surface resolves it here — one hook rather than a flag read per
 * call site, for the same reason `useMetricDeltaTreatment()` is one hook.
 *
 * WHAT THIS KEY ACTUALLY GATES TODAY (davetho review on #6829, extended by
 * #6885):
 *
 *  - the Branches summary strip — `ApprovedBranchesSummaryCards`, the row both
 *    live hosts render, and the legacy `BranchesSummaryCards` row behind it;
 *  - the Branch detail headline strip — `BranchHeadlineCards`;
 *  - the Sessions summary strip's COST card alone — `SessionsSummaryCards`.
 *
 * THE ADMISSION TEST IS A STATE MACHINE, NOT A SURFACE COUNT. ISS-9749 walked
 * every other `MetricCard` consumer and ruled each one out at its own call site.
 * The reasons collapse to one fact — the Branches surfaces read the
 * `BranchMetricAvailability` machine, so "nobody could compute this" reaches them
 * as its OWN state, while elsewhere a nullish value is ALSO how a failed read, a
 * still-hydrating read, or a gate the reader can open arrives. A card earns a
 * place here by distinguishing those states, not by being wired to this hook.
 *
 * The Sessions Cost card earns it the same way, which is why only that one card
 * of that strip is listed: `resolveCostTileSlots` publishes a POSITIVE
 * `settledEmpty` for the honest no-cost cohort, separately from the dash it also
 * shows for a failed read, for the reader's own Unknown-cost facet, and for a
 * malformed settled payload. Its rowmates on that strip are still OUT, and the
 * reasons are worth keeping because each one was proposed and rejected (#6885):
 * Total Tokens' `null` means a CORRUPT counter and nothing else, so hiding on it
 * would delete the only evidence of a bad payload; and `DeliveryMetricCard`'s
 * signed-in empty branch cannot tell "no data in range" from "we could not read
 * the connection state", which is a failed read wearing the shape of an empty.
 *
 * `useFeatureFlagEnabledOptional` resolves false with no provider mounted, so a
 * Storybook or prototype mount keeps the shipped "No data" treatment rather
 * than throwing or leaking the new behaviour.
 */
export function useMetricCardHideUnavailable(): boolean {
  return useFeatureFlagEnabledOptional(
    METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY
  );
}
