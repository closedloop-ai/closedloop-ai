import type { SessionSpan } from "@repo/api/src/types/agent-session";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { SessionTimelineAxis } from "./session-timeline-axis";

function makeSpan(overrides: Partial<SessionSpan> = {}): SessionSpan {
  return {
    first: "10:00",
    last: "14:54",
    ...overrides,
  };
}

/*
 * The axis row's layout lives entirely in `.sd3-act-axis` (a `space-between`
 * flex under `.sd3-actbar`), so without this ancestor the three slots stack and
 * the crowding these stories exist to show cannot happen.
 */
function TimelineAxisFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="sd3-actbar" style={{ maxWidth: 640 }}>
      <div className="sd3-act-head">
        <span className="sd3-act-title">Session Timeline</span>
      </div>
      {children}
    </div>
  );
}

/**
 * The start, span and end time labels under the Session Timeline's bars,
 * meant to pair with the Bars and Dot Rail rows rather than stand alone.
 */
const meta = {
  title: "Primitives/Charts/Session Timeline Axis",
  component: SessionTimelineAxis,
  tags: ["autodocs"],
  argTypes: {
    axisDurationLabel: { control: "text" },
    span: { control: "object" },
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <TimelineAxisFrame>
        <Story />
      </TimelineAxisFrame>
    ),
  ],
} satisfies Meta<typeof SessionTimelineAxis>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ISS-4675 shape: a session whose Duration card reads "3h 33m wall" while
 * the axis legitimately spans 4h 54m of calendar time. The middle slot names the
 * measure so the two numbers read as two measures rather than a contradiction,
 * and the right tick keeps the end instant — the position a reader looks to for
 * it.
 */
export const Default: Story = {
  args: {
    axisDurationLabel: "4h 54m",
    span: makeSpan(),
  },
};

/**
 * A sub-hour session. The label is seconds-led here and the row has room to
 * spare; nothing about the three-slot order changes with the magnitude.
 */
export const ShortSpan: Story = {
  args: {
    axisDurationLabel: "5m 5s",
    span: makeSpan({ first: "12:00", last: "12:05" }),
  },
};

/**
 * The crowding case: a multi-day session whose ticks both carry full
 * date-and-time stamps. All three slots are at their widest at once, which is
 * where the middle caption is most at risk of colliding with a tick — the thing
 * a composed-view test cannot see.
 */
export const CrowdedTicks: Story = {
  args: {
    axisDurationLabel: "93h 42m",
    span: makeSpan({
      first: "Jun 10, 2026, 10:00:00",
      last: "Jun 14, 2026, 07:42:00",
    }),
  },
};

/**
 * A session with no resolvable end instant. `getSessionSpan` can return an empty
 * `last` when neither a marker nor any lifecycle timestamp is formattable, so
 * the right slot collapses and the caption must not slide into the tick
 * position and read as an end time.
 */
export const MissingEndTick: Story = {
  args: {
    axisDurationLabel: "1h 0m",
    span: makeSpan({ last: "" }),
  },
};
