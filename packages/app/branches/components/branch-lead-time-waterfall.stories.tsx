import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import type { Meta, StoryObj } from "@storybook/react";
import { makeBranchDetail } from "../__tests__/branch-fixtures";
import { BranchLeadTimeWaterfall } from "./branch-lead-time-waterfall";
import {
  completeMetrics,
  completePhaseAttribution,
  completeSelectedPullRequest,
} from "./branch-story-metric-fixtures";

/**
 * A single horizontal bar tracing one pull request from its first pushed
 * code to merged or closed, split into colored Build, Review and Rework
 * segments with any idle waiting time shown as gaps and a marker for when
 * the PR was opened. Use it to see how a branch's time was actually spent
 * across its lifecycle; it is the time counterpart to Branch Cost to Merge,
 * which shows the same three phases measured in dollars instead of elapsed
 * time. It covers only the selected cycle up to its terminal point, not the
 * branch's whole history, and it falls back to a plain message when the
 * underlying evidence is missing.
 */
const meta = {
  title: "Primitives/Charts/Branch Lead Time Waterfall",
  component: BranchLeadTimeWaterfall,
  tags: ["autodocs"],
  argTypes: {
    detail: { control: "object" },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchLeadTimeWaterfall>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompleteWithIdle: Story = {
  args: {
    detail: makeBranchDetail({
      canonicalMetrics: completeMetrics(),
      phaseAttribution: completePhaseAttribution(),
      selectedPullRequest: completeSelectedPullRequest(),
    }),
  },
};

export const Partial: Story = {
  args: {
    detail: makeBranchDetail({
      canonicalMetrics: {
        ...completeMetrics(),
        leadTimeMs: {
          state: BranchMetricAvailability.Partial,
          value: 7_200_000,
          disclosure: BranchMetricDisclosure.DefaultIncomplete,
        },
      },
      phaseAttribution: completePhaseAttribution(),
      selectedPullRequest: completeSelectedPullRequest(),
    }),
  },
};

export const Unavailable: Story = {
  args: {
    detail: makeBranchDetail({
      canonicalMetrics: {
        ...completeMetrics(),
        leadTimeMs: {
          state: BranchMetricAvailability.Unavailable,
          value: null,
        },
        idleTimeMs: {
          state: BranchMetricAvailability.Unavailable,
          value: null,
        },
      },
      phaseAttribution: completePhaseAttribution(),
      selectedPullRequest: completeSelectedPullRequest(),
    }),
  },
};
