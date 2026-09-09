import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { Meta, StoryObj } from "@storybook/react";
import {
  SessionTimelineSummary,
  type SessionTimelineSummarySession,
} from "./session-timeline-summary";

/**
 * ISS-5970 — the Session Timeline's run-level summary, in every state it can
 * honestly be in.
 *
 * The matrix IS the story's job. Three of these five states are the ticket's
 * "do not let it lie" cases, and they are only distinguishable side by side: a
 * cost that could not be computed, a run with no token usage recorded, and a
 * subscription run whose cost is a GENUINE zero must not read alike. Seeing
 * `$0.00` and `—` in the same view is what stops the next change collapsing them.
 */
const ENDED_AT = new Date("2026-03-02T12:30:00Z");
const STARTED_AT = new Date("2026-03-02T10:13:00Z");

const baseSession: SessionTimelineSummarySession = {
  cacheReadTokens: 480_000,
  cacheWriteTokens: 120_000,
  endedAt: ENDED_AT,
  estimatedCost: 12.5,
  inputTokens: 1_400_000,
  model: "claude-sonnet-4",
  outputTokens: 100_000,
  startedAt: STARTED_AT,
  status: SESSION_STATUS.INACTIVE,
  turns: 42,
};

const meta: Meta<typeof SessionTimelineSummary> = {
  argTypes: {
    /*
     * The whole matrix lives in one prop, and every field it turns on is plain
     * data: the instants are typed `Date | string | null`, so an edited object
     * control stays inside the contract the derivations read.
     */
    session: { control: "object" },
  },
  component: SessionTimelineSummary,
  tags: ["autodocs"],
  /*
   * The strip is laid out by `.sd3-act-head` in production (flex,
   * space-between), so it is framed here the same way rather than floating.
   *
   * The title is an `h2`, not a `span`: the Session Timeline heading is the only
   * `.sd3-act-head` this strip ever sits in, and the header's wrap rule is scoped
   * to `:has(> h2.sd3-act-title)` so it does not reach the sibling headers that
   * reuse the class with a `span` (Activity phases). A `span` here would frame
   * the strip in a header production never pairs it with, and would quietly hide
   * the reflow the narrow story exists to show (#4869 design review).
   */
  decorators: [
    (Story) => (
      <div className="sd3-act-head w-[560px]">
        <h2 className="sd3-act-title">Session Timeline</h2>
        <Story />
      </div>
    ),
  ],
  title: "App Core/Agents/Session Timeline Summary",
};

export default meta;

type Story = StoryObj<typeof SessionTimelineSummary>;

/** All three facts present — the ordinary run. */
export const AllFactsPresent: Story = {
  args: { session: baseSession },
};

/**
 * Consumed real tokens but carries no priced cost, so pricing is genuinely
 * unavailable for the model. The cost dashes and explains itself on hover; the
 * tokens it DID record still print.
 */
export const CostUnavailable: Story = {
  args: {
    session: { ...baseSession, estimatedCost: 0, model: null },
  },
};

/**
 * A run that registered turns but recorded zero tokens (the errored-on-turn-one
 * shape). Tokens dash rather than print a confident `0`.
 */
export const TokensUnavailable: Story = {
  args: {
    session: {
      ...baseSession,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      turns: 1,
    },
  },
};

/**
 * The case that must NOT look like the two above: a subscription run whose cost
 * really is zero because the spend is covered. It prints `$0.00`, not a dash.
 */
export const GenuineZeroCost: Story = {
  args: {
    session: { ...baseSession, billingMode: "pro", estimatedCost: 0 },
  },
};

/**
 * Still running, so the duration is measured to now and ticks.
 *
 * `startedAt` is derived from the render clock rather than pinned (#design
 * review): a fixed past date measured against a live `now` renders months of
 * elapsed time, which is useless as a reference for what a live run looks like.
 */
export const StillRunning: Story = {
  args: {
    session: {
      ...baseSession,
      endedAt: null,
      estimatedCost: 3.2,
      startedAt: new Date(Date.now() - 77 * 60_000),
      status: SESSION_STATUS.ACTIVE,
    },
  },
};

/**
 * A multi-day run, so the duration string is at its widest. Shown DELIBERATELY
 * rather than as an accident of a stale fixture — it is the state that decides
 * whether the strip still fits beside its heading.
 */
export const LongRunningSession: Story = {
  args: {
    session: {
      ...baseSession,
      endedAt: new Date(ENDED_AT.getTime() + 9 * 24 * 60 * 60_000),
      estimatedCost: 486.21,
      inputTokens: 41_000_000,
    },
  },
};

/**
 * The strip in a container too narrow for one line — roughly what a 320px phone
 * leaves this row once `.sd3-doc`'s padding is taken out.
 *
 * This story did its job by failing (#4869 design review): at `300px` the strip
 * used to spill 28px PAST its own frame, because neither `.sd3-act-head` nor the
 * strip could wrap and every fact is `whitespace-nowrap`. In production that
 * overflow landed inside an `overflow-x: hidden` ancestor, so the third fact was
 * clipped mid-word rather than scrollable. Both rows wrap now, and this story is
 * where that stays visible: it must show the facts REFLOWED onto their own
 * lines, not merely not-overflowing.
 */
export const NarrowContainer: Story = {
  args: { session: baseSession },
  decorators: [
    (Story) => (
      <div className="sd3-act-head w-[300px]">
        <h2 className="sd3-act-title">Session Timeline</h2>
        <Story />
      </div>
    ),
  ],
};

/**
 * The widest content in the narrowest frame — the `LongRunningSession` numbers
 * at the `NarrowContainer` width. Measured at 287px of unbreakable text against
 * a 300px frame, this is the combination that decides whether the reflow
 * actually holds, and it is the one the earlier pair of stories could not show
 * because each varied only one axis.
 */
export const NarrowContainerLongRun: Story = {
  args: {
    session: {
      ...baseSession,
      endedAt: new Date(ENDED_AT.getTime() + 9 * 24 * 60 * 60_000),
      estimatedCost: 486.21,
      inputTokens: 41_000_000,
    },
  },
  decorators: [
    (Story) => (
      <div className="sd3-act-head w-[300px]">
        <h2 className="sd3-act-title">Session Timeline</h2>
        <Story />
      </div>
    ),
  ],
};

/**
 * A corrupt counter reached the render — a negative total here. It must NOT read
 * like the empty run above: same dash, different sentence, because "we recorded
 * nothing" and "we could not read what we recorded" are different claims.
 */
export const TokensUntrustworthy: Story = {
  args: {
    session: { ...baseSession, inputTokens: -1, outputTokens: 0 },
  },
};

/**
 * No start time recorded, so the span is unmeasurable. The duration dashes
 * rather than inventing one from the timeline's own axis.
 */
export const DurationUnmeasurable: Story = {
  args: {
    session: { ...baseSession, endedAt: null, startedAt: null },
  },
};
