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
 * Desktop Dashboard scope selection (PLN-1138). The desktop Dashboard defaults
 * to personal (`Me`) and exposes an org toggle only when the insights source
 * advertises it. The returned `scope` is always one the source can serve.
 */
export function useDashboardScope(
  availableScopes: readonly InsightsScope[]
): DashboardScope {
  const orgScopeAvailable = availableScopes.includes(InsightsScope.Org);
  const [selectedScope, setSelectedScope] = useState<InsightsScope>(
    InsightsScope.Me
  );
  const scope = orgScopeAvailable ? selectedScope : InsightsScope.Me;
  const setScope = useCallback((value: string) => {
    setSelectedScope(
      value === InsightsScope.Org ? InsightsScope.Org : InsightsScope.Me
    );
  }, []);
  return { scope, orgScopeAvailable, setScope };
}
