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

const meta = {
  title: "App Core/Branches/Branch Lead Time Waterfall",
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
