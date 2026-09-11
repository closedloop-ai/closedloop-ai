import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import type { Meta, StoryObj } from "@storybook/react";
import { makeBranchDetail } from "../__tests__/branch-fixtures";
import { BranchCostToMerge } from "./branch-cost-to-merge";
import {
  completeMetrics,
  completePhaseAttribution,
} from "./branch-story-metric-fixtures";

/**
 * A horizontal bar split into Build, Review and Rework segments sized by
 * dollar cost, with a row underneath spelling out each phase's time, cost
 * and share of the total. Use it on a branch's detail page to show where its
 * spend went; it is the cost counterpart to Branch Lead Time Waterfall,
 * which measures the same three phases in elapsed time instead of dollars.
 * When the underlying cost data is only partly available it still renders,
 * marked with an asterisk and a footnote, and it falls back to a plain
 * message instead of a bar when no cost evidence exists at all.
 */
const meta = {
  title: "Primitives/Charts/Branch Cost to Merge",
  component: BranchCostToMerge,
  tags: ["autodocs"],
  argTypes: {
    detail: { control: "object" },
    suppressSplits: { control: false },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchCostToMerge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Complete: Story = {
  args: {
    detail: makeBranchDetail({
      canonicalMetrics: completeMetrics(),
      phaseAttribution: completePhaseAttribution(),
    }),
  },
};

export const Partial: Story = {
  args: {
    detail: makeBranchDetail({
      canonicalMetrics: partialMetrics(),
      phaseAttribution: completePhaseAttribution(),
    }),
  },
};

export const Unavailable: Story = {
  args: {
    detail: makeBranchDetail({
      canonicalMetrics: {
        ...completeMetrics(),
        phaseCostUsd: {
          [BranchVisibleLifecyclePhase.Build]: unavailableMetric(),
          [BranchVisibleLifecyclePhase.Review]: unavailableMetric(),
          [BranchVisibleLifecyclePhase.Rework]: unavailableMetric(),
        },
        totalCostUsd: unavailableMetric(),
      },
      phaseAttribution: completePhaseAttribution(),
    }),
  },
};

export const ZeroSpend: Story = {
  args: {
    detail: makeBranchDetail({
      canonicalMetrics: {
        ...completeMetrics(),
        phaseCostUsd: {
          [BranchVisibleLifecyclePhase.Build]: completeMetric(0),
          [BranchVisibleLifecyclePhase.Review]: completeMetric(0),
          [BranchVisibleLifecyclePhase.Rework]: completeMetric(0),
        },
        totalCostUsd: completeMetric(0),
      },
      phaseAttribution: completePhaseAttribution(),
    }),
  },
};

function partialMetrics() {
  return {
    ...completeMetrics(),
    phaseCostUsd: {
      [BranchVisibleLifecyclePhase.Build]: partialMetric(2),
      [BranchVisibleLifecyclePhase.Review]: partialMetric(1),
      [BranchVisibleLifecyclePhase.Rework]: partialMetric(1),
    },
    totalCostUsd: partialMetric(4),
  };
}

function completeMetric(value: number) {
  return { state: BranchMetricAvailability.Complete, value } as const;
}

function partialMetric(value: number) {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    disclosure: BranchMetricDisclosure.DefaultIncomplete,
  } as const;
}

function unavailableMetric() {
  return {
    state: BranchMetricAvailability.Unavailable,
    value: null,
  } as const;
}
