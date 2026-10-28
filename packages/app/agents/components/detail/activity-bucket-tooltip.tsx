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
  TIMELINE_UNMEASURED_INTERVAL_TOOLTIP,
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
 * Extracted from `agent-session-detail-view.tsx`
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
  costsUnpublished = false,
  costUnmeasured = false,
  grouping,
  intervalUnmeasured = false,
  segments,
}: Readonly<{
  anchor: TooltipAnchor;
  /** ISS-5479: why a click cannot land, so the meta row answers in place. */
  block: BucketJumpBlock | null;
  bucket: ActivityBucket;
  /**
   * ISS-5632: `true` when this strip may publish no dollar figure at all — the
   * SAME `barCostsUnpublished` that governs the bar rail and the per-segment
   * amounts in the bar buttons' accessible names, so no two of the three can
   * disagree about a figure the strip cannot stand behind.
   *
   * Wider than {@link costUnmeasured}, and that difference is the whole defect.
   * `costUnmeasured` is flag-gated, so with the disclosure flag OFF a strip
   * priced entirely from the `Math.max(estimatedCost, 0.01)` floor got a blank
   * rail and a hover card quoting `$0.0025` to four decimal places — one panel
   * below a Properties Cost row rendering a dash.
   *
   * It withholds only; the sentence EXPLAINING the withdrawal stays behind
   * `costUnmeasured`, because ISS-5563's withdrawal shipped ungated but its
   * disclosure copy did not.
   */
  costsUnpublished?: boolean;
  /**
   * ISS-5850: `true` when the producer's measured extent does not reach this
   * column at all, so its zeroes are the absence of a measurement rather than a
   * measurement of absence.
   *
   * A DIFFERENT AXIS from `costUnmeasured`, not a stronger form of it. That one
   * asks whether this strip's MONEY was measured; this asks whether this
   * INTERVAL was. A measured strip has unmeasured intervals around its extent,
   * and a synthesized strip's intervals can be fully covered — so the two are
   * independent and both branches below are reachable.
   *
   * Defaults to `false` so a caller that cannot answer the question does not
   * have the readout claim an absence it has not established — the same posture
   * `costUnmeasured` takes.
   */
  intervalUnmeasured?: boolean;
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
          {cost > 0 && !(costUnmeasured || costsUnpublished) ? (
            <span className="mono">{formatBucketTooltipTotal(cost)}</span>
          ) : null}
        </div>
        {renderBucketTooltipBody({
          bucket,
          cost,
          costsUnpublished,
          costUnmeasured,
          grouping,
          intervalUnmeasured,
          segments,
        })}
        <div className="sd3-tip-meta">
          {/*
            ISS-5850 (design review): the counts are WITHHELD on an unmeasured
            column, not printed as zero. They are measured claims — "0 events, 0
            tool calls" — about an interval nobody measured, and printing them
            one line under the sentence saying so re-commits the exact defect
            this ticket removes, in the footer of the card that fixes it. An
            uncovered column is initialized `total: 0, toolStart: 0` and never
            receives a contribution, so the zeros are structural, not observed.
            The jump hint stays: it describes the CONTROL, not the data.
          */}
          {intervalUnmeasured
            ? null
            : `${bucket.total} events | ${bucket.toolStart} tool calls`}
          {getBucketJumpHint(bucket, block)}
        </div>
      </div>
    </ViewportTooltipPortal>
  );
}

/**
 * ISS-5566 × ISS-5632 × ISS-5850: five genuinely different answers, kept in one
 * function so a reader can see they are exclusive — the slice was never measured
 * at all (ISS-5850), we do not know what it cost and may say so (synthesized,
 * flag on), we may not answer at all (unpublished, flag off), we know it was
 * nothing (idle), or here is the measured split.
 *
 * The order is load-bearing, twice over. `intervalUnmeasured` goes FIRST because
 * it is the only branch that disqualifies the rest: the others all describe what
 * a measurement found, and an unmeasured interval has no measurement to
 * describe. Then `costUnmeasured` implies `costsUnpublished` in production
 * (`barCostsUnpublished = costUnmeasured || costsSynthesized`), so testing it
 * before the silent branch is what keeps ISS-5566's disclosure copy on the
 * flag-on strip; reversed, the silent branch would swallow it.
 */
function renderBucketTooltipBody({
  bucket,
  cost,
  costsUnpublished,
  costUnmeasured,
  grouping,
  intervalUnmeasured,
  segments,
}: {
  bucket: ActivityBucket;
  cost: number;
  costsUnpublished: boolean;
  costUnmeasured: boolean;
  grouping?: TimelineStackGrouping;
  intervalUnmeasured: boolean;
  segments?: readonly TimelineStackSegment[];
}) {
  /*
   * ISS-5850: FIRST, ahead of both provenance branches below, because it is the
   * only one that disqualifies the others. `costUnmeasured` and the idle line
   * both describe what a measurement FOUND in this slice; an unmeasured interval
   * has no measurement to describe, so either of them here would answer a
   * question that was never asked. A column outside the extent also has cost 0
   * by construction, so without this branch it falls into the idle line and
   * reads "no tokens billed" — the exact false claim this ticket removes.
   */
  if (intervalUnmeasured) {
    return (
      <div className="sd3-tip-idle">{TIMELINE_UNMEASURED_INTERVAL_TOOLTIP}</div>
    );
  }
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
  if (costsUnpublished) {
    /*
     * ISS-5632: the same withdrawal, without the sentence. Reached only with the
     * disclosure flag off, where ISS-5563's ungated refusal to publish the
     * placeholder floor applies but its explanatory copy does not — so the card
     * gains no ungated user-facing text.
     *
     * It does NOT go silent, though (#5146 review, whitlockk). Only the money comes
     * off; `publishCosts: false` keeps every swatch and label and removes the
     * amounts.
     */
    return renderWithheldTooltipBody({ bucket, cost, grouping, segments });
  }
  if (cost === 0) {
    return (
      <div className="sd3-tip-idle">
        Agent asleep | scheduled wake-up | no tokens billed
      </div>
    );
  }
  if (grouping && segments) {
    return renderGroupedTooltipBody({
      cost,
      grouping,
      publishCosts: true,
      segments,
    });
  }
  return renderUngroupedTooltipBody({ bucket, cost, publishCosts: true });
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
 *
 * ISS-5632: `publishCosts` drops the cost COLUMN, header and cells together, and
 * nothing else. The swatch-and-label mapping is what the painted stack owes a
 * sighted reader, so it survives a withdrawal that only ever indicts the money;
 * a table left with an empty second column would be the withdrawal announcing
 * itself in layout instead of just not answering.
 */
function renderGroupedTooltipBody({
  cost,
  grouping,
  publishCosts,
  segments,
}: {
  cost: number;
  grouping: TimelineStackGrouping;
  publishCosts: boolean;
  segments: readonly TimelineStackSegment[];
}) {
  return (
    <table className="sd3-tip-tbl">
      <thead>
        <tr>
          <th>{getTimelineStackGroupingLabel(grouping).toLowerCase()}</th>
          {publishCosts ? <th>cost</th> : null}
        </tr>
      </thead>
      <tbody>
        {segments.map((segment) => (
          <tr key={segment.key}>
            <td className="mono">
              <i style={{ background: segment.colorVar }} />
              {segment.label}
            </td>
            {publishCosts ? (
              <td>{formatBucketTooltipMoney(segment.value, cost)}</td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * ISS-5632 (#5146 review): the withheld card's body — which legend the reader is
 * owed, given which stack was actually PAINTED.
 *
 * The stack is the thing being explained, and `renderBarStack` suppresses it on
 * `costUnmeasured` ALONE — never on `costsUnpublished`. So with the flag off a
 * floor-priced bucket still paints a coloured stack, and the card is the only
 * key to it. Which key depends on which of the two shapes was painted:
 *
 * - With `stacks`, the bar carries the "Group by" segments and the grouped table
 *   names them. The "Group by" control names only the DIMENSION, so without this
 *   the cut would be conveyed by hue alone (WCAG 1.4.1).
 * - WITHOUT them the bar falls back to the three fixed `cb-cache`/`cb-out`/`cb-in`
 *   segments, and this card's swatch headers are their ONLY legend in the
 *   product. That is not a corner: `useSessionTimelineScale` returns
 *   `controls: null` and `stacks: null` for every strip whose bins state no
 *   clock — the ordinal `buildEvenActivityBuckets` fallback, which is also the
 *   path a floor-priced session with no timed rows takes — so `grouping` is
 *   `undefined` there by construction, not by user choice. An earlier revision
 *   returned `null` here on the reasoning that no cut was painted; the fixed
 *   three-colour cut is painted, and the accessible name cannot cover for it
 *   either, because `buildBucketAccessibleCosts` returns `null` for every bucket
 *   on a floor-priced strip and `withStackBreakdown` appends nothing when
 *   `stacks` is `null`. Both audiences were told nothing about three colours.
 *
 * `null` is reserved for the genuinely UNPAINTED column: `cost <= 0`, which
 * `renderBarStack` refuses outright, and an idle column under a cut, whose
 * `segments` is an EMPTY array rather than absent. A header over no rows would be
 * the withdrawal announcing itself in layout instead of just not answering. That
 * silence takes the measured strip's idle line with it, deliberately: it ends "no
 * tokens billed", and on a session with no recorded cost at all that is a billing
 * claim nothing backs.
 */
function renderWithheldTooltipBody({
  bucket,
  cost,
  grouping,
  segments,
}: {
  bucket: ActivityBucket;
  cost: number;
  grouping?: TimelineStackGrouping;
  segments?: readonly TimelineStackSegment[];
}) {
  if (grouping && segments) {
    return segments.length > 0
      ? renderGroupedTooltipBody({
          cost,
          grouping,
          publishCosts: false,
          segments,
        })
      : null;
  }
  return cost > 0
    ? renderUngroupedTooltipBody({ bucket, cost, publishCosts: false })
    : null;
}

/**
 * The per-model cache/out/in table — the card's shape when no "Group by" cut is
 * in play, and the only place the three fixed stack colours are ever named.
 *
 * ISS-5632: `publishCosts` drops the AMOUNTS and nothing else. The swatch headers
 * are the legend for a stack that is still painted, so they survive a withdrawal
 * that only ever indicts the money, and the model column stays because a model
 * name is an observation, not a figure. The row then spans the full width rather
 * than trailing three empty cells, which would be the withdrawal announcing
 * itself in layout instead of just not answering.
 */
function renderUngroupedTooltipBody({
  bucket,
  cost,
  publishCosts,
}: {
  bucket: ActivityBucket;
  cost: number;
  publishCosts: boolean;
}) {
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
            <td className="mono" colSpan={publishCosts ? undefined : 4}>
              {model}
            </td>
            {publishCosts ? (
              <>
                <td>{formatBucketTooltipMoney(usage.cCache, cost)}</td>
                <td>{formatBucketTooltipMoney(usage.cOut, cost)}</td>
                <td>{formatBucketTooltipMoney(usage.cIn, cost)}</td>
              </>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
