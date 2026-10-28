"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import type { TraceTextAnchor } from "@repo/api/src/types/comment";
import { resolveSessionDetailDisplayStatus } from "@repo/app/agents/lib/session-detail-display-status";
import { TRANSCRIPT_FILE_PARAM } from "@repo/app/agents/lib/session-transcript-href";
import type { ArtifactCommentAddress } from "@repo/app/documents/components/artifact-activity/artifact-activity-rows";
import { ArtifactCanvasPanel } from "@repo/app/shared/components/artifact-detail-shell/artifact-canvas-panel";
import { ArtifactDetailShell } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { useArtifactDetailTabRoute } from "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route";
import { useLinkedSearchWriter } from "@repo/app/shared/hooks/use-linked-search-writer";
import { withArtifactCommentParam } from "@repo/app/shared/lib/artifact-comment-href";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentSessionDetailView,
  type AgentSessionDetailViewProps,
} from "./agent-session-detail-view";
import {
  SESSION_ARTIFACT_ROUTE_CONFIG,
  SESSION_ARTIFACT_TAB_LABELS,
  SESSION_ARTIFACT_TABS,
} from "./session-artifact-routing";
import { SessionCommentsPane } from "./session-comments-pane";
import { SessionDetailTab } from "./session-detail-tabs";
import { SessionShellActivity } from "./session-shell-activity";
import {
  SessionShellCollaborators,
  SessionShellDetails,
} from "./session-shell-details";
import type { SessionTraceCommentsHost } from "./session-trace-comments-host";
import { resolveTranscriptNeverExpected } from "./transcript-never-expected-from-sync-level";

/** Drop-in Session host: maps the existing view onto the canonical shell. */
export function AgentSessionShellView(props: AgentSessionDetailViewProps) {
  const route = useSessionArtifactRoute();
  const searchParams = useSearchParamsValue();
  const navigation = useNavigation();
  const pathname = usePath();
  const { readLatest, replaceSearch } = useLinkedSearchWriter(
    pathname,
    searchParams,
    navigation.replace
  );
  const addressedFile = searchParams.get(TRANSCRIPT_FILE_PARAM);
  // ISS-11004: the Activity tab's comment rows link to the comment, and only
  // this host knows which of its tabs holds the rail.
  const buildCommentHref = useCallback(
    ({ threadId }: ArtifactCommentAddress) =>
      withArtifactCommentParam({
        threadId,
        path: pathname,
        railTab: ArtifactDetailTab.Sessions,
        searchParams,
      }),
    [pathname, searchParams]
  );
  const deepLink = JSON.stringify([
    props.session?.id,
    addressedFile,
    props.invocationAnchor,
  ]);
  // `undefined` is "this view has not seen a URL yet", which is NOT "the
  // addressed file changed". `useTabParam` keeps `?file=` across tabs, so a URL
  // can arrive carrying both an explicit tab and a stale file — reloaded, or
  // pasted to someone else.
  const previousDeepLink = useRef<string | undefined>(undefined);
  useEffect(() => {
    const isColdLoad = previousDeepLink.current === undefined;
    if (previousDeepLink.current === deepLink) {
      return;
    }
    previousDeepLink.current = deepLink;
    const params = readLatest();
    let rewritten = false;
    if (isColdLoad) {
      // A legacy `?tab=trace` bookmark aliases to the Artifact tab, but the
      // nested workspace reads `?view=` only, so the Trace selection was lost
      // and the bookmark opened Overview (whitlockk review, PR #8461). Translate it
      // once; `tab` itself stays, since the outer alias already resolves it and
      // the route hook canonicalizes on the next write. Only `trace` needs it —
      // `overview` is the nested default, which `useTabParam` omits from URLs.
      if (
        params.get("view") === null &&
        params.get("tab") === SessionDetailTab.Trace
      ) {
        params.set("view", SessionDetailTab.Trace);
        rewritten = true;
      }
      // A cold load honors the tab the URL asked for and drops the stale
      // selection instead, so the URL stops advertising a file this view is not
      // showing (operator ruling, 2026-10-06). Stripping the tab here sent
      // anyone who reloaded or shared `?file=…&tab=details` to Artifact.
      if (addressedFile || props.invocationAnchor) {
        params.delete(TRANSCRIPT_FILE_PARAM);
        rewritten = true;
      }
    } else if (addressedFile || props.invocationAnchor) {
      params.delete("tab");
      params.delete("view");
      rewritten = true;
    }
    // ONE replace for every cold-load rewrite: two effects each building from
    // the same `searchParams` would have the second drop the first's change.
    if (!rewritten) {
      return;
    }
    replaceSearch(params);
  }, [
    deepLink,
    addressedFile,
    props.invocationAnchor,
    readLatest,
    replaceSearch,
  ]);

  const { session } = props;
  if (!session) {
    return <AgentSessionDetailView {...props} />;
  }
  const displayedStatus = resolveSessionDetailDisplayStatus({
    awaitingInputSince: session.awaitingInputSince,
    endedAt: session.endedAt,
    lastActivityAt: session.lastActivityAt,
    startedAt: session.startedAt,
    status: session.status,
  });

  return (
    <SessionShell
      buildCommentHref={buildCommentHref}
      detailProps={props}
      displayedStatus={displayedStatus}
      key={session.id}
      route={route}
      session={session}
    />
  );
}

function useSessionArtifactRoute() {
  return useArtifactDetailTabRoute(SESSION_ARTIFACT_ROUTE_CONFIG);
}

/**
 * One Session's shell, keyed by its id so the trace selection and the revealed
 * anchor the comments pane shares with the trace never cross Sessions.
 */
function SessionShell({
  buildCommentHref,
  detailProps: props,
  displayedStatus,
  route,
  session,
}: {
  buildCommentHref: (address: ArtifactCommentAddress) => string;
  detailProps: AgentSessionDetailViewProps;
  displayedStatus: ReturnType<typeof resolveSessionDetailDisplayStatus>;
  route: ReturnType<typeof useSessionArtifactRoute>;
  session: AgentSessionDetail;
}) {
  const traceJump = useRef<((row: number) => void) | null>(null);
  const [traceSelection, setTraceSelection] = useState<TraceTextAnchor | null>(
    null
  );
  const [revealedAnchor, setRevealedAnchor] = useState<TraceTextAnchor | null>(
    null
  );
  // A selection is spent once a thread is posted on it or another thread is
  // revealed, as the legacy trace's draft was; a stale one would otherwise mask
  // every later reveal's highlight and keep anchoring the composer.
  const revealAnchor = useCallback((anchor: TraceTextAnchor | null) => {
    setTraceSelection(null);
    setRevealedAnchor(anchor);
  }, []);
  const clearTraceSelection = useCallback(() => setTraceSelection(null), []);
  const traceCommentsHost = useMemo<SessionTraceCommentsHost>(
    () => ({
      highlightAnchor: traceSelection ?? revealedAnchor,
      jumpToRowRef: traceJump,
      onTraceSelectionChange: setTraceSelection,
    }),
    [revealedAnchor, traceSelection]
  );
  // The Sessions panel and the pane stay mounted and `?comment=` survives tab
  // changes, so clear the address while away or re-entering the same link
  // would never reveal the thread again (whitlockk review, PR #8562).
  const addressedThreadId =
    route.activeTab === ArtifactDetailTab.Sessions
      ? props.selectedThreadId
      : null;

  return (
    <ArtifactDetailShell
      activeTab={route.activeTab}
      comments={
        <SessionCommentsPane
          addressedThreadId={addressedThreadId}
          onRevealedAnchorChange={revealAnchor}
          onTraceSelectionUsed={clearTraceSelection}
          selectTabThenReveal={route.selectTabThenReveal}
          sessionId={session.id}
          traceJump={traceJump}
          traceSelection={traceSelection}
          visible={route.activeTab === ArtifactDetailTab.Sessions}
        />
      }
      headerEnd={<SessionShellCollaborators sessionId={session.id} />}
      keepMountedTabs={[ArtifactDetailTab.Sessions]}
      onActivePanelReady={route.onActivePanelReady}
      onActiveTabChange={route.setActiveTab}
      panels={{
        // The session itself is this type's Sessions body (ISS-12167), on the
        // canvas card every tab shares (ISS-12412). It fills the card because
        // it keeps its own scroller and pinned timeline.
        [ArtifactDetailTab.Sessions]: (
          <ArtifactCanvasPanel fill label="Session">
            <AgentSessionDetailView
              {...props}
              // ISS-12269: no Properties card here — the Details tab beside
              // this one states the same values, and two copies on one artifact
              // is the duplication this shell exists to remove. The legacy page
              // keeps its card, having no Details tab to state them on.
              rendersPropertiesCard={false}
              selectedThreadId={addressedThreadId}
              tabParamName="view"
              traceCommentsHost={traceCommentsHost}
            />
          </ArtifactCanvasPanel>
        ),
        [ArtifactDetailTab.Details]: (
          // The card is the scroll container: desktop clips overflow in both
          // the route viewport and `SessionDetailView`, so without one this
          // panel cut off the lower fields and the linked artifacts (whitlockk
          // review, PR #8461).
          <ArtifactCanvasPanel label="Session details">
            <SessionShellDetails
              artifactHrefPending={props.artifactHrefPending}
              buildArtifactHref={props.buildArtifactHref}
              displayedStatus={displayedStatus}
              getBranchHref={props.getBranchHref}
              session={session}
              // ISS-12269: the Sync row moved here off the Properties card, so
              // this tab now needs the shell's own never-expected answer —
              // resolved exactly as the Sessions panel resolves it, so the row
              // and the transcript below it cannot state opposite things.
              transcriptNeverExpected={resolveTranscriptNeverExpected(
                session,
                props.transcriptNeverExpected
              )}
            />
          </ArtifactCanvasPanel>
        ),
        [ArtifactDetailTab.Activity]: (
          // The comments rail sits in the Sessions tab's body, so that is where
          // a comment row's link points (ISS-11004).
          <ArtifactCanvasPanel label="Session activity">
            <SessionShellActivity
              buildCommentHref={buildCommentHref}
              sessionId={session.id}
            />
          </ArtifactCanvasPanel>
        ),
      }}
      tabLabels={SESSION_ARTIFACT_TAB_LABELS}
      tabs={SESSION_ARTIFACT_TABS}
    />
  );
}
