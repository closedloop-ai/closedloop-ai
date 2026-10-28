import type { SessionMeshInsights } from "@repo/api/src/types/session-mesh";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionMeshInsightsCard } from "./session-mesh-insights-card";

const report: SessionMeshInsights = {
  scope: { kind: "org" },
  window: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-25T00:00:00.000Z" },
  trend: [],
  participation: { active: 8, eligible: 12 },
  deliveries: {
    attempted: 32,
    delivered: 29,
    acknowledged: 25,
    useful: 14,
    conflictsResolved: 3,
    judged: 19,
    notUseful: 4,
    cantTell: 1,
    recipientActions: 6,
  },
  requestResponseLatencyMs: 42_000,
  estimatedTimeSavedMinutes: 187,
  estimatedCostSavedUsd: 24.35,
  coordinationOverheadMs: 18_000,
  provenance: {
    availability: "partial",
    notes: ["Savings are explicitly attributed estimates."],
  },
};

const meta = {
  title: "Composites v1.0/Insights/Session Mesh Insights Card",
  tags: ["deprecated"],
  component: SessionMeshInsightsCard,
  args: { data: report, isError: false, isLoading: false },
  argTypes: {
    data: {
      control: false,
      description:
        "Control: false. This story uses a fixed, reconciled API payload.",
    },
    isError: { control: "boolean" },
    isLoading: { control: "boolean" },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionMeshInsightsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Organization: Story = {};
export const Loading: Story = { args: { isLoading: true } };
export const Unavailable: Story = { args: { isError: true, isLoading: false } };
/** The shipped production shape: deliveries land and nothing rates them. Every
 * value tile must read as unknown with its denominator, never as a zero-value
 * outcome — the defect ISS-11435 fixes. */
export const NothingJudged: Story = {
  args: {
    data: {
      ...report,
      deliveries: {
        ...report.deliveries,
        acknowledged: 0,
        useful: 0,
        conflictsResolved: 0,
        judged: 0,
        notUseful: 0,
        cantTell: 0,
        recipientActions: 0,
      },
      estimatedTimeSavedMinutes: null,
      estimatedCostSavedUsd: null,
    },
  },
};
