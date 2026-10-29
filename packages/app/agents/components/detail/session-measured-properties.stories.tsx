import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
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
  title: "Composites v1.0/Agents/Detail/Session Measured Properties",
  component: SessionAutonomyProperty,
  tags: ["deprecated", "autodocs"],
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
 * ISS-5637's gate, ON. Mounted through the real `FeatureFlagAdapterProvider`
 * seam (the `sessions-summary-cards.stories.tsx` pattern) rather than a stubbed
 * boolean, so these stories resolve the flag exactly as the web session detail
 * and the desktop renderer do.
 */
const withTokensHonestyFlag: Decorator = (Story) => (
  <FeatureFlagAdapterProvider
    adapter={createStaticFeatureFlagAdapter({
      enabledFlags: [SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY],
    })}
  >
    <Story />
  </FeatureFlagAdapterProvider>
);

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
 * ISS-5637 REVERSED THE CLAIM THIS STORY WAS WRITTEN TO MAKE. It was authored
 * reading an all-zero quadruple as "every counter was RECORDED and every one is
 * zero" — but neither producer can emit the `null` that would have meant
 * unrecorded, so these four zeros are precisely what a session with NO
 * token-usage rows renders, and calling them a measurement was the defect.
 *
 * It survives as the record of the FLAG-OFF default, which is still what ships
 * by default. {@link TokensNoRecordedUsage} is the same fixture with the gate
 * open; the two are adjacent so the change the flag makes is visible rather
 * than inferred.
 */
export const TokensMeasuredZeroGateClosed: Story = {
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

/**
 * ISS-5637, gate OPEN: the same all-zero record now reads as one dash, because
 * a summed-zero quadruple is the absence of token-usage evidence rather than a
 * measurement of it. This is the row that used to contradict the Cost dash two
 * rows below it on the same panel.
 */
export const TokensNoRecordedUsage: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      tokensIn: 0,
      tokensOut: 0,
      cache: 0,
      cacheWrite: 0,
    }),
  },
  decorators: [withTokensHonestyFlag],
  render: (args) => <SessionTokensProperty {...args} />,
};

/**
 * The state ISS-5637 had to PRESERVE, and the reason its predicate sums the
 * quadruple rather than testing each counter: this session really did consume
 * tokens, and its two cache halves really were zero. Those zeros stay zeros.
 * Sitting beside {@link TokensNoRecordedUsage} is the only way to confirm a
 * reader can tell a measured `0 cache read` from a row that knows nothing —
 * collapsing both to a dash would swap one lie for the opposite one.
 */
export const TokensMeasuredZeroCacheWithUsage: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      tokensIn: 128_400,
      tokensOut: 24_800,
      cache: 0,
      cacheWrite: 0,
    }),
  },
  decorators: [withTokensHonestyFlag],
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

/**
 * ISS-5636, the THIRD state ISS-5565's absent/zero pair does not cover: counted,
 * but only over the events the producer could read. Worth looking at rather than
 * asserting, because the qualifier changes the row's TREATMENT — an explained
 * value is a focusable button, not the plain truncating span above — so the
 * question a story answers is whether a hedged row still sits in the same value
 * track as `AutonomyMeasured` beside it, or reads as a different kind of row.
 */
export const AutonomyPrefixCounted: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      autonomy: 41,
      autonomyTruncated: true,
    }),
  },
};

/**
 * The same state on the Work row, where only SOME of the counters are prefix
 * counts: the steer count is folded from the bounded event rows, the tool-call
 * count was re-read whole-run by ISS-5407, and a metadata `turns` was never
 * event-derived. Placed next to `WorkMeasured` because the numbers are
 * deliberately identical — the row's disclosure is the only difference.
 */
export const WorkPrefixCountedSteering: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      turns: 42,
      toolCallsTotal: 310,
      steeringEpisodes: 6,
      steeringEpisodesTruncated: true,
    }),
  },
  render: (args) => <SessionWorkProperty {...args} />,
};
