"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { AgentSessionDetailView } from "@repo/app/agents/components/detail/agent-session-detail-view";
import { useAgentSessionDetail } from "@repo/app/agents/hooks/use-agent-sessions";
import {
  readTranscriptFileKey,
  withTranscriptFileParam,
} from "@repo/app/agents/lib/session-transcript-href";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import {
  SessionDetailActions,
  SessionDetailFavoriteButton,
  SessionDetailOverflowMenu,
} from "@/app/(authenticated)/components/session-detail-header-controls";
import { useOrgSlug } from "@/hooks/use-org-slug";

export default function SessionDetailPage() {
  const orgSlug = useOrgSlug();
  const params = useRouteParams();
  const sessionId = typeof params.id === "string" ? params.id : "";
  const detailQuery = useAgentSessionDetail(sessionId);
  const session = detailQuery.data;
  const sessionsHref = `/${orgSlug}/sessions`;
  const searchParams = useSearchParamsValue();
  const transcriptFileKey = readTranscriptFileKey(searchParams);
  const buildTranscriptFileHref = useCallback(
    (fileKey: string) =>
      withTranscriptFileParam(`/${orgSlug}/sessions/${sessionId}`, fileKey),
    [orgSlug, sessionId]
  );
  const [commentsRailOpen, setCommentsRailOpen] = useState(true);

  return (
    <FeatureFlagged flag={DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY}>
      <div className="flex min-h-0 flex-1 flex-col">
        <Header
          afterBreadcrumbs={<SessionDetailFavoriteButton />}
          breadcrumbs={[
            { label: "Sessions", href: sessionsHref },
            { label: session?.name ?? session?.externalSessionId ?? "Session" },
          ]}
          moreMenu={<SessionDetailOverflowMenu sessionId={sessionId} />}
        >
          <SessionDetailActions
            commentsRailOpen={commentsRailOpen}
            isRefreshing={detailQuery.isFetching}
            onRefresh={() => {
              detailQuery.refetch().catch(() => undefined);
            }}
            onToggleCommentsRail={() =>
              setCommentsRailOpen((current) => !current)
            }
            sessionId={sessionId}
          />
        </Header>
        <AgentSessionDetailView
          backHref={sessionsHref}
          buildTranscriptFileHref={buildTranscriptFileHref}
          commentsRailOpen={commentsRailOpen}
          isLoading={detailQuery.isLoading}
          session={session}
          transcriptFileKey={transcriptFileKey}
        />
      </div>
    </FeatureFlagged>
  );
}
