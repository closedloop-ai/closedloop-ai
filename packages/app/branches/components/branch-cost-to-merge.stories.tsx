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

const meta = {
  title: "Composites v1.0/Branches/Branch Cost To Merge",
  component: BranchCostToMerge,
  tags: ["deprecated", "autodocs"],
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

// ISS-6949: the TOTAL is the branch's canonical attributed cost and is never
// Partial at a positive value, so this story shows what the kernel can actually
// emit — a settled total over rows whose phase split is incomplete.
function partialMetrics() {
  return {
    ...completeMetrics(),
    phaseCostUsd: {
      [BranchVisibleLifecyclePhase.Build]: partialMetric(2),
      [BranchVisibleLifecyclePhase.Review]: partialMetric(1),
      [BranchVisibleLifecyclePhase.Rework]: partialMetric(1),
    },
    totalCostUsd: completeMetric(4),
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
