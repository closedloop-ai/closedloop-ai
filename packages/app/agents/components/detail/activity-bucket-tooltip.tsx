import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import {
  getTimelineStackGroupingLabel,
  type TimelineStackGrouping,
  type TimelineStackSegment,
} from "@repo/app/agents/lib/session-timeline-stacks";
import {
  type BucketJumpBlock,
  formatBucketTooltipMoney,
  formatBucketTooltipTotal,
  getBucketCost,
  getBucketJumpHint,
  TIMELINE_SYNTHESIZED_COST_TOOLTIP,
  TIMELINE_SYNTHESIZED_IDLE_TOOLTIP,
} from "./activity-bucket-rendering";
import {
  type TooltipAnchor,
  useViewportTooltipStyle,
  ViewportTooltipPortal,
} from "./viewport-tooltip";

/**
 * The Session Timeline's per-bucket hover card: the bucket's total, its
 * per-model cache/out/in decomposition, and the event/tool-call meta row.
 *
 * Extracted from `agent-session-detail-view.tsx` (grandfathered, shrink-only)
 * alongside the ISS-5563 review fixes that reformatted the figures it prints —
 * the header total and the decomposition rows now have to agree about one
 * bucket's magnitude (see `formatBucketTooltipMoney`), so the two formatters and
 * the markup that pairs them belong in view of each other rather than buried in
 * the hot file.
 */
export function ActivityBucketTooltip({
  anchor,
  block,
  bucket,
  costUnmeasured = false,
  grouping,
  segments,
}: Readonly<{
  anchor: TooltipAnchor;
  /** ISS-5479: why a click cannot land, so the meta row answers in place. */
  block: BucketJumpBlock | null;
  bucket: ActivityBucket;
  /**
   * ISS-5566: `true` when this strip's money was synthesized, so the readout
   * drops BOTH dollar figures it cannot back — the header total and the
   * per-model cache/out/in table, which is where the fabricated 69/23/8 split
   * was most legible. The event and tool-call counts below them are measured
   * and stay.
   *
   * Defaults to `false` so a caller that cannot answer the question does not
   * have the readout claim a fabrication it has not established. The single
   * source for this answer is `SessionActivityTimeline`'s `costUnmeasured`,
   * which also drives the bar rail and the in/out/cache stack — the readout
   * cannot disagree with the strip it is anchored to.
   */
  costUnmeasured?: boolean;
  /**
   * ISS-5819: the "Group by" dimension this bar is currently cut along, and the
   * segments that cut produced. Supplied together or not at all.
   *
   * Without them the card prints the per-model cache/out/in table it always
   * printed. WITH them it must print the ACTIVE cut instead: the stack is the
   * only place the grouping is visible, it is visible only as colour, and a card
   * describing a token-type split under a phase-grouped bar does not just fail
   * to help — it contradicts what the reader is looking at.
   */
  grouping?: TimelineStackGrouping;
  segments?: readonly TimelineStackSegment[];
}>) {
  const cost = getBucketCost(bucket);
  const { placement, ref, style } = useViewportTooltipStyle(anchor);
  return (
    <ViewportTooltipPortal>
      <div
        className="sd3-tip"
        data-placement={placement}
        ref={ref}
        style={style}
      >
        <div className="sd3-tip-h">
          <b>{bucket.label}</b>
          {cost > 0 && !costUnmeasured ? (
            <span className="mono">{formatBucketTooltipTotal(cost)}</span>
          ) : null}
        </div>
        {renderBucketTooltipBody({
          bucket,
          cost,
          costUnmeasured,
          grouping,
          segments,
        })}
        <div className="sd3-tip-meta">
          {bucket.total} events | {bucket.toolStart} tool calls
          {getBucketJumpHint(bucket, block)}
        </div>
      </div>
    </ViewportTooltipPortal>
  );
}

/**
 * ISS-5566: three genuinely different answers to "what did this slice cost?",
 * kept in one function so a reader can see they are exclusive — we do not know
 * (synthesized), we know it was nothing (idle), or here is the measured split.
 */
function renderBucketTooltipBody({
  bucket,
  cost,
  costUnmeasured,
  grouping,
  segments,
}: {
  bucket: ActivityBucket;
  cost: number;
  costUnmeasured: boolean;
  grouping?: TimelineStackGrouping;
  segments?: readonly TimelineStackSegment[];
}) {
  if (costUnmeasured) {
    /*
     * Two answers, not one (logical-metric review). A synthesized bucket at
     * zero cost has `total === 0` — the transcript caught no turn in that slice,
     * which is an observation we hold and must not throw away by answering
     * "cost not recorded". But the measured strip's idle line below ends "no
     * tokens billed", and on a session with no recorded cost that is a billing
     * claim nothing backs. So: keep the true-zero/unknown distinction, make
     * neither claim.
     */
    return (
      <div className="sd3-tip-idle">
        {cost === 0
          ? TIMELINE_SYNTHESIZED_IDLE_TOOLTIP
          : TIMELINE_SYNTHESIZED_COST_TOOLTIP}
      </div>
    );
  }
  if (cost === 0) {
    return (
      <div className="sd3-tip-idle">
        Agent asleep | scheduled wake-up | no tokens billed
      </div>
    );
  }
  if (grouping && segments) {
    return renderGroupedTooltipBody(grouping, segments, cost);
  }
  return (
    <table className="sd3-tip-tbl">
      <thead>
        <tr>
          <th>model</th>
          <th>
            <i className="cb-cache" />
            cache
          </th>
          <th>
            <i className="cb-out" />
            out
          </th>
          <th>
            <i className="cb-in" />
            in
          </th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(bucket.byModel).map(([model, usage]) => (
          <tr key={model}>
            <td className="mono">{model}</td>
            <td>{formatBucketTooltipMoney(usage.cCache, cost)}</td>
            <td>{formatBucketTooltipMoney(usage.cOut, cost)}</td>
            <td>{formatBucketTooltipMoney(usage.cIn, cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * ISS-5819: the bar's composition under the ACTIVE "Group by" cut.
 *
 * Two columns rather than the ungrouped card's four, because only the token-type
 * cut has a cache/out/in decomposition to print — a model, a phase and an owner
 * each carry one number. The header names the dimension (`model`, `activity
 * phase`) so the card says which question it is answering, and every row carries
 * its swatch AND its label, so the cut is legible to a reader who cannot
 * distinguish the colours (WCAG 1.4.1).
 */
function renderGroupedTooltipBody(
  grouping: TimelineStackGrouping,
  segments: readonly TimelineStackSegment[],
  cost: number
) {
  return (
    <table className="sd3-tip-tbl">
      <thead>
        <tr>
          <th>{getTimelineStackGroupingLabel(grouping).toLowerCase()}</th>
          <th>cost</th>
        </tr>
      </thead>
      <tbody>
        {segments.map((segment) => (
          <tr key={segment.key}>
            <td className="mono">
              <i style={{ background: segment.colorVar }} />
              {segment.label}
            </td>
            <td>{formatBucketTooltipMoney(segment.value, cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
