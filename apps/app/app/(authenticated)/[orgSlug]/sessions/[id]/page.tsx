"use client";

import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { OnboardingAnalyticsPageName } from "@repo/api/src/types/onboarding-analytics";
import { classifySessionDetailError } from "@repo/app/agents/components/detail/agent-session-detail-states";
import { AgentSessionDetailView } from "@repo/app/agents/components/detail/agent-session-detail-view";
import { AgentSessionShellView } from "@repo/app/agents/components/detail/agent-session-shell-view";
import { SessionCommentsPaneToggle } from "@repo/app/agents/components/detail/session-comments-pane-toggle";
import { useAgentSessionDetail } from "@repo/app/agents/hooks/use-agent-sessions";
import {
  readTranscriptFileKey,
  readTranscriptInvocationAnchor,
  withTranscriptFileParam,
} from "@repo/app/agents/lib/session-transcript-href";
import {
  getDocumentTypeRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import { readArtifactCommentThreadId } from "@repo/app/shared/lib/artifact-comment-href";
import {
  ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY,
  SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  NavReferrerSurface,
  withNavReferrer,
} from "@repo/app/shared/lib/nav-referrer";
import { usePageViewedEvent } from "@repo/app/shared/observability/use-page-viewed-event";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { SessionDetailActions } from "@/components/agent-sessions/session-detail-header-controls";
import { useOrgSlug } from "@/hooks/use-org-slug";

export default function SessionDetailPage() {
  const orgSlug = useOrgSlug();
  const params = useRouteParams();
  const sessionId = typeof params.id === "string" ? params.id : "";
  const detailQuery = useAgentSessionDetail(sessionId);
  // PRD-736: the aha-moment anchor — first page_viewed[session_detail]. Gated
  // on the detail read succeeding: a 404 or a failed read rendered an error
  // state, not a session, and must not count as the activation moment.
  usePageViewedEvent(OnboardingAnalyticsPageName.SessionDetail, {
    ready: detailQuery.isSuccess,
  });
  const session = detailQuery.data;
  const sessionsHref = `/${orgSlug}/sessions`;
  const searchParams = useSearchParamsValue();
  const transcriptFileKey = readTranscriptFileKey(searchParams);
  const invocationAnchor = readTranscriptInvocationAnchor(searchParams);
  // ISS-11004: the Activity tab's comment rows link here with `?comment=`; the
  // shell that owns the URL reads it, as it does the transcript deep links.
  const selectedThreadId = readArtifactCommentThreadId(searchParams);
  const buildTranscriptFileHref = useCallback(
    (fileKey: string) =>
      withTranscriptFileParam(`/${orgSlug}/sessions/${sessionId}`, fileKey),
    [orgSlug, sessionId]
  );
  // FEA-3635: org-scoped href to a referenced/created Closedloop artifact
  // (FEAT/PRD/…). Null when the artifact has no slug or its type is not
  // navigable (e.g. Template) — the pill then renders as a non-clickable label.
  const buildArtifactHref = useCallback(
    (artifact: SessionLinkedArtifact) =>
      withOrgSlug(
        orgSlug,
        getDocumentTypeRoute(artifact.documentType, artifact.slug)
      ),
    [orgSlug]
  );
  // FEA-4256: link the session's Repository/Branch/PR display to its own branch
  // detail page (the session knows which branch it shipped). FEA-4262: tag the
  // link with `?from=session` so the branch page's Back returns to Sessions.
  const getBranchHref = useCallback(
    (branchArtifactId: string) =>
      withNavReferrer(
        `/${orgSlug}/branches/${branchArtifactId}`,
        NavReferrerSurface.Session
      ),
    [orgSlug]
  );
  const [commentsRailOpen, setCommentsRailOpen] = useState(true);
  // ISS-5574: a detail tab should name its record, and say only what is true
  // while the read is in flight. `"Session"` is the honest generic — it names the
  // kind of page, where a placeholder like the raw id would read as a name the
  // record does not have. ONE const feeds both the tab and the breadcrumb below,
  // so "the tab and the crumb never disagree" holds by construction rather than
  // by two copies of the chain staying in sync. Same chain the Sessions LIST row
  // resolves (`session-table-row.ts`), so one session reads the same everywhere.
  const sessionTitle = session?.name ?? session?.externalSessionId ?? "Session";
  const tabTitlesEnabled = useFeatureFlagEnabled(
    SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
  );
  useDocumentTitle(tabTitlesEnabled ? sessionTitle : null);
  const shellEnabled = useFeatureFlagEnabled(
    ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY
  );
  const SessionDetailBody = shellEnabled
    ? AgentSessionShellView
    : AgentSessionDetailView;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        breadcrumbs={[
          { label: "Sessions", href: sessionsHref },
          { label: sessionTitle },
        ]}
        suppressPageHeading
      >
        {/* ISS-12300 D3: the shell's pane keeps its own saved state, and its
            button shows on the Session tab only. */}
        {shellEnabled ? (
          <SessionCommentsPaneToggle />
        ) : (
          <SessionDetailActions
            commentsRailOpen={commentsRailOpen}
            onToggleCommentsRail={() =>
              setCommentsRailOpen((current) => !current)
            }
          />
        )}
      </Header>
      <SessionDetailBody
        backHref={sessionsHref}
        buildArtifactHref={buildArtifactHref}
        buildTranscriptFileHref={buildTranscriptFileHref}
        commentsRailOpen={commentsRailOpen}
        errorKind={classifySessionDetailError(detailQuery.error)}
        getBranchHref={getBranchHref}
        invocationAnchor={invocationAnchor}
        isError={detailQuery.isError}
        isLoading={detailQuery.isLoading}
        onRevealCommentsRail={() => setCommentsRailOpen(true)}
        selectedThreadId={selectedThreadId}
        session={session}
        transcriptFileKey={transcriptFileKey}
      />
    </div>
  );
}
