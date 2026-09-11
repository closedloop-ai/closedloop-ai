import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import { LineChart } from "@repo/design-system/components/ui/primitives/line-chart";
import type { Meta, StoryObj } from "@storybook/react";

type LineChartPoint = {
  label: string;
  value: number;
};

const DEFAULT_POINTS: LineChartPoint[] =
  workflowData.effectiveness[0]?.trend.map((value, index) => ({
    label: `Run ${index + 1}`,
    value,
  })) ?? [];

// The card wrapper the chart is always read inside. Props forward straight to
// `LineChart` so the controls panel drives the primitive itself.
const LineChartCanvas = ({
  color = "#22c55e",
  label = "Subagent trend",
  points = DEFAULT_POINTS,
}: {
  color?: string;
  label?: string;
  points?: LineChartPoint[];
}) => (
  <div className="w-[380px] rounded-xl border border-border/80 bg-card p-4">
    <LineChart color={color} label={label} points={points} />
  </div>
);

/**
 * A small filled line chart with hoverable dots for a compact trend inside a
 * card, between Sparkline's simplicity and a full Time Series Area Chart.
 */
const meta = {
  title: "Primitives/Charts/Line Chart",
  component: LineChartCanvas,
  tags: ["autodocs"],
  argTypes: {
    points: {
      control: "object",
      description:
        "Series data. Each point draws a dot with a `label: value` tooltip.",
    },
    color: {
      control: "color",
      description: "Stroke color, also the top stop of the area gradient.",
    },
    label: {
      control: "text",
      description: "Accessible name for the chart and the gradient fill id.",
    },
  },
  parameters: {
    layout: "centered",
  },
  args: {
    color: "#22c55e",
    label: "Subagent trend",
    points: DEFAULT_POINTS,
  },
} satisfies Meta<typeof LineChartCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
