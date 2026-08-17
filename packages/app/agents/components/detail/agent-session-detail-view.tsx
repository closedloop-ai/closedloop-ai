"use client";

import type { AgentComponentInvocationAnchor } from "@repo/api/src/types/agent-component-invocation";
import type {
  ActivityBucket,
  AgentSessionDetail,
  SessionLinkedArtifact,
  SessionMarker,
  SessionSpan,
  SessionThrottle,
  SyncedActivitySegmentRow,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { clamp, clampPercent } from "@repo/api/src/utils/math";
import {
  getBucketCost,
  getBucketJumpBlock,
  getUnreadFromIndex,
  TIMELINE_SYNTHESIZED_COST_LEGEND,
} from "@repo/app/agents/components/detail/activity-bucket-rendering";
import { buildActivityBuckets } from "@repo/app/agents/components/detail/activity-bucket-synthesis";
import {
  type DotColor,
  getEventMarkerKind,
  getMarkerDotColor,
} from "@repo/app/agents/components/detail/activity-dot-rendering";
import { SessionPropertiesPanel } from "@repo/app/agents/components/detail/session-properties-panel";
import {
  buildBucketAccessibleCosts,
  buildBucketBarLabels,
  getPeakBucketIndex,
  hasSynthesizedBucketCosts,
  resolveTimelineCostDisclosure,
  SessionTimelineBarLabels,
} from "@repo/app/agents/components/detail/session-timeline-bar-labels";
import { SessionTimelineBars } from "@repo/app/agents/components/detail/session-timeline-bars";
import {
  SessionTimelineControls,
  SessionTimelineScrubber,
} from "@repo/app/agents/components/detail/session-timeline-controls";
import { SessionTimelineDotRail } from "@repo/app/agents/components/detail/session-timeline-dot-rail";
import {
  SessionTimelineHeading,
  SessionTimelineRegion,
} from "@repo/app/agents/components/detail/session-timeline-header";
import type { SessionTimelineSummarySession } from "@repo/app/agents/components/detail/session-timeline-summary";
import { SessionStatusBadge } from "@repo/app/agents/components/session-status-badges";
import { useSessionTimelineScale } from "@repo/app/agents/hooks/use-session-timeline-scale";
import { useSessionTimelineWindow } from "@repo/app/agents/hooks/use-session-timeline-window";
import {
  isSessionDetailStatusClockRelevant,
  resolveSessionDetailDisplayStatus,
} from "@repo/app/agents/lib/session-detail-display-status";
import { SESSION_DURATION_TICK_MS } from "@repo/app/agents/lib/session-duration";
import { formatMarkerTime } from "@repo/app/agents/lib/session-marker-time";
import {
  getDateMs,
  getLimitDotPercent,
  getTurnItemMs,
  getWindowPercent,
  hasTimedTraceRow,
  hasTraceRow,
  type SessionTimelineWindow,
} from "@repo/app/agents/lib/session-timeline-geometry";
import { UNKNOWN_OWNER_LABEL } from "@repo/app/agents/lib/session-timeline-stacks";
import {
  TRACE_ROW_SELECTOR,
  type TraceScrollOutcome,
} from "@repo/app/agents/lib/trace-scroll-target";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useCoarseNow } from "@repo/app/shared/hooks/use-coarse-now";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { computeActiveTraceRow } from "@repo/app/shared/lib/active-trace-row";
import {
  SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY,
  SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { formatDuration } from "@repo/app/shared/lib/format-utils";
import {
  TRACE_EVENTS_TRUNCATED_CAPTION,
  TRACE_EVENTS_TRUNCATED_NOTE,
  TRACE_TOO_MANY_EVENTS_TO_PLOT,
  TRACE_UNREAD_TAIL_LEGEND,
} from "@repo/app/shared/lib/trace-truncation-copy";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { isSessionTerminatingLabel } from "@repo/lib/session-trace/derivation";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY as PHASES_FLAG } from "../../../shared/lib/feature-flags";
import {
  IDENTITY_TRACE_ROW_TRANSLATORS,
  type TraceRowTranslators,
} from "../../lib/timeline-row-space";
import {
  SessionDetailErrorKind,
  SessionDetailLoading,
  SessionDetailNotFound,
  SessionDetailProviderError,
} from "./agent-session-detail-states";
import { SessionActivityPhaseRegions } from "./session-activity-phase-regions";
import { renderCommentsRail } from "./session-comments-rail";
import {
  formatThrottleDuration,
  formatThrottleSourceLimitLabel,
  getSessionEventLimitLabel,
  getTurnEventLimitLabel,
  getTurnItemTimestamp,
} from "./session-limit-label-format";
import {
  type ActivityMarker,
  getSessionSpan,
  SessionTimelineAxis,
} from "./session-timeline-axis";
import {
  EMPTY_SEGMENT_ROWS,
  type HoverBucket,
  type HoverDot,
  SessionTimelineHoverCards,
  type TimelineDotEvent,
  withStackBreakdown,
} from "./session-timeline-strip-parts";
import { SessionTranscriptPanel } from "./session-transcript-panel";
import { useCommentsRailState } from "./use-comments-rail-state";
import { useTraceJump } from "./use-trace-jump";

/** Shared web and desktop session detail body for transcript-first review. */
export type AgentSessionDetailViewProps = {
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
   * {@link SessionPropertiesPanel}, which owns the linked-artifact pills.
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
};

/**
 * Replaces the legacy card dashboard with the shared Session Trace workspace.
 * Route shells own breadcrumbs and feature availability; this component owns
 * the portable trace, properties, timeline, and comments surfaces.
 */
export function AgentSessionDetailView({
  session,
  isLoading,
  isError = false,
  errorKind,
  backHref,
  commentsRailOpen = true,
  transcriptFileKey,
  buildTranscriptFileHref,
  buildArtifactHref,
  artifactHrefPending,
  getBranchHref,
  invocationAnchor,
}: AgentSessionDetailViewProps) {
  const [commentsWidth, setCommentsWidth] = useState(
    DEFAULT_COMMENTS_RAIL_WIDTH
  );
  // Persist the collapse preference alongside the app's other UI prefs so it is
  // remembered across navigation and app restart (FEA-2479).
  const [commentsCollapsed, setCommentsCollapsed] = useLocalStorageState(
    COMMENTS_RAIL_COLLAPSED_KEY,
    false
  );

  // The skeleton is for the genuine first load only: a still-pending read with
  // no row yet. A settled read falls through, so the not-found / provider-error
  // states below can resolve it. Mirrors the sibling BranchDetailPage contract
  // (`isLoading && !detail`); a background detail-poll refetch leaves `isLoading`
  // false, so a loaded trace never flashes back to the skeleton.
  if (isLoading && !session) {
    return <SessionDetailLoading />;
  }

  // A settled read that errored with no row: split a genuine not-found (404)
  // from a transient provider failure (gateway down / db-host worker died) so we
  // never tell the user a session they still have doesn't exist (FEA-3984).
  if (isError && !session) {
    return errorKind === SessionDetailErrorKind.ProviderError ? (
      <SessionDetailProviderError backHref={backHref} />
    ) : (
      <SessionDetailNotFound backHref={backHref} />
    );
  }

  if (!session) {
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
      session={session}
      transcriptFileKey={transcriptFileKey}
    />
  );
}

function SessionDetailWorkspace({
  buildTranscriptFileHref,
  buildArtifactHref,
  artifactHrefPending,
  getBranchHref,
  commentsCollapsed,
  commentsWidth,
  commentsRailOpen,
  onCommentsCollapsedChange,
  onCommentsWidthChange,
  session,
  transcriptFileKey,
  invocationAnchor,
}: Readonly<{
  buildTranscriptFileHref?: (fileKey: string) => string;
  buildArtifactHref?: (artifact: SessionLinkedArtifact) => string | null;
  /**
   * ISS-5366: true while the shell still cannot say whether artifact links are
   * reachable, so the pills must not yet assert either answer. See
   * {@link SessionPropertiesPanel}, which owns the linked-artifact pills.
   */
  artifactHrefPending?: boolean;
  getBranchHref?: (branchArtifactId: string) => string;
  commentsCollapsed: boolean;
  commentsWidth: number;
  commentsRailOpen: boolean;
  onCommentsCollapsedChange: (collapsed: boolean) => void;
  onCommentsWidthChange: (width: number) => void;
  session: AgentSessionDetail;
  transcriptFileKey?: string;
  invocationAnchor?: AgentComponentInvocationAnchor | null;
}>) {
  /*
   * The transcript row the reader is on. Owned HERE, below the `key={session.id}`
   * this component is mounted under, and that placement is the whole point
   * (#4753 review, wongk).
   *
   * It used to live in `AgentSessionDetailView`, ABOVE the key. The key remounts
   * this workspace on every session change, but state above it does not reset —
   * so navigating from a session the reader had scrolled deep into to a fresh one
   * carried the old row across. Before ISS-5819 that was invisible: the row only
   * drove the `.tl-here` marker, and a marker briefly in the wrong place is
   * corrected by the first scroll event. It is not invisible now — the row also
   * picks the timeline's COLUMN, and the window FOLLOWS that column, so a high
   * row from the previous session opened the next one already panned away from
   * its own start, showing an empty stretch of clock instead of the run.
   *
   * Owning it under the key is the fix that cannot rot: there is no session-id
   * comparison to keep in sync, because React resets it with everything else the
   * workspace holds.
   */
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const ignoreNextTraceScrollRef = useRef(false);
  /*
   * FEA-4252: the transcript panel owns the rendered items, so it publishes the
   * pair of translators between the Session Timeline's DB `session.turnItems`
   * `_row` space and the rendered trace's `_row` space:
   *  - `toRendered` maps a jump row forward before scrolling (or `null` when the
   *    clicked turn isn't in the rendered trace, so the parent skips the jump);
   *  - `toTrace` maps the active rendered row BACK so the "you are here" marker,
   *    which measures against bucket `tl0` keyed to `session.turnItems._row`,
   *    stays on the turn the reader is looking at instead of snapping to a
   *    divergent bar.
   * Both default to identity so desktop and aligned web sessions never regress.
   */
  const traceRowTranslatorsRef = useRef<TraceRowTranslators>(
    IDENTITY_TRACE_ROW_TRANSLATORS
  );
  /*
   * Reactive mirror of the published translators. The ref above stays the source
   * the JUMP reads (it is always the newest, even mid-render); this copy is what
   * the timeline PAINTS from, because the affordance has to follow resolvability
   * — `hasRenderedRows` to disable the strip while the trace is a skeleton, and
   * `toRendered` so a bar whose turn is absent from the rendered transcript
   * stops advertising a jump (ISS-5479 review).
   *
   * Safe against a render loop: the publishing effect in
   * `session-transcript-panel.tsx` is keyed on `renderedItems`/`sourceItems`
   * identity, and both are stable — `cloudItems` is a `useMemo` and
   * `fallbackItems` is `session.turnItems` passed straight through.
   */
  const [traceRowTranslators, setTraceRowTranslators] =
    useState<TraceRowTranslators>(IDENTITY_TRACE_ROW_TRANSLATORS);
  const traceHasRenderedRows = traceRowTranslators.hasRenderedRows;
  const registerTraceRowTranslator = useCallback(
    (translators: TraceRowTranslators) => {
      traceRowTranslatorsRef.current = translators;
      setTraceRowTranslators(translators);
    },
    []
  );
  const isTimelineRowInReadTranscript = useCallback(
    (row: number) => traceRowTranslators.toRendered(row) != null,
    [traceRowTranslators]
  );
  /*
   * ISS-4833 / ISS-4821: ONE window for the whole Session Timeline — the axis
   * labels AND the bucket/marker/dot geometry below them. It is the
   * plotted-activity window (both ends anchored to rows the screen actually
   * draws), so the axis total reconciles with the "Activity phases" span caption
   * beneath it, a sweeper-stamped `endedAt` cannot inflate either end
   * (FEA-3594), and an event dated after a stale `endedAt` lands at its true
   * fraction instead of clamping to the right edge.
   *
   * ISS-4821 review (wongk / codex): that same window is what PERSISTED geometry
   * is rebased onto. The stored `x`/`x0` fractions were computed over the
   * producer's window (which the detail DTO does not carry) and this axis has
   * moved out from under them, so they are recomputed from whatever absolute
   * instant survived into the payload.
   */
  const axis = useSessionTimelineWindow(session);
  const markers = useMemo(
    () => buildActivityMarkers(session, axis.window),
    [axis.window, session]
  );
  const limitDotEvents = useMemo(
    () => buildLimitDotEvents(session, axis.window),
    [axis.window, session]
  );
  // ISS-5566: `{ buckets, synthesized }`, not a bare array — the strip has to
  // know whether the collector measured these bars or this render invented them.
  const bucketStrip = useMemo(
    () => buildActivityBuckets(session, markers, axis.window),
    [axis.window, markers, session]
  );
  // ISS-5566, `…Optional` because this view also renders in Storybook and in
  // tests, which mount no flag provider.
  const synthesizedCostDisclosureEnabled = useFeatureFlagEnabledOptional(
    SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY
  );
  /*
   * ISS-5818 (D1): the DISPLAYED status for the title chip — an unrecognized
   * value folds to "Unknown", an `active` run silent past the staleness cutoff
   * folds to "Stale", and a run awaiting input reads "Waiting". Reusing the
   * list's chip without reusing a display derivation would put a pulsing green
   * "Active" on the detail page for the very rows the list honestly badges as
   * stale.
   *
   * #4739 review (wongk), both halves:
   *
   *  - the CLOCK. The staleness cutoff is measured against `now`, and a detail
   *    page is a surface that stays open for hours. Left to the resolver's own
   *    `new Date()` this is read once per render, and nothing re-renders this
   *    view when the only thing that changed is the time — so an open page could
   *    cross the 24-hour cutoff and keep pulsing "Active" until some unrelated
   *    state change happened to repaint it. The list surfaces already feed their
   *    mapper a coarse clock for exactly this reason; the detail now does too.
   *  - the WAITING projection, which `resolveDisplayedSessionStatus` cannot make
   *    on its own. See `session-detail-display-status.ts`: without it, turning
   *    on THIS layout flag alone badges an awaiting-input desktop-local session
   *    "Active" while the same session reads "Waiting" on web.
   *
   * The tick is skipped outright for a session whose chip can no longer move on
   * its own, so a page parked on a finished run does not re-render forever.
   */
  const titleStatusNow = useCoarseNow(
    SESSION_DURATION_TICK_MS,
    isSessionDetailStatusClockRelevant(session)
  );
  const titleDisplayedStatus = resolveSessionDetailDisplayStatus({
    awaitingInputSince: session.awaitingInputSince,
    endedAt: session.endedAt,
    lastActivityAt: session.lastActivityAt,
    now: titleStatusNow,
    startedAt: session.startedAt,
    status: session.status,
  });
  /*
   * ISS-5566 × ISS-5563: ONE decision, resolved in one documented place (see
   * `resolveTimelineCostDisclosure`), so the bar label rail, the in/out/cache
   * stack, the tooltip total, the tooltip's per-model table AND the legend
   * below the strip cannot disagree about whether this session HAS a per-bucket
   * cost. Flag off, or a measured strip, and every one of them behaves exactly
   * as before.
   *
   * Resolved HERE rather than inside `SessionActivityTimeline` because the
   * legend has to render outside the pinned header (FEA-4025) while the strip
   * renders inside it — one answer, two placements.
   */
  const timelineDisclosure = resolveTimelineCostDisclosure({
    costsSynthesized: hasSynthesizedBucketCosts(session),
    disclosureEnabled: synthesizedCostDisclosureEnabled,
    synthesized: bucketStrip.synthesized,
  });
  // ISS-5366: the ticks and the total below are formatted from ONE object, so
  // they cannot name different instants (see `getSessionSpan`).
  const span = getSessionSpan(axis);
  /*
   * ISS-4684: render the axis total in the SAME `Hh Mm` unit system as the
   * "Activity phases" caption directly below it (`phases span 93h 42m`), so a
   * reader can see the two totals reconcile instead of comparing "5622m" against
   * "93h 42m" and doing the unit math by eye.
   */
  const axisDurationLabel = formatDuration(axis.start, axis.end);
  const traceCountLabel = getTraceCountLabel(session);

  const cancelPendingTraceScroll = useCallback(() => {
    if (rafRef.current === null) {
      return;
    }
    globalThis.cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  useEffect(() => cancelPendingTraceScroll, [cancelPendingTraceScroll]);

  // ISS-5479: every transcript jump — resolve the row, scroll, and say what the
  // attempt actually did — lives in `useTraceJump`. Extracted from this
  // over-size view so the four callbacks that share that one concern sit
  // together (and so this shrink-only file keeps shrinking).
  const { jumpToInvocationAnchor, jumpToRow, jumpToTimelineRow } = useTraceJump(
    {
      cancelPendingTraceScroll,
      ignoreNextTraceScrollRef,
      onActiveRowChange: setActiveRow,
      scrollRef,
      traceRowTranslatorsRef,
    }
  );

  // FEA-4233: the comments rail's live data + open/collapsed state (poll gating,
  // the empty-default slim handle, and the reveal callbacks) live in one hook so
  // this over-size view stays lean. See `useCommentsRailState`.
  const {
    activeAnchor: activeTraceCommentAnchor,
    comments: traceComments,
    commentsRailCollapsed,
    collapseCommentsRail,
    expandCommentsRail,
    deleteTraceComment,
    jumpToTraceComment,
    replyToTraceComment,
    submitTraceCommentAndReveal,
    updateTraceComment,
  } = useCommentsRailState({
    sessionId: session.id,
    jumpToRow,
    commentsRailOpen,
    commentsCollapsed,
    onCommentsCollapsedChange,
  });

  const handleTraceScroll = useCallback(() => {
    if (ignoreNextTraceScrollRef.current) {
      ignoreNextTraceScrollRef.current = false;
      return;
    }
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = globalThis.requestAnimationFrame(() => {
      rafRef.current = null;
      // Shared with the Branch detail page so both timelines agree on the active
      // row (and share the scroll-to-top reset).
      const row = computeActiveTraceRow({
        rowSelector: TRACE_ROW_SELECTOR,
        scroller: scrollRef.current,
        stickySelectors: [".sd3-stickyhead.is-sticky"],
      });
      if (row != null) {
        setActiveRow(row);
      }
    });
  }, []);

  const commentsRail = renderCommentsRail({
    activeRow,
    collapsed: commentsRailCollapsed,
    comments: traceComments,
    onCollapse: collapseCommentsRail,
    onDelete: deleteTraceComment,
    onExpand: expandCommentsRail,
    onJump: jumpToTraceComment,
    onReply: replyToTraceComment,
    onUpdate: updateTraceComment,
    onWidthChange: onCommentsWidthChange,
    open: commentsRailOpen,
    traceIdentity: session.id,
    width: commentsWidth,
  });

  // FEA-4252: `activeRow` is a RENDERED-trace row (the scroll handler and jumps
  // both report `data-row`). The Session Timeline's "you are here" marker,
  // however, measures against bucket `tl0` keyed to `session.turnItems._row`, so
  // translate the active row back into that source space or the marker drifts a
  // bar or two off the turn on a divergent web session. Identity on desktop /
  // aligned sessions.
  const timelineActiveRow =
    activeRow == null
      ? null
      : traceRowTranslatorsRef.current.toTrace(activeRow);

  /*
   * ISS-5818 (D1): name + status on one line, the prototype's
   * `session-detail.tsx:72-79`. The chip is the SAME `SessionStatusBadge` the
   * Sessions LIST row renders (`sessions-table.tsx:683,701`), fed by
   * `resolveSessionDetailDisplayStatus` — the list's own
   * `resolveDisplayedSessionStatus` folds plus the Waiting projection the list
   * gets from its producer — so a stale, unrecognized or awaiting-input run
   * reads "Stale"/"Unknown"/"Waiting" here exactly as it does in the list,
   * instead of this chip reintroducing the pulsing-green "Active" lie
   * ISS-4997/ISS-4998 removed. `syncPresentation` is deliberately not passed:
   * the detail carries its own Sync property row, and an unmarked chip is the
   * documented byte-identical plain-status pill.
   *
   * Built here rather than inline below so the region ORDER stays the only
   * thing the layout expresses.
   */
  const titleBlock = (
    <header className="sd3-head">
      {/* The prototype's own title classes (`session-detail.tsx:73`), which are
          also what the sibling Agent detail page already ships
          (`agent-detail.tsx`). Deliberately NOT `.sd3-title`: that step was
          sized for a title that condensed inside the sticky box, which this one
          no longer sits in. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="font-semibold text-2xl tracking-tight">
          {session.name ?? session.externalSessionId}
        </h1>
        <SessionStatusBadge status={titleDisplayedStatus} />
      </div>
    </header>
  );

  const timelineStrip = (
    <SessionActivityTimeline
      activeRow={timelineActiveRow}
      axisDurationLabel={axisDurationLabel}
      barCostsUnpublished={timelineDisclosure.barCostsUnpublished}
      buckets={bucketStrip.buckets}
      costUnmeasured={timelineDisclosure.costUnmeasured}
      disabled={!traceHasRenderedRows}
      eventsTruncated={session.eventsTruncated}
      isRowInReadTranscript={isTimelineRowInReadTranscript}
      limitDotEvents={limitDotEvents}
      markers={markers}
      onJump={jumpToTimelineRow}
      ownerLabel={
        session.user ? getUserDisplayName(session.user) : UNKNOWN_OWNER_LABEL
      }
      segmentRows={session.activitySegmentRows ?? EMPTY_SEGMENT_ROWS}
      /*
       * ISS-5819: the SAME window the axis and the bucket synthesis already run
       * on (`useSessionTimelineWindow`), handed down so the clock projection
       * cannot introduce a third scale — the exact failure ISS-4833 / ISS-4821
       * collapsed two windows into one to prevent.
       */
      sourceWindow={
        axis.window
          ? { endMs: axis.window.endMs, startMs: axis.window.startMs }
          : null
      }
      span={span}
      summarySession={session}
    />
  );

  /* FEA-4025: OUTSIDE the pinned header, deliberately. The strip itself belongs
     in the pinned box; this sentence explaining why its bars carry no figures
     does not, because the header is held under half the scroll pane and this
     line alone pushed it over (281px against a 267.5px budget at a 600px
     viewport). It sits immediately below the box, so at rest it still reads as
     part of the strip, and it simply scrolls away with the rest of the page
     instead of riding along pinned. */
  const timelineCostLegend = timelineDisclosure.costUnmeasured ? (
    <p className="mb-1 text-muted-foreground text-xs">
      {TIMELINE_SYNTHESIZED_COST_LEGEND}
    </p>
  ) : null;

  const transcriptRegion = (
    <div className="sd3-trace sd3-trace-chat">
      {/*
       * FEA-2717: cloud-preferred, two-phase conversation. The metadata panels
       * above render immediately from the detail response; this panel hydrates
       * the conversation from the archived cloud transcript and surfaces the FR8
       * availability states, falling back to the DB-backed `turnItems` until
       * FEA-2718 removes that path.
       */}
      <SessionTranscriptPanel
        activeRow={activeRow}
        buildTranscriptFileHref={buildTranscriptFileHref}
        fallbackItems={session.turnItems}
        fileKey={transcriptFileKey}
        highlightAnchor={activeTraceCommentAnchor}
        invocationAnchor={invocationAnchor}
        onInvocationAnchorResolved={jumpToInvocationAnchor}
        onJump={jumpToRow}
        onSubmitTraceComment={submitTraceCommentAndReveal}
        onTraceRowTranslatorChange={registerTraceRowTranslator}
        session={session}
      />
    </div>
  );

  const propertiesPanel = (
    <SessionPropertiesPanel
      artifactHrefPending={artifactHrefPending}
      buildArtifactHref={buildArtifactHref}
      getBranchHref={getBranchHref}
      session={session}
    />
  );

  return (
    <div
      className="sd3"
      style={{ "--sd3-cmts-w": `${commentsWidth}px` } as CSSProperties}
    >
      <div className="sd3-main">
        <div
          className="sd3-scroll"
          onScroll={handleTraceScroll}
          ref={scrollRef}
        >
          <article className="sd3-doc">
            {/*
             * ISS-5818: the prototype's region order — Title → Properties →
             * Timeline → Trace (`session-detail.tsx:87-99`).
             *
             * WHAT STAYS PINNED: the Timeline ALONE. FEA-4025's rule was "pin
             * only the orientation block, keep it small enough that it can never
             * occlude the trace" — keeping the identity row OUT of the box
             * serves that rule harder, not less, because the pinned block is
             * strictly shorter. The alternative — pinning title + Properties +
             * Timeline to keep them contiguous — would put an expandable 21-row
             * disclosure inside a sticky header, which is the "enormous page
             * header" ISS-5818 warned about. (`--sd3-sticky-clearance`'s 216px
             * fallback is sized for the older, taller box; only the fallback,
             * since the scroll code measures the live element.)
             */}
            {titleBlock}
            {propertiesPanel}
            {/* `.sd3-props` ends flush and the sticky box has no top spacing of
                its own, so without this the strip butts against the pinned
                header's fill. The prototype clears it by ~40px (`pb-6` on the
                identity block plus `py-4` inside the sticky box). */}
            <div className="sd3-stickyhead is-sticky mt-6">{timelineStrip}</div>
            {timelineCostLegend}

            {/*
             * ISS-5841: both activity-phase regions — FEA-3705's strip and
             * FEA-2275's per-phase breakdown — behind their shared gate. The
             * module owns the full rationale.
             */}
            <SessionActivityPhaseRegions session={session} />

            {/*
             * ISS-5818 (D5): a real `h2` inside a labelled landmark, matching
             * the prototype's `session-trace.tsx:71-75`.
             *
             * #4739 review (codex P2): the transcript goes INSIDE the section,
             * not beside it. A `section[aria-labelledby]` that closes after its
             * own heading is a named region containing only its own name — the
             * landmark announces "Session Trace" and then holds nothing, which
             * is a worse outline than the plain `span` it replaced, and it is
             * not what the prototype does (`session-trace.tsx` keeps the rows
             * inside the section).
             */}
            <section aria-labelledby={SESSION_TRACE_HEADING_ID}>
              <div className="sd3-tracehead">
                <h2 className="sd3-th-title" id={SESSION_TRACE_HEADING_ID}>
                  Session Trace
                </h2>
                <span className="sd3-th-count">{traceCountLabel}</span>
              </div>
              {transcriptRegion}
            </section>
          </article>
        </div>
      </div>

      {commentsRail}
    </div>
  );
}

function SessionActivityTimeline({
  activeRow,
  axisDurationLabel,
  barCostsUnpublished,
  buckets,
  costUnmeasured = false,
  disabled = false,
  eventsTruncated,
  isRowInReadTranscript,
  limitDotEvents,
  markers,
  onJump,
  ownerLabel,
  segmentRows,
  sourceWindow,
  span,
  summarySession,
}: Readonly<{
  activeRow: number | null;
  /**
   * ISS-4684: the axis total in the same `Hh Mm` unit system as the "Activity
   * phases" caption below it, so the two totals visibly reconcile.
   */
  axisDurationLabel: string;
  /**
   * ISS-5566 × ISS-5563, resolved by the PARENT so the caller can render the
   * disclosure legend outside the pinned header (see the call site). Every
   * figure-bearing element on the strip reads this one answer.
   */
  barCostsUnpublished: boolean;
  buckets: ActivityBucket[];
  /**
   * ISS-5566: `true` when this strip's per-bucket money was synthesized AND the
   * disclosure flag is on, so the strip withdraws every figure it cannot back.
   * Resolved by the caller alongside {@link barCostsUnpublished} — see
   * `resolveTimelineCostDisclosure`. Defaults to `false`: a caller that cannot
   * answer the question must not have the strip claim a fabrication it has not
   * established.
   */
  costUnmeasured?: boolean;
  /**
   * FEA-4252: `true` while the trace is still a skeleton (no rendered
   * `[data-row]` to scroll to). Disables the bar/dot jump controls so they stop
   * promising navigation they cannot perform yet.
   */
  disabled?: boolean;
  /*
   * ISS-5075 (stage review): the bars and the dot rail are plotted from the
   * session's `turnItems`/`events`, which the detail read serves as a
   * chronological PREFIX once it hits its row ceiling. The axis still measures
   * the whole run, so the strip's empty tail would otherwise read as "nothing
   * happened" instead of "we stopped reading". The tail past the last plotted
   * bucket carries its own treatment ({@link UNREAD_BAR_STYLE}) — a caption
   * cannot undo what the eye has already read off the strip.
   */
  eventsTruncated?: true;
  /**
   * ISS-5479 review: whether a timeline row has a counterpart in the transcript
   * actually rendered. The affordance follows THIS, not `tl0` alone — a bar can
   * carry a jump row that resolves nowhere (most root-timeline bars do on a
   * `subagent:{id}` view) and it must not keep advertising a jump.
   */
  isRowInReadTranscript: (row: number) => boolean;
  limitDotEvents: ActivityMarker[];
  markers: ActivityMarker[];
  /**
   * ISS-5479: accepts `null` so an idle bar/dot (no jump row) reports "nothing
   * to scroll to" on the one outcome path instead of being dropped by a guard
   * here and reading as a dead control.
   */
  onJump: (
    row: number | null,
    flash?: boolean,
    missingRowOutcome?: TraceScrollOutcome
  ) => void;
  /** ISS-5819: the "Session Owner" grouping's one segment label. */
  ownerLabel: string;
  /**
   * ISS-5819: the classifier's activity tiling, used to cut a column's cost by
   * phase. Empty when the session carries none — the phase grouping then reports
   * every column as unattributed rather than inventing a phase.
   */
  segmentRows: readonly SyncedActivitySegmentRow[];
  /**
   * ISS-5819: the wall-clock span `buckets` uniformly tiles, which is what makes
   * them re-projectable onto a clock window. `null` when no window resolved, and
   * the strip then renders the bars exactly as given.
   */
  sourceWindow: { endMs: number; startMs: number } | null;
  span: SessionSpan;
  /**
   * ISS-5970: the session the run-level cost/tokens/duration summary reads.
   * Passed in whole rather than as three pre-formatted strings so the strip can
   * run the SAME canonical derivations the Properties rows run — pre-formatting
   * it here would put a second answer on the page, which is the failure the
   * ticket is about.
   */
  summarySession: SessionTimelineSummarySession;
}>) {
  // ISS-5548, `…Optional` because this strip also renders in Storybook and in
  // tests, which mount no flag provider.
  const columnHitTargetEnabled = useFeatureFlagEnabledOptional(
    SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY
  );
  const activityPhasesEnabled = useFeatureFlagEnabledOptional(PHASES_FLAG);
  const [hoverBucket, setHoverBucket] = useState<HoverBucket | null>(null);
  const [hoverDot, setHoverDot] = useState<HoverDot | null>(null);
  const timelineScale = useSessionTimelineScale({
    activeRow,
    activityPhasesEnabled,
    buckets,
    limitDotEvents,
    markers,
    ownerLabel,
    segmentRows,
    sourceWindow,
  });
  // ONE name each, resolved once inside the hook: the bars, the label rail, the
  // dot rail, the tooltip and the "you are here" marker must all be plotted over
  // the SAME columns, or the strip disagrees with itself the moment the window
  // moves.
  const { columnLimitDots, columnMarkers, columns } = timelineScale;
  const maxCost = Math.max(0.01, ...columns.map(getBucketCost));
  const cells = buildDotCells(columnMarkers, columnLimitDots, columns.length);
  const hoverIndex = hoverBucket?.index ?? null;
  const hoveredBucket = hoverBucket == null ? null : columns[hoverBucket.index];
  const hoveredEvents =
    hoverDot == null ? null : cells[hoverDot.bucketIndex]?.[hoverDot.color];
  // Memoized: `toRendered` walks the turn-item projections, and a strip can hold
  // 48 bars — recomputing per bar per render would be quadratic on a long session.
  const jumpBlocks = useMemo(
    () =>
      columns.map((bucket) =>
        getBucketJumpBlock(bucket, isRowInReadTranscript)
      ),
    [columns, isRowInReadTranscript]
  );
  const unreadFromIndex = getUnreadFromIndex(columns, eventsTruncated === true);
  const barLabels = buildBucketBarLabels({
    buckets: columns,
    costsSynthesized: barCostsUnpublished,
    maxCost,
    unreadFromIndex,
  });
  // ISS-5761: the spoken cost, which is NOT the printed one — the rail prints
  // only prominent buckets and only when the columns are wide enough, while the
  // name carries every priced bucket unconditionally.
  /*
   * ISS-5819: the "Group by" cut is otherwise conveyed by COLOUR ALONE — the
   * stack segments carry no text and no class. Folding each column's segment
   * labels into the button's accessible name is what makes changing the
   * grouping perceivable without sight (WCAG 1.4.1); the hover card carries the
   * same breakdown for a sighted reader.
   */
  const barAccessibleCosts = withStackBreakdown(
    buildBucketAccessibleCosts({
      buckets: columns,
      costsSynthesized: barCostsUnpublished,
    }),
    timelineScale.stacks
  );
  /*
   * ISS-5819: the "you are here" marker reads the ONE position model the hook
   * holds — the same number the scrubber thumb sits on — rather than deriving
   * its own. When no source window resolves, that model falls back to
   * `getRowPercent` over the caller's own bars.
   *
   * `.tl-here` is shared with the Branch PR activity timeline
   * (`packages/app/branches/components/branch-pr-activity-timeline.tsx`), which
   * computes its own left offset and is untouched by this: nothing here changes
   * the class, the stylesheet, or that component.
   */
  const herePercent = timelineScale.herePercent;

  if (buckets.length === 0) {
    return (
      <SessionTimelineRegion>
        <div className="sd3-actbar">
          <SessionTimelineHeading summarySession={summarySession} />
          <p className="text-muted-foreground text-sm">
            {eventsTruncated
              ? TRACE_TOO_MANY_EVENTS_TO_PLOT
              : "No activity recorded for this session."}
          </p>
        </div>
      </SessionTimelineRegion>
    );
  }

  return (
    <SessionTimelineRegion>
      <div className="sd3-actbar">
        <SessionTimelineHeading summarySession={summarySession} />
        {timelineScale.controls ? (
          <SessionTimelineControls
            activityPhasesEnabled={activityPhasesEnabled}
            grouping={timelineScale.controls.grouping}
            onGroupingChange={timelineScale.controls.setGrouping}
            onScaleChange={timelineScale.controls.setScale}
            scale={timelineScale.controls.scale}
            subColumnSource={timelineScale.subColumnSource}
          />
        ) : null}
        <div className="sd3-bars2-wrap">
          {herePercent == null ? null : (
            <div
              aria-hidden
              className="tl-here"
              style={{ left: `${herePercent}%` }}
            />
          )}
          <SessionTimelineBarLabels
            labels={barLabels}
            peakIndex={getPeakBucketIndex(columns)}
          />
          <SessionTimelineBars
            accessibleCosts={barAccessibleCosts}
            buckets={columns}
            columnHitTargetEnabled={columnHitTargetEnabled}
            costUnmeasured={costUnmeasured}
            disabled={disabled}
            hoverIndex={hoverIndex}
            jumpBlocks={jumpBlocks}
            maxCost={maxCost}
            onHover={setHoverBucket}
            onJump={onJump}
            stacks={timelineScale.stacks}
            unreadFromIndex={unreadFromIndex}
          />

          <SessionTimelineDotRail
            buckets={columns}
            cells={cells}
            disabled={disabled}
            hoverDot={hoverDot}
            onHoverDot={setHoverDot}
            onJump={onJump}
          />

          <SessionTimelineHoverCards
            block={hoverIndex == null ? null : (jumpBlocks[hoverIndex] ?? null)}
            costUnmeasured={costUnmeasured}
            grouping={timelineScale.controls?.grouping}
            hoverBucket={hoverBucket}
            hoverDot={hoverDot}
            hoveredBucket={hoveredBucket}
            hoveredEvents={hoveredEvents}
            segments={
              hoverIndex == null
                ? undefined
                : (timelineScale.stacks?.[hoverIndex] ?? undefined)
            }
          />
        </div>
        {/*
          ISS-5819: when the strip is showing a WINDOW smaller than the session,
          the axis names that window's two edges, not the session's. Session-wide
          ticks under a windowed chart would put an end time on the right that the
          rightmost bar is nowhere near — the axis would be describing a chart
          that is not on screen. Unwindowed (`maxWindowStart === 0`, which is
          every session that fits, and every flag-off render) the window IS the
          session and both branches print the same thing.
        */}
        {/* The TICKS follow the window; the duration caption between them does
            NOT (#4753). It measures the run, and a window is a viewport — see
            `getWindowedAxis`. */}
        <SessionTimelineAxis
          axisDurationLabel={axisDurationLabel}
          span={timelineScale.windowedAxis?.span ?? span}
        />
        {timelineScale.scrubber ? (
          <SessionTimelineScrubber
            onPositionChange={timelineScale.scrubber.onPositionChange}
            position={timelineScale.scrubber.position}
            totalColumns={timelineScale.scrubber.totalColumns}
          />
        ) : null}
        {/* ISS-5566 design review: `mb-1` on THIS caption rather than a wrapper
          around both. A synthesized strip can also be truncated, and the two
          captions would otherwise sit flush and read as one run-on block. The
          margin lives on the flag-gated element so the flag-off DOM is
          unchanged. */}
        {/* ISS-5566 × FEA-4025: the synthesized-cost legend is NOT rendered here.
          This strip mounts inside `.sd3-stickyhead`, which FEA-4025 pins and
          holds to "only the identity row + the Session Timeline, small by
          construction" so it can never blanket the transcript. Measured on a
          600px viewport, this one caption line took the pinned header to 281px
          against a 267.5px budget (half the scroll pane). The caption is
          explanatory prose rather than orientation data, so the CALLER renders
          it just below the pinned box — see the `costUnmeasured` legend at the
          `SessionActivityTimeline` call site. It cannot be hidden by CSS here:
          `is-sticky` is static markup, not a scroll state, so a
          `.is-sticky` rule would withhold it always. */}
        {eventsTruncated ? (
          <p className="text-muted-foreground text-xs">
            {/*
             * Against `columns`, NOT `buckets`: the shading is applied over the
             * PROJECTED strip (`index >= unreadFromIndex` in the bar row and the
             * label rail), and `unreadFromIndex` is derived from `columns` too.
             * Comparing against the pre-projection `buckets.length` made any
             * projection that shrinks the column count (40 source bins onto 24
             * columns) satisfy the test unconditionally, so the strip promised a
             * shaded tail it had rendered none of.
             */}
            {unreadFromIndex < columns.length
              ? TRACE_UNREAD_TAIL_LEGEND
              : TRACE_EVENTS_TRUNCATED_CAPTION}
          </p>
        ) : null}
      </div>
    </SessionTimelineRegion>
  );
}

export function buildActivityMarkers(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  if (session.markers && session.markers.length > 0) {
    return session.markers.map((marker) => ({
      ...marker,
      label: marker.label,
      // ISS-4821 (wongk / codex review): see resolvePersistedMarkerPercent —
      // `marker.x` is the producer's fraction over a window the DTO does not
      // carry, so it cannot stay verbatim once this screen resolves its own.
      x: resolvePersistedMarkerPercent(session, marker, window),
      // Normalize the marker instant through the same formatter every other
      // marker path uses. `SessionMarker.t` is TYPED `string`, but a synced
      // detail can deserialize the timestamp column to a runtime `Date`; copying
      // it verbatim rendered `[object Date]` as a React child in the timeline
      // tooltip (`<span>{event.t}</span>`) and crashed the whole detail subtree,
      // including the transcript panel under the same error boundary.
      t: formatMarkerTime(marker.t),
      /*
       * FEA-4252: a persisted `SessionMarker.tl` can be a raw producer index (a
       * TraceTimelineRow / correction-source index), NOT a `turnItems._row`, so
       * trusting it makes the downstream row translation correlate the wrong
       * turn (a coalesced second tool can carry `tl=2` while its DB turn is row
       * 1). Re-anchor ONLY when the persisted value is not already a real
       * `turnItems._row`: a matching value is a genuine DB turn and is kept, and
       * an absent `tl` stays absent so the dot remains an inert no-op rather than
       * resolving to a fabricated row.
       */
      tl: normalizePersistedMarkerRow(session, marker.tl, marker.t, marker.x),
    }));
  }

  const items = session.turnItems ?? [];
  return items
    .map((item, index) => buildTurnMarker(item, index, items.length))
    .filter((marker): marker is ActivityMarker => marker !== null);
}

/*
 * FEA-3642: rate-limit indicators are driven by STRUCTURED signals only. A
 * session that merely mentions "rate limit"/"429"/"throttle" in conversation or
 * tool output must show NO indicator; only a recorded throttle
 * (`session.throttles`/`session.throttleSources`) or an event the harness
 * classified as a limit (structured `eventType`/`data`, not free-text
 * `summary`/`title`/`text`) produces a dot. `buildTimelineLimitDots` — the sole
 * pure free-text scanner (timeline events carry only free-text `title`/`detail`,
 * no structured type) — is gone: it was the false-positive source.
 */
export function buildLimitDotEvents(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  const explicitThrottles = buildExplicitThrottleLimitDots(session, window);
  if (explicitThrottles.length > 0) {
    return dedupeLimitDotEvents(explicitThrottles);
  }

  return dedupeLimitDotEvents([
    ...buildThrottleSourceLimitDots(session, window),
    ...buildSessionEventLimitDots(session, window),
    ...buildTurnItemLimitDots(session, window),
  ]);
}

function buildExplicitThrottleLimitDots(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  return (session.throttles ?? []).map((throttle) => {
    /*
     * ISS-4821 (wongk review): `x0` is the PRODUCER's fraction, computed over
     * `startedAt → resolvePresentationEndMs` (packages/lib/session-trace/
     * derivation.ts). This early-return path kept it verbatim, so a throttle dot
     * never reached the new window math and stayed at its old fraction while the
     * axis around it moved. `t0` is an absolute instant, so recompute from that
     * and keep `x0` only when the timestamp or the window is unusable.
     */
    const x =
      getWindowPercent(window, throttle.t0) ?? clampPercent(throttle.x0);
    return {
      kind: "limit",
      label: formatThrottleLimitLabel(throttle),
      t: formatMarkerTime(throttle.t0),
      tl: resolveLimitTraceRow(session, throttle.t0, throttle.tl, x),
      x,
    };
  });
}

function buildThrottleSourceLimitDots(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  return (session.throttleSources ?? []).map((source, index) => {
    const x = getLimitDotPercent(window, session, source.observedAt, index);
    return {
      kind: "limit",
      label: formatThrottleSourceLimitLabel(source),
      t: formatMarkerTime(source.observedAt),
      tl: resolveLimitTraceRow(session, source.observedAt, index, x),
      x,
    };
  });
}

function buildSessionEventLimitDots(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  return session.events.flatMap((event, index) => {
    const label = getSessionEventLimitLabel(event);
    if (!label) {
      return [];
    }
    const x = getLimitDotPercent(window, session, event.createdAt, index);
    return [
      {
        kind: "limit",
        label,
        t: formatMarkerTime(event.createdAt),
        tl: resolveLimitTraceRow(session, event.createdAt, index, x),
        x,
      },
    ];
  });
}

function buildTurnItemLimitDots(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  return (session.turnItems ?? []).flatMap((item, index) => {
    const label = getTurnEventLimitLabel(item);
    const timestamp = getTurnItemTimestamp(item);
    if (!(label && timestamp)) {
      return [];
    }
    const fallbackRow = hasTraceRow(item) ? item._row : index;
    const x = getLimitDotPercent(window, session, timestamp, fallbackRow);
    return [
      {
        kind: "limit",
        label,
        t: formatMarkerTime(timestamp),
        tl: resolveExplicitTraceRow(
          hasTraceRow(item) ? item._row : null,
          session,
          timestamp,
          fallbackRow,
          x
        ),
        x,
      },
    ];
  });
}

function dedupeLimitDotEvents(events: ActivityMarker[]): ActivityMarker[] {
  const seen = new Set<string>();
  const deduped: ActivityMarker[] = [];
  for (const event of events) {
    const key = `${event.tl}:${event.t}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

/**
 * The fallback marker path, for a session with no PERSISTED markers.
 *
 * ISS-5819 (#4753 review, wongk): the marker carries its ABSOLUTE instant
 * alongside the ordinal `x` below. `x` here is `index / (total - 1)` — the
 * turn's POSITION IN THE LIST, not its position in time — which the session-wide
 * axis renders correctly because it plots in that same ordinal geometry, but
 * which a wall-clock window cannot read: on a two-hour run whose second of three
 * turns fires one minute in, an `x` of `50` put the dot an hour late. `item.t`
 * is the real timestamp and was already on hand, only ever formatted for
 * display, so the honest fix is to hand the instant to the consumer that needs a
 * clock rather than have it infer a time from a rank.
 *
 * Attached ONCE here rather than in each of the switch's four `return`s below,
 * so a fifth marker kind cannot be added without it. An unparseable `t` yields
 * `NaN` and is left off, and the projection falls back to `x`.
 */
function buildTurnMarker(
  item: TurnItem,
  index: number,
  total: number
): ActivityMarker | null {
  const marker = buildOrdinalTurnMarker(item, index, total);
  if (marker === null) {
    return null;
  }
  // `"t" in item` rather than a cast: `TurnItem` is a union and its `idle` arm
  // carries no timestamp at all. Those arms produce no marker anyway, but the
  // narrowing is what makes that a fact the compiler holds rather than one this
  // function assumes about a sibling switch.
  const atMs = "t" in item ? getDateMs(item.t) : Number.NaN;
  return Number.isFinite(atMs) ? { ...marker, atMs } : marker;
}

function buildOrdinalTurnMarker(
  item: TurnItem,
  index: number,
  total: number
): ActivityMarker | null {
  const x = total <= 1 ? 0 : (index / (total - 1)) * 100;
  switch (item.type) {
    case "prompt":
      if (isSessionTerminatingLabel(item.text)) {
        return null;
      }
      return {
        kind: "prompt",
        x,
        t: formatMarkerTime(item.t),
        label: item.text,
        tl: item._row,
      };
    case "tools":
      // FEA-2192: a successful tool turn is routine agent activity, not human
      // steering; only surface a marker when the turn failed. Mirrors the
      // server-side buildTraceMarkers/traceMarkerKind path, which emits no
      // marker for successful tool events.
      return item.hasFail
        ? {
            kind: "fail",
            x,
            t: formatMarkerTime(item.t),
            label: item.summary,
            tl: item._row,
          }
        : null;
    case "event":
      if (getTurnEventLimitLabel(item)) {
        return null;
      }
      return {
        kind: getEventMarkerKind(item.dot),
        x,
        t: formatMarkerTime(item.t),
        label: item.tag ?? item.text,
        tl: item._row,
      };
    case "subagent": {
      // FEA-2192: a completed subagent run is routine agent activity, not human
      // steering; only mark failures (see the "tools" case). Cloud-sourced
      // subagents report "error" (not just "fail") as their failure status, so
      // match the package-wide vocabulary (agent-tree-utils) and the server-side
      // traceMarkerKind, which both treat "error" and "fail" as failures.
      const statusLower = item.status.toLowerCase();
      return statusLower.includes("fail") || statusLower.includes("error")
        ? {
            kind: "fail",
            x,
            t: formatMarkerTime(item.t),
            label: item.sub,
            tl: item._row,
          }
        : null;
    }
    case "say":
      return null;
    case "idle":
    case "sessionstart":
    case "end":
      return null;
    default:
      return assertNeverTurnItem(item);
  }
}

function buildDotCells(
  markers: readonly ActivityMarker[],
  limitDotEvents: readonly ActivityMarker[],
  bucketCount: number
): DotCell[] {
  if (bucketCount === 0) {
    return [];
  }
  const cells = Array.from({ length: bucketCount }, createDotCell);
  for (const marker of markers) {
    const color = getMarkerDotColor(marker.kind);
    if (color) {
      cells[getBucketIndexFromPercent(marker.x, bucketCount)][color].push({
        kind: marker.kind,
        label: marker.label,
        t: marker.t,
        tl: marker.tl,
      });
    }
  }
  for (const event of limitDotEvents) {
    cells[getBucketIndexFromPercent(event.x, bucketCount)].r.push({
      kind: event.kind,
      label: event.label,
      t: event.t,
      tl: event.tl,
    });
  }
  return cells;
}

function formatThrottleLimitLabel(throttle: SessionThrottle): string {
  const duration = formatThrottleDuration(throttle.durMin);
  if (duration) {
    return `Throttled for ${duration}; resumed ${formatMarkerTime(throttle.t1)}`;
  }
  return `Throttled; resumed ${formatMarkerTime(throttle.t1)}`;
}

function resolveExplicitTraceRow(
  explicitRow: number | null | undefined,
  session: AgentSessionDetail,
  timestamp: unknown,
  fallbackRow: number,
  fallbackPercent: number
): number {
  if (typeof explicitRow === "number" && Number.isFinite(explicitRow)) {
    return normalizeTraceRow(explicitRow);
  }
  return resolveLimitTraceRow(session, timestamp, fallbackRow, fallbackPercent);
}

function resolveLimitTraceRow(
  session: AgentSessionDetail,
  timestamp: unknown,
  fallbackRow: number,
  fallbackPercent: number
): number {
  const rows = session.turnItems?.filter(hasTimedTraceRow) ?? [];
  const timestampMs = getDateMs(timestamp);
  if (Number.isFinite(timestampMs) && rows.length > 0) {
    return getNearestTraceRow(rows, timestampMs);
  }
  return getTraceRowFromPercent(session, fallbackPercent, fallbackRow);
}

/*
 * FEA-4252: normalize a persisted marker's jump row into a real `turnItems._row`
 * so the downstream row translation starts from a genuine DB turn identity.
 * - An absent/non-finite `tl` is preserved (the dot stays an inert no-op, never
 *   a fabricated jump to the top).
 * - A `tl` that already names a real `turnItems._row` is a valid DB turn and is
 *   kept as-is (the common, aligned case).
 * - Only a `tl` that is NOT a real row (a raw TraceTimelineRow / correction index
 *   the desktop producer emitted) is re-anchored to the nearest real row by the
 *   marker's instant, falling back to its horizontal position.
 */
/**
 * Where a PERSISTED marker belongs on the resolved timeline window
 * (ISS-4821, wongk + codex review).
 *
 * `SessionMarker.x` is the producer's fraction over the producer's own window,
 * and that window is not in the detail DTO — so once this screen resolves a
 * different window, keeping `x` relabels the axis while leaving the dot where it
 * was. The two producers differ in what they preserve:
 *   - the cloud path (`deriveCorrectionMarkers`, packages/lib/session-trace/
 *     derivation.ts) writes `t: source.observedAt` — an ABSOLUTE instant, so it
 *     rebases directly;
 *   - the desktop path (`buildTraceMarkers`, apps/desktop/src/main/database/
 *     session-trace.ts) writes `t: formatTraceClockOffset(rowMs - startMs)` — a
 *     relative clock offset like "1:00:00", which carries no absolute instant.
 *     For that shape the marker's re-anchored transcript row IS an absolute
 *     instant, so rebase from the row's timestamp instead.
 *
 * Only when neither is available — no parseable `t`, no timed transcript row —
 * does the stored fraction stand, which keeps an older payload rendering exactly
 * as it does today. That last case is where wongk's suggested DTO addition (an
 * optional producer source-window, or absolute marker times) would remove the
 * remaining guesswork; it needs a desktop producer change and a skew fallback,
 * so it is deliberately not folded into this PR.
 */
function resolvePersistedMarkerPercent(
  session: AgentSessionDetail,
  marker: SessionMarker,
  window: SessionTimelineWindow | null
): number {
  const fromTimestamp = getWindowPercent(window, marker.t);
  if (fromTimestamp !== null) {
    return fromTimestamp;
  }
  const rowMs = getPersistedMarkerRowMs(session, marker);
  return getWindowPercent(window, rowMs) ?? clampPercent(marker.x);
}

/** The absolute instant of the transcript row a persisted marker re-anchors to. */
function getPersistedMarkerRowMs(
  session: AgentSessionDetail,
  marker: SessionMarker
): Date | null {
  const row = normalizePersistedMarkerRow(
    session,
    marker.tl,
    marker.t,
    marker.x
  );
  if (typeof row !== "number" || !Number.isFinite(row)) {
    return null;
  }
  for (const item of session.turnItems ?? []) {
    if (hasTimedTraceRow(item) && item._row === row) {
      return new Date(getTurnItemMs(item));
    }
  }
  return null;
}

function normalizePersistedMarkerRow(
  session: AgentSessionDetail,
  tl: number | undefined,
  timestamp: unknown,
  percent: number
): number {
  if (typeof tl !== "number" || !Number.isFinite(tl)) {
    return tl as number;
  }
  const rows = session.turnItems ?? [];
  const isRealRow = rows.some((item) => "_row" in item && item._row === tl);
  if (isRealRow) {
    return tl;
  }
  return resolveLimitTraceRow(session, timestamp, tl, percent);
}

function getNearestTraceRow(
  rows: (TurnItem & { _row: number; t: string })[],
  timestampMs: number
): number {
  let nearestRow = rows[0]?._row ?? 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const distance = Math.abs(getTurnItemMs(row) - timestampMs);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestRow = row._row;
    }
  }
  return normalizeTraceRow(nearestRow);
}

function getTraceRowFromPercent(
  session: AgentSessionDetail,
  percent: number,
  fallbackRow: number
): number {
  const rows = session.turnItems?.filter(hasTraceRow) ?? [];
  if (rows.length === 0) {
    return normalizeTraceRow(fallbackRow);
  }
  const index = clamp(
    Math.round((clampPercent(percent) / 100) * (rows.length - 1)),
    0,
    rows.length - 1
  );
  return normalizeTraceRow(rows[index]?._row ?? fallbackRow);
}

function normalizeTraceRow(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function getBucketIndexFromPercent(
  percent: number,
  bucketCount: number
): number {
  if (bucketCount <= 1) {
    return 0;
  }
  return clamp(Math.floor((percent / 100) * bucketCount), 0, bucketCount - 1);
}

function createDotCell(): DotCell {
  return { b: [], g: [], r: [] };
}

/**
 * ISS-5075: count caption for the Session trace header, honest about truncation.
 *
 * The count keeps counting exactly what it always has: the session's own
 * DB-derived trace projection (`turnItems`, falling back to the raw `events`).
 * That is NOT always the set the panel below paints. On the web a parsed cloud
 * transcript is the sole trace source when it has content
 * (`session-transcript-panel.tsx`), and it is read whole, so the header number
 * and the rows can already describe two different projections. Swapping in a
 * different quantity here would relocate that split rather than close it, so
 * this stays a caption about the session's event stream.
 *
 * The qualifier therefore has to describe THE COUNT's population, and logical-QA
 * review caught it describing the panel's instead: gating it on what the panel
 * painted meant that on the primary web path — an archived transcript, so the
 * rendered source is never the capped projection — a session past the cap
 * printed `10,000 events` with no disclosure at all, which is the one thing an
 * uncapped read never did. `eventsTruncated` describes the DB event stream, and
 * that stream is exactly what this number counts, so the flag alone is the
 * gate. It says so in the same words the Activity phases panel on this screen
 * uses for the same condition ("later phases truncated") rather than a
 * "(partial)" a reader cannot tell apart from "still loading".
 *
 * The end-of-trace note in `session-transcript-panel.tsx` is the other case and
 * keeps its render-source gate: that one claims something about the ROWS, so
 * stamping it over a whole parsed transcript would be the same lie pointed the
 * other way.
 */
function getTraceCountLabel(session: AgentSessionDetail): string {
  const rowCount = session.turnItems?.length ?? session.events.length;
  const count = `${rowCount.toLocaleString()} ${rowCount === 1 ? "event" : "events"}`;
  return session.eventsTruncated === true
    ? `${count} · ${TRACE_EVENTS_TRUNCATED_NOTE}`
    : count;
}

function assertNeverTurnItem(item: never): null {
  return item;
}

type DotCell = Record<DotColor, TimelineDotEvent[]>;

const DEFAULT_COMMENTS_RAIL_WIDTH = 360;
const COMMENTS_RAIL_COLLAPSED_KEY = "sessions:comments-rail:collapsed";
// FEA-3642: this regex is applied ONLY to structured harness classification
// signals — a synced event's `eventType`, a turn item's `tag`, and the
// structured `data` keys below — never to free-text `summary`/`title`/`detail`/
// `text`/conversational prose. It mirrors the desktop producer's
// `SESSION_TRACE_THROTTLE_EVENT_RE` (`apps/desktop/.../session-trace.ts`), so
// the renderer's "is this a limit?" test agrees with the pipeline that emits
// `throttleSources`. Renamed from LIMIT_EVENT_TEXT_REGEX to make the
// structured-only contract explicit.

const SESSION_TRACE_HEADING_ID = "session-trace-heading";
