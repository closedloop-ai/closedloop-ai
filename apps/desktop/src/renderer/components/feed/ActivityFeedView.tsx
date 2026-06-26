import { AgentSessionActivityFeed } from "@repo/app/agents/components/activity/agent-session-activity-feed";
import { desktopSessionDetailHashHref } from "../../shared-agent-sessions/session-hrefs";

/** Desktop wrapper for the shared agent-session activity feed. */
export function ActivityFeedView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
      <AgentSessionActivityFeed getSessionHref={desktopSessionDetailHashHref} />
    </div>
  );
}
