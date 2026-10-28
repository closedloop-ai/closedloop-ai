"use client";

import type { InsightsScope } from "@closedloop-ai/loops-api/insights";
import { AnalyticsRangeToggle } from "@repo/design-system/components/ui/analytics-range-toggle";
import {
  DASHBOARD_SCOPE_LABEL,
  SCOPE_TOGGLE_OPTIONS,
} from "./dashboard-scope-copy";

/**
 * The dashboard's Me / Organization scope toggle, shared by both shells.
 *
 * Restored on desktop by operator instruction (2026-09-30): ISS-10929 retired
 * this control alongside the Tour button and the Local/Cloud pill, and the
 * operator has ruled that removing this one was a regression. The other two stay
 * retired. The same instruction extended it to web — Marisol Ashgrove,
 * 2026-09-30: "We need to also do [PR #8213] this for web; add it in. We can do
 * it as a separate PR" — which is why this module lives under `packages/app`
 * rather than in the desktop renderer.
 *
 * `available` is the source's own answer, threaded from `useDashboardScope`, so
 * the toggle renders only where `org` is actually served (authenticated +
 * online) and can never offer a scope the read cannot answer for — the operator
 * gate, stated the same day: "the selector of course should only appear on
 * desktop if I'm logged in and have 'org' data to display — otherwise it's
 * hidden and just shows my local". ISS-10942 retired the guest ask that used to
 * show this gated on Organization, so a guest sees no toggle rather than a
 * teased one.
 */
export function DashboardScopeControl({
  available,
  scope,
  onValueChange,
}: {
  available: boolean;
  scope: InsightsScope;
  onValueChange: (value: string) => void;
}) {
  if (!available) {
    return null;
  }
  return (
    <AnalyticsRangeToggle
      label={DASHBOARD_SCOPE_LABEL}
      onValueChange={onValueChange}
      options={SCOPE_TOGGLE_OPTIONS}
      value={scope}
    />
  );
}
