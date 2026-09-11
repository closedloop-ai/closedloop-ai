import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import type { Meta, StoryObj } from "@storybook/react";
import { makeBranchDetail } from "../__tests__/branch-fixtures";
import { BranchHeadlineCards } from "./branch-headline-cards";
import { completeMetrics } from "./branch-story-metric-fixtures";

/**
 * Three fixed metric cards at the top of a branch's detail page: lines of
 * code changed per dollar spent, lead time from first code push to merge,
 * and how long the branch ran before it was closed without merging. Each
 * card carries a small info tooltip explaining exactly what it measures and
 * how it is calculated, since these numbers get scrutinized. When a metric
 * cannot be calculated, the card says why, such as 'not applicable' for a
 * branch that never merged, rather than showing a blank or a zero. A value
 * built from incomplete evidence carries an asterisk and a note explaining
 * that, instead of passing off a partial number as a complete one.
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
