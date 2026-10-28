import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import type { TimelineStackSegment } from "@repo/app/agents/lib/session-timeline-stacks";
import { SESSION_TIMELINE_LEGEND_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { expect, within } from "storybook/test";
import type { DotColor } from "./activity-dot-rendering";
import type { ActivityMarker } from "./session-timeline-axis";
import { SessionTimelineDotRail } from "./session-timeline-dot-rail";
import { SessionTimelineLegend } from "./session-timeline-legend";

/**
 * The Session Timeline's DOT RAIL in isolation.
 *
 * ISS-5819 (#4753 review, krisw-story-reviewer): this rail was PROMOTED out of
 * `agent-session-detail-view.tsx` into its own exported module in this PR, which
 * is exactly the trigger `packages/app/AGENTS.md` names — a private helper's
 * states stop being covered by the parent's single-shape fixture the moment it
 * becomes a module of its own. Its two siblings on the same strip
 * (`session-timeline-bars`, `session-timeline-axis`) and its opposite number in
 * `packages/app/branches` (`branch-event-dot-rail.stories.tsx`) each already
 * have one; this was the gap.
 *
 * What the parent-view story cannot show you, and each story below can:
 *
 * - the THREE LANES and their order (`b` human steering, `g` commits & PRs,
 *   `r` failures & limits), including a column where more than one lane lights
 *   up at once — the case that decides whether the dots stay separable;
 * - the HOVER (`hot`) affordance, which in the real strip needs a live pointer
 *   over exactly the right 6px target;
 * - the WITHDRAWN dot (ISS-5479, unconditional since ISS-6006 retired its gate
 *   ON): a lane whose events carry no transcript row drops the scale-on-hover,
 *   takes `aria-disabled`, and loses the "Jump to" from its accessible name —
 *   three changes that have to happen together, and the defect was shipping
 *   only some of them.
 */

/** The strip measured on the real session-detail panel at a 1440px window. */
const STAGE_DETAIL_WIDTH_PX = 936;

/** The jump-promising form of a dot's accessible name, withdrawn when rowless. */
const JUMP_TO_DOT_NAME = /^Jump to /;

const meta = {
  title: "Composites v1.0/Agents/Detail/Session Timeline Dot Rail",
  component: SessionTimelineDotRail,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  args: {
    buckets: stageBuckets(),
    cells: mixedLaneCells(),
    disabled: false,
    hoverDot: null,
    onHoverDot: () => {
      // Static stories; the hover state is driven by the `hoverDot` arg.
    },
    onJump: () => {
      // No transcript to scroll in isolation.
    },
  },
} satisfies Meta<typeof SessionTimelineDotRail>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ordinary rail: eight columns, each lane appearing where its events fell.
 * Column 3 lights all three at once, which is the density question — three dots
 * stacked in one column is the most crowded a real column gets.
 */
export const Default: Story = {
  decorators: [
    (Story) => (
      <DotRailStage caption="A measured rail. Column 3 carries all three lanes at once, which is the densest a column gets; every dot here has a transcript row behind it, so all of them offer a jump.">
        <Story />
      </DotRailStage>
    ),
  ],
};

/**
 * The hover state, pinned rather than performed. `hot` is what tells the reader
 * which of several adjacent dots their pointer has actually acquired — worth
 * looking at beside {@link Default}, because a hover treatment that is legible
 * on an isolated dot can disappear inside a three-dot column.
 */
export const HoveredDot: Story = {
  args: { hoverDot: { bucketIndex: 3, color: "g" } },
  decorators: [
    (Story) => (
      <DotRailStage caption="Hover acquired on the green lane of column 3 — the crowded column, which is where the affordance has to work hardest.">
        <Story />
      </DotRailStage>
    ),
  ],
};

/**
 * ISS-5479, and the reason that fix exists: a lane whose events carry no
 * transcript row must withdraw the affordance COMPLETELY. The defect was a dot
 * that kept its pointer cursor and its scale-1.4 hover while announcing a jump
 * it could not make — half the bar's treatment.
 *
 * Every dot here is rowless, so the whole rail is in the withdrawn state and the
 * three changes are visible together: no `hot` growth, `aria-disabled`, and an
 * accessible name that is the lane's own ("Commits & PRs") rather than "Jump to
 * Commits & PRs".
 */
export const WithdrawnNoJump: Story = {
  args: { cells: rowlessCells(), hoverDot: { bucketIndex: 3, color: "g" } },
  decorators: [
    (Story) => (
      <DotRailStage caption="Every lane rowless: the dots still mark that something happened, but they no longer offer — or announce — a jump. Hover is pinned on column 3 to show the growth is gone too.">
        <Story />
      </DotRailStage>
    ),
  ],
  // ISS-6006 removed this story's flag-OFF twin, whose only job was to prove the
  // withdrawn state was a CHANGE. Without it the withdrawal is invisible to the
  // all-stories sweep — the rowless rail and the default rail differ only in
  // attributes — so the two machine-readable halves are asserted here instead.
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const dot of canvas.getAllByRole("button")) {
      await expect(dot).toHaveAttribute("aria-disabled", "true");
    }
    await expect(
      canvas.queryByRole("button", { name: JUMP_TO_DOT_NAME })
    ).not.toBeInTheDocument();
  },
};

/**
 * FEA-4252 passes `disabled` for the whole strip while the trace has no rendered
 * rows, and that can sit true indefinitely rather than for one frame.
 */
export const DisabledStrip: Story = {
  args: { disabled: true },
  decorators: [
    (Story) => (
      <DotRailStage caption="Disabled: the rail still shows where events fell, but no dot is a live control.">
        <Story />
      </DotRailStage>
    ),
  ],
};

/**
 * ISS-12117 (ISS-10676): the rail's own palette beside every bar colour the
 * strip can paint. The legend is gated on
 * `SESSION_TIMELINE_LEGEND_FEATURE_FLAG_KEY`, opened here, and its Bars group
 * is fed one segment per `--chart-*` slot (the five a Model-grouped strip
 * cycles through, a superset of the three token-type colours), so every bar
 * hue sits next to the three marks it must never be mistaken for.
 *
 * What to look for: no mark shares a hue with a bar swatch, and each lane's
 * shape (square, circle, diamond) is the same in the rail and in the key. Compare with
 * {@link PaletteKeyDark}; the dark-mode collision ISS-10676 measured did not
 * exist in light mode, so one theme alone proves nothing.
 */
export const PaletteKey: Story = {
  parameters: {
    appCore: { enabledFlags: [SESSION_TIMELINE_LEGEND_FEATURE_FLAG_KEY] },
  },
  decorators: [
    (Story) => (
      <DotRailStage caption="Every bar colour the strip can paint, in the key above the rail's three marks. Steering is a magenta square, commits and PRs a violet circle, failures and limits a crimson diamond: none shares a hue with a bar, and each mark has its own shape, which is what tells them apart when colour cannot.">
        <Story />
      </DotRailStage>
    ),
  ],
  render: (args) => (
    <>
      <SessionTimelineLegend
        buckets={args.buckets}
        cells={args.cells}
        costUnmeasured={false}
        stacks={allChartSlotStacks()}
      />
      <SessionTimelineDotRail {...args} />
    </>
  ),
};

/** {@link PaletteKey} in the dark theme, where `--chart-1` met `--primary`. */
export const PaletteKeyDark: Story = {
  ...PaletteKey,
  globals: { theme: "dark" },
};

/**
 * The rail's own layout lives in `.sd3-drail` under `.sd3-actbar`. Without those
 * ancestors the cells have no column width to distribute across, so every story
 * would bunch the dots at the left edge.
 *
 * Width is pinned rather than stretched to the canvas, for the same reason the
 * bar-row stories pin theirs: a column is roughly 18px on the real surface, and
 * an arbitrary canvas width would give each dot room it does not have.
 */
function DotRailStage({
  caption,
  children,
}: Readonly<{ caption: ReactNode; children: ReactNode }>) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 13, margin: 0, maxWidth: "44rem", opacity: 0.75 }}>
        {caption}
      </p>
      <div className="sd3-actbar" style={{ maxWidth: STAGE_DETAIL_WIDTH_PX }}>
        <div className="sd3-act-head">
          <span className="sd3-act-title">Session Timeline</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function stageBuckets(): ActivityBucket[] {
  return Array.from({ length: 8 }, (_, index) => ({
    byModel: {},
    cCache: 0,
    cIn: 0,
    cOut: 0,
    key: `dot-${index}`,
    label: `${index * 5}m`,
    tl0: index,
    toolStart: 0,
    total: 0,
  }));
}

/** A marker as the rail consumes it: everything but its plotted position. */
function dotEvent(
  kind: ActivityMarker["kind"],
  label: string,
  row: number
): Omit<ActivityMarker, "x"> {
  return { kind, label, t: "9:05 AM", tl: row };
}

/**
 * The same event with no transcript row — the state ISS-5479 exists for, since
 * a SYNCED marker can deserialize without one and the rail reads `?.tl ?? null`.
 *
 * ISS-7632: this is now plain key omission. `ActivityMarker.tl` is optional, so
 * the prop type says what the runtime already did and the fixture no longer has
 * to cast its way to a reachable state.
 */
function withoutRow(
  event: Omit<ActivityMarker, "x">
): Omit<ActivityMarker, "x"> {
  const { tl: _row, ...rowless } = event;
  return rowless;
}

function emptyLanes(): Record<DotColor, Omit<ActivityMarker, "x">[]> {
  return { b: [], g: [], r: [] };
}

/**
 * Eight columns with the lanes spread across them, and column 3 carrying all
 * three at once. Rows are present, so every dot offers a jump.
 */
function mixedLaneCells(): Record<DotColor, Omit<ActivityMarker, "x">[]>[] {
  return stageBuckets().map((_, index) => {
    const cell = emptyLanes();
    if (index === 1 || index === 3 || index === 6) {
      cell.b.push(dotEvent("prompt", "Try the other adapter", index * 10));
    }
    if (index === 3 || index === 4) {
      cell.g.push(dotEvent("commit", "Commit pushed", index * 10 + 1));
    }
    if (index === 3 || index === 5) {
      cell.r.push(dotEvent("fail", "CI failed — flaky seed", index * 10 + 2));
    }
    // Two events in one lane: the tooltip's "N events" line keys off this, and
    // the rail must still draw exactly one dot for the lane.
    if (index === 6) {
      cell.b.push(dotEvent("frust", "Still not right", index * 10 + 3));
    }
    return cell;
  });
}

/**
 * The same shape with every `tl` absent — a synced marker that deserialized
 * without a transcript row, which is the ISS-5479 case.
 */
function rowlessCells(): Record<DotColor, Omit<ActivityMarker, "x">[]>[] {
  return mixedLaneCells().map((cell) => ({
    b: cell.b.map(withoutRow),
    g: cell.g.map(withoutRow),
    r: cell.r.map(withoutRow),
  }));
}

/**
 * One column per `--chart-*` slot, labelled as the Model grouping labels them.
 * The model names are fixture data; the colours are the point.
 */
function allChartSlotStacks(): TimelineStackSegment[][] {
  return [
    "claude-opus-4-1",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "gpt-5",
    "gemini-2.5-pro",
  ].map((model, index) => [
    {
      colorVar: `var(--chart-${index + 1})`,
      key: model,
      label: model,
      value: 1,
    },
  ]);
}
