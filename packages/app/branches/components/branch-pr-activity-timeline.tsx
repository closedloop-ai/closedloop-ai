"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { resolveAttributedBranchCost } from "@repo/api/src/types/branch-cost";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
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
import {
  type BranchActorColorDomain,
  BranchActorTurnSide,
} from "../lib/branch-actor-domain";
import { locPerDollar } from "../lib/branch-derivations";
import {
  buildSessionTimeline,
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
  resolveTimelineCostEvidence,
  resolveTimelineNoBarsMessage,
  resolveTimelineTraceEvidence,
  TIMELINE_TOKEN_PARTS,
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
 * sized BY that user's COST (e.g. Chris's spend vs Thadeus's spend within each
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
 * attributed. Purely presentational over `BranchPageDetail`.
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
  traceState,
  isLoading = false,
  actorDomain,
  activeHourStart,
  activeFraction,
  onScrubHour,
  loc,
  children,
  className,
}: BranchPrActivityTimelineProps) {
  const renderedDetail = useMemo(
    () => detailForLoadedTimelineSessions(detail, traceState),
    [detail, traceState]
  );
  const domain = useMemo(
    () =>
      actorDomain ?? buildTimelineHumanActorDomain(renderedDetail, traceState),
    [actorDomain, renderedDetail, traceState]
  );
  const timeline = useMemo(
    () => buildSessionTimeline(renderedDetail, domain),
    [renderedDetail, domain]
  );
  const timingDisclosureId = useId();
  // ISS-5951 (ISS-4779 closed-by-default). Read above the early returns so the
  // hook order is stable, and through the OPTIONAL port because this shared
  // component also mounts in Storybook and in tests that wire no flag adapter —
  // there it resolves off, which is this gate's honest default.
  const fallbackCostMarkerEnabled = useFeatureFlagEnabledOptional(
    BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY
  );

  if (isLoading) {
    return <Skeleton className={cn("h-[140px] w-full", className)} />;
  }

  // Distinct sessions (deduped by `sessionId`, the SAME key the bars use) — a
  // branch can carry duplicate session rows (one per PR link), so this, not
  // `detail.sessions.length`, is the count every "N sessions" surface must show.
  // Reusing the timeline's own count keeps the message from double-counting a
  // session repeated across two links (FEA-4269 review, wongk). The true-empty
  // guard stays a raw-length boolean: zero rows ⇔ zero distinct sessions.
  const sessionCount = timeline.distinctSessionCount;
  const noSessionsState = resolveNoSessionsState({
    className,
    sessionCount: detail.sessions.length,
  });
  if (noSessionsState) {
    return noSessionsState;
  }

  const {
    chartableCostUsd,
    columns,
    maxTotal,
    nonBucketableSessions,
    truncatedSessions,
    startMs,
    endMs,
  } = timeline;
  // Sessions exist but timing cannot produce a bucketizable duration. Keep the
  // section + stats and swap only the bars area for this message.
  const noBarsMessage = resolveTimelineNoBarsMessage({
    columnCount: columns.length,
    sourceSessionCount: new Set(
      detail.sessions.map(({ sessionId }) => sessionId)
    ).size,
    sessionCount,
    traceCompleteness: traceState?.aggregateCompleteness.state,
  });
  const authoritativeCost = resolveAttributedBranchCost(renderedDetail);
  // wongk review: `detailForLoadedTimelineSessions` rewrites a legacy Branch's
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
  // shafty023 review: this reads the boundary ONCE, and a trace that never
  // arrived is its own answer rather than the one a confirmed-complete trace
  // gives. Both this component and `formatTimelineEvidenceValue` take that one
  // answer, so neither can decide the evidence question for itself.
  const traceEvidence = resolveTimelineTraceEvidence(traceState);
  // Prefer the Branch-level authoritative cost when it exists and every loaded
  // Session can be charted. Otherwise use the defensible rendered subtotal so
  // the headline still reconciles with priced bars; LOC/$ remains Branch-level.
  //
  // ISS-5951: the figure, its marker, and the sentence explaining the marker all
  // come from this ONE call. The selection rule used to live here while the
  // marker was decided separately at the render site, and the two disagreed for
  // the no-authoritative-cost arm — a fallback figure with nothing saying so.
  const costEvidence = resolveTimelineCostEvidence({
    authoritativeCostUsd: authoritativeCost,
    chartableCostUsd,
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
  const wallClockMs = startMs != null && endMs != null ? endMs - startMs : null;

  // Distinct users (with summed cost) for the legend.
  const legend = buildTimelineLegend(columns);

  return (
    <section className={cn("bq-act", className)}>
      <div className="bq-act-head">
        <span className="bq-act-title">
          PR timeline
          <span className="bq-act-sub">
            {" "}
            · {timelineSessionLabel(sessionCount, detail.sessions)}
          </span>
        </span>
        <div className="bq-act-legend">
          {legend.map((entry) => (
            <span
              className="bq-lg"
              key={entry.key}
              title={`${domain.labelFor(entry.owner)} · ${formatCostPrecise(entry.total)}`}
            >
              <span
                className="bq-lg-sw"
                style={{
                  background: domain.colorForTurn(
                    entry.owner,
                    BranchActorTurnSide.Human
                  ),
                }}
              />
              <span className="bq-lg-name">{domain.labelFor(entry.owner)}</span>
            </span>
          ))}
        </div>
        <div className="bq-stats">
          <span className="bq-stat">
            {/* wongk review (ISS-4919): the SAME precise formatter the bars'
                tooltips and the legend use. Fixed-2dp `formatCost` rendered this
                headline as "$0.00" for a sub-cent branch total while the tooltips
                directly beneath it read "< $0.0001" — one total, two claims, on
                one panel. */}
            <b
              aria-describedby={
                costEvidence.incomplete ? disclosureId : undefined
              }
              className="font-mono"
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
            </b>
            cost
          </span>
          <span className="bq-stat">
            {/* LOC/$ takes its marker from the same predicate the cost does, so
                it owes the reader the same footnote — the asterisk and the
                description come from the one answer.

                Its denominator IS `authoritativeCost`: the same rewritten
                stand-in total `unpricedBranchFallback` exists to disclose. Read
                only from aggregate trace incompleteness, this stat rendered a
                bare unqualified ratio beside a cost figure marked `$5.00*` for
                that very substitution — one denominator making two different
                claims on one row. */}
            <b
              aria-describedby={
                costEvidence.incompleteTraceEvidence ||
                costEvidence.unpricedBranchFallback
                  ? disclosureId
                  : undefined
              }
              className="font-mono"
            >
              {/* ISS-4667: the SAME shared formatter the headline card uses, so
                  one branch value can't read two different ways on one page
                  (e.g. `0.0088` here vs the card) or floor a small real value. */}
              {formatTimelineEvidenceValue(
                formatLocPerDollar(locPerDollarValue),
                traceEvidence,
                {
                  incomplete: costEvidence.unpricedBranchFallback,
                  unavailable: costEvidence.evidenceMissing,
                }
              )}
            </b>
            LOC/$
          </span>
          <span className="bq-stat">
            <b
              aria-describedby={
                timingIncomplete || costEvidence.incompleteTraceEvidence
                  ? disclosureId
                  : undefined
              }
              className="font-mono"
            >
              {formatTimelineEvidenceValue(
                wallClockMs == null ? "—" : formatDurationMs(wallClockMs),
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
      </div>

      {noBarsMessage ? (
        <p className="bq-act-nobars">{noBarsMessage}</p>
      ) : (
        <TimelineChart
          activeFraction={activeFraction}
          activeHourStart={activeHourStart}
          columns={columns}
          domain={domain}
          endMs={endMs}
          maxTotal={maxTotal}
          onScrubHour={onScrubHour}
          startMs={startMs}
        >
          {children}
        </TimelineChart>
      )}
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

/**
 * The drawable chart region — the "you are here" line, the interactive bars +
 * hover card, the event-dot rail (`children`), and the time axis. Owns the hover
 * state (only the bars use it) and is only rendered when there ARE bars to draw,
 * so the parent function stays under the cognitive-complexity ceiling.
 */
function TimelineChart({
  columns,
  domain,
  maxTotal,
  startMs,
  endMs,
  activeHourStart,
  activeFraction,
  onScrubHour,
  children,
}: {
  columns: TimelineColumn[];
  domain: BranchActorColorDomain;
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
          {columns.map((column, index) => (
            <TimelineBar
              active={
                activeHourStart != null && column.hourStart === activeHourStart
              }
              ariaLabel={formatTimelineBarLabel(column, domain)}
              column={column}
              hovered={hoverIndex === index}
              key={column.hourStart}
              maxTotal={maxTotal}
              onHover={(anchor) => setHover({ anchor, index })}
              onLeave={() => setHover(null)}
              onScrubHour={onScrubHour}
            />
          ))}
        </div>
        {hover && hoverColumn && !hoverColumn.isGap ? (
          <BarTip anchor={hover.anchor} column={hoverColumn} domain={domain} />
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
  domain,
  anchor,
}: {
  column: TimelineColumn;
  domain: BranchActorColorDomain;
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
            <span className="bq-tip-name">
              {domain.labelFor(segment.owner)}
            </span>
            <span className="bq-tip-tok font-mono">
              {formatTimelineSegmentCost(segment)}
            </span>
          </div>
          <div className="bq-tip-split">
            {/* Unit boundary: everything above is USD, the rows below are TOKENS.
                The caption keeps the eye from reading them as cents. */}
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
  maxTotal,
  hovered,
  active,
  ariaLabel,
  onScrubHour,
  onHover,
  onLeave,
}: {
  column: TimelineColumn;
  maxTotal: number;
  hovered: boolean;
  active: boolean;
  ariaLabel: string;
  onScrubHour?: (hourStart: string) => void;
  onHover: (anchor: BranchTipAnchor) => void;
  onLeave: () => void;
}) {
  const height = timelineBarHeightPercent(column, maxTotal);
  // Concurrency is already legible from a bar's stacked multi-actor colors, so it
  // carries no extra border (only the semantic `data-concurrent` hook remains).
  const classes = cn(
    "bq-bar",
    column.isGap && "idle",
    (hovered || active) && "hot"
  );
  const segments = column.segments.map((segment) => (
    <i
      data-actor-key={segment.key}
      key={segment.key}
      style={{
        height: `${segmentHeightPercent(segment, column)}%`,
        background: segment.color,
      }}
    />
  ));
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
        style={{ height: `${height}%` }}
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
      style={{ height: `${height}%` }}
    >
      {segments}
    </div>
  );
}

function segmentHeightPercent(
  segment: TimelineColumn["segments"][number],
  column: TimelineColumn
): number {
  const activityOnlyCount = column.segments.filter(
    (candidate) => candidate.value <= 0
  ).length;
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

function timelineSessionLabel(
  renderedCount: number,
  sourceSessions: BranchPageDetail["sessions"]
): string {
  const totalCount = new Set(sourceSessions.map(({ sessionId }) => sessionId))
    .size;
  if (renderedCount === totalCount) {
    return `${renderedCount} session${renderedCount === 1 ? "" : "s"}`;
  }
  return `${renderedCount} of ${totalCount} sessions`;
}
