"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { GaugeIcon } from "lucide-react";
import { formatSessionLocPerDollar } from "./detail-content";
import { PropertyValue } from "./property-values";

/**
 * FEA-3630 / ISS-4667: the session-detail Properties "LOC / $" row, extracted
 * from `agent-session-detail-view.tsx` (a grandfathered, shrink-only file) into
 * its own sibling — the same move `SessionDurationProperty` made (FEA-4275) — so
 * the row's label, unit, and empty semantics live in one testable place and the
 * hot file shrinks.
 *
 * The row sits next to Cost deliberately: its numerator is the same "Lines
 * changed" figure this panel prints and its denominator is the same Cost, so all
 * three reconcile on the card rather than contradicting each other. The label
 * comes from the shared `LOC_PER_DOLLAR_LABEL` so the unit can never drift from
 * the other surfaces rendering the same metric, and an uncomputable ratio renders
 * the shared not-applicable placeholder rather than a fabricated `0.00`.
 */
export function SessionLocPerDollarProperty({
  session,
}: {
  session: AgentSessionDetail;
}) {
  return (
    <PropertyValue icon={GaugeIcon} label={LOC_PER_DOLLAR_LABEL} mono>
      {formatSessionLocPerDollar(session)}
    </PropertyValue>
  );
}
