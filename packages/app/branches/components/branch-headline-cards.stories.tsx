import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import type { Meta, StoryObj } from "@storybook/react";
import { makeBranchDetail } from "../__tests__/branch-fixtures";
import { BranchHeadlineCards } from "./branch-headline-cards";
import { completeMetrics } from "./branch-story-metric-fixtures";

/**
 * Three fixed metric cards atop a branch's detail page for cost per line,
 * lead time, and time open before closing unmerged, explaining any that
 * don't apply.
 */
const meta = {
  title: "Composites/Branches/Branch Headline Cards",
  component: BranchHeadlineCards,
  tags: ["autodocs"],
  argTypes: {
    detail: { control: "object" },
    analytics: { control: "object" },
    loc: {
      control: "object",
      description: "Branch changed-LOC resolved once at the page boundary.",
    },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchHeadlineCards>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Complete: Story = {
  args: {
    detail: makeBranchDetail({ canonicalMetrics: completeMetrics() }),
  },
};

export const Partial: Story = {
  args: {
    detail: makeBranchDetail({
      canonicalMetrics: {
        ...completeMetrics(),
        locPerDollar: {
          state: BranchMetricAvailability.Partial,
          value: 42.5,
          disclosure: BranchMetricDisclosure.DefaultIncomplete,
        },
      },
    }),
  },
};

export const NotApplicable: Story = {
  args: {
    detail: makeBranchDetail({
      canonicalMetrics: {
        ...completeMetrics(),
        leadTimeMs: {
          state: BranchMetricAvailability.NotApplicable,
          value: null,
        },
        abandonmentTimeMs: {
          state: BranchMetricAvailability.NotApplicable,
          value: null,
        },
      },
    }),
  },
};
