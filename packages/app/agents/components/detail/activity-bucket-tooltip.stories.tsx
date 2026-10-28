import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import {
  TimelineStackGrouping,
  type TimelineStackSegment,
} from "@repo/app/agents/lib/session-timeline-stacks";
import type { Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { BucketJumpBlock } from "./activity-bucket-rendering";
import { ActivityBucketTooltip } from "./activity-bucket-tooltip";
import { getTooltipAnchor, type TooltipAnchor } from "./viewport-tooltip";

/**
 * ISS-5563 review (krisw-story-reviewer). The header/rows precision mismatch this
 * card carries — a `$0.0042` total sitting over a table whose every cell read
 * `$0.00` — was caught in review twice before it landed, because the only thing
 * asserting it was a pair of formatter unit tests that each passed in isolation.
 * The agreement is between TWO figures rendered inches apart, so it is a thing to
 * LOOK at, and the populated `AgentSessionDetailView` story cannot serve: you
 * would have to hover exactly the right bar, and its fixture never reaches the
 * sub-cent or idle edges at all.
 *
 * The stories below are that state matrix, one scenario each. Three answer the
 * MEASURED strip: {@link Idle} (no tokens billed), {@link PricedMultiModel} (the
 * ordinary magnitude, where the cent floor on the rows is correct), and
 * {@link SubCentBucket} (the regression itself).
 *
 * ISS-5566 adds a second axis — whether the strip's money was measured at all —
 * and the same argument carries: {@link UnmeasuredPriced} and
 * {@link UnmeasuredIdle} are branches of `costUnmeasured` that the populated
 * parent-view story cannot reach without hovering exactly the right bar. They
 * are two stories rather than one because a synthesized bucket at zero cost
 * still carries a real observation (`total === 0`) and must not be answered with
 * the priced branch's "wasn't recorded". ISS-5632 adds the third point on that
 * axis, {@link UnpublishedPriced}: the withdrawal without the sentence, which is
 * what a flag-off synthesized strip gets.
 *
 * No `autodocs` tag: `ActivityBucketTooltip` portals to `document.body` at
 * `position: fixed` (`ViewportTooltipPortal`), so a docs page rendering every
 * story at once would stack every card on the same viewport coordinates.
 * One story per canvas is the only way each is actually legible —
 * `agent-session-detail-view.stories.tsx` omits the tag for the same reason.
 */
const meta = {
  title: "Composites v1.0/Agents/Detail/Activity Bucket Tooltip",
  tags: ["deprecated"],
  component: ActivityBucketTooltip,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ActivityBucketTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The card is anchored to a viewport rect, not to a parent box, so a story that
 * rendered it bare would float it against the canvas origin with nothing to
 * read it against. This stage puts a stand-in activity bar on screen, measures
 * it with the same {@link getTooltipAnchor} the real strip uses, and hands the
 * resulting rect over — so each story shows the card where a hover would
 * actually put it, and the flip/clamp logic runs for real.
 */
function BucketTooltipStage({
  anchor: initialAnchor,
  block,
  bucket,
  caption,
  costsUnpublished = false,
  costUnmeasured = false,
  grouping,
  segments,
}: Readonly<{
  anchor: TooltipAnchor;
  block: BucketJumpBlock | null;
  bucket: ActivityBucket;
  caption: ReactNode;
  costsUnpublished?: boolean;
  costUnmeasured?: boolean;
  grouping?: TimelineStackGrouping;
  segments?: readonly TimelineStackSegment[];
}>) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<TooltipAnchor>(initialAnchor);

  useLayoutEffect(() => {
    if (barRef.current) {
      setAnchor(getTooltipAnchor(barRef.current));
    }
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: "60vh",
        padding: 24,
      }}
    >
      <p style={{ fontSize: 13, margin: 0, maxWidth: "48rem", opacity: 0.75 }}>
        {caption}
      </p>
      <div
        ref={barRef}
        style={{
          background: "var(--muted, #8884)",
          borderRadius: 2,
          height: 64,
          width: 18,
        }}
      />
      <ActivityBucketTooltip
        anchor={anchor}
        block={block}
        bucket={bucket}
        costsUnpublished={costsUnpublished}
        costUnmeasured={costUnmeasured}
        grouping={grouping}
        segments={segments}
      />
    </div>
  );
}

/**
 * The `anchor` arg's starting value: a zero rect, used for the single render
 * that happens before {@link BucketTooltipStage} has measured the stand-in bar.
 * `useViewportTooltipStyle` renders the card hidden until it has measured
 * itself anyway, so this is the same pre-measurement state the real strip passes
 * through — not a placeholder the reader ever sees.
 */
const UNMEASURED_ANCHOR: TooltipAnchor = {
  bottom: 0,
  height: 0,
  left: 0,
  right: 0,
  top: 0,
  width: 0,
};

/**
 * A bucket whose slice caught no billed tokens at all. The decomposition table
 * is replaced outright by the idle line rather than rendered as a grid of zeros
 * — a table of `$0.00` cells asserts a measurement, and nothing was measured
 * here. `block` is `NoTurn` so the meta row also answers the click the bar's
 * withdrawn cursor has just refused.
 */
export const Idle: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    block: BucketJumpBlock.NoTurn,
    bucket: {
      label: "02:15 – 02:30",
      cIn: 0,
      cOut: 0,
      cCache: 0,
      total: 0,
      toolStart: 0,
      tl0: null,
      byModel: {},
    },
  },
  render: (args) => (
    <BucketTooltipStage
      {...args}
      caption="Idle bucket: no tokens billed, so the card states that in words instead of tabulating zeros."
    />
  ),
};

/**
 * The ordinary magnitude, and the reason the rows' cent floor is not simply a
 * bug: at $7.21 a bucket the reader wants whole cents, and the trailing
 * `claude-3-5-haiku` row — a real but negligible slice — is correctly floored to
 * `$0.00` rather than spraying `$0.0004` across the table. Header reads `$7.21`;
 * every row that carries a cent or more agrees with it at the same precision.
 */
export const PricedMultiModel: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    block: null,
    bucket: {
      label: "14:00 – 14:15",
      cIn: 0.64,
      cOut: 2.17,
      cCache: 4.4,
      total: 128,
      toolStart: 31,
      tl0: 412,
      byModel: {
        "claude-opus-4": { cIn: 0.6, cOut: 2.05, cCache: 4.1 },
        "claude-sonnet-4": { cIn: 0.04, cOut: 0.12, cCache: 0.3 },
        "claude-3-5-haiku": { cIn: 0.0002, cOut: 0.0003, cCache: 0.0001 },
      },
    },
  },
  render: (args) => (
    <BucketTooltipStage
      {...args}
      caption="Priced bucket, multi-model: header $7.21 over rows at whole cents. The haiku row flooring to $0.00 is deliberate at this magnitude."
    />
  ),
};

/**
 * REGRESSION GUARD, and the defect that reached review twice. The bucket totals
 * $0.0042 — genuinely sub-cent, and reachable in practice because `getBarStyle`'s
 * `showLabel` will select a bucket this small and `applyBucketCost` splits a
 * floored bucket into three slices that are each well under a cent.
 *
 * Both fixes have to be visible in this one card at once: the header is
 * `formatCostPrecise`, so it matches the `$0.0042` painted on the bar instead of
 * collapsing to `$0.00` one hover away; and the ROWS drop to the same precise
 * formatter exactly because the bucket they decompose is itself sub-cent, so the
 * table adds up to the total printed two lines above it. If this story ever
 * shows a `$0.0042` header over a grid of `$0.00` cells — or a `$0.00` header at
 * all — one of the two halves has regressed.
 */
export const SubCentBucket: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    block: null,
    bucket: {
      label: "09:45 – 10:00",
      cIn: 0.0002,
      cOut: 0.0009,
      cCache: 0.0031,
      total: 3,
      toolStart: 1,
      tl0: 88,
      byModel: {
        "claude-3-5-haiku": { cIn: 0.0002, cOut: 0.0009, cCache: 0.0031 },
      },
    },
  },
  render: (args) => (
    <BucketTooltipStage
      {...args}
      caption="Sub-cent bucket: header and rows must state ONE magnitude. Both use the precise formatter here, so the decomposition adds up to the total above it."
    />
  ),
};

/**
 * ISS-5566, and the reason it needs a story of its own: this is the SAME bucket
 * as {@link PricedMultiModel} — byte-for-byte the same `byModel` split, the same
 * $7.21 — rendered on a strip whose money was synthesized rather than measured.
 * Read the two side by side and the fix is the whole diff between them: the
 * header total is gone, and the per-model cache/out/in table is gone with it.
 *
 * That table is the point. The synthesized split is three FIXED ratios applied
 * to a guessed per-bucket share, so before this change every bar's decomposition
 * repeated the same 69/23/8 shape — the most legible fabrication on the surface,
 * and the one a reader is most likely to trust because it looks like a
 * measurement. The event and tool-call counts in the meta row are real
 * observations and deliberately stay.
 *
 * A regression here reads as this story growing its dollar figures back: a
 * `$7.21` header, or any `$` cell under it, means `costUnmeasured` stopped
 * reaching the readout and the priced table returned.
 */
export const UnmeasuredPriced: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    block: null,
    bucket: {
      label: "14:00 – 14:15",
      cIn: 0.64,
      cOut: 2.17,
      cCache: 4.4,
      total: 128,
      toolStart: 31,
      tl0: 412,
      byModel: {
        "claude-opus-4": { cIn: 0.6, cOut: 2.05, cCache: 4.1 },
        "claude-sonnet-4": { cIn: 0.04, cOut: 0.12, cCache: 0.3 },
        "claude-3-5-haiku": { cIn: 0.0002, cOut: 0.0003, cCache: 0.0001 },
      },
    },
    costUnmeasured: true,
  },
  render: (args) => (
    <BucketTooltipStage
      {...args}
      caption="Synthesized strip, priced bucket: the SAME bucket as PricedMultiModel. Header total and per-model table are both withdrawn; the measured event and tool-call counts stay."
    />
  ),
};

/**
 * The second unmeasured branch, and it is deliberately NOT the same sentence as
 * {@link UnmeasuredPriced}. A synthesized bucket at zero cost has `total === 0`:
 * the transcript caught no turn in that slice, which is a real observation, so
 * answering "cost wasn't recorded" here would throw away a fact the surface
 * holds.
 *
 * Nor can it borrow {@link Idle}'s line. That one ends "no tokens billed" — a
 * billing claim, and on a session whose costs were never measured nothing backs
 * it. So this branch keeps the true-zero/unknown distinction while making
 * neither claim, which is why the two unmeasured stories exist rather than one.
 *
 * If this story ever shows the measured idle line, or the same sentence as
 * {@link UnmeasuredPriced}, that distinction has collapsed.
 */
export const UnmeasuredIdle: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    block: BucketJumpBlock.NoTurn,
    bucket: {
      label: "02:15 – 02:30",
      cIn: 0,
      cOut: 0,
      cCache: 0,
      total: 0,
      toolStart: 0,
      tl0: null,
      byModel: {},
    },
    costUnmeasured: true,
  },
  render: (args) => (
    <BucketTooltipStage
      {...args}
      caption="Synthesized strip, empty bucket: the transcript caught no turn here, which is a real observation — so this says that, without the measured line's 'no tokens billed' billing claim."
    />
  ),
};

/**
 * ISS-5632, the third state on the provenance axis, and the one that shipped
 * broken: the disclosure flag is OFF, so the strip may not publish the
 * `Math.max(estimatedCost, 0.01)` floor — but it has not been given the copy
 * that explains why either.
 *
 * Same $7.21 bucket as {@link PricedMultiModel} and {@link UnmeasuredPriced}, so
 * the three read as one axis. Against `UnmeasuredPriced` the only difference is
 * the missing sentence; against `PricedMultiModel` it is every dollar figure.
 *
 * A regression reads as the header total or a `$` cell coming back — which is
 * this card rendering as `PricedMultiModel` beside a rail that withheld the very
 * same number.
 */
export const UnpublishedPriced: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    block: null,
    bucket: {
      label: "14:00 – 14:15",
      cIn: 0.64,
      cOut: 2.17,
      cCache: 4.4,
      total: 128,
      toolStart: 31,
      tl0: 412,
      byModel: {
        "claude-opus-4": { cIn: 0.6, cOut: 2.05, cCache: 4.1 },
        "claude-sonnet-4": { cIn: 0.04, cOut: 0.12, cCache: 0.3 },
      },
    },
    costsUnpublished: true,
  },
  render: (args) => (
    <BucketTooltipStage
      {...args}
      caption="Synthesized costs, disclosure flag off: no header total and no table, and no sentence either — the withdrawal is ungated, the copy explaining it is not."
    />
  ),
};

/**
 * The zero-cost half of {@link UnpublishedPriced}, and the one state this fix
 * deliberately makes QUIETER than it was.
 *
 * The measured strip answers an empty slice with "Agent asleep | scheduled
 * wake-up | no tokens billed", and {@link UnmeasuredIdle} replaces that with a
 * sentence that drops the billing claim. Flag off there is no such sentence to
 * fall back to — it is gated copy — so the card falls silent rather than assert
 * "no tokens billed" on a session whose costs were never measured at all.
 *
 * What survives is the meta row: `0 events | 0 tool calls` is measured from the
 * transcript, so the true-zero observation ISS-5566 fought to keep is still on
 * screen. If this story ever shows the measured idle line, that argument has
 * been lost.
 */
export const UnpublishedIdle: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    block: BucketJumpBlock.NoTurn,
    bucket: {
      label: "02:15 – 02:30",
      cIn: 0,
      cOut: 0,
      cCache: 0,
      total: 0,
      toolStart: 0,
      tl0: null,
      byModel: {},
    },
    costsUnpublished: true,
  },
  render: (args) => (
    <BucketTooltipStage
      {...args}
      caption="Synthesized costs, disclosure flag off, empty bucket: no figure and no sentence, but the measured 0 events | 0 tool calls still says the slice was quiet."
    />
  ),
};

/**
 * ISS-5819 (#4753 review, krisw-story-reviewer): the "Group by" branch, which
 * swaps the four-column per-model cache/out/in table for a TWO-column grouped
 * one — header naming the dimension, each row a swatch plus its label.
 *
 * It is a different table, not a restyled one, and none of the six scenarios
 * above reaches it: they all leave `grouping`/`segments` undefined. Nor can the
 * parent-view story serve, for the reason this whole file exists — you would
 * have to pick the right cut from the select AND hover exactly the right bar.
 *
 * What to look at: the header reads the dimension rather than `model`; the
 * column count drops from four to two; every row carries BOTH a swatch and a
 * text label, so a reader who cannot separate the colours still gets the cut
 * (WCAG 1.4.1); and the rows still sum to the header, which is the projection's
 * conservation contract arriving on screen.
 */
export const GroupedByModel: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    block: null,
    bucket: {
      label: "14:00 – 14:15",
      cIn: 0.64,
      cOut: 2.17,
      cCache: 4.4,
      total: 128,
      toolStart: 31,
      tl0: 412,
      byModel: {
        "claude-opus-4": { cIn: 0.6, cOut: 2.05, cCache: 4.1 },
        "claude-sonnet-4": { cIn: 0.04, cOut: 0.12, cCache: 0.3 },
      },
    },
    grouping: TimelineStackGrouping.Model,
    segments: [
      {
        colorVar: "var(--chart-1)",
        key: "claude-opus-4",
        label: "claude-opus-4",
        value: 6.75,
      },
      {
        colorVar: "var(--chart-2)",
        key: "claude-sonnet-4",
        label: "claude-sonnet-4",
        value: 0.46,
      },
    ],
  },
  render: (args) => (
    <BucketTooltipStage
      {...args}
      caption="Group by model: two columns, header named for the dimension, and the two rows sum to the $7.21 header."
    />
  ),
};

/**
 * ISS-5632 (#5146 review, whitlockk): the grouped card with the money withdrawn, and
 * the state the fix exists to produce. This is what a floor-priced strip's hover
 * card looks like with the disclosure flag OFF and a "Group by" cut active — the
 * common case, since Token Type is the default cut.
 *
 * The pair to compare it against is {@link GroupedByModel}, which differs in
 * exactly one respect: the cost column, header and cells together, is gone. What
 * must NOT differ is the swatch-and-label mapping. The flag-off stack is still
 * painted in colour and the "Group by" control names only the DIMENSION, so this
 * table is the sole colour-to-label key a sighted reader has — an earlier
 * revision returned no body at all here, which left the cut encoded in hue alone
 * (WCAG 1.4.1) while the bar's accessible name kept the labels for everyone
 * else.
 *
 * A regression reads as either half coming back wrong: a `$` cell returning, or
 * the rows losing their labels.
 */
export const UnpublishedGroupedByModel: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    block: null,
    bucket: {
      label: "14:00 – 14:15",
      cIn: 0.64,
      cOut: 2.17,
      cCache: 4.4,
      total: 128,
      toolStart: 31,
      tl0: 412,
      byModel: {
        "claude-opus-4": { cIn: 0.6, cOut: 2.05, cCache: 4.1 },
        "claude-sonnet-4": { cIn: 0.04, cOut: 0.12, cCache: 0.3 },
      },
    },
    costsUnpublished: true,
    grouping: TimelineStackGrouping.Model,
    segments: [
      {
        colorVar: "var(--chart-1)",
        key: "claude-opus-4",
        label: "claude-opus-4",
        value: 6.75,
      },
      {
        colorVar: "var(--chart-2)",
        key: "claude-sonnet-4",
        label: "claude-sonnet-4",
        value: 0.46,
      },
    ],
  },
  render: (args) => (
    <BucketTooltipStage
      {...args}
      caption="Group by model, costs unpublished: one column, not two — every swatch and label survives, and only the money comes off."
    />
  ),
};
