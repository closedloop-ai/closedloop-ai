import type { Meta, StoryObj } from "@storybook/react";
import { ArtifactBar } from "./artifact-bar";

const metrics = [
  { key: "issues", label: "Issues", value: 12 },
  { key: "total-cost", label: "Est. Total", value: "$1.25" },
  { key: "median-cost", label: "Median token cost", value: "$0.63" },
  { key: "metric-four", label: "Produced by sessions", value: 8 },
  { key: "metric-five", label: "Updated this week", value: 3 },
];
const meta = {
  title: "Composites v1.0/Artifacts/Artifact Bar",
  tags: ["deprecated"],
  component: ArtifactBar,
  parameters: { layout: "fullscreen" },
  argTypes: {
    metrics: { control: "object" },
    visibleMetricKeys: { control: false },
  },
  args: {
    metrics,
    visibleMetricKeys: new Set(metrics.map((metric) => metric.key)),
  },
} satisfies Meta<typeof ArtifactBar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Unavailable: Story = {
  args: { metrics: metrics.map((metric) => ({ ...metric, value: null })) },
};
export const Zero: Story = {
  args: { metrics: metrics.map((metric) => ({ ...metric, value: 0 })) },
};

export const Trends: Story = {
  args: {
    metrics: metrics.map((metric) => ({
      ...metric,
      sparkline: [0, 2, 1, 4, 3, 5, 8],
    })),
  },
};
