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
 * the priced branch's "wasn't recorded".
 *
 * No `autodocs` tag: `ActivityBucketTooltip` portals to `document.body` at
 * `position: fixed` (`ViewportTooltipPortal`), so a docs page rendering every
 * story at once would stack every card on the same viewport coordinates.
 * One story per canvas is the only way each is actually legible —
 * `agent-session-detail-view.stories.tsx` omits the tag for the same reason.
 */
const meta = {
  title: "App Core/Agents/Activity Bucket Tooltip",
  component: ActivityBucketTooltip,
  args: { costUnmeasured: false },
  argTypes: {
    anchor: {
      control: false,
      description:
        "Viewport rect the card pins itself to. The stage re-measures its stand-in bar on layout, so editing this value does not move the card.",
    },
    block: {
      control: { type: "radio" },
      options: [
        null,
        BucketJumpBlock.NoTurn,
        BucketJumpBlock.NotInReadTranscript,
      ],
      description: "Why a click cannot land, or null when the bar is jumpable.",
    },
    bucket: { control: "object" },
    costUnmeasured: {
      control: "boolean",
      description:
        "True when this strip's money was synthesized, not measured.",
    },
    grouping: {
      control: { type: "radio" },
      options: Object.values(TimelineStackGrouping),
      description:
        "Active Group-by cut. Leave unset for the per-model cache/out/in table.",
    },
    segments: { control: "object" },
  },
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
  costUnmeasured = false,
  grouping,
  segments,
}: Readonly<{
  anchor: TooltipAnchor;
  block: BucketJumpBlock | null;
  bucket: ActivityBucket;
  caption: ReactNode;
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
 * The same branch cut by ACTIVITY PHASE, which is the one that also exercises
 * `UNATTRIBUTED_KEY`'s label reaching the card.
 *
 * Two stories rather than one because the header text is derived per grouping,
 * and a single scenario would let a hardcoded "model" header pass. The
 * `Unattributed` row is here deliberately: it is what the projection emits for
 * the stretch of a column no classifier span covers, so it is the most common
 * real segment on this cut and the one most likely to be mistaken for a bug.
 */
export const GroupedByActivityPhase: Story = {
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
      },
    },
    grouping: TimelineStackGrouping.ActivityPhase,
    segments: [
      {
        colorVar: "var(--chart-1)",
        key: "implement",
        label: "Implement",
        value: 3.0,
      },
      {
        colorVar: "var(--chart-2)",
        key: "review",
        label: "Review",
        value: 3.0,
      },
      {
        colorVar: "var(--chart-4)",
        key: "unattributed",
        label: "Unattributed",
        value: 1.21,
      },
    ],
  },
  render: (args) => (
    <BucketTooltipStage
      {...args}
      caption="Group by activity phase: the header follows the cut, and the Unattributed row is the stretch of the column no classifier span covered — not a rendering gap."
    />
  ),
};
