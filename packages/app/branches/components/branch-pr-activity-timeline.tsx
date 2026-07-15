"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { formatCost, formatNumber } from "@repo/app/shared/lib/format-utils";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { ActivityIcon } from "lucide-react";
import { memo, type ReactNode, useMemo, useState } from "react";
import {
  type BranchActorColorDomain,
  buildActorColorDomain,
  deriveActorsFromSessions,
} from "../lib/branch-actor-domain";
import { locPerDollar } from "../lib/branch-derivations";
import {
  buildSessionTimeline,
  type TimelineColumn,
} from "../lib/branch-session-buckets";
import { formatClock } from "../lib/branch-timeline-range";
import {
  type PreferredBranchLoc,
  resolveNetLoc,
} from "../lib/live-overlays/use-preferred-branch-loc";
import {
  type BranchTipAnchor,
  BranchTipPortal,
  tipAnchorFromElement,
} from "./branch-tip-portal";

/**
 * Per-hour-by-actor stacked token bars (Epic E / E1) — the design handoff's
 * `BQActivity` timeline. One stacked bar per clock-hour across the branch span,
 * colored BY ACTOR (shared E0 domain). Tokens are distributed across the hours a
 * session's ACTIVE bursts span (so idle hours render as hatched gaps and a busy
 * hour is a taller bar). Bar height is sqrt-scaled to the busiest hour. Hovering
 * a bar opens the design's `bq-tip` card (the hour, total, and a per-actor
 * input/output/cache split).
 *
 * Sessions-driven (not `usage.hourBuckets`): in v1 the usage rollup is
 * unattributed (`owner: null`) and underpopulated, so E1 reads the same
 * sessions + merged trace the swimlane/trace use, keeping the page consistent and
 * attributed. Purely presentational over `BranchPageDetail`.
 */
export type BranchPrActivityTimelineProps = {
  detail: BranchPageDetail;
  isLoading?: boolean;
  /** Inject the parent's shared domain so E1 and E4 colors match; else derived. */
  actorDomain?: BranchActorColorDomain;
  /** Highlight the bar for this hour (driven by the E2 playhead). */
  activeHourStart?: string | null;
  /**
   * Read-only "you are here" position along the timeline (0–1), drawn as a
   * non-interactive line over the bars. Null hides it (no click/scroll yet).
   */
  activeFraction?: number | null;
  /** When provided, each bar is a button that scrubs the trace to its hour. */
  onScrubHour?: (hourStart: string) => void;
  /** PR-preferred LOC from `usePreferredBranchLoc`; omit to use `detail` columns. */
  loc?: PreferredBranchLoc;
  /** Rendered between the bars and the time axis (the event-dot rail), so the
   *  graph stacks bars → dots → axis like the Session timeline. */
  children?: ReactNode;
  className?: string;
};

const MIN_BAR_PERCENT = 8;
const TRAILING_ZERO_RE = /\.0$/;

/** Token-split rows for the hover card — colors mirror the design handoff. */
const TOKEN_PARTS = [
  { key: "input", label: "Input", color: "#6B8AF0" },
  { key: "output", label: "Output", color: "#2DAA9E" },
  { key: "cache", label: "Cache read", color: "#B6BECB" },
] as const;

function barHeightPercent(column: TimelineColumn, maxTotal: number): number {
  if (column.isGap || maxTotal <= 0) {
    return 0;
  }
  return Math.max(
    MIN_BAR_PERCENT,
    Math.round((Math.sqrt(column.total) / Math.sqrt(maxTotal)) * 100)
  );
}

/** Compact token count ("1.2M" / "45k" / "—") — the design's `brFmtTokens`. */
function formatTokens(value: number): string {
  const rounded = Math.round(value);
  if (!rounded) {
    return "—";
  }
  if (rounded >= 1e6) {
    return `${(rounded / 1e6).toFixed(1).replace(TRAILING_ZERO_RE, "")}M`;
  }
  if (rounded >= 1e3) {
    return `${Math.round(rounded / 1e3)}k`;
  }
  return String(rounded);
}

/** Concise per-bar a11y label (the hover card carries the visual breakdown). */
function formatBarLabel(
  column: TimelineColumn,
  domain: BranchActorColorDomain
): string {
  const when = formatClock(Date.parse(column.hourStart));
  if (column.isGap) {
    return `${when} · idle`;
  }
  const breakdown = column.segments
    .map(
      (segment) =>
        `${domain.labelFor(segment.owner)} ${formatTokens(segment.value)}`
    )
    .join(" · ");
  return `${when} · ${formatTokens(column.total)} tokens · ${breakdown}`;
}

export const BranchPrActivityTimeline = memo(function BranchPrActivityTimeline({
  detail,
  isLoading = false,
  actorDomain,
  activeHourStart,
  activeFraction,
  onScrubHour,
  loc,
  children,
  className,
}: BranchPrActivityTimelineProps) {
  const [hover, setHover] = useState<{
    index: number;
    anchor: BranchTipAnchor;
  } | null>(null);
  const hoverIndex = hover?.index ?? null;
  const domain = useMemo(
    () =>
      actorDomain ?? buildActorColorDomain(deriveActorsFromSessions(detail)),
    [actorDomain, detail]
  );
  const timeline = useMemo(
    () => buildSessionTimeline(detail, domain),
    [detail, domain]
  );

  if (isLoading) {
    return <Skeleton className={cn("h-[140px] w-full", className)} />;
  }

  if (timeline.columns.length === 0) {
    return (
      <EmptyState
        className={className}
        description="No session activity captured for this branch yet."
        icon={ActivityIcon}
        title="No PR activity"
      />
    );
  }

  const { columns, maxTotal, startMs, endMs } = timeline;
  const sessionCount = detail.sessions.length;
  const cost = detail.estimatedCostUsd;
  // Prefer the connected PR's live LOC (authoritative) over enrichment columns.
  const netLoc = resolveNetLoc(loc, detail);
  const valuePerDollar = locPerDollar({ netLoc, totalCostUsd: cost });
  const wallClockMs = startMs != null && endMs != null ? endMs - startMs : null;
  const hoverColumn = hoverIndex == null ? null : columns[hoverIndex];

  // Distinct actors (with summed tokens) for the legend.
  const legendByOwner = new Map<
    string,
    { owner: string | null; total: number }
  >();
  for (const column of columns) {
    for (const segment of column.segments) {
      const entry = legendByOwner.get(segment.key) ?? {
        owner: segment.owner,
        total: 0,
      };
      entry.total += segment.value;
      legendByOwner.set(segment.key, entry);
    }
  }
  const legend = [...legendByOwner.values()].sort((a, b) => b.total - a.total);

  return (
    <section className={cn("bq-act", className)}>
      <div className="bq-act-head">
        <span className="bq-act-title">
          PR timeline
          <span className="bq-act-sub">
            {" "}
            · {sessionCount} session{sessionCount === 1 ? "" : "s"}
          </span>
        </span>
        {legend.length > 0 ? (
          <div className="bq-act-legend">
            {legend.map((entry) => (
              <span
                className="bq-lg"
                key={entry.owner ?? "__unattributed__"}
                title={`${domain.labelFor(entry.owner)} · ${formatTokens(entry.total)} tokens`}
              >
                <span
                  className="bq-lg-sw"
                  style={{ background: domain.colorFor(entry.owner) }}
                />
                <span className="bq-lg-name">
                  {domain.labelFor(entry.owner)}
                </span>
              </span>
            ))}
          </div>
        ) : null}
        <div className="bq-stats">
          <span className="bq-stat">
            <b className="font-mono">{cost == null ? "—" : formatCost(cost)}</b>
            cost
          </span>
          <span className="bq-stat">
            <b className="font-mono">
              {valuePerDollar == null
                ? "—"
                : `${formatNumber(valuePerDollar, true)}`}
            </b>
            LOC/$
          </span>
          <span className="bq-stat">
            <b className="font-mono">
              {wallClockMs == null ? "—" : formatDurationMs(wallClockMs)}
            </b>
            wall clock
          </span>
        </div>
      </div>

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
              ariaLabel={formatBarLabel(column, domain)}
              column={column}
              hovered={hoverIndex === index}
              key={column.hourStart}
              maxTotal={maxTotal}
              onHover={(anchor) => setHover({ anchor, index })}
              onScrubHour={onScrubHour}
            />
          ))}
        </div>
        {hover && hoverColumn && hoverColumn.total > 0 ? (
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
    </section>
  );
});

/** The design's `bq-tip`: hour + total, then a per-actor io/cache split.
 *  Portaled to <body> so it's never clipped behind the sticky chrome. */
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
        <span className="font-mono">{formatTokens(column.total)}</span>
      </div>
      {column.segments.map((segment) => (
        <div className="bq-tip-srow" key={segment.key}>
          <div className="bq-tip-row">
            <span className="bq-tip-sw" style={{ background: segment.color }} />
            <span className="bq-tip-name">
              {domain.labelFor(segment.owner)}
            </span>
            <span className="bq-tip-tok font-mono">
              {formatTokens(segment.value)}
            </span>
          </div>
          <div className="bq-tip-split">
            {TOKEN_PARTS.map((part) => (
              <span className="bq-tip-sp" key={part.key}>
                <span
                  className="bq-tip-spdot"
                  style={{ background: part.color }}
                />
                <span className="bq-tip-spk">{part.label}</span>
                <span className="bq-tip-spv font-mono">
                  {formatTokens(segment[part.key])}
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
}: {
  column: TimelineColumn;
  maxTotal: number;
  hovered: boolean;
  active: boolean;
  ariaLabel: string;
  onScrubHour?: (hourStart: string) => void;
  onHover: (anchor: BranchTipAnchor) => void;
}) {
  const height = barHeightPercent(column, maxTotal);
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
        height: `${(segment.value / column.total) * 100}%`,
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
