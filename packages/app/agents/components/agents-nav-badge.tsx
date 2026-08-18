"use client";

import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import { useEffect } from "react";
import { useAgentsActivityCount } from "../hooks/use-agents-activity-count";

/**
 * Count above which the badge renders `9+` rather than the raw number, so a
 * long-idle surface never overflows the pill or misstates the value. The
 * accessible label still announces the true count.
 */
const DISPLAY_CAP = 9;

type AgentsNavBadgeProps = Readonly<{
  /**
   * True when the Agents surface is the active route. On becoming active the
   * badge stamps the visit and drains to zero. The org scope is read from the
   * injected auth port inside the hook, so no orgId prop is needed here.
   */
  isActive: boolean;
}>;

/**
 * Activity badge for the Agents sidebar nav item (FEA-3009), shared by the web
 * and desktop sidebars. Renders the count of sessions completed since the user
 * last opened Agents; nothing when there is no new activity. Reuses the proven
 * {@link SidebarCountBadge} the Inbox item uses, with an accessible name so the
 * count is announced with meaning rather than as a bare number.
 */
export function AgentsNavBadge({ isActive }: AgentsNavBadgeProps) {
  const { count, hasActivity, label, markVisited } = useAgentsActivityCount({
    isActive,
  });

  // Opening Agents clears the "new since last visit" window. Effect (not render)
  // so the visit stamp is a committed side effect, not a render-phase write.
  useEffect(() => {
    if (isActive) {
      markVisited();
    }
  }, [isActive, markVisited]);

  if (isActive || !hasActivity) {
    return null;
  }

  return <SidebarCountBadge count={count} label={label} max={DISPLAY_CAP} />;
}
