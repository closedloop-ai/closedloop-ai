import { AgentSessionDetailView as SharedAgentSessionDetailView } from "@repo/app/agents/components/detail/agent-session-detail-view";
import { useAgentSessionDetail } from "@repo/app/agents/hooks/use-agent-sessions";
import { ArrowLeftIcon } from "lucide-react";

/** Desktop wrapper for the shared agent-session detail body. */
export function SessionDetailView({
  backHref,
  sessionId,
}: {
  backHref: string;
  sessionId: string;
}) {
  const sessionQuery = useAgentSessionDetail(sessionId);
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center border-border border-b px-5 py-3">
        <a
          className="sd3-back"
          href={backHref}
          onClick={(event) => {
            event.preventDefault();
            globalThis.location.hash = backHref;
          }}
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Back to Sessions
        </a>
      </div>
      <SharedAgentSessionDetailView
        backHref={backHref}
        commentsRailOpen={false}
        isLoading={sessionQuery.isLoading}
        session={sessionQuery.data}
      />
    </div>
  );
}
