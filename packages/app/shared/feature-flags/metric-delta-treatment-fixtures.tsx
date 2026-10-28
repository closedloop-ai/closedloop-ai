// gardener-support: test and story data, not shipped
"use client";

import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY,
  METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { ReactNode } from "react";

/**
 * ISS-5842 test fixture: mount a delta-rendering surface with the
 * `metric-delta-unified-pill` gate ON, through the REAL
 * `FeatureFlagAdapterProvider` seam both shells use — not a stubbed boolean, so
 * the test exercises the same resolution path production does.
 *
 * Shared rather than re-declared per suite: the Sessions cost card, the Insights
 * KPI tile and the Sessions delivery deltas all need the identical wrapper, and
 * a per-file copy is exactly the drift the repo's shared-fixture rule forbids.
 *
 * There is deliberately no `off` counterpart — the flag is default OFF, so a
 * bare `render(...)` already IS the flag-off case, and every suite here pairs
 * the two so the counterfactual cannot silently stop discriminating.
 */
export function WithUnifiedDeltaPill({ children }: { children: ReactNode }) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

/**
 * ISS-6493 test fixture: the same seam with ONLY `metric-delta-neutral-pill` on.
 *
 * The isolating permutation, and the reason it is a separate fixture rather than
 * a second flag in the one above. `metric-delta-unified-pill` also pills every
 * tone, so a mount with both gates on can never show whether THIS gate did
 * anything; and a mount with both off is the `Legacy` baseline a bare
 * `render(...)` already gives. Only "unified in its shipped state, neutral ON"
 * exercises {@link MetricDeltaTreatment.NeutralPill}'s own branch — the neutral
 * pill present WITH the verdict word still beside it.
 */
export function WithNeutralDeltaPill({ children }: { children: ReactNode }) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

/**
 * ISS-6493: BOTH gates on — the permutation where the precedence rule is the
 * only thing deciding the render.
 *
 * `useMetricDeltaTreatment` resolves two flags, and its ordering claim (unified
 * wins, because it is a strict superset) is behaviour no single-gate mount can
 * observe: with only one on, either ordering returns the same treatment. This
 * fixture is what makes swapping those two branches a test failure instead of a
 * silent change to what a user with both toggles on sees.
 */
export function WithBothDeltaPillGates({ children }: { children: ReactNode }) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [
          METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY,
          METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
        ],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}
