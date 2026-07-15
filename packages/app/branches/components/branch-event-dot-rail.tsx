"use client";

import type { BranchCommit, MergedTraceItem } from "@repo/api/src/types/branch";
import { cn } from "@repo/design-system/lib/utils";
import { MessageSquareIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import {
  type BranchEventDot,
  deriveEventDots,
  deriveLifecycleDots,
} from "../lib/branch-event-dots";
import {
  formatClock,
  fractionOf,
  type TimeRange,
  timeRange,
} from "../lib/branch-timeline-range";
import {
  type BranchTipAnchor,
  BranchTipPortal,
  tipAnchorFromElement,
} from "./branch-tip-portal";

/**
 * Event-dot rail (Epic E / E3) — the design handoff's `bq-drail`. Green
 * (success/commit/merge) and red (error/fail) dots derive from the LOCAL merged
 * trace and are positioned by their timestamp along the shared timeline axis, so
 * they sit under the matching E1 hour bar. Orange dots are a SEPARATE source —
 * the live PR comment count (soft F3) — overlaid only when GitHub is KNOWN to be
 * connected (`githubConnected === true`); when it's KNOWN disconnected
 * (`=== false`) a muted connect-GitHub hint shows. While the connection state is
 * UNKNOWN (prop omitted/undefined — the v1 default, no producer wired yet) we
 * show neither the hint nor orange, so we never assert "Connect GitHub" against
 * a state we haven't actually determined. Never blue.
 * Outcome colors use semantic tokens (success/destructive/warning), NOT the
 * actor chart palette, so outcome ≠ actor identity. Hovering a dot opens the
 * design's `bq-tip-mk` card; clicking it scrubs the shared playhead to the dot's
 * timestamp (`onScrub`), which scrolls the trace — the same path the bars and
 * playhead use — so lifecycle dots (no trace row, e.g. the merge) work too.
 */
export type BranchEventDotRailProps = {
  traceItems: readonly MergedTraceItem[];
  /** Merge timestamp (structured detail) → a green lifecycle "Merged" dot. */
  mergedAt?: string | null;
  /** PR opened timestamp (PRD-486) → a green "Opened" lifecycle dot. */
  openedAt?: string | null;
  /** Real commits on the branch (PRD-486) → one green dot each, by commit time. */
  commits?: readonly BranchCommit[];
  /** PR number, labels the lifecycle dots ("Merged #123"). */
  prNumber?: number | null;
  /** Live PR comment count (soft F3); null/undefined → no orange. */
  prCommentCount?: number | null;
  /**
   * GitHub connection state. `true` → may show orange comments; `false` → shows
   * the connect hint; `undefined` (unknown — the v1 default) → shows neither.
   */
  githubConnected?: boolean;
  /** Shared axis (from E1) so dots align with the bars; else derived from dots. */
  range?: TimeRange | null;
  activeRow?: number | null;
  /** Scrub the shared playhead to a dot's timestamp (scrolls the trace). */
  onScrub?: (t: string) => void;
  className?: string;
};

const COLOR_CLASS: Record<BranchEventDot["color"], string> = {
  green: "d-green",
  red: "d-red",
  orange: "d-orange",
};

/** Category header (label + accent color) for the marker tooltip. */
const DOT_META: Record<
  BranchEventDot["color"],
  { label: string; color: string }
> = {
  green: { label: "Commits, PRs & merges", color: "var(--success-foreground)" },
  red: { label: "Failures & limits", color: "var(--destructive)" },
  orange: { label: "Review comments", color: "var(--warning, #d9a441)" },
};

type PositionedDot = { dot: BranchEventDot; left: number; key: string };

function EventDot({
  dot,
  left,
  active,
  onScrub,
  onHover,
}: {
  dot: BranchEventDot;
  left: number;
  active: boolean;
  onScrub?: (t: string) => void;
  onHover: (anchor: BranchTipAnchor) => void;
}) {
  const className = cn("bq-dot", COLOR_CLASS[dot.color], active && "hot");
  const style = { left: `${left}%` };
  if (onScrub) {
    return (
      <button
        aria-label={dot.label}
        className={className}
        onClick={() => onScrub(dot.t)}
        onFocus={(event) => onHover(tipAnchorFromElement(event.currentTarget))}
        onMouseEnter={(event) =>
          onHover(tipAnchorFromElement(event.currentTarget))
        }
        style={style}
        type="button"
      />
    );
  }
  return <span className={className} style={style} />;
}

/** Portaled to <body> so it's never clipped behind the sticky chrome. */
function DotTip({
  dot,
  anchor,
}: {
  dot: BranchEventDot;
  anchor: BranchTipAnchor;
}) {
  const meta = DOT_META[dot.color];
  return (
    <BranchTipPortal anchor={anchor} className="bq-tip-mk">
      <div className="bq-tip-mkhead" style={{ color: meta.color }}>
        <span className="bq-tip-sw" style={{ background: meta.color }} />
        {meta.label}
      </div>
      <div className="bq-tip-list">
        <div className="bq-tip-li">
          <div className="bq-tip-litop">
            <span className="bq-tip-lt font-mono">
              {formatClock(Date.parse(dot.t))}
            </span>
          </div>
          <span className="bq-tip-ll">{dot.label}</span>
        </div>
      </div>
    </BranchTipPortal>
  );
}

export const BranchEventDotRail = memo(function BranchEventDotRail({
  traceItems,
  mergedAt,
  openedAt,
  commits,
  prNumber,
  prCommentCount,
  githubConnected,
  range,
  activeRow,
  onScrub,
  className,
}: BranchEventDotRailProps) {
  const [hovered, setHovered] = useState<{
    dot: BranchEventDot;
    anchor: BranchTipAnchor;
  } | null>(null);
  const dots = useMemo(
    () => [
      ...deriveEventDots(traceItems),
      ...deriveLifecycleDots({
        mergedAt: mergedAt ?? null,
        prNumber: prNumber ?? null,
        openedAt: openedAt ?? null,
        commits: commits ?? [],
      }),
    ],
    [traceItems, mergedAt, prNumber, openedAt, commits]
  );
  const axis = useMemo(() => {
    if (range) {
      return range;
    }
    const stamps = dots.map((dot) => dot.t);
    return timeRange(stamps, stamps);
  }, [range, dots]);

  const positioned = useMemo<PositionedDot[]>(() => {
    if (!axis) {
      return [];
    }
    return dots.map((dot, i) => {
      const ms = Date.parse(dot.t);
      return {
        dot,
        left: Number.isNaN(ms) ? 0 : fractionOf(axis, ms) * 100,
        // Lifecycle dots all have row: null, and N commit/PR dots can share a
        // color+timestamp; disambiguate with the array index so React never
        // drops a sibling. (`l${i}` can't collide with a numeric trace row.)
        key: `${dot.color}-${dot.row ?? `l${i}`}-${dot.t}`,
      };
    });
  }, [axis, dots]);

  // Only act on a KNOWN connection state — `undefined` means unknown, so we show
  // neither the hint nor orange rather than asserting "Connect GitHub".
  const showComments =
    githubConnected === true && prCommentCount != null && prCommentCount > 0;
  const showHint = githubConnected === false;

  if (dots.length === 0 && !(showComments || showHint)) {
    return null;
  }

  return (
    <div className={cn("bq-drail-wrap", className)}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: container only clears the hover tooltip; dots carry the interactivity */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: container only clears the hover tooltip; dots carry the interactivity */}
      <div className="bq-drail" onMouseLeave={() => setHovered(null)}>
        {positioned.map((entry) => (
          <EventDot
            active={activeRow != null && entry.dot.row === activeRow}
            dot={entry.dot}
            key={entry.key}
            left={entry.left}
            onHover={(anchor) => setHovered({ anchor, dot: entry.dot })}
            onScrub={onScrub}
          />
        ))}
      </div>
      {hovered ? <DotTip anchor={hovered.anchor} dot={hovered.dot} /> : null}
      {showComments || showHint ? (
        <div className="bq-drail-foot">
          {showComments ? (
            <span className="bq-drail-comments">
              <span className="bq-dot d-orange" />
              {prCommentCount} PR comment{prCommentCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {showHint ? (
            <span className="bq-drail-hint">
              <MessageSquareIcon aria-hidden size={11} />
              Connect GitHub for PR comments
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
