import { AgentSessionDetailView as SharedAgentSessionDetailView } from "@repo/app/agents/components/detail/agent-session-detail-view";
import { useAgentSessionDetail } from "@repo/app/agents/hooks/use-agent-sessions";
import { Profiler } from "react";
import { RendererRenderView } from "../../../shared/render-commit-event";
import {
  detailTitleKey,
  usePublishDetailTitle,
} from "../../navigation/detail-title-context";
import {
  resolveSessionsDetailCause,
  useRenderCommitInstrumentation,
} from "./use-render-commit-instrumentation";

/** Desktop wrapper for the shared agent-session detail body. */
export function SessionDetailView({
  backHref,
  sessionId,
}: {
  backHref: string;
  sessionId: string;
}) {
  const sessionQuery = useAgentSessionDetail(sessionId);
  // Publish the session name to the Topbar breadcrumb (mirrors the web detail
  // page's "Sessions / <name>" breadcrumb); null while still loading.
  usePublishDetailTitle(
    detailTitleKey("session", sessionId),
    sessionQuery.data?.name ?? sessionQuery.data?.externalSessionId ?? null
  );
  // FEA-1998: render-commit timing for the session detail. Item count is the
  // number of rendered session events.
  const onRenderCommit = useRenderCommitInstrumentation({
    view: RendererRenderView.SessionsDetail,
    itemCount: sessionQuery.data?.events.length ?? 0,
    causeInputs: { sessionId },
    resolveCause: resolveSessionsDetailCause,
  });
  return (
    // The Topbar breadcrumb ("Sessions / <name>") is the back affordance now;
    // this wrapper stays as the detail shell (h-full overflow-hidden). backHref
    // still feeds the shared not-found state's "Back to Sessions" link.
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <Profiler id="sessions_detail" onRender={onRenderCommit}>
        <SharedAgentSessionDetailView
          backHref={backHref}
          isLoading={sessionQuery.isLoading}
          session={sessionQuery.data}
        />
      </Profiler>
    </div>
  );
}
