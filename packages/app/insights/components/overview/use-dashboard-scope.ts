"use client";

import { InsightsScope } from "@closedloop-ai/loops-api/insights";
import { useCallback, useState } from "react";

export type DashboardScope = {
  /**
   * The effective insights scope for reads and tile availability. Clamped to an
   * available scope on every render: when `org` is not offered (signed out /
   * offline / Local mode) this is always `Me`, so a Cloud->Local flip can never
   * send a stale `org` read to the local own-data store before a state update
   * settles.
   */
  scope: InsightsScope;
  /** Whether the org scope is currently offered (authenticated + online). */
  orgScopeAvailable: boolean;
  /** Toggle handler: any non-`org` value resolves to personal (`Me`) scope. */
  setScope: (value: string) => void;
};

/**
 * Dashboard scope selection, shared by both shells (PLN-1138). The returned
 * `scope` is always one the insights source can serve: `org` is offered only
 * where `availableScopes` advertises it, and the selection is clamped to `Me`
 * everywhere it is not.
 *
 * Personal (`Me`) is the starting scope on BOTH shells, by operator ruling
 * (Marisol Ashgrove, 2026-09-30: "both should default to 'Me'"). `defaultScope`
 * exists so a host can seed a different one — it is what carries
 * `InsightsOverviewDashboard`'s own `scope` prop into this state — and neither
 * production surface passes anything but the default today.
 */
export function useDashboardScope(
  availableScopes: readonly InsightsScope[],
  defaultScope: InsightsScope = InsightsScope.Me
): DashboardScope {
  const orgScopeAvailable = availableScopes.includes(InsightsScope.Org);
  const [selectedScope, setSelectedScope] =
    useState<InsightsScope>(defaultScope);
  const scope = orgScopeAvailable ? selectedScope : InsightsScope.Me;
  const setScope = useCallback((value: string) => {
    setSelectedScope(
      value === InsightsScope.Org ? InsightsScope.Org : InsightsScope.Me
    );
  }, []);
  return { scope, orgScopeAvailable, setScope };
}
