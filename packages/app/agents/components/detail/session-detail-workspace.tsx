"use client";

import type { AgentComponentInvocationAnchor } from "@repo/api/src/types/agent-component-invocation";
import type {
  AgentSessionDetail,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import { TIMELINE_SYNTHESIZED_COST_LEGEND } from "@repo/app/agents/components/detail/activity-bucket-rendering";
import { buildActivityBuckets } from "@repo/app/agents/components/detail/activity-bucket-synthesis";
import { SessionNameHeading } from "@repo/app/agents/components/detail/session-name-heading";
import { SessionPropertiesPanel } from "@repo/app/agents/components/detail/session-properties-panel";
import {
  hasSynthesizedBucketCosts,
  resolveTimelineCostDisclosure,
} from "@repo/app/agents/components/detail/session-timeline-bar-labels";
import { SessionStatusBadge } from "@repo/app/agents/components/session-status-badges";
import { useSessionTimelineWindow } from "@repo/app/agents/hooks/use-session-timeline-window";
import { resolveSessionDetailDisplayStatus } from "@repo/app/agents/lib/session-detail-display-status";
import { buildTraceRowInstants } from "@repo/app/agents/lib/session-timeline-geometry";
import { resolveTimelineSourceExtent } from "@repo/app/agents/lib/session-timeline-projection";
import { resolveTimelineOwnerLabel } from "@repo/app/agents/lib/session-timeline-stacks";
import { sessionTitle } from "@repo/app/agents/lib/session-title";
import { TRACE_ROW_SELECTOR } from "@repo/app/agents/lib/trace-scroll-target";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useTabParam } from "@repo/app/shared/hooks/use-tab-param";
import { computeActiveTraceRow } from "@repo/app/shared/lib/active-trace-row";
import {
  SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY,
  SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
  SESSION_TRACE_EVIDENCE_DISCLOSURE_FEATURE_FLAG_KEY,
  SESSION_TRACE_TAB_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { formatDuration } from "@repo/app/shared/lib/format-utils";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import { Tabs, TabsContent } from "@repo/design-system/components/ui/tabs";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IDENTITY_TRACE_ROW_TRANSLATORS,
  type TraceRowTranslators,
} from "../../lib/timeline-row-space";
import {
  buildActivityMarkers,
  buildLimitDotEvents,
} from "./session-activity-markers";
import { SessionActivityTimeline } from "./session-activity-timeline";
import { renderCommentsRail } from "./session-comments-rail";
import {
  SESSION_DETAIL_TABS_WITH_TRACE,
  SESSION_DETAIL_TABS_WITHOUT_TRACE,
  SessionDetailTab,
} from "./session-detail-tabs";
import { getSessionSpan } from "./session-timeline-axis";
import {
  composeTimelineLegend,
  resolveTimelineCoverageLegend,
  resolveTimelineTruncatedTilingLegend,
} from "./session-timeline-coverage";
import { SESSION_TIMELINE_LEGEND_ID } from "./session-timeline-header";
import {
  type SessionTraceCommentsHost,
  usePublishTraceJump,
} from "./session-trace-comments-host";
import type { SessionTraceHandle } from "./session-trace-contract";
import {
  getTraceCountLabel,
  SESSION_TRACE_HEADING_ID,
} from "./session-trace-header";
import { SessionTranscriptPanel } from "./session-transcript-panel";
import { SessionTraceTab } from "./trace/session-trace-tab";
import { useCommentsRailState } from "./use-comments-rail-state";
import { useTraceJump } from "./use-trace-jump";

export function SessionDetailWorkspace({
  tabParamName,
  buildTranscriptFileHref,
  rendersPropertiesCard = true,
  buildArtifactHref,
  artifactHrefPending,
  getBranchHref,
  commentsCollapsed,
  commentsWidth,
  commentsRailOpen,
  onCommentsCollapsedChange,
  onCommentsWidthChange,
  selectedThreadId,
  onRevealCommentsRail,
  session,
  transcriptFileKey,
  invocationAnchor,
  transcriptNeverExpected,
  traceCommentsHost,
  titleActions,
}: Readonly<{
  tabParamName?: string;
  buildTranscriptFileHref?: (fileKey: string) => string;
  /**
   * ISS-12269: the Properties card came off the NEW Session surface, where the
   * shell's Details tab states the same values. The legacy page has no Details
   * tab, so it keeps the card until `artifact-detail-shell` is the default —
   * removing it from both would leave a flag-off reader no properties at all.
   *
   * This is the shell telling the workspace what it already hosts, not a flag
   * read: only the shell knows it mounted a Details tab beside this panel.
   */
  rendersPropertiesCard?: boolean;
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
  /** ISS-11004: the comment a `?comment=` link addressed, if any. */
  selectedThreadId?: string | null;
  /** ISS-11004: re-open a rail the header toggle hid, for an addressed link. */
  onRevealCommentsRail?: () => void;
  session: AgentSessionDetail;
  transcriptFileKey?: string;
  invocationAnchor?: AgentComponentInvocationAnchor | null;
  /** ISS-7516: forwarded verbatim; `SessionTranscriptPanel` owns the contract. */
  transcriptNeverExpected?: boolean;
  /** Present: the shell's comments pane hosts the comments, so no legacy rail. */
  traceCommentsHost?: SessionTraceCommentsHost;
  /** ISS-12539: forwarded verbatim; `AgentSessionDetailView` owns the contract. */
  titleActions?: ReactNode;
}>) {
  /*
   * The transcript row the reader is on. Owned HERE, below the `key={session.id}`
   * this component is mounted under, and that placement is the whole point
   * (#4753 review, whitlockk).
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
  const traceRef = useRef<SessionTraceHandle | null>(null);
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
   * draws), so a sweeper-stamped `endedAt` cannot inflate either end
   * (FEA-3594), and an event dated after a stale `endedAt` lands at its true
   * fraction instead of clamping to the right edge.
   *
   * ISS-4821 review (whitlockk / codex): that same window is what PERSISTED geometry
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
  // ISS-7427, `…Optional` for the same reason as above: Storybook and the unit
  // tests mount no flag provider, and an absent provider must read as OFF.
  const evidenceDisclosureEnabled = useFeatureFlagEnabledOptional(
    SESSION_TRACE_EVIDENCE_DISCLOSURE_FEATURE_FLAG_KEY
  );
  // ISS-7427 AC5: the timeline's own gate, separate from the trace count's —
  // one qualifies a count's provenance, the other a span's coverage.
  const timelineCoverageDisclosureEnabled = useFeatureFlagEnabledOptional(
    SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY
  );
  /*
   * ISS-10737: THE ONE READ SITE for the Trace tab's gate, and it picks between
   * two whole shapes rather than handing a boolean to the tab bar, the route,
   * the query and the analytics separately (`no-threaded-feature-flag`). Flag
   * off and this view renders exactly what it rendered before the ticket: no
   * tab bar, no `?tab=` participation, and no `SessionTraceTab` in the tree, so
   * `useSessionInvocationTree` is never called and no request is issued.
   *
   * `…Optional` for the same reason its siblings above are: Storybook and the
   * unit tests mount no flag provider, and an absent provider must read as OFF.
   */
  const traceTabEnabled = useFeatureFlagEnabledOptional(
    SESSION_TRACE_TAB_FEATURE_FLAG_KEY
  );
  /*
   * `validTabs` is built from the tabs ACTUALLY RENDERED, which is what
   * `useTabParam`'s own contract asks of a flag-gated adopter: a `?tab=trace`
   * link opened by an account the flag is off for then resolves to the default
   * — today's document — instead of selecting a tab that is not mounted. The
   * default is `overview`, so an existing deep link, which carries no `?tab=`,
   * still lands where it did and still copies back out unchanged.
   */
  const { activeTab, setActiveTab } = useTabParam<SessionDetailTab>({
    paramName: tabParamName,
    defaultTab: SessionDetailTab.Overview,
    validTabs: traceTabEnabled
      ? SESSION_DETAIL_TABS_WITH_TRACE
      : SESSION_DETAIL_TABS_WITHOUT_TRACE,
  });
  /*
   * ISS-5818 (D1): the DISPLAYED status for the title chip, through the shared
   * derivation rather than the raw column, so this page and the Sessions list
   * cannot badge one row two ways.
   *
   * ISS-10364 (operator ruling, 2026-09-23/24) retired every read-time
   * derivation the chip used to carry — Unknown, Stale and Waiting — so the
   * value now depends only on the stored status. The coarse clock #4739 added
   * for the staleness cutoff went with them: nothing it advanced could change
   * the chip, so it only re-rendered this view every 30s.
   */
  const titleDisplayedStatus = resolveSessionDetailDisplayStatus({
    awaitingInputSince: session.awaitingInputSince,
    endedAt: session.endedAt,
    lastActivityAt: session.lastActivityAt,
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
  const timelineCoverageLegendText = resolveTimelineCoverageLegend({
    bucketCount: bucketStrip.buckets.length,
    disclosureEnabled: timelineCoverageDisclosureEnabled,
    evidenceCoverage: session.evidenceCoverage,
  });
  const timelineTruncatedTilingLegendText =
    resolveTimelineTruncatedTilingLegend({
      bucketCount: bucketStrip.buckets.length,
      rowsTruncated: session.activitySegmentRowsTruncated,
    });
  // ISS-5366: the ticks and the total below are formatted from ONE object, so
  // they cannot name different instants (see `getSessionSpan`).
  const span = getSessionSpan(axis);
  /*
   * ISS-4684: render the axis total in `Hh Mm` rather than a bare rounded-up
   * minute count, so a reader is not left comparing "5622m" against "93h 42m"
   * and doing the unit math by eye.
   */
  const axisDurationLabel = formatDuration(axis.start, axis.end);
  const traceCountLabel = getTraceCountLabel(session, {
    discloseEvidence: evidenceDisclosureEnabled === true,
  });

  const cancelPendingTraceScroll = useCallback(() => {
    if (rafRef.current === null) {
      return;
    }
    globalThis.cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  useEffect(() => cancelPendingTraceScroll, [cancelPendingTraceScroll]);

  // ISS-5479: every transcript jump — resolve the row, scroll, and say what the
  // attempt actually did — lives in `useTraceJump`. Extracted from this view so
  // the four callbacks that share that one concern sit together.
  const { jumpToInvocationAnchor, jumpToRow, jumpToTimelineRow } = useTraceJump(
    {
      cancelPendingTraceScroll,
      ignoreNextTraceScrollRef,
      onActiveRowChange: setActiveRow,
      scrollRef,
      traceRef,
      traceRowTranslatorsRef,
    }
  );

  // FEA-4233: the comments rail's live data + open/collapsed state (poll gating,
  // the empty-default slim handle, and the reveal callbacks) live in one hook so
  // this view stays lean. See `useCommentsRailState`.
  const {
    activeAnchor: activeTraceCommentAnchor,
    comments: traceComments,
    commentsRailCollapsed,
    collapseCommentsRail,
    expandCommentsRail,
    deleteTraceComment,
    jumpToTraceComment,
    replyToTraceComment,
    // ISS-8597: the recovery door. `useCommentsRailState` already spreads it out
    // of `useTraceComments`; this view simply never took it, so the failed badge
    // rendered with no way to act on it (tamsinb + whitlockk review of #7326).
    // `undefined` on a source that cannot dead-letter, which is what makes the
    // rail hide the button rather than offer one that rejects.
    retryTraceCommentSync,
    submitTraceCommentAndReveal,
    updateTraceComment,
  } = useCommentsRailState({
    sessionId: session.id,
    jumpToRow,
    commentsRailOpen,
    commentsCollapsed,
    onCommentsCollapsedChange,
    enabled: !traceCommentsHost,
    selectedThreadId,
    onRevealCommentsRail,
  });
  usePublishTraceJump(traceCommentsHost, jumpToRow);

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

  const commentsRail = traceCommentsHost
    ? null
    : renderCommentsRail({
        activeRow,
        collapsed: commentsRailCollapsed,
        comments: traceComments,
        onCollapse: collapseCommentsRail,
        onDelete: deleteTraceComment,
        onExpand: expandCommentsRail,
        onJump: jumpToTraceComment,
        onReply: replyToTraceComment,
        onRetrySync: retryTraceCommentSync,
        onUpdate: updateTraceComment,
        onWidthChange: onCommentsWidthChange,
        open: commentsRailOpen,
        selectedThreadId,
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
  // ISS-7115: the timeline places the reader by INSTANT, because `_row` is not a
  // reading-order ordinal across a sub-session boundary. Memoized because this
  // re-derives on every rAF-throttled scroll frame and `turnItems` can be
  // thousands of rows.
  const traceRowInstants = useMemo(
    () => buildTraceRowInstants(session.turnItems ?? []),
    [session.turnItems]
  );
  const timelineActiveRowMs =
    timelineActiveRow == null
      ? null
      : (traceRowInstants.get(timelineActiveRow) ?? null);

  /*
   * ISS-5818 (D1): name + status on one line, the prototype's
   * `session-detail.tsx:72-79`. The chip is the SAME `SessionStatusBadge` the
   * Sessions list row renders (`session-cell-renderers.tsx`), fed by
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
        {/* ISS-8718: the owner's inline rename lives behind this heading, which
            renders byte-identically for every viewer the gate turns down. */}
        <SessionNameHeading session={session} title={sessionTitle(session)} />
        <SessionStatusBadge
          artifactId={session.id}
          status={titleDisplayedStatus}
        />
        {titleActions ? (
          <div className="ml-auto flex items-center gap-2">{titleActions}</div>
        ) : null}
      </div>
    </header>
  );

  const timelineStrip = (
    <SessionActivityTimeline
      activeRow={timelineActiveRow}
      activeRowMs={timelineActiveRowMs}
      axisDurationLabel={axisDurationLabel}
      barCostsUnpublished={timelineDisclosure.barCostsUnpublished}
      buckets={bucketStrip.buckets}
      costUnmeasured={timelineDisclosure.costUnmeasured}
      disabled={!traceHasRenderedRows}
      eventsTruncated={session.eventsTruncated}
      isRowInReadTranscript={isTimelineRowInReadTranscript}
      /*
       * ISS-7427 AC5 / ISS-9858: only when an EXTENT withdrawal is rendering —
       * the ISS-7427 coverage caption or the ISS-9858 tiling note. Both say the
       * strip may not span the whole session, and the line sits outside the
       * region, so without this a screen-reader user traverses the timeline
       * before hearing it. The cost legend alone never drives this id: it sits
       * in the same line behind its own flag, and pointing the region at it
       * would change a surface neither of these owns.
       */
      legendId={
        timelineCoverageLegendText === null &&
        timelineTruncatedTilingLegendText === null
          ? undefined
          : SESSION_TIMELINE_LEGEND_ID
      }
      limitDotEvents={limitDotEvents}
      markers={markers}
      onJump={jumpToTimelineRow}
      ownerLabel={resolveTimelineOwnerLabel(session)}
      /*
       * ISS-5850: the extent the producer's bins actually TILE, which is NOT the
       * window above.
       *
       * `session.span`, NOT the `span` prop below: that one is
       * `getSessionSpan(axis)`, a display span this module derives from the axis
       * and which deliberately never consults the server's value, so it carries
       * the formatted ticks and never the producer's instants. Reading it here
       * would resolve to `null` on every session and silently disable the
       * disclosure everywhere.
       *
       * Resolved through the one parser that knows how to refuse a half-stated,
       * inverted or version-skewed value. `null` — an older desktop build that
       * never sent it — leaves every column's coverage `Unknown`, and the strip
       * behaves exactly as it did before this ticket.
       *
       * WITHHELD ENTIRELY ON A SYNTHESIZED STRIP (ISS-5850 code review), and
       * that guard is the whole correctness of this line. `session.span` is the
       * DESKTOP COLLECTOR's extent, but `buckets` above is
       * `bucketStrip.buckets`, which is the turn-item strip whenever
       * `session.activityBuckets` came back empty — a different producer,
       * binning over the full axis window. Handing one producer's extent to
       * another producer's bins marks every synthesized bar outside it
       * "unmeasured" while it is visibly drawing a bar, and, because the
       * unmeasured branch is tested first, swallows ISS-5566's synthesized-cost
       * disclosure on precisely the strip that disclosure exists for.
       */
      sourceExtent={
        bucketStrip.synthesized
          ? null
          : resolveTimelineSourceExtent(session.span)
      }
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
  /* ISS-7427 AC5: a SECOND, orthogonal withdrawal in the same slot and for the
     same FEA-4025 reason. The cost legend says the bars' HEIGHTS are not
     measured money; this one says their EXTENT may not be the whole session. Both
     can be true of one strip, so they are middot-joined into ONE line rather
     than stacked as two identically-styled paragraphs, which read as a single
     sentence wrapping. A lone surviving note comes back verbatim, so a strip
     carrying only the cost legend is byte-identical to today. */
  const timelineLegendText = composeTimelineLegend([
    timelineDisclosure.costUnmeasured ? TIMELINE_SYNTHESIZED_COST_LEGEND : null,
    timelineCoverageLegendText,
    timelineTruncatedTilingLegendText,
  ]);
  const timelineLegend =
    timelineLegendText === null ? null : (
      <p
        className="mb-1 text-muted-foreground text-xs"
        id={SESSION_TIMELINE_LEGEND_ID}
      >
        {timelineLegendText}
      </p>
    );

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
        highlightAnchor={
          traceCommentsHost
            ? traceCommentsHost.highlightAnchor
            : activeTraceCommentAnchor
        }
        invocationAnchor={invocationAnchor}
        onInvocationAnchorResolved={jumpToInvocationAnchor}
        onJump={jumpToRow}
        onSubmitTraceComment={
          traceCommentsHost ? undefined : submitTraceCommentAndReveal
        }
        onTraceRowTranslatorChange={registerTraceRowTranslator}
        onTraceSelectionChange={traceCommentsHost?.onTraceSelectionChange}
        scrollElementRef={scrollRef}
        session={session}
        traceRef={traceRef}
        transcriptNeverExpected={transcriptNeverExpected}
      />
    </div>
  );

  const propertiesPanel = (
    <SessionPropertiesPanel
      artifactHrefPending={artifactHrefPending}
      buildArtifactHref={buildArtifactHref}
      displayedStatus={titleDisplayedStatus}
      getBranchHref={getBranchHref}
      session={session}
      transcriptNeverExpected={transcriptNeverExpected}
    />
  );

  /*
   * ISS-10737: today's single scrolling document, lifted into a named region so
   * it can be BOTH the whole page (Trace flag off) and the `overview` tab's
   * content (flag on) from one definition. Nothing inside it changed: with the
   * flag off the tree below renders exactly what it rendered before the tab bar
   * existed.
   */
  const overviewRegion = (
    <>
      {rendersPropertiesCard ? propertiesPanel : null}
      {/* `.sd3-props` ends flush and the sticky box has no top spacing of
              its own, so without this the strip butts against the pinned
              header's fill. The prototype clears it by ~40px (`pb-6` on the
              identity block plus `py-4` inside the sticky box). */}
      <div className="sd3-stickyhead is-sticky mt-6">{timelineStrip}</div>
      {timelineLegend}

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
    </>
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
            {traceTabEnabled ? (
              <Tabs onValueChange={setActiveTab} value={activeTab}>
                {/* The BranchDetailPage tab bar, so the two sibling detail
                    surfaces present a tabbed page the same way rather than
                    growing a second tabbing idiom. */}
                <div className="overflow-x-auto pb-1">
                  <UnderlineTabsList className="min-w-0">
                    <UnderlineTabsTrigger value={SessionDetailTab.Overview}>
                      Overview
                    </UnderlineTabsTrigger>
                    <UnderlineTabsTrigger value={SessionDetailTab.Trace}>
                      Trace
                    </UnderlineTabsTrigger>
                  </UnderlineTabsList>
                </div>
                <TabsContent value={SessionDetailTab.Overview}>
                  {overviewRegion}
                </TabsContent>
                <TabsContent value={SessionDetailTab.Trace}>
                  <SessionTraceTab sessionId={session.id} />
                </TabsContent>
              </Tabs>
            ) : (
              overviewRegion
            )}
          </article>
        </div>
      </div>

      {commentsRail}
    </div>
  );
}

export const DEFAULT_COMMENTS_RAIL_WIDTH = 360;
export const COMMENTS_RAIL_COLLAPSED_KEY = "sessions:comments-rail:collapsed";
// FEA-3642: this regex is applied ONLY to structured harness classification
// signals — a synced event's `eventType`, a turn item's `tag`, and the
// structured `data` keys below — never to free-text `summary`/`title`/`detail`/
// `text`/conversational prose. It mirrors the desktop producer's
// `SESSION_TRACE_THROTTLE_EVENT_RE` (`apps/desktop/.../session-trace.ts`), so
// the renderer's "is this a limit?" test agrees with the pipeline that emits
// `throttleSources`. Renamed from LIMIT_EVENT_TEXT_REGEX to make the
// structured-only contract explicit.
