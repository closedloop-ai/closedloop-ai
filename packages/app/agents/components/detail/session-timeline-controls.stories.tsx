import {
  TIMELINE_VISIBLE_COLUMNS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import { TimelineStackGrouping } from "@repo/app/agents/lib/session-timeline-stacks";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import {
  SessionTimelineControls,
  SessionTimelineScrubber,
} from "./session-timeline-controls";

/**
 * ISS-5819 — the Session Timeline's controls, isolated from the strip they act
 * on. Both are prop-driven with a real state matrix (four scales, four
 * groupings, and a scrubber whose whole meaning is its position within a span),
 * so they get their own stories rather than only being reachable through a
 * 20-day session fixture on the detail page.
 *
 * Rendered LIVE, not with static props: a control that cannot be operated in
 * Storybook is a control nobody can check the focus ring, the keyboard path, or
 * the wrap behaviour of.
 */
const meta: Meta<typeof SessionTimelineControls> = {
  component: SessionTimelineControls,
  parameters: { layout: "padded" },
  title: "App Core/Agents/Session Timeline Controls",
};

export default meta;

type Story = StoryObj<typeof SessionTimelineControls>;

/** Both controls at their opening state: `5m`, cut by token type. */
export const Default: Story = {
  render: () => <LiveControls />,
};

/**
 * The coarsest scale. Worth its own story because the `12h` option is the one a
 * multi-day session opens on, and it is the widest label in the toggle.
 */
export const CoarsestScale: Story = {
  render: () => <LiveControls initialScale={TimelineScale.TwelveHours} />,
};

/**
 * Cut by model — the grouping with the longest value, and the one that decides
 * whether the 156px trigger truncates.
 */
export const GroupedByModel: Story = {
  render: () => <LiveControls initialGrouping={TimelineStackGrouping.Model} />,
};

/**
 * ISS-5819 review (wongk): the note the row carries when the chosen scale is
 * finer than the bins the strip was measured in. Its own story because it is the
 * only thing that can push this row onto a second line at a normal width, and
 * because a caveat nobody has looked at is a caveat nobody wrote well.
 */
export const InterpolatedScale: Story = {
  render: () => <LiveControls subColumnSource />,
};

/**
 * The scrubber at the START of a long session: a 20-day run at the `12h` scale
 * needs 40 columns, so 16 positions are pannable.
 */
export const ScrubberAtStart: Story = {
  render: () => <LiveScrubber />,
};

/** The scrubber at the far end, where the percentage readout reads 100%. */
export const ScrubberAtEnd: Story = {
  render: () => <LiveScrubber initialPosition={LONG_SESSION_COLUMNS - 1} />,
};

/**
 * Narrow viewport. The control row wraps rather than clipping the "Group by"
 * select out of an `overflow-hidden` parent — the 390px case the prototype
 * sandbox's own guidance calls out.
 */
export const Narrow: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => (
    <div className="w-[340px]">
      <LiveControls />
    </div>
  ),
};

/**
 * A 20-day session at the `12h` scale: 40 columns against a 24-column window,
 * leaving 16 pannable positions. Derived from the window constant rather than
 * written as a bare 40, so the story cannot drift from the model.
 */
const LONG_SESSION_COLUMNS = TIMELINE_VISIBLE_COLUMNS + 16;

function LiveControls({
  activityPhasesEnabled = true,
  initialGrouping = TimelineStackGrouping.TokenType,
  initialScale = TimelineScale.FiveMinutes,
  subColumnSource = false,
}: {
  activityPhasesEnabled?: boolean;
  initialGrouping?: TimelineStackGrouping;
  initialScale?: TimelineScale;
  subColumnSource?: boolean;
}) {
  const [scale, setScale] = useState<TimelineScale>(initialScale);
  const [grouping, setGrouping] =
    useState<TimelineStackGrouping>(initialGrouping);
  return (
    <SessionTimelineControls
      activityPhasesEnabled={activityPhasesEnabled}
      grouping={grouping}
      onGroupingChange={setGrouping}
      onScaleChange={setScale}
      scale={scale}
      subColumnSource={subColumnSource}
    />
  );
}

function LiveScrubber({ initialPosition = 0 }: { initialPosition?: number }) {
  const [position, setPosition] = useState(initialPosition);
  return (
    <SessionTimelineScrubber
      onPositionChange={setPosition}
      position={Math.min(position, LONG_SESSION_COLUMNS - 1)}
      totalColumns={LONG_SESSION_COLUMNS}
    />
  );
}

/**
 * ISS-5841: with activity phases gated off, the Group-by control offers three
 * cuts instead of four. Open the select to see that "Activity phase" is absent
 * rather than present-and-disabled.
 */
export const GroupByWithoutActivityPhase: Story = {
  render: () => <LiveControls activityPhasesEnabled={false} />,
};
