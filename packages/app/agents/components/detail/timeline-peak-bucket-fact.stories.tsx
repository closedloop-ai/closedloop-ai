import {
  TIMELINE_SCALE_OPTIONS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import type { Meta, StoryObj } from "@storybook/react";
import { TimelinePeakBucketFact } from "./timeline-peak-bucket-fact";

/**
 * ISS-12665: the timeline header's peak-column fact, as the Session Timeline
 * and the Branch PR timeline print it. Default carries the prototype's
 * explanation (Session); Unavailable is the dash a strip with no publishable
 * per-column cost shows; Without Explanation is the Branch form, whose span is
 * many sessions.
 */
const meta = {
  title: "Composites/Artifacts/Timeline Peak Bucket Fact",
  tags: ["stable"],
  component: TimelinePeakBucketFact,
  args: {
    costUsd: 4.37,
    explainsFullSession: true,
    scale: TimelineScale.FifteenMinutes,
  },
  argTypes: {
    costUsd: { control: { type: "number", min: 0, step: 0.01 } },
    explainsFullSession: { control: "boolean" },
    scale: { control: "inline-radio", options: [...TIMELINE_SCALE_OPTIONS] },
  },
  decorators: [
    (Story) => (
      <div className="text-muted-foreground text-xs">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimelinePeakBucketFact>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Unavailable: Story = {
  args: { costUsd: null },
};

export const WithoutExplanation: Story = {
  args: { explainsFullSession: false, scale: TimelineScale.OneHour },
};
