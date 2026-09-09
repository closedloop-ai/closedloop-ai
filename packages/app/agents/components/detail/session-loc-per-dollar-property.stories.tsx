import type { Meta, StoryObj } from "@storybook/react";
import { createAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import { SessionLocPerDollarProperty } from "./session-loc-per-dollar-property";
import { SessionPropertiesFrame } from "./session-properties-story-frame";

const meta = {
  title: "App Core/Agents/Session LOC Per Dollar Property",
  component: SessionLocPerDollarProperty,
  tags: ["autodocs"],
  argTypes: {
    session: {
      control: "object",
      description:
        "Only linesAdded, linesRemoved and estimatedCost reach the ratio. Either side at zero renders the placeholder.",
    },
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <SessionPropertiesFrame>
        <Story />
      </SessionPropertiesFrame>
    ),
  ],
} satisfies Meta<typeof SessionLocPerDollarProperty>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ordinary computed case: 132 lines changed (120 added + 12 removed) over a
 * $4.82 session resolves to a real LOC/$ ratio. The numerator and denominator
 * are the same "Lines changed" and "Cost" the surrounding Properties pane
 * prints, so all three reconcile on the card.
 */
export const ComputedRatio: Story = {
  args: {
    session: createAgentSessionDetailFixture(),
  },
};

/**
 * REGRESSION GUARD for the `0.00` floor (ISS-4667), part one: a real but tiny
 * efficiency. 4 lines changed against a $500 session is a genuinely measured
 * `0.008` LOC/$ — a fixed-2dp render would floor it to `0.00` and claim the
 * session delivered nothing. The shared formatter switches to significant-digit
 * precision below `0.01`, so this row must read `0.008`, never `0.00`.
 */
export const SmallButRealRatio: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 3,
      linesRemoved: 1,
      estimatedCost: 500,
    }),
  },
};

/**
 * REGRESSION GUARD for the `0.00` floor (ISS-4667), part two — the state this PR
 * exists to introduce. The ratio is genuinely undefined (no cost to divide by),
 * so the row renders the honest not-applicable placeholder `—` rather than a
 * fabricated `0.00` that would read as "this session was maximally inefficient".
 * If this story ever shows a number, the floor is back.
 */
export const NotApplicableNoCost: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 120,
      linesRemoved: 12,
      estimatedCost: 0,
    }),
  },
};

/**
 * The other undefined-ratio input: a priced session that changed no lines. The
 * numerator is zero, so there is no efficiency to report and the row shows the
 * same not-applicable placeholder — not a `0.00` that would conflate "nothing
 * delivered" with "delivered nothing per dollar".
 */
export const NotApplicableNoLines: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 0,
      linesRemoved: 0,
      estimatedCost: 4.82,
    }),
  },
};
