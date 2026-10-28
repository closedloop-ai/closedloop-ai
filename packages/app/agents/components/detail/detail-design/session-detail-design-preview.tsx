// gardener-support: test and story data, not shipped
"use client";

import { resolveSessionDetailDisplayStatus } from "@repo/app/agents/lib/session-detail-display-status";
import { resolveTimelineSourceExtent } from "@repo/app/agents/lib/session-timeline-projection";
import { resolveTimelineOwnerLabel } from "@repo/app/agents/lib/session-timeline-stacks";
import {
  ACTIVITY_FIXTURE_NOW,
  newestFirst,
} from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import { SESSION_EXAMPLE_ROWS } from "@repo/app/documents/components/artifact-activity/activity-example-timelines.fixtures";
// Feature slice -> documents slice: the Activity tab renders the shared
// Activity timeline (ISS-10843) with the Session feed's example rows.
import { ActivityTimeline } from "@repo/app/documents/components/artifact-activity/activity-timeline";
import {
  DETAILS_DESIGN_HOST,
  DetailsPriorityEditorHost,
} from "@repo/app/documents/components/details-design/details-design-preview-host";
import { ActivityArtifactKind } from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import { ArtifactCanvasPanel } from "@repo/app/shared/components/artifact-detail-shell/artifact-canvas-panel";
import { ArtifactDetailShell } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import {
  ACTIVITY_TIMELINE_TITLE,
  ArtifactPlainPanel,
  ArtifactTabSection,
} from "@repo/app/shared/components/artifact-detail-shell/artifact-plain-panel";
import {
  Collaborators,
  collaboratorsFromNames,
} from "@repo/app/shared/components/collaborators";
import { useCommentsPaneDrafts } from "@repo/app/shared/components/comments/use-comments-pane-drafts";
// Feature slice -> shared: the shared preview's comments rail and Details
// sections are the generic-artifact surfaces this harness places on a Session.
import {
  ArtifactCommentsRail,
  type GenericCommentRecord,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-rail";
import { ArtifactCommentsToggle } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-toggle";
import { sessionDetailsTabConfig } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-fixtures";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDesignCommentsRail } from "@repo/app/shared/hooks/use-design-comments-rail";
import { useIsMounted } from "@repo/app/shared/hooks/use-is-mounted";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import {
  SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
  SESSION_TRACE_EVIDENCE_DISCLOSURE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { formatDuration } from "@repo/app/shared/lib/format-utils";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import {
  CheckIcon,
  CopyIcon,
  LinkIcon,
  MoreHorizontalIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { useSessionTimelineWindow } from "../../../hooks/use-session-timeline-window";
import { SessionStatusBadge } from "../../session-status-badges";
import { buildActivityBuckets } from "../activity-bucket-synthesis";
import {
  buildActivityMarkers,
  buildLimitDotEvents,
} from "../session-activity-markers";
import { SessionActivityTimeline } from "../session-activity-timeline";
import { SESSION_ARTIFACT_TAB_LABELS } from "../session-artifact-routing";
import { getSessionSpan } from "../session-timeline-axis";
import {
  hasSynthesizedBucketCosts,
  resolveTimelineCostDisclosure,
} from "../session-timeline-bar-labels";
import { SessionTrace } from "../session-trace";
import type { SessionTraceHandle } from "../session-trace-contract";
import { useSessionTraceGutterActor } from "../session-trace-gutter-actor";
import { getTraceCountLabel } from "../session-trace-header";
import {
  SESSION_DESIGN_ARTIFACT,
  SESSION_DESIGN_COMMENTS,
  SESSION_DESIGN_DETAILS_INPUT,
  SESSION_DESIGN_SESSION,
} from "./session-detail-design-fixtures";

/**
 * ISS-10964 design-review harness: the Session detail page in the ISS-10790
 * shell. Nothing in production imports it. It stays as staged design work that
 * Storybook renders (Surfaces/Artifacts/Sessions/Session Detail):
 * ISS-12171 copies its pattern to the remaining artifact types, and ISS-12412
 * builds its Details tab into the production page.
 *
 * - Artifact is today's whole Session detail (Properties, Session Timeline,
 *   trace), in production order and one scroll container, so a timeline jump
 *   still lands on the trace beside it. Same rule as Branch's ISS-10963.
 * - The tabs read Session / Details / Activity (ISS-12167, operator
 *   2026-10-07): a Session hides the generic Artifact tab and keeps the
 *   Sessions one, singular, whose body is this canvas. Activity is the third
 *   tab (Nerys,
 *   2026-10-06, replacing the 2026-09-28 ruling that hid it): the shared
 *   Activity timeline with example rows shaped like
 *   `GET /agent-sessions/[id]/activity`, newest first.
 * - The trace is the real `SessionTrace` over the fixture's own rows; the
 *   transcript fetch states belong to `SessionTranscriptPanel`, which needs a
 *   live query.
 * - Page chrome as the web-master generic artifact prototype lays it out: a
 *   page header row (the host's breadcrumbs, with the copy overflow and status
 *   after them and the comments toggle at its end), then the tab row with
 *   Refresh and the collaborators. Refresh shows on every tab; the comments
 *   toggle shows where the rail does.
 */

const SESSION_DESIGN_TABS = [
  ArtifactDetailTab.Sessions,
  ArtifactDetailTab.Details,
  ArtifactDetailTab.Activity,
] as const;
export type SessionDesignTab = (typeof SESSION_DESIGN_TABS)[number];

const SESSION_DESIGN_ACTIVITY_ROWS = newestFirst(SESSION_EXAMPLE_ROWS);

const session = SESSION_DESIGN_SESSION;

/** What the page header row holds; the host lays it out as its own header. */
export type SessionDetailPageHeaderParts = {
  title: string;
  overflowMenu: ReactNode;
  status: ReactNode;
  /** Null on a tab with no comments rail. */
  commentsToggle: ReactNode;
};

export function SessionDetailDesignPreview({
  initialTab = ArtifactDetailTab.Sessions,
  pageHeader = SessionDetailFallbackPageHeader,
}: Readonly<{
  /** The tab the page opens on, so a story can open it on any tab. */
  initialTab?: SessionDesignTab;
  /** Renders the page header row; the app's route header in a full page. */
  pageHeader?: (parts: SessionDetailPageHeaderParts) => ReactNode;
}>) {
  const [activeTab, setActiveTab] = useState<SessionDesignTab>(initialTab);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  // Refresh re-reads the fixture: the Artifact body remounts from it.
  const [loadCount, setLoadCount] = useState(0);
  const [commentsWidth, setCommentsWidth] = useState(352);
  // ISS-11209: the rail's drafts live above it, as in the generic artifact shell.
  const commentDrafts = useCommentsPaneDrafts(SESSION_DESIGN_ARTIFACT.id);
  const traceRef = useRef<SessionTraceHandle>(null);
  const [comments, setComments] = useState<GenericCommentRecord[]>(() => [
    ...SESSION_DESIGN_COMMENTS,
  ]);
  const [sessionComments, setSessionComments] = useState<
    GenericCommentRecord[]
  >([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const rail = useDesignCommentsRail(rootRef);
  const jumpTo = (row: number | null) => {
    setActiveRow(row);
    if (row !== null) {
      traceRef.current?.scrollToRow(row);
    }
  };
  const displayedStatus = sessionDesignDisplayedStatus();
  const onCanvas = activeTab === ArtifactDetailTab.Sessions;
  const railShown = onCanvas && rail.available;

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background" ref={rootRef}>
        {pageHeader({
          commentsToggle: railShown ? (
            <ArtifactCommentsToggle
              onToggle={() => rail.setOpen((open) => !open)}
              open={rail.open}
            />
          ) : null,
          overflowMenu: <SessionOverflowMenu />,
          status: <SessionDetailStatus displayedStatus={displayedStatus} />,
          title: session.name ?? "",
        })}
        <ArtifactDetailShell
          activeTab={activeTab}
          comments={
            railShown ? (
              <ArtifactCommentsRail
                activeTab={activeTab}
                {...commentDrafts}
                artifact={SESSION_DESIGN_ARTIFACT}
                availableWidth={rail.availableWidth}
                generalComments={comments}
                onOpenChange={rail.setOpen}
                onSelectArtifactComment={(comment) =>
                  jumpTo(comment.traceRow ?? null)
                }
                // ISS-12167 made this canvas the Sessions tab, but a session's
                // own trace comments are the artifact's, so the rail keeps its
                // artifact variant and never shows the per-session list.
                onSelectSessionComment={() => undefined}
                onWidthChange={setCommentsWidth}
                open={rail.open}
                sessionComments={sessionComments}
                setGeneralComments={setComments}
                setSessionComments={setSessionComments}
                showsSessionComments={false}
                width={commentsWidth}
              />
            ) : null
          }
          headerActions={
            <Button
              onClick={() => {
                setActiveRow(null);
                setLoadCount((count) => count + 1);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCcwIcon className="size-3.5" />
              Refresh
            </Button>
          }
          headerActionsTabs={SESSION_DESIGN_TABS}
          headerEnd={
            <Collaborators
              people={collaboratorsFromNames(
                SESSION_DESIGN_ARTIFACT.collaborators
              )}
            />
          }
          onActiveTabChange={setActiveTab}
          panels={{
            sessions: (
              <SessionArtifactPanel
                activeRow={activeRow}
                key={loadCount}
                onJump={jumpTo}
                traceRef={traceRef}
              />
            ),
            details: <SessionDetailsPanel />,
            activity: <SessionActivityPanel />,
          }}
          tabLabels={SESSION_ARTIFACT_TAB_LABELS}
          tabs={SESSION_DESIGN_TABS}
        />
      </div>
    </TooltipProvider>
  );
}

/**
 * Today's overflow beside the session title, with the shipped
 * `session-detail-header-controls.tsx` labels and copy behaviour. The URL is
 * this harness's own page, as production copies `location.href`.
 */
export function SessionOverflowMenu() {
  const [copiedId, copySessionId] = useCopyToClipboard();
  const [copiedUrl, copySessionUrl] = useCopyToClipboard();
  const IdIcon = copiedId ? CheckIcon : CopyIcon;
  const UrlIcon = copiedUrl ? CheckIcon : LinkIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="More session actions"
          size="icon-sm"
          variant="ghost"
        >
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            copySessionId(session.id).catch(() => undefined);
          }}
        >
          <IdIcon aria-hidden="true" className="size-3.5" />
          {copiedId ? "Copied session ID" : "Copy session ID"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            copySessionUrl(globalThis.location.href).catch(() => undefined);
          }}
        >
          <UrlIcon aria-hidden="true" className="size-3.5" />
          {copiedUrl ? "Copied session URL" : "Copy session URL"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * @reuses ArtifactCanvasPanel, SessionActivityTimeline, SessionTrace
 *
 * ISS-12403 (Oct 9 sync): the session's content sits on the Artifact tab's
 * framed canvas, and the tab carries no Properties section: a session's
 * properties are its Details tab.
 */
export function SessionArtifactPanel({
  activeRow,
  onJump,
  traceRef,
}: {
  activeRow: number | null;
  onJump: (row: number | null) => void;
  traceRef: RefObject<SessionTraceHandle | null>;
}) {
  const axis = useSessionTimelineWindow(session);
  const scrollRef = useRef<HTMLElement>(null);
  // Client-only, as in production where the trace paints after its query:
  // the shared event row nests a button in a button, which server HTML
  // cannot carry, so a server-rendered trace fails hydration.
  const mounted = useIsMounted();
  // Read at the leaf, as session-detail-workspace.tsx does; no provider here
  // reads as off.
  const synthesizedCostDisclosureEnabled = useFeatureFlagEnabledOptional(
    SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY
  );
  const evidenceDisclosureEnabled = useFeatureFlagEnabledOptional(
    SESSION_TRACE_EVIDENCE_DISCLOSURE_FEATURE_FLAG_KEY
  );
  const traceHeadingId = useId();
  // The session's creator in the primary avatar seat, as the live transcript
  // panel resolves it (`useTranscriptTraceItems`).
  const renderGutterActor = useSessionTraceGutterActor(
    (session.createdBy === undefined ? session.user : session.createdBy) ?? null
  );
  const markers = buildActivityMarkers(session, axis.window);
  const limitDotEvents = buildLimitDotEvents(session, axis.window);
  const bucketStrip = buildActivityBuckets(session, markers, axis.window);
  const disclosureInput = {
    costsSynthesized: hasSynthesizedBucketCosts(session),
    synthesized: bucketStrip.synthesized,
  };
  // The flag picks the whole disclosure here rather than being threaded on.
  const timelineDisclosure = synthesizedCostDisclosureEnabled
    ? resolveTimelineCostDisclosure({
        ...disclosureInput,
        disclosureEnabled: true,
      })
    : resolveTimelineCostDisclosure({
        ...disclosureInput,
        disclosureEnabled: false,
      });
  const sourceExtent = bucketStrip.synthesized
    ? null
    : resolveTimelineSourceExtent(session.span);
  const sourceWindow = axis.window
    ? { endMs: axis.window.endMs, startMs: axis.window.startMs }
    : null;

  return (
    <ArtifactCanvasPanel label="Session" scrollRef={scrollRef}>
      <SessionActivityTimeline
        activeRow={activeRow}
        activeRowMs={null}
        axisDurationLabel={formatDuration(axis.start, axis.end)}
        barCostsUnpublished={timelineDisclosure.barCostsUnpublished}
        buckets={bucketStrip.buckets}
        costUnmeasured={timelineDisclosure.costUnmeasured}
        isRowInReadTranscript={() => true}
        limitDotEvents={limitDotEvents}
        markers={markers}
        onJump={onJump}
        ownerLabel={resolveTimelineOwnerLabel(session)}
        sourceExtent={sourceExtent}
        sourceWindow={sourceWindow}
        span={getSessionSpan(axis)}
        summarySession={session}
      />
      {/* The live trace region (`session-detail-workspace.tsx`): its own
          heading with the event count, then the rows with each turn's actor
          avatar in the gutter (ISS-12666). */}
      <section aria-labelledby={traceHeadingId} className="mt-6">
        <div className="mt-6 mb-2 flex items-center gap-2.5">
          <h2
            className="font-semibold text-muted-foreground text-sm"
            id={traceHeadingId}
          >
            Session Trace
          </h2>
          <span className="text-muted-foreground text-xs">
            {getTraceCountLabel(session, {
              discloseEvidence: evidenceDisclosureEnabled === true,
            })}
          </span>
        </div>
        {mounted ? (
          <SessionTrace
            activeRow={activeRow}
            items={session.turnItems ?? []}
            onJump={onJump}
            ref={traceRef}
            renderGutterActor={renderGutterActor}
            // The trace scrolls this bounded container, as
            // `session-transcript-panel.tsx` does; without it a jump is
            // a no-op.
            scrollElementRef={scrollRef}
          />
        ) : null}
      </section>
    </ArtifactCanvasPanel>
  );
}

/** The status the page shows for this session, displayed as Sessions do. */
export function SessionDetailStatus({
  displayedStatus,
}: {
  displayedStatus: ReturnType<typeof resolveSessionDetailDisplayStatus>;
}) {
  return (
    <SessionStatusBadge artifactId={session.id} status={displayedStatus} />
  );
}

/**
 * The Details tab (ISS-12252, ISS-12403): Artifact details, Session details,
 * Custom fields and Associated artifacts, for the session the header names.
 */
export function SessionDetailsPanel() {
  return (
    <ArtifactPlainPanel label="Session details">
      <DetailsTabSections
        config={sessionDetailsTabConfig(
          DETAILS_DESIGN_HOST,
          SESSION_DESIGN_DETAILS_INPUT
        )}
        priorityEditor={DetailsPriorityEditorHost}
      />
    </ArtifactPlainPanel>
  );
}

/** The Activity tab: the shared Activity timeline with the Session feed. */
export function SessionActivityPanel() {
  return (
    <ArtifactPlainPanel label="Session activity">
      <ArtifactTabSection title={ACTIVITY_TIMELINE_TITLE}>
        <ActivityTimeline
          artifactKind={ActivityArtifactKind.Session}
          now={ACTIVITY_FIXTURE_NOW}
          rows={SESSION_DESIGN_ACTIVITY_ROWS}
        />
      </ArtifactTabSection>
    </ArtifactPlainPanel>
  );
}

/** The page's displayed status for this fixture session. */
export function sessionDesignDisplayedStatus() {
  return resolveSessionDetailDisplayStatus({
    awaitingInputSince: session.awaitingInputSince,
    endedAt: session.endedAt,
    lastActivityAt: session.lastActivityAt,
    startedAt: session.startedAt,
    status: session.status,
  });
}

/** The header row when no host supplies one: the title, then its parts. */
function SessionDetailFallbackPageHeader({
  commentsToggle,
  overflowMenu,
  status,
  title,
}: SessionDetailPageHeaderParts) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
      <h1 className="font-medium text-sm">{title}</h1>
      {overflowMenu}
      {status}
      {commentsToggle ? <div className="ml-auto">{commentsToggle}</div> : null}
    </div>
  );
}
