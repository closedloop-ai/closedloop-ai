import type { Meta, StoryObj } from "@storybook/react";
import { createAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import {
  SessionAutonomyProperty,
  SessionTokensProperty,
  SessionWorkProperty,
} from "./session-measured-properties";
import { SessionPropertiesFrame } from "./session-properties-story-frame";

/**
 * ISS-5565. These three rows were promoted out of `agent-session-detail-view.tsx`
 * in the same change, which is the moment their state matrix stops being covered
 * by the parent's single-shape fixture — so they get isolated stories.
 *
 * The matrix that matters here is exactly the one the fix is about: **absent vs.
 * measured-zero**. Those two states differ by one glyph, they sit in the same
 * value track, and a test asserting `"—"` proves the string but not that the
 * dash reads as "we don't know" rather than as a squashed value. Each pair below
 * is deliberately adjacent so the difference is visible rather than inferred.
 */
const meta = {
  title: "App Core/Agents/Session Measured Properties",
  component: SessionAutonomyProperty,
  tags: ["autodocs"],
  argTypes: {
    session: {
      control: "object",
      description:
        "The measured fields these rows read: autonomy, tokensIn, tokensOut, cache, cacheWrite, turns and toolCallsTotal. Null is absent, 0 is measured, and the two must not render alike.",
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
} satisfies Meta<typeof SessionAutonomyProperty>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ordinary measured case: a high autonomy score renders its tier word and
 * its number, unchanged by this fix.
 */
export const AutonomyMeasured: Story = {
  args: { session: createAgentSessionDetailFixture({ autonomy: 92 }) },
};

/**
 * REGRESSION GUARD, the defect itself: `autonomy == null` used to render
 * "Unknown autonomy | 0/100" — the word saying unknown while the number said
 * measured-at-the-floor, and a reader takes the number. It now renders the same
 * shared empty affordance the Sessions LIST already used for this field, so one
 * record cannot tell two stories across two surfaces. If this story ever shows
 * `0/100` again, the coercion is back.
 */
export const AutonomyUnrecorded: Story = {
  args: { session: createAgentSessionDetailFixture({ autonomy: null }) },
};

/**
 * The guard against over-correcting, and the reason the pair above has to be
 * looked at rather than asserted: a MEASURED zero keeps its tier word and its
 * number. Placed next to `AutonomyUnrecorded` so the two states are visibly
 * different — that distinction is the whole fix.
 */
export const AutonomyMeasuredZero: Story = {
  args: { session: createAgentSessionDetailFixture({ autonomy: 0 }) },
};

/**
 * The Tokens row with everything recorded — the four counters and their
 * separators at the width they actually occupy, which is the row most at risk of
 * crowding when a dash replaces a number mid-line.
 */
export const TokensMeasured: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      tokensIn: 128_400,
      tokensOut: 24_800,
      cache: 1_204_000,
      cacheWrite: 96_000,
    }),
  },
  render: (args) => <SessionTokensProperty {...args} />,
};

/**
 * Nothing recorded: ONE dash for the whole row rather than
 * "— in | — out | — cache read | — cache write", which is four shrugs where one
 * will do — and, before the fix, "0 in | 0 out | 0 cache read | 0 cache write",
 * which claimed four measurements that never happened.
 */
export const TokensUnrecorded: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      tokensIn: null,
      tokensOut: null,
      cache: null,
      cacheWrite: null,
    }),
  },
  render: (args) => <SessionTokensProperty {...args} />,
};

/**
 * The partial case, which is the one only a story can really check: the row
 * keeps the halves it knows and dashes only the rest. Worth looking at because
 * a dash inline between two numbers has to sit on the same baseline and not
 * collapse the separators around it.
 */
export const TokensPartiallyRecorded: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      tokensIn: 128_400,
      tokensOut: 24_800,
      cache: null,
      cacheWrite: null,
    }),
  },
  render: (args) => <SessionTokensProperty {...args} />,
};

/**
 * The third state the pair above does not cover, and the one this fix most has
 * to get right: a session that genuinely consumed nothing. Every counter was
 * RECORDED and every one of them is zero, so the row reads "0 in | 0 out | …"
 * — a measurement, not a shrug. Sits next to `TokensUnrecorded` on purpose:
 * empty, unavailable, and real-zero are three different claims
 * (`packages/app/AGENTS.md`), and the only way to confirm the reader can tell
 * the last two apart is to look at them side by side.
 */
export const TokensMeasuredZero: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      tokensIn: 0,
      tokensOut: 0,
      cache: 0,
      cacheWrite: 0,
    }),
  },
  render: (args) => <SessionTokensProperty {...args} />,
};

/** The Work row fully measured — turns, tool calls, and steering episodes. */
export const WorkMeasured: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      turns: 42,
      toolCallsTotal: 310,
      steeringEpisodes: 6,
    }),
  },
  render: (args) => <SessionWorkProperty {...args} />,
};

/**
 * REGRESSION GUARD: `steeringEpisodes` is `Int?`, so null is a real state, and
 * "0 steers" asserted a measured absence of human steering that was never
 * measured. That is the most misleading of the three — a fully autonomous run
 * and an unrecorded one read identically.
 */
export const WorkUnrecordedSteering: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      turns: 42,
      toolCallsTotal: 310,
      steeringEpisodes: null,
    }),
  },
  render: (args) => <SessionWorkProperty {...args} />,
};

/**
 * The other side of that boundary: a run that really was never steered keeps
 * reading "0 steers". Adjacent to the story above so the pair shows that the fix
 * distinguishes absent from zero rather than hiding zeros.
 */
export const WorkMeasuredZeroSteering: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      turns: 42,
      toolCallsTotal: 310,
      steeringEpisodes: 0,
    }),
  },
  render: (args) => <SessionWorkProperty {...args} />,
};
