"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { GaugeIcon } from "lucide-react";
import { formatSessionLocPerDollar } from "./detail-content";
import { PropertyValue } from "./property-values";

/**
 * FEA-3630 / ISS-4667: the session-detail Properties ratio row, extracted
 * from `agent-session-detail-view.tsx` into
 * its own sibling — the same move `SessionDurationProperty` made (FEA-4275) — so
 * the row's label, unit, and empty semantics live in one testable place and the
 * hot file shrinks.
 *
 * The row sits next to Cost deliberately: its numerator is the same "Lines
 * changed" figure this panel prints and its denominator is the same Cost, so all
 * three reconcile on the card rather than contradicting each other. The label
 * comes from this row's entry in the LOC definition registry (ISS-9097), so the
 * unit can never drift from the other surfaces rendering the same metric, and an
 * uncomputable ratio renders the shared not-applicable placeholder rather than a
 * fabricated `0.00`.
 */
export function SessionLocPerDollarProperty({
  session,
}: {
  session: AgentSessionDetail;
}) {
  return (
    <PropertyValue
      icon={GaugeIcon}
      label={useSessionLocPerDollarRowLabel()}
      mono
    >
      {formatSessionLocPerDollar(session)}
    </PropertyValue>
  );
}

/**
 * This row's own label. ISS-10667: read where the row swaps it. The PER-SESSION
 * entry, because `session.locPerDollar` divides one session's merged authored
 * lines by that same session's cost — not the summary's matched-session totals.
 *
 * ISS-12269 put the ratio on the Details tab too, and that surface supplies its
 * own row chrome, so it reads the label from here rather than resolving the
 * registry entry a second time.
 */
export function useSessionLocPerDollarRowLabel(): string {
  const definition =
    LOC_METRIC_DEFINITION[LocMetricDefinitionId.SessionDetailMergedLoc];
  return useFeatureFlagEnabledOptional(ONE_LABEL_PER_METRIC_FLAG_KEY)
    ? definition.canonicalLabel
    : definition.label;
}
