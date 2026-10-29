import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionDurationProperty } from "./session-duration-property";
import { SessionPropertiesFrame } from "./session-properties-story-frame";

/** Bounds spanning 4h 54m — the ISS-4631 SES-74818 reported span. */
const STARTED_AT = "2026-07-30T10:00:00.000Z";
const ENDED_AT = "2026-07-30T14:54:00.000Z";

const meta = {
  title: "Composites v1.0/Agents/Detail/Session Duration Property",
  component: SessionDurationProperty,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <SessionPropertiesFrame>
        <Story />
      </SessionPropertiesFrame>
    ),
  ],
} satisfies Meta<typeof SessionDurationProperty>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shipped shape: one measure, one number, no qualifier.
 *
 * The story this replaces (`MeasuredTriple`) is why the row changed. It rendered
 * three pipe-separated segments — "4h 54m wall | 27h 8m active | 41s waiting on
 * you" — and shipped the #4409 defect in the catalog: `active` and `waitingUser`
 * are the collector's turn-gap projection, clamped to a window anchored on LAST
 * ACTIVITY, so a sub-fact more than five times the headline beside it was not
 * only possible but the reported case. A pipe-separated list is the strongest
 * "these add up" signal there is, so the row read as broken arithmetic rather
 * than as two honest measures. Turn-gap time is the Activity breakdown panel's
 * job, against its own stated window.
 */
export const Measured: Story = {
  args: {
    session: {
      status: SESSION_STATUS.INACTIVE,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    },
  },
};

/**
 * The ISS-5131 session verbatim (`019fb3e3`): a 31h 4m run whose activity
 * timestamps kept advancing for six days after it ended, because they track SYNC
 * time. The row prints its own span. Pinned as a story, not only as a string
 * assertion, because "the number beside Duration is the small one" is a thing
 * you check by looking.
 */
export const CompletedWithLateActivity: Story = {
  args: {
    session: {
      status: SESSION_STATUS.INACTIVE,
      startedAt: "2026-07-28T14:58:31.028Z",
      endedAt: "2026-07-29T22:02:53.365Z",
    },
  },
};

/**
 * Still running: measured to `now`, so this story's number moves while you look
 * at it — which is the point. The row re-reads the clock on the shared
 * `SESSION_DURATION_TICK_MS` tick rather than freezing at mount.
 */
export const Running: Story = {
  args: {
    session: {
      status: SESSION_STATUS.ACTIVE,
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      endedAt: null,
    },
  },
};

/**
 * Terminal with no end instant — nothing measured a span, so the row shows the
 * shared em-dash rather than a fabricated "0s". Worth seeing at width: an empty
 * value slot beside a filled label is the state most easily mistaken for a
 * rendering failure, so it has to read as deliberate.
 */
export const Unmeasurable: Story = {
  args: {
    session: {
      status: SESSION_STATUS.INACTIVE,
      startedAt: STARTED_AT,
      endedAt: null,
    },
  },
};

// ISS-10364 (operator ruling, 2026-09-23/24) retired the Stale fold these two
// stories existed to draw: a long-silent `active` row with no end instant now
// keeps timing against `now()` instead of rendering the em-dash, exactly like
// any other non-terminal row with no recorded end. Both stories are removed
// rather than kept pointed at a Duration state production can no longer reach.
