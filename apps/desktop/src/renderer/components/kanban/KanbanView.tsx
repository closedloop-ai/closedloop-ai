import { AgentSessionsKanban } from "@repo/app/agents/components/kanban/agent-sessions-kanban";
import { desktopSessionDetailHashHref } from "../../shared-agent-sessions/session-hrefs";

/** Desktop wrapper for the shared agent-session kanban body. */
export function KanbanView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
      <AgentSessionsKanban getSessionHref={desktopSessionDetailHashHref} />
    </div>
  );
}
