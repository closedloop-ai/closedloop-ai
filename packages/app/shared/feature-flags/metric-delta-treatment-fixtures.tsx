"use client";

import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
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
