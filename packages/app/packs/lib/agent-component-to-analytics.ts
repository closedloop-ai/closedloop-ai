/**
 * Maps the canonical org-wide agent-component analytics
 * (`AgentComponent` / `AgentComponentDetail`) onto the `PackView` analytics
 * blocks — the single source of truth for per-pack usage, code productivity, and
 * adoption. No new aggregation: these are the metrics the agent-components
 * services already compute (FEA-3090 KLOC/$, invocation/session rollups, owner
 * attribution, adoption breadth).
 */

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import { getInitials } from "../../shared/lib/user-utils";
import type { PackPerformance, PackTeamUsage, PackUser } from "./pack-view";

function toPackUser(name: string): PackUser {
  return { id: name, name, initials: getInitials(name) };
}

/**
 * Derive the `teamUsage` (adoption) and `performance` (KLOC/$, usage) blocks for
 * a pack from its linked agent component. Owner + collaborators are the teammates
 * who have used it; `computeTargetIds` is the device adoption breadth.
 */
export function agentComponentToPackAnalytics(component: AgentComponent): {
  teamUsage: PackTeamUsage;
  performance: PackPerformance;
} {
  const ownerNames = [
    ...(component.owner ? [component.owner] : []),
    ...component.collaborators,
  ];
  const installers = ownerNames.map(toPackUser);
  const trend = [...component.trend];

  return {
    teamUsage: {
      installers,
      installedCount: installers.length,
      deviceCount: component.computeTargetIds.length,
      installTrend: trend,
    },
    performance: {
      klocPerDollar: component.klocPerDollar,
      invocations: component.invocations,
      sessions: component.sessions,
      usageTrend: trend,
    },
  };
}
