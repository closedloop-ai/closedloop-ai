"use client";

import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
// Cross-slice on purpose: the shell's model owns when a navigation count may
// render, so the legacy badge and the v2 sidebar cannot disagree on it.
import { resolveNavigationBadgeCount } from "../../shell/v2/lib/navigation-section-model";
import { useAgentsNavActivity } from "../hooks/use-agents-nav-activity";
import { AGENTS_NAV_BADGE_MAX } from "../lib/agents-nav-count";

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
  const { count, label } = useAgentsNavActivity({ isActive });
  // Only a settled, non-zero count renders. One still loading or one that could
  // not be read shows nothing, exactly as a zero does.
  const badgeCount = resolveNavigationBadgeCount(count);

  if (isActive || badgeCount === null) {
    return null;
  }

  return (
    <SidebarCountBadge
      count={badgeCount}
      label={label}
      max={AGENTS_NAV_BADGE_MAX}
    />
  );
}
