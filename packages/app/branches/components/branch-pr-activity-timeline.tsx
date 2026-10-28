"use client";

import { resolveAttributedBranchCost } from "@repo/api/src/types/branch-cost";
import type { SessionTimelineDetail } from "@repo/api/src/types/document-sessions";
// ISS-12665: the Session Timeline's peak-column fact, shared so both timeline
// headers state the peak with one label and one format.
import { TimelinePeakBucketFact } from "@repo/app/agents/components/detail/timeline-peak-bucket-fact";
import {
  TIMELINE_SCALE_OPTIONS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import { formatBranchDurationMs } from "@repo/app/branches/lib/format-branch-duration-ms";
import { TimelineGroupByControl } from "@repo/app/shared/components/timeline-group-by-control";
import {
  TimelinePositionScrubber,
  TimelineScaleControl,
} from "@repo/app/shared/components/timeline-scale-control";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY,
  BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import {
  formatCostPrecise,
  formatLocPerDollar,
} from "@repo/app/shared/lib/format-utils";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { ActivityIcon } from "lucide-react";
import { memo, type ReactNode, useId, useMemo, useState } from "react";
import { locPerDollar } from "../lib/branch-derivations";
import {
  BRANCH_TIMELINE_GROUPING_OPTIONS,
  buildSessionTimeline,
  DEFAULT_BRANCH_TIMELINE_GROUPING,
  type SessionTimeline,
  type TimelineColumn,
} from "../lib/branch-session-buckets";
import { formatClock } from "../lib/branch-timeline-range";
import { resolveChurn } from "../lib/preferred-branch-loc";
import {
  type BranchPrActivityTimelineProps,
  buildTimelineLegend,
  detailForLoadedTimelineSessions,
  formatTimelineBarLabel,
  formatTimelineCompletenessDisclosure,
  formatTimelineEvidenceValue,
  formatTimelineSegmentCost,
  formatTimelineTokens,
  hasLocPerDollarRatio,
  resolveTimelineCostEvidence,
  resolveTimelineNoBarsMessage,
  resolveTimelineTraceEvidence,
  TIMELINE_TOKEN_PARTS,
  type TimelineCostEvidence,
  type TimelineLegendEntry,
  type TimelineTraceEvidence,
  timelineBarHeightPercent,
} from "./branch-pr-activity-timeline-helpers";
import { buildTimelineHumanActorDomain } from "./branch-timeline-human-domain";
import {
  type BranchTipAnchor,
  BranchTipPortal,
  tipAnchorFromElement,
} from "./branch-tip-portal";

/**
 * Per-hour-by-USER stacked cost bars (Epic E / E1, FEA-3576) — the design
 * handoff's `BQActivity` timeline. One stacked bar per clock-hour across the
 * branch span, segmented BY the human stakeholder/user who spent the money and
 * sized BY that user's COST (e.g. Cosimo's spend vs Tamsin's spend within each
 * hour), colored by a shared per-user domain. Each session's cost is distributed
 * across the hours its ACTIVE bursts span (so idle hours render as hatched gaps
 * and a costly hour is a taller bar). Bar height is sqrt-scaled to the costliest
 * hour. Hovering a bar opens the design's `bq-tip` card (the hour, total cost,
 * and a per-user cost + input/output/cache token split).
 *
 * Before FEA-3576 this segmented by the session/model ACTOR and sized by token
 * count (cost only appeared in the header stat); the design intends per-user
 * cost, so segmentation + size are now the user and their spend.
 *
 * Sessions-driven (not `usage.hourBuckets`): in v1 the usage rollup is
 * unattributed (`owner: null`) and underpopulated, so E1 reads the same
 * sessions + merged trace the swimlane/trace use, keeping the page consistent and
 * attributed. Purely presentational over `SessionTimelineDetail`.
 *
 * Degraded states (sessions exist but timing cannot produce bars) keep the
 * section header and its cost/LOC/duration stats and swap only the bars area for
 * a message. Zero-cost and unavailable-cost activity still renders an actor bar
 * so the timestamp-driven playhead never floats over a falsely idle bucket.
 */
/**
 * The standalone empty state, shown ONLY when the branch has zero linked
 * sessions. When sessions exist but no bars can be drawn we keep the section and
 * its stats and show a `noBarsMessage` inside the bars area instead (see
 * `resolveNoBarsMessage`) — never a false "no sessions" claim above a real
 * trace. That is the FEA-4269 fix. `size="compact"` because this sits in-panel
 * next to other content, not as the main event (matches `branches-empty-state`).
 */
function resolveNoSessionsState({
  className,
  sessionCount,
}: {
  className?: string;
  sessionCount: number;
}): ReactNode {
  if (sessionCount > 0) {
    return null;
  }
  return (
    <EmptyState
      className={className}
      description="No sessions have run on this branch yet."
      icon={ActivityIcon}
      size="compact"
      title="No sessions on this branch yet"
    />
  );
}

/**
 * The message shown in place of the bars when sessions exist but the cost-sized
 * chart can't be drawn — or null when there ARE bars. Two distinct causes, two
 * distinct messages (Threads 0/1): zero columns means the session timing has no
 * measurable duration to chart, whereas `maxTotal <= 0` (columns exist but the
 * whole span is un-priced) means cost hasn't been attributed yet. Collapsing
 * both into "cost pending" is misleading when cost IS priced but timing isn't.
 * Assumes `sessionCount > 0` (the caller renders the standalone state otherwise).
 */
export const BranchPrActivityTimeline = memo(function BranchPrActivityTimeline({
  detail,
  showBranchContext = true,
  traceState,
  isLoading = false,
  actorDomain,
  activeHourStart,
  activeFraction,
  grouping = DEFAULT_BRANCH_TIMELINE_GROUPING,
  scale = TimelineScale.OneHour,
  windowStart = 0,
  onGroupingChange,
  onPositionChange,
  onScaleChange,
  onWindowStartChange,
  onScrubHour,
  positionColumn,
  loc,
  children,
  className,
}: BranchPrActivityTimelineProps) {
  // ISS-5951 / ISS-5747 (ISS-4779 closed-by-default). Read above the early
  // returns so hook order is stable, and through the optional port because this
  // shared component also mounts in Storybook and tests that wire no flag
  // adapter; there it resolves off, matching the shipped default.
  const fallbackCostMarkerEnabled = useFeatureFlagEnabledOptional(
    BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY
  );
  const renderedDetail = useMemo(
    () =>
      detailForLoadedTimelineSessions(detail, traceState, {
        requireKnownLoadedCost: fallbackCostMarkerEnabled,
      }),
    [detail, fallbackCostMarkerEnabled, traceState]
  );
  const domain = useMemo(
    () =>
      actorDomain ?? buildTimelineHumanActorDomain(renderedDetail, traceState),
    [actorDomain, renderedDetail, traceState]
  );
  const timeline = useMemo(
    () =>
      buildSessionTimeline(renderedDetail, domain, grouping, {
        scale,
        windowStart,
      }),
    [renderedDetail, domain, grouping, scale, windowStart]
  );
  const {
    chartableCostUsd,
    columns,
    maxTotal,
    nonBucketableSessions,
    truncatedSessions,
    startMs,
    endMs,
    fullStartMs,
    fullEndMs,
  } = timeline;
  const timingDisclosureId = useId();
  if (isLoading) {
    return <Skeleton className={cn("h-[140px] w-full", className)} />;
  }

  // Distinct sessions (deduped by `sessionId`, the SAME key the bars use) — a
  // branch can carry duplicate session rows (one per PR link), so this, not
  // `detail.sessions.length`, is the count every "N sessions" surface must show.
  // Reusing the timeline's own count keeps the message from double-counting a
  // session repeated across two links (FEA-4269 review, whitlockk). The true-empty
  // guard stays a raw-length boolean: zero rows ⇔ zero distinct sessions.
  const sessionCount = timeline.distinctSessionCount;
  const noSessionsState = showBranchContext
    ? resolveNoSessionsState({
        className,
        sessionCount: detail.sessions.length,
      })
    : null;
  if (noSessionsState) {
    return noSessionsState;
  }

  // Sessions exist but timing cannot produce a bucketizable duration. Keep the
  // section + stats and swap only the bars area for this message.
  const noBarsMessage = resolveTimelineNoBarsMessage({
    columnCount: columns.length,
    sourceSessionCount: new Set(
      detail.sessions.map(({ sessionId }) => sessionId)
    ).size,
    sessionCount,
    traceCompleteness: traceState?.aggregateCompleteness.state,
    showBranchContext,
  });
  const authoritativeCost = resolveAttributedBranchCost(renderedDetail);
  // whitlockk review: `detailForLoadedTimelineSessions` rewrites a legacy Branch's
  // null total to the loaded-Session subtotal, so `authoritativeCost` above can
  // be a settled number for a Branch that still has no total of its own. Source
  // absence is therefore read from the UNREWRITTEN `detail` and carried
  // separately, never inferred from the figure the rewrite produced.
  const sourceCostUnpriced = resolveAttributedBranchCost(detail) === null;
  const timingIncomplete =
    formatTimelineCompletenessDisclosure(
      nonBucketableSessions,
      truncatedSessions
    ) !== null;
  // `formatTimelineEvidenceValue` marks figures from this on its own, so it has
  // to reach the predicate that decides describedby and the disclosure — a
  // marker whose footnote does not exist is the same defect in a new shape.
  //
  // davetho review: this reads the boundary ONCE, and a trace that never
  // arrived is its own answer rather than the one a confirmed-complete trace
  // gives. Both this component and `formatTimelineEvidenceValue` take that one
  // answer, so neither can decide the evidence question for itself.
  const traceEvidence = resolveTimelineTraceEvidence(traceState);
  // Prefer the Branch-level authoritative cost when it exists and every loaded
  // Session can be charted. Otherwise use the defensible rendered subtotal so
  // the headline still reconciles with priced bars.
  //
  // ISS-7180 ruled `BranchMetricId.DetailLocPerDollar` — the headline card's
  // Branch-lifetime ratio — canonical for Branch detail. This stat is the OTHER
  // estimand and still renders the bare metric name: the approved vocabulary
  // separates LOC/$ by basis, never by scope (ISS-10667 R4a), so no human-authored
  // phrase distinguishing the two exists yet. Do not compose one here.
  //
  // LOC/$ mixes populations, so do not read it as Branch-level: `churn` below is
  // taken from the UNREWRITTEN `detail`, while its denominator is
  // `authoritativeCost` off `renderedDetail`, which
  // `detailForLoadedTimelineSessions` may already have rewritten to the
  // loaded-Session subtotal. Which population both ends should share is ISS-7836.
  //
  // ISS-5951: the figure, its marker, and the sentence explaining the marker all
  // come from this ONE call. The selection rule used to live here while the
  // marker was decided separately at the render site, and the two disagreed for
  // the no-authoritative-cost arm — a fallback figure with nothing saying so.
  // ISS-5747: when the loaded-cost projection resolved to unknown, the charted
  // subtotal cannot resurrect unavailable rows as zero.
  const chartableCostForEvidence =
    (fallbackCostMarkerEnabled || !showBranchContext) &&
    renderedDetail.estimatedCostUsd === null
      ? null
      : chartableCostUsd;
  const costEvidence = resolveTimelineCostEvidence({
    authoritativeCostUsd: authoritativeCost,
    chartableCostUsd: chartableCostForEvidence,
    discloseFallbackReasons: fallbackCostMarkerEnabled,
    sourceCostUnpriced,
    timingIncomplete,
    traceEvidence,
  });
  // Rebuilt with the cost's own fallback reasons folded in, so every `*` this
  // section renders resolves to a sentence in the one disclosure paragraph. Both
  // reasons come back from the single predicate above rather than being re-read
  // here, so the sentence can never describe a state the marker disagrees with.
  const timingDisclosure = formatTimelineCompletenessDisclosure(
    nonBucketableSessions,
    truncatedSessions,
    {
      incompleteTraceEvidence: costEvidence.incompleteTraceEvidence,
      unpricedBranch: costEvidence.unpricedBranchFallback,
    }
  );
  // An `aria-describedby` pointing at a node that never rendered is worse than
  // no marker, so the id is only ever handed out alongside its paragraph.
  const disclosureId = timingDisclosure ? timingDisclosureId : undefined;
  // Prefer the connected PR's live LOC (authoritative) over enrichment columns.
  const churn = resolveChurn(loc, detail);
  const locPerDollarValue = locPerDollar({
    churn,
    totalCostUsd: authoritativeCost,
  });
  const wallClockMs =
    fullStartMs != null && fullEndMs != null ? fullEndMs - fullStartMs : null;

  const legend = buildTimelineLegend(columns);
  const handlePositionChange = onPositionChange ?? onWindowStartChange;

  return (
    <section className={cn("bq-act", className)}>
      <TimelineHeader
        costEvidence={costEvidence}
        detail={detail}
        disclosureId={disclosureId}
        grouping={grouping}
        legend={legend}
        locPerDollarValue={locPerDollarValue}
        onGroupingChange={onGroupingChange}
        onScaleChange={onScaleChange}
        peakColumnCostUsd={resolvePeakColumnCost(costEvidence, timeline)}
        scale={scale}
        sessionCount={sessionCount}
        showBranchContext={showBranchContext}
        timingIncomplete={timingIncomplete}
        totalSessionCount={
          showBranchContext ? undefined : traceState?.qualifyingSessionCount
        }
        traceEvidence={traceEvidence}
        wallClockMs={wallClockMs}
      />

      {noBarsMessage ? (
        <p className="bq-act-nobars">{noBarsMessage}</p>
      ) : (
        <TimelineChart
          activeFraction={activeFraction}
          activeHourStart={activeHourStart}
          columns={columns}
          endMs={endMs}
          maxTotal={maxTotal}
          onScrubHour={onScrubHour}
          startMs={startMs}
        >
          {children}
        </TimelineChart>
      )}
      {!noBarsMessage && timeline.maxWindowStart > 0 && handlePositionChange ? (
        <TimelinePositionScrubber
          className="mt-3 flex items-center gap-3"
          leadingLabel={showBranchContext ? "Branch" : "Sessions"}
          onPositionChange={handlePositionChange}
          position={clampScrubberColumn(
            positionColumn ?? timeline.windowStart,
            timeline.totalColumns
          )}
          title={showBranchContext ? "Branch timeline position" : "Sessions"}
          totalColumns={timeline.totalColumns}
        />
      ) : null}
      {timingDisclosure ? (
        <p
          className="mt-2 text-muted-foreground text-xs"
          id={timingDisclosureId}
        >
          {timingDisclosure}
        </p>
      ) : null}
    </section>
  );
});

function clampScrubberColumn(column: number, totalColumns: number): number {
  if (!(Number.isFinite(column) && totalColumns > 0)) {
    return 0;
  }
  return Math.max(0, Math.min(totalColumns - 1, Math.round(column)));
}

function TimelineHeader({
  costEvidence,
  showBranchContext,
  detail,
  disclosureId,
  grouping,
  legend,
  locPerDollarValue,
  onGroupingChange,
  onScaleChange,
  peakColumnCostUsd,
  scale,
  sessionCount,
  totalSessionCount,
  timingIncomplete,
  traceEvidence,
  wallClockMs,
}: {
  costEvidence: TimelineCostEvidence;
  showBranchContext: boolean;
  detail: SessionTimelineDetail;
  disclosureId?: string;
  grouping: BranchPrActivityTimelineProps["grouping"];
  legend: readonly TimelineLegendEntry[];
  locPerDollarValue: number | null;
  onGroupingChange?: BranchPrActivityTimelineProps["onGroupingChange"];
  onScaleChange?: BranchPrActivityTimelineProps["onScaleChange"];
  peakColumnCostUsd: number | null;
  scale: TimelineScale;
  sessionCount: number;
  totalSessionCount?: number | null;
  timingIncomplete: boolean;
  traceEvidence: TimelineTraceEvidence;
  wallClockMs: number | null;
}) {
  return (
    <div className="bq-act-head">
      <div className="bq-act-head-left">
        <div className="bq-act-title-row">
          <span className="bq-act-title">
            {showBranchContext ? "PR timeline" : "Sessions"}
            {showBranchContext || totalSessionCount !== null ? (
              <span className="bq-act-sub">
                {" "}
                ·{" "}
                {timelineSessionLabel(
                  sessionCount,
                  detail.sessions,
                  totalSessionCount
                )}
              </span>
            ) : null}
          </span>
          <TimelineLegend legend={legend} />
        </div>
        {onScaleChange ? (
          <TimelineScaleControl
            className="bq-act-scale"
            itemClassName="px-2.5"
            onValueChange={onScaleChange}
            options={TIMELINE_SCALE_OPTIONS}
            title="Timeline scale"
            value={scale}
          />
        ) : null}
      </div>
      <div className="bq-act-head-right">
        <TimelineHeaderStats
          costEvidence={costEvidence}
          disclosureId={disclosureId}
          locPerDollarValue={locPerDollarValue}
          peakColumnCostUsd={peakColumnCostUsd}
          scale={scale}
          showBranchContext={showBranchContext}
          timingIncomplete={timingIncomplete}
          traceEvidence={traceEvidence}
          wallClockMs={wallClockMs}
        />
        {onGroupingChange ? (
          <TimelineGroupByControl
            onValueChange={onGroupingChange}
            options={BRANCH_TIMELINE_GROUPING_OPTIONS}
            title={
              showBranchContext ? "Group branch timeline bars by" : "Group by"
            }
            triggerClassName="h-[34px] w-[184px]"
            value={grouping ?? DEFAULT_BRANCH_TIMELINE_GROUPING}
          />
        ) : null}
      </div>
    </div>
  );
}

function TimelineLegend({
  legend,
}: {
  legend: readonly TimelineLegendEntry[];
}) {
  return (
    <div className="bq-act-legend">
      {legend.map((entry) => (
        <span
          className="bq-lg"
          key={entry.key}
          title={`${entry.label} · ${formatCostPrecise(entry.total)}`}
        >
          <span
            className="bq-lg-sw"
            style={{
              background: entry.color,
            }}
          />
          <span className="bq-lg-name">{entry.label}</span>
        </span>
      ))}
    </div>
  );
}

function TimelineHeaderStats({
  costEvidence,
  showBranchContext,
  disclosureId,
  locPerDollarValue,
  peakColumnCostUsd,
  scale,
  timingIncomplete,
  traceEvidence,
  wallClockMs,
}: {
  costEvidence: TimelineCostEvidence;
  showBranchContext: boolean;
  disclosureId?: string;
  locPerDollarValue: number | null;
  /** ISS-12665: the costliest column across the whole span at `scale`. */
  peakColumnCostUsd: number | null;
  scale: TimelineScale;
  timingIncomplete: boolean;
  traceEvidence: TimelineTraceEvidence;
  wallClockMs: number | null;
}) {
  // ISS-6958 (ISS-4779 closed-by-default): this strip is where a 53-hour cycle
  // rendered "3180m 0s". Optional port because the component also mounts in
  // Storybook and tests that wire no adapter; off there, matching the default.
  const honest = useFeatureFlagEnabledOptional(
    BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY
  );
  const format = honest ? formatBranchDurationMs : formatDurationMs;
  const locPerDollarLabel = formatTimelineEvidenceValue(
    formatLocPerDollar(locPerDollarValue),
    traceEvidence,
    {
      incomplete: costEvidence.unpricedBranchFallback,
      unavailable: costEvidence.evidenceMissing,
    }
  );
  // Agreed design: ISS-8358 prototype,
  // `packages/app/branches/components/prototype-preview/components/branch-sessions-timeline.tsx` (ISS-12207).
  return (
    <div className="bq-stats">
      <span className="bq-stat">
        <b
          aria-describedby={costEvidence.incomplete ? disclosureId : undefined}
        >
          {formatTimelineEvidenceValue(
            costEvidence.value == null
              ? "—"
              : formatCostPrecise(costEvidence.value),
            traceEvidence,
            {
              incomplete: costEvidence.incomplete,
              unavailable:
                costEvidence.evidenceMissing || costEvidence.value == null,
            }
          )}
        </b>{" "}
        cost
      </span>
      {/* ISS-12665: the span is a Branch's sessions, not one session, so the
          prototype's "across the full session" explanation is not carried. The
          peak is read off the same rendered columns as duration, so it carries
          duration's marker and disclosure (#9008 review, whitlockk). */}
      <span className="bq-stat">
        <TimelinePeakBucketFact
          costUsd={peakColumnCostUsd}
          describedBy={
            timingIncomplete || costEvidence.incompleteTraceEvidence
              ? disclosureId
              : undefined
          }
          explainsFullSession={false}
          markValue={(formatted) =>
            formatTimelineEvidenceValue(formatted, traceEvidence, {
              incomplete: timingIncomplete,
            })
          }
          scale={scale}
        />
      </span>
      {showBranchContext ? (
        <span className="bq-stat bq-stat-loc">
          <b
            aria-describedby={
              costEvidence.incompleteTraceEvidence ||
              costEvidence.unpricedBranchFallback
                ? disclosureId
                : undefined
            }
          >
            {locPerDollarLabel}
          </b>
          {hasLocPerDollarRatio(
            locPerDollarValue,
            traceEvidence,
            costEvidence.evidenceMissing
          )
            ? " LOC/$"
            : null}
        </span>
      ) : null}
      <span className="bq-stat">
        <span className="sr-only">Duration: </span>
        <b
          aria-describedby={
            timingIncomplete || costEvidence.incompleteTraceEvidence
              ? disclosureId
              : undefined
          }
        >
          {formatTimelineEvidenceValue(
            wallClockMs == null ? "—" : format(wallClockMs),
            traceEvidence,
            {
              incomplete: timingIncomplete,
              unavailable:
                costEvidence.evidenceMissing ||
                (wallClockMs == null && timingIncomplete),
            }
          )}
        </b>
      </span>
    </div>
  );
}

/**
 * The drawable chart region — the "you are here" line, the interactive bars +
 * hover card, the event-dot rail (`children`), and the time axis. Owns the hover
 * state (only the bars use it) and is only rendered when there ARE bars to draw,
 * so the parent function stays under the cognitive-complexity ceiling.
 */
function TimelineChart({
  columns,
  maxTotal,
  startMs,
  endMs,
  activeHourStart,
  activeFraction,
  onScrubHour,
  children,
}: {
  columns: TimelineColumn[];
  maxTotal: number;
  startMs: number | null;
  endMs: number | null;
  activeHourStart?: string | null;
  activeFraction?: number | null;
  onScrubHour?: (hourStart: string) => void;
  children?: ReactNode;
}) {
  const [hover, setHover] = useState<{
    index: number;
    anchor: BranchTipAnchor;
  } | null>(null);
  const hoverIndex = hover?.index ?? null;
  const hoverColumn = hoverIndex == null ? null : columns[hoverIndex];
  const barRenderData = useMemo(
    () => columns.map((column) => buildTimelineBarRenderData(column, maxTotal)),
    [columns, maxTotal]
  );

  return (
    <>
      <div className="bq-bars-wrap">
        {activeFraction == null ? null : (
          <div
            aria-hidden
            className="tl-here"
            style={{
              left: `${Math.min(100, Math.max(0, activeFraction * 100))}%`,
            }}
          />
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: container only clears the hover tooltip; bars carry the interactivity */}
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: container only clears the hover tooltip; bars carry the interactivity */}
        <div className="bq-bars" onMouseLeave={() => setHover(null)}>
          {barRenderData.map((bar, index) => (
            <TimelineBar
              active={
                activeHourStart != null &&
                bar.column.hourStart === activeHourStart
              }
              ariaLabel={bar.ariaLabel}
              column={bar.column}
              heightPercent={bar.heightPercent}
              hovered={hoverIndex === index}
              key={bar.column.hourStart}
              onHover={(anchor) => setHover({ anchor, index })}
              onLeave={() => setHover(null)}
              onScrubHour={onScrubHour}
              segmentHeights={bar.segmentHeights}
            />
          ))}
        </div>
        {hover && hoverColumn && !hoverColumn.isGap ? (
          <BarTip anchor={hover.anchor} column={hoverColumn} />
        ) : null}
      </div>

      {/* Event-dot rail slots between the bars and the axis (bars → dots → axis,
          matching the Session timeline). */}
      {children}

      {startMs != null && endMs != null ? (
        <div className="bq-axis">
          <span className="font-mono">{formatClock(startMs)}</span>
          <span className="font-mono">{formatClock(endMs)}</span>
        </div>
      ) : null}
    </>
  );
}

/** The design's `bq-tip`: hour + total COST, then a per-USER cost + io/cache
 *  token split. The header + per-user figures are DOLLARS; the Input/Output/Cache
 *  split underneath is TOKENS — the two units are labeled ("Tokens" caption) and
 *  visually separated so a reader never reads the token counts as sub-costs of
 *  the dollar figure above them. Portaled to <body> so it's never clipped behind
 *  the sticky chrome. */
function BarTip({
  column,
  anchor,
}: {
  column: TimelineColumn;
  anchor: BranchTipAnchor;
}) {
  return (
    <BranchTipPortal anchor={anchor}>
      <div className="bq-tip-h">
        <b>{formatClock(Date.parse(column.hourStart))}</b>
        <span className="font-mono">{formatCostPrecise(column.total)}</span>
      </div>
      {column.segments.map((segment) => (
        <div className="bq-tip-srow" key={segment.key}>
          <div className="bq-tip-row">
            <span className="bq-tip-sw" style={{ background: segment.color }} />
            <span className="bq-tip-name">{segment.label}</span>
            <span className="bq-tip-tok font-mono">
              {formatTimelineSegmentCost(segment)}
            </span>
          </div>
          <div className="bq-tip-split">
            {/* Unit boundary: everything above is USD, the rows below are TOKENS.
                The caption keeps the eye from reading them as cents.

                ISS-10691: deliberately outside the canonical metric vocabulary
                (ruling of 2026-09-19) — that vocabulary governs a label naming
                ONE measured figure, and a unit caption names none. */}
            <span className="bq-tip-splitlabel">Tokens</span>
            {TIMELINE_TOKEN_PARTS.map((part) => (
              <span className="bq-tip-sp" key={part.key}>
                <span
                  className="bq-tip-spdot"
                  style={{ background: part.color }}
                />
                <span className="bq-tip-spk">{part.label}</span>
                <span className="bq-tip-spv font-mono">
                  {formatTimelineTokens(segment[part.key])}
                </span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </BranchTipPortal>
  );
}

function TimelineBar({
  column,
  heightPercent,
  hovered,
  active,
  ariaLabel,
  segmentHeights,
  onScrubHour,
  onHover,
  onLeave,
}: {
  column: TimelineColumn;
  heightPercent: number;
  hovered: boolean;
  active: boolean;
  ariaLabel: string;
  segmentHeights: readonly TimelineSegmentRenderData[];
  onScrubHour?: (hourStart: string) => void;
  onHover: (anchor: BranchTipAnchor) => void;
  onLeave: () => void;
}) {
  // Concurrency is already legible from a bar's stacked multi-actor colors, so it
  // carries no extra border (only the semantic `data-concurrent` hook remains).
  const classes = cn(
    "bq-bar",
    column.isGap && "idle",
    (hovered || active) && "hot"
  );
  const segments = segmentHeights.map(
    ({ heightPercent: segmentHeight, segment }) => (
      <i
        data-actor-key={segment.key}
        key={segment.key}
        style={{
          height: `${segmentHeight}%`,
          background: segment.color,
        }}
      />
    )
  );
  const dataConcurrent = column.hasConcurrency ? "true" : undefined;
  const dataGap = column.isGap ? "true" : undefined;

  if (onScrubHour) {
    return (
      <button
        aria-label={ariaLabel}
        className={classes}
        data-concurrent={dataConcurrent}
        data-gap={dataGap}
        onBlur={onLeave}
        onClick={() => onScrubHour(column.hourStart)}
        onFocus={(event) => onHover(tipAnchorFromElement(event.currentTarget))}
        onMouseEnter={(event) =>
          onHover(tipAnchorFromElement(event.currentTarget))
        }
        style={{ height: `${heightPercent}%` }}
        type="button"
      >
        {segments}
      </button>
    );
  }

  return (
    <div
      className={classes}
      data-concurrent={dataConcurrent}
      data-gap={dataGap}
      style={{ height: `${heightPercent}%` }}
    >
      {segments}
    </div>
  );
}

function segmentHeightPercent(
  segment: TimelineColumn["segments"][number],
  column: TimelineColumn,
  activityOnlyCount: number
): number {
  if (column.total > 0 && activityOnlyCount > 0) {
    const reservedPercent = Math.min(
      MAX_ACTIVITY_ONLY_RESERVE_PERCENT,
      activityOnlyCount * ACTIVITY_ONLY_SEGMENT_PERCENT
    );
    if (segment.value <= 0) {
      return reservedPercent / activityOnlyCount;
    }
    return (segment.value / column.total) * (100 - reservedPercent);
  }
  if (column.total > 0) {
    return (segment.value / column.total) * 100;
  }
  return 100 / Math.max(1, column.segments.length);
}

const ACTIVITY_ONLY_SEGMENT_PERCENT = 8;
const MAX_ACTIVITY_ONLY_RESERVE_PERCENT = 50;

function buildTimelineBarRenderData(
  column: TimelineColumn,
  maxTotal: number
): TimelineBarRenderData {
  const activityOnlyCount = countActivityOnlySegments(column);
  return {
    ariaLabel: formatTimelineBarLabel(column),
    column,
    heightPercent: timelineBarHeightPercent(column, maxTotal),
    segmentHeights: column.segments.map((segment) => ({
      heightPercent: segmentHeightPercent(segment, column, activityOnlyCount),
      segment,
    })),
  };
}

function countActivityOnlySegments(column: TimelineColumn): number {
  let count = 0;
  for (const segment of column.segments) {
    if (segment.value <= 0) {
      count += 1;
    }
  }
  return count;
}

function timelineSessionLabel(
  renderedCount: number,
  sourceSessions: SessionTimelineDetail["sessions"],
  qualifyingSessionCount?: number | null
): string {
  const totalCount =
    qualifyingSessionCount ??
    new Set(sourceSessions.map(({ sessionId }) => sessionId)).size;
  if (renderedCount === totalCount) {
    return `${renderedCount} session${renderedCount === 1 ? "" : "s"}`;
  }
  return `${renderedCount} of ${totalCount} sessions`;
}

type TimelineBarRenderData = {
  ariaLabel: string;
  column: TimelineColumn;
  heightPercent: number;
  segmentHeights: readonly TimelineSegmentRenderData[];
};

type TimelineSegmentRenderData = {
  heightPercent: number;
  segment: TimelineColumn["segments"][number];
};

/**
 * ISS-12665: the header's peak column publishes a figure only when the cost stat
 * beside it does, so an unavailable Branch cost cannot sit next to a priced peak.
 */
function resolvePeakColumnCost(
  costEvidence: TimelineCostEvidence,
  timeline: Pick<SessionTimeline, "peakColumnCostUsd">
): number | null {
  if (costEvidence.evidenceMissing || costEvidence.value == null) {
    return null;
  }
  return timeline.peakColumnCostUsd;
}
