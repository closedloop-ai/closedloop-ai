import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import type { TimelineStackSegment } from "@repo/app/agents/lib/session-timeline-stacks";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { fn } from "storybook/test";
import { BucketJumpBlock, getBucketCost } from "./activity-bucket-rendering";
import { buildBucketAccessibleCosts } from "./session-timeline-bar-labels";
import { SessionTimelineBars } from "./session-timeline-bars";

/**
 * The Session Timeline's BAR ROW in isolation.
 *
 * Its two rail siblings — `session-timeline-axis.stories.tsx` and
 * `session-timeline-bar-labels.stories.tsx` — each got stories when they were
 * carved out of `agent-session-detail-view.tsx`; this row was extracted in
 * ISS-5761 and is the last of the three without one (code review). It also has
 * the richest state matrix of the three, and every state below was previously
 * reachable ONLY by mounting the whole `AgentSessionDetailView` with a session
 * fixture, a jump handler, hover state and up to three feature flags — which is
 * a fine test of the wiring and a poor place to look at a bar.
 *
 * Each story isolates one decision the row makes, so a future change to one of
 * these class contracts has a focused place to be eyeballed:
 *
 * - the UNREAD tail renders `aria-hidden` divs, not buttons, because there is
 *   nothing behind them to jump to and ~47 identically-named inert controls in a
 *   screen-reader path is worse than a caption;
 * - a BLOCKED bucket keeps its cost and tooltip but withdraws the affordance
 *   (`.no-jump` + `aria-disabled`), and the two block reasons stay distinct;
 * - a SYNTHESIZED read swaps the in/out/cache stack for the 45° hatch, and only
 *   on `Stacked` bars — never on a zero-cost one, which would repaint "nothing
 *   happened here" as "something happened, unpriced";
 * - the HIT-TARGET flag changes what area is clickable and hoverable without
 *   moving the bar, which stays the encoding of magnitude.
 */

/** The strip measured on the real session-detail panel at a 1440px window. */
const STAGE_DETAIL_WIDTH_PX = 936;

function makeBucket(
  index: number,
  cost: number,
  overrides: Partial<ActivityBucket> = {}
): ActivityBucket {
  return {
    byModel: {
      "gpt-5.5": { cCache: cost * 0.2, cIn: cost * 0.5, cOut: cost * 0.3 },
    },
    cCache: cost * 0.2,
    cIn: cost * 0.5,
    cOut: cost * 0.3,
    key: `bar-${index}`,
    label: `${index * 5}m`,
    tl0: index,
    toolStart: 2,
    total: 6,
    ...overrides,
  };
}

/**
 * A twelve-column strip with an interior quiet slice.
 *
 * Index 5 is zero-cost with priced buckets on both sides, which is the ONLY
 * shape `isInteriorGap` recognises — a trailing zero is idle, not a gap, and the
 * two draw differently. Keeping one of each in the default fixture means the
 * `.cb-gap` / `.idle` distinction is visible without its own story.
 */
function stageBuckets(): ActivityBucket[] {
  return [
    makeBucket(0, 4.2),
    makeBucket(1, 11.75),
    makeBucket(2, 27.75),
    makeBucket(3, 8.55),
    makeBucket(4, 14.95),
    makeBucket(5, 0),
    makeBucket(6, 18.15),
    makeBucket(7, 21.35),
    // Costly but ANCHORLESS: nothing distinguishes it from its neighbour on
    // geometry alone, which is the case `.no-jump` exists to tell apart.
    makeBucket(8, 12.4, { tl0: null }),
    makeBucket(9, 6.8),
    makeBucket(10, 24.55),
    // A trailing zero — idle, not an interior gap.
    makeBucket(11, 0),
  ];
}

const STAGE_BUCKETS = stageBuckets();
const STAGE_MAX_COST = Math.max(...STAGE_BUCKETS.map(getBucketCost));

function noBlocks(): (BucketJumpBlock | null)[] {
  return STAGE_BUCKETS.map(() => null);
}

/**
 * The row's own layout lives in `.sd3-bars2`, a flex-end row inside
 * `.sd3-bars2-wrap` under `.sd3-actbar`. Without those ancestors the bars have
 * no column height to be a percentage OF, so every story would render a flat
 * strip and the heights these stories exist to show could not happen.
 *
 * Width is pinned rather than stretched to the canvas: a bar is roughly 18px at
 * the producer's 40-bucket target, and a story given an arbitrary canvas width
 * would hand every bar room the real surface does not have.
 */
function BarRowStage({
  caption,
  children,
}: Readonly<{ caption: ReactNode; children: ReactNode }>) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ fontSize: 13, margin: 0, maxWidth: "44rem", opacity: 0.75 }}>
        {caption}
      </p>
      <div className="sd3-actbar" style={{ maxWidth: STAGE_DETAIL_WIDTH_PX }}>
        <div className="sd3-act-head">
          <span className="sd3-act-title">Session Timeline</span>
        </div>
        <div className="sd3-bars2-wrap">{children}</div>
      </div>
    </div>
  );
}

/**
 * The row of clickable, cost-colored bars in the Session Timeline that shows
 * where the money and time actually went, paired with the Axis and Dot Rail
 * rows.
 */
const meta = {
  title: "Primitives/Charts/Session Timeline Bars",
  component: SessionTimelineBars,
  tags: ["autodocs"],
  argTypes: {
    accessibleCosts: { control: "object", table: { category: "Data" } },
    buckets: { control: "object", table: { category: "Data" } },
    columnHitTargetEnabled: {
      control: "boolean",
      table: { category: "State" },
    },
    costUnmeasured: { control: "boolean", table: { category: "State" } },
    disabled: { control: "boolean", table: { category: "State" } },
    hoverIndex: {
      control: {
        max: STAGE_BUCKETS.length - 1,
        min: 0,
        step: 1,
        type: "number",
      },
      table: { category: "State" },
    },
    jumpBlocks: { control: "object", table: { category: "Data" } },
    maxCost: {
      control: { min: 0, step: 0.05, type: "number" },
      table: { category: "Data" },
    },
    onHover: { control: false, table: { category: "Events" } },
    onJump: { control: false, table: { category: "Events" } },
    stacks: { control: "object", table: { category: "Data" } },
    unreadFromIndex: {
      control: { max: STAGE_BUCKETS.length, min: 0, step: 1, type: "number" },
      table: { category: "State" },
    },
  },
  parameters: { layout: "padded" },
  args: {
    accessibleCosts: buildBucketAccessibleCosts({
      buckets: STAGE_BUCKETS,
      costsSynthesized: false,
    }),
    buckets: STAGE_BUCKETS,
    columnHitTargetEnabled: false,
    costUnmeasured: false,
    disabled: false,
    hoverIndex: null,
    jumpBlocks: noBlocks(),
    maxCost: STAGE_MAX_COST,
    // Stories are static; hover state is driven by the `hoverIndex` arg.
    onHover: fn(),
    // No transcript to scroll in isolation.
    onJump: fn(),
    // The ungated shape: the three hardcoded in/out/cache slices, no grouping.
    stacks: null,
    unreadFromIndex: STAGE_BUCKETS.length,
  },
} satisfies Meta<typeof SessionTimelineBars>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The measured, fully-jumpable strip: `sqrt(cost)/sqrt(maxCost)` heights, the
 * in/out/cache stack on every priced bar, the interior gap at index 5 drawn as
 * `.cb-gap` and the trailing zero at index 11 drawn as `.idle`.
 */
export const Default: Story = {
  decorators: [
    (Story) => (
      <BarRowStage caption="A measured strip. Every priced bar carries the in/out/cache stack; index 5 is an interior gap and index 11 a trailing idle slice — the two zero-cost treatments that mean different things.">
        <Story />
      </BarRowStage>
    ),
  ],
};

/**
 * ISS-5075: the tail the detail read never reached — a full-height wash rather
 * than the idle hatch, because an empty region on this strip already means
 * "nothing happened here" and without its own treatment a reader who skims past
 * the caption walks away with the wrong number of hours.
 *
 * These bars are `aria-hidden` DIVs, not buttons: the tail is many buckets wide
 * and none of them is a control.
 */
export const UnreadTail: Story = {
  args: { unreadFromIndex: 8 },
  decorators: [
    (Story) => (
      <BarRowStage caption="Everything from index 8 on is unread — real time with no evidence either way, not observed quiet. Rendered decorative and named once by the caption beneath the strip.">
        <Story />
      </BarRowStage>
    ),
  ],
};

/**
 * ISS-5479: the two reasons a click cannot land, side by side. They stay
 * distinct rather than collapsing into one "cannot jump" flag because they are
 * different facts and the reader is owed the difference — nothing happened in
 * that slice, versus something happened and you are looking at a different file.
 */
export const BlockedBuckets: Story = {
  args: {
    jumpBlocks: STAGE_BUCKETS.map((bucket, index) => {
      if (bucket.tl0 == null) {
        return BucketJumpBlock.NoTurn;
      }
      return index === 2 || index === 7
        ? BucketJumpBlock.NotInReadTranscript
        : null;
    }),
  },
  decorators: [
    (Story) => (
      <BarRowStage caption="Index 8 caught no transcript turn at all; indices 2 and 7 carry a turn that is absent from the transcript on screen (a `subagent:` view). All three withdraw the affordance with `.no-jump` + `aria-disabled` while keeping their cost in the accessible name.">
        <Story />
      </BarRowStage>
    ),
  ],
};

/**
 * ISS-5566: a strip whose per-bucket money was reconstructed rather than
 * measured. The hatch replaces the solid in/out/cache stack, because that stack
 * is the strip's way of saying "here is where the money went" and on a
 * synthesized bucket its split is three fixed ratios repeated on every bar.
 *
 * Note the zero-cost bars keep their own treatment: `.synthesized` composes ONLY
 * with `Stacked`, since it ties on specificity with `.idle`/`.cb-gap` and would
 * otherwise repaint "nothing happened here" as "something happened, unpriced".
 */
export const SynthesizedCosts: Story = {
  args: {
    accessibleCosts: buildBucketAccessibleCosts({
      buckets: STAGE_BUCKETS,
      costsSynthesized: true,
    }),
    costUnmeasured: true,
  },
  decorators: [
    (Story) => (
      <BarRowStage caption="A synthesized read: hatched active bars, no cost stack, and no figure in any accessible name — the strip stops publishing money it cannot stand behind, while the bars still draw at their placeholder heights.">
        <Story />
      </BarRowStage>
    ),
  ],
};

/**
 * ISS-5548: the whole column answers a click, without the bar moving. The bar
 * stays the encoding of magnitude; only the hit box grows.
 *
 * Keyed off `tl0`, so the anchorless bucket at index 8 is deliberately LEFT at
 * today's geometry — this flag must never turn inert space into a bigger dead
 * target, which is the defect ISS-5479 fixed.
 */
export const ColumnHitTarget: Story = {
  args: { columnHitTargetEnabled: true },
  decorators: [
    (Story) => (
      <BarRowStage caption="With the hit-target flag on, every anchored bar reaches the full column height for clicks and hover. Index 8 (anchorless) keeps its small target on purpose.">
        <Story />
      </BarRowStage>
    ),
  ],
};

/**
 * FEA-4252 passes `disabled` for the whole strip while the trace has no rendered
 * rows, and that is not merely a first-paint flash — it can sit true
 * indefinitely. A disabled bar keeps exactly today's geometry: this flag changes
 * where a live click lands, never what a dead control offers.
 */
export const DisabledStrip: Story = {
  args: { columnHitTargetEnabled: true, disabled: true },
  decorators: [
    (Story) => (
      <BarRowStage caption="Disabled with the hit-target flag ON: no bar takes `.reach`, so the cursor, the hover outline and the hit box all settle on one answer instead of offering a column-tall dead target.">
        <Story />
      </BarRowStage>
    ),
  ],
};

/**
 * ISS-5819 (#4753 review, krisw-story-reviewer): the "Group by" branch, where
 * `renderBarStack` paints from `segment.colorVar` — an OPEN set of model / phase
 * / owner keys — instead of the three fixed `cb-cache` / `cb-out` / `cb-in`
 * classes.
 *
 * That is a colour CONTRACT change, not a restyle: the number of slices, their
 * order, their palette and the percentage each takes all move, and every story
 * above leaves `stacks` null, so none of them draws a single pixel of it. This
 * file's own doc calls the row "the richest state matrix of the three"
 * specifically so each rendering decision gets a focused look; this is the one
 * decision that had none.
 *
 * What to look at: adjacent segments stay distinguishable at an ~18px bar width
 * (the real surface's, pinned by {@link BarRowStage}); the slices are ordered
 * largest-first so the eye reads the dominant model at the bottom of every bar;
 * and the zero-cost columns (5 and 11) take NO segments, so a grouped strip
 * still tells an idle slice apart from a priced one.
 */
export const GroupedByModel: Story = {
  args: { stacks: groupedByModelStacks() },
  decorators: [
    (Story) => (
      <BarRowStage caption="Group by model: each bar is cut by model rather than by token type, painted from the open-set colour vars. Zero-cost columns take no segments, so idle still reads as idle.">
        <Story />
      </BarRowStage>
    ),
  ],
};

/**
 * The same branch on the ACTIVITY PHASE cut, which is the one that carries
 * `Unattributed` — the stretch of a column no classifier span covered.
 *
 * Worth its own story because that segment is the most common one on this cut
 * and the easiest to misread as a rendering gap; seeing it named and coloured
 * beside real phases is what settles that it is a deliberate answer.
 */
export const GroupedByActivityPhase: Story = {
  args: { stacks: groupedByPhaseStacks() },
  decorators: [
    (Story) => (
      <BarRowStage caption="Group by activity phase, including the Unattributed slice the projection emits for time no classifier span covered — a stated answer, not a hole in the bar.">
        <Story />
      </BarRowStage>
    ),
  ],
};

/**
 * Per-column model segments over {@link STAGE_BUCKETS}, summing to each bucket's
 * own cost so the grouped bar is exactly as tall as the ungrouped one. A fixture
 * that did not conserve would make a real regression in the stack arithmetic
 * look like a deliberate fixture choice.
 */
function groupedByModelStacks(): TimelineStackSegment[][] {
  return STAGE_BUCKETS.map((bucket) => {
    const cost = getBucketCost(bucket);
    if (cost <= 0) {
      return [];
    }
    return [
      {
        colorVar: "var(--chart-1)",
        key: "claude-opus-4",
        label: "claude-opus-4",
        value: cost * 0.62,
      },
      {
        colorVar: "var(--chart-2)",
        key: "gpt-5.5",
        label: "gpt-5.5",
        value: cost * 0.28,
      },
      {
        colorVar: "var(--chart-3)",
        key: "claude-3-5-haiku",
        label: "claude-3-5-haiku",
        value: cost * 0.1,
      },
    ];
  });
}

/** The phase cut, conserving each bucket's cost for the same reason. */
function groupedByPhaseStacks(): TimelineStackSegment[][] {
  return STAGE_BUCKETS.map((bucket, index) => {
    const cost = getBucketCost(bucket);
    if (cost <= 0) {
      return [];
    }
    const explore = index < 4 ? cost * 0.7 : cost * 0.1;
    return [
      {
        colorVar: "var(--chart-1)",
        key: "explore",
        label: "Explore",
        value: explore,
      },
      {
        colorVar: "var(--chart-2)",
        key: "implement",
        label: "Implement",
        value: cost * 0.75 - explore * 0.75,
      },
      {
        colorVar: "var(--chart-4)",
        key: "unattributed",
        label: "Unattributed",
        value: cost - explore - (cost * 0.75 - explore * 0.75),
      },
    ];
  });
}
