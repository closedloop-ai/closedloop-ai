import type { Meta, StoryObj } from "@storybook/react";
import { OverviewMetric } from "./overview-metric";

// `OverviewMetric` was a private piece of `AiImpactCard`'s markup until it was
// promoted to a shared module, which is the moment `packages/app/AGENTS.md`
// says a prop-driven component owes its own story: its states stop being
// covered by the parent's single-shape fixture.
// The contract that is genuinely this component's own is what happens when the
// value does not fit. It commits to ONE line — `truncate` with the full string
// on `title` — because a metric that wraps to two lines breaks the baseline it
// shares with every sibling in the grid. These stories are how that gets
// checked, since a test asserting the class name proves nothing about whether
// the row still reads as a row.
/**
 * Shows one headline number inside a metrics summary: a small uppercase
 * label on top, a large value in the middle, and a muted caption underneath
 * explaining what the number covers. Use it when you need several of these
 * stat tiles lined up in a row and want them all to share one baseline,
 * rather than building a one off metric block for each. The value always
 * stays on a single line and truncates rather than wrapping, with the full
 * figure still reachable on hover, and a missing number should show the
 * honest placeholder rather than a fabricated zero.
 */
const meta: Meta<typeof OverviewMetric> = {
  title: "Primitives/Data Display/Overview Metric",
  component: OverviewMetric,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    value: { control: "text" },
    detail: {
      control: false,
      description:
        "The caption beneath the value. A ReactNode, so each story passes one in rather than editing it here.",
    },
    className: { control: false },
  },
  args: {
    label: "Cost per merged PR",
    value: "$12.40",
    detail: "214 PRs merged in range",
  },
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof OverviewMetric>;

export const Default: Story = {
  args: {
    label: "Cost per merged PR",
    value: "$12.40",
    detail: "214 PRs merged in range",
  },
};

/** The honest no-value glyph. Never a fabricated `0` — the caller decides. */
export const NoValue: Story = {
  args: {
    label: "Cost per merged PR",
    value: "—",
    detail: "No merged PR carries a line count yet",
  },
};

/**
 * The overflow case this component exists to handle: a top-model or repo name
 * far wider than its column. It must stay one line and keep the grid's
 * baseline, with the full string reachable on hover via `title`.
 */
export const LongValueTruncates: Story = {
  args: {
    label: "Top model",
    value: "claude-opus-5-20260114-extended-thinking-1m-context",
    detail: "62% of tokens across 1,284 sessions",
  },
};

/** A label long enough to wrap tests the uppercase eyebrow's own rhythm. */
export const LongLabel: Story = {
  args: {
    label: "Merged lines per non-subscription dollar",
    value: "118.4",
    detail: "84,212 lines across 214 merged PRs",
  },
};

/**
 * `detail` is a `ReactNode`, so a caller can emphasize part of the caption.
 * Worth pinning: it is the one prop that is not a plain string, and a two-line
 * caption changes the card's height.
 */
export const RichDetail: Story = {
  args: {
    label: "Merged lines per dollar",
    value: "118.4",
    detail: (
      <>
        Counted <span className="font-medium">96</span> of 148 sessions with
        spend, across 11 repositories connected this month
      </>
    ),
  },
};

/** Three in a row — the real arrangement, where any drift shows up. */
export const InAGrid: Story = {
  render: () => (
    <div className="grid grid-cols-3 gap-6">
      <OverviewMetric
        detail="214 PRs merged in range"
        label="Cost per merged PR"
        value="$12.40"
      />
      <OverviewMetric
        detail="8,240 tokens per thousand lines"
        label="Tokens per KLOC"
        value="8.2k"
      />
      <OverviewMetric
        detail="No merged PR carries a line count yet"
        label="Merged lines per dollar"
        value="—"
      />
    </div>
  ),
};
