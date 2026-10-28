"use client";

import type { AgentComponentInvocationAnchor } from "@repo/api/src/types/agent-component-invocation";
import type {
  AgentSessionDetail,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import { SharedAnalyticsComponent } from "@repo/api/src/types/surface-analytics";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { booleanOrFallback } from "@repo/app/shared/lib/local-storage-validators";
import { useSharedComponentRenderedEvent } from "@repo/app/shared/observability/surface-analytics-context";
import { type ReactNode, useState } from "react";
import {
  resolveSessionDetailAbsence,
  SessionDetailAbsence,
} from "./agent-session-detail-absence";
import {
  type SessionDetailErrorKind,
  SessionDetailLoading,
  SessionDetailNotFound,
  SessionDetailProviderError,
} from "./agent-session-detail-states";
import {
  COMMENTS_RAIL_COLLAPSED_KEY,
  DEFAULT_COMMENTS_RAIL_WIDTH,
  SessionDetailWorkspace,
} from "./session-detail-workspace";
import type { SessionTraceCommentsHost } from "./session-trace-comments-host";
import { resolveTranscriptNeverExpected } from "./transcript-never-expected-from-sync-level";

/** Shared web and desktop session detail body for transcript-first review. */
export type AgentSessionDetailViewProps = {
  /** A nested host can reserve `tab` for its own sections. */
  tabParamName?: string;
  /**
   * ISS-12269: forwarded verbatim to {@link SessionDetailWorkspace}, which owns
   * the contract. Only `AgentSessionShellView` passes `false`.
   */
  rendersPropertiesCard?: boolean;
  session?: AgentSessionDetail;
  isLoading: boolean;
  /**
   * FEA-3984: whether the detail read settled to an error. Lets the view tell a
   * genuine not-found (404) apart from a transient provider failure (gateway
   * down, db-host worker died) instead of reporting every settled-empty read as
   * "Session not found". Mirrors the sibling BranchDetailPage contract.
   */
  isError?: boolean;
  /** Classified read failure; only consulted when `isError` and no `session`. */
  errorKind?: SessionDetailErrorKind;
  backHref: string;
  /** Caller-controlled comments rail visibility for surfaces without durable comments. */
  commentsRailOpen?: boolean;
  /** ISS-11004: re-open a rail the header toggle hid when a `?comment=` link is followed. */
  onRevealCommentsRail?: () => void;
  /**
   * ISS-11004: the comment a `?comment=` link addressed, read by the route
   * shell that owns the URL and forwarded here like the transcript deep links.
   */
  selectedThreadId?: string | null;
  /**
   * FEA-2717 Task 5: which transcript file the conversation region renders —
   * `main` (default) or a `subagent:{id}` sidechain from the `?file=` deep link.
   */
  transcriptFileKey?: string;
  /**
   * Builds a deep link to a given transcript file on this session, enabling the
   * file switcher. Supplied by the route shell (it owns URL construction);
   * omitted on surfaces without routing.
   */
  buildTranscriptFileHref?: (fileKey: string) => string;
  /** Validated invocation anchor from the current route query. */
  invocationAnchor?: AgentComponentInvocationAnchor | null;
  /**
   * FEA-3635: builds an org-scoped href to a Closedloop artifact (FEAT/PRD/…)
   * the transcript referenced or created, so the "Linked artifacts" pills can
   * navigate to it. Supplied by the route shell (it owns URL + org-slug
   * construction); omitted on surfaces without artifact routing (e.g. the
   * desktop renderer), where the pills render as non-clickable labels. Returning
   * null for a given artifact (e.g. no slug, or a non-navigable type) also falls
   * back to the non-clickable label.
   */
  buildArtifactHref?: (artifact: SessionLinkedArtifact) => string | null;
  /**
   * ISS-5366: true while the shell still cannot say whether artifact links are
   * reachable, so the pills must not yet assert either answer. See
   * `session-properties-panel.tsx`, which owns the linked-artifact pills.
   */
  artifactHrefPending?: boolean;
  /**
   * FEA-4256: builds an org-scoped href to the session's own branch detail page
   * (`/{org}/branches/{branchArtifactId}`) from the session's resolved
   * `branchArtifactId`, so the Properties panel's Repository / Branch values and
   * the PR pill link to your own branch page instead of opening GitHub in a new
   * tab. Supplied by the route shell (it owns URL + org-slug construction);
   * omitted on surfaces without branch routing (e.g. the desktop-local session,
   * which has no cloud branch-artifact id), where those values render as plain,
   * non-clickable text. A session with no resolved `branchArtifactId` likewise
   * degrades to non-links, never a dead route.
   */
  getBranchHref?: (branchArtifactId: string) => string;
  /**
   * ISS-7516: the SHELL's own answer, from evidence only that shell holds — the
   * desktop's device consent record, scoped to sessions recorded on that
   * machine. `apps/app` has no such evidence and passes nothing.
   *
   * NOT forwarded verbatim any more: it is the FALLBACK arm of
   * `resolveTranscriptNeverExpected`, which prefers the recording machine's
   * level off the session payload when the server reports one. That function's
   * doc owns the precedence and why it runs this way round;
   * `SessionTranscriptPanel`'s prop doc owns what the resulting value means.
   */
  transcriptNeverExpected?: boolean;
  /**
   * PLN-2162 M6: set by the Session shell, whose comments pane hosts this
   * Session's comments. The legacy rail then neither renders nor reads.
   */
  traceCommentsHost?: SessionTraceCommentsHost;
  /**
   * ISS-12539: actions at the end of the session's title row, for the data
   * controls deletion entry point (`DeletionEntryPoint`). This view is what
   * both the web route and the desktop renderer draw, inside either shell, so
   * one slot places it on session detail everywhere. Omitted by every host
   * today, which therefore renders exactly as before.
   */
  titleActions?: ReactNode;
};

/**
 * Replaces the legacy card dashboard with the shared Session Trace workspace.
 * Route shells own breadcrumbs and feature availability; this component owns
 * the portable trace, properties, timeline, and comments surfaces.
 */
export function AgentSessionDetailView({
  tabParamName,
  session,
  isLoading,
  isError = false,
  errorKind,
  backHref,
  commentsRailOpen = true,
  onRevealCommentsRail,
  selectedThreadId,
  transcriptFileKey,
  buildTranscriptFileHref,
  rendersPropertiesCard,
  buildArtifactHref,
  artifactHrefPending,
  getBranchHref,
  invocationAnchor,
  transcriptNeverExpected,
  traceCommentsHost,
  titleActions,
}: AgentSessionDetailViewProps) {
  useSharedComponentRenderedEvent(
    SharedAnalyticsComponent.AgentSessionDetailView
  );
  const [commentsWidth, setCommentsWidth] = useState(
    DEFAULT_COMMENTS_RAIL_WIDTH
  );
  // Persist the collapse preference alongside the app's other UI prefs so it is
  // remembered across navigation and app restart (FEA-2479).
  const [commentsCollapsed, setCommentsCollapsed] = useLocalStorageState(
    COMMENTS_RAIL_COLLAPSED_KEY,
    false,
    booleanOrFallback
  );

  // ISS-7249 (review cid 3821325581): the "no session to show" precedence is
  // resolved by `resolveSessionDetailAbsence`, not re-encoded here, so the
  // desktop dead-end classifier reads the SAME decision instead of mirroring
  // this branch order by hand. The has-a-session gate stays inline because it is
  // what narrows `session` for the workspace below.
  //
  // The skeleton is still for the genuine first load only (a pending read with
  // no row yet), matching the sibling BranchDetailPage contract; a background
  // detail-poll refetch leaves `isLoading` false, so a loaded trace never
  // flashes back to the skeleton.
  if (!session) {
    const absence = resolveSessionDetailAbsence({
      errorKind,
      isError,
      isLoading,
    });
    if (absence === SessionDetailAbsence.Loading) {
      return <SessionDetailLoading />;
    }
    // FEA-3984: split a genuine not-found from a transient provider failure
    // (gateway down / db-host worker died) so we never tell the user a session
    // they still have doesn't exist.
    if (absence === SessionDetailAbsence.ProviderError) {
      return <SessionDetailProviderError backHref={backHref} />;
    }
    // `ErroredAbsent` and `UnresolvedAbsent` draw the same card: an established
    // 404 and a settled-but-unanswered read look identical to the user. They are
    // NOT the same fact, which is why the shared vocabulary keeps them apart for
    // the classifier even though this render folds them.
    return <SessionDetailNotFound backHref={backHref} />;
  }

  return (
    <SessionDetailWorkspace
      artifactHrefPending={artifactHrefPending}
      buildArtifactHref={buildArtifactHref}
      buildTranscriptFileHref={buildTranscriptFileHref}
      commentsCollapsed={commentsCollapsed}
      commentsRailOpen={commentsRailOpen}
      commentsWidth={commentsWidth}
      getBranchHref={getBranchHref}
      invocationAnchor={invocationAnchor}
      key={session.id}
      onCommentsCollapsedChange={setCommentsCollapsed}
      onCommentsWidthChange={setCommentsWidth}
      onRevealCommentsRail={onRevealCommentsRail}
      rendersPropertiesCard={rendersPropertiesCard}
      selectedThreadId={selectedThreadId}
      session={session}
      tabParamName={tabParamName}
      titleActions={titleActions}
      traceCommentsHost={traceCommentsHost}
      transcriptFileKey={transcriptFileKey}
      transcriptNeverExpected={resolveTranscriptNeverExpected(
        session,
        transcriptNeverExpected
      )}
    />
  );
}
