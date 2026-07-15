import { metrics } from "@repo/app/agents/lib/session-mock-data";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Metric Card",
  component: MetricCard,
  tags: ["autodocs"],
  argTypes: {
    label: {
      control: "text",
      description: "Uppercase caption rendered above the value.",
    },
    value: {
      control: "text",
      description: "Formatted metric value (string or number).",
    },
    unitLabel: {
      control: "text",
      description: "Unit suffix rendered beside the value (FEA-2416).",
    },
    detail: {
      control: "text",
      description: "Secondary caption in the footer.",
    },
    trend: {
      control: "text",
      description: "Emphasised trend text aligned to the footer end.",
    },
    delta: {
      control: { type: "select" },
      options: ["unknown", -8, 0, 12],
      description:
        'Period-over-period change (`number | "unknown"`). A number renders a signed up/down chip; pass "unknown" for a neutral placeholder chip.',
    },
    deltaLabel: {
      control: "text",
      description: 'Caption beside the delta chip (e.g. "vs. prior 90 days").',
    },
    sparkline: {
      control: "object",
      description:
        "Recent values; when the delta is a number and at least two points are finite, the chip renders a sparkline instead of an icon.",
    },
    info: {
      control: "object",
      description: "`{ what, how? }` explainer rendered in a label popover.",
    },
    placeholder: {
      control: "boolean",
      description:
        'Dims the card and adds a "Sample" badge for placeholder data.',
    },
  },
  parameters: {
    layout: "centered",
  },
  args: {
    label: "Active sessions",
    value: 18,
    className: "w-[280px]",
  },
} satisfies Meta<typeof MetricCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Overview grid of the dashboard KPI mocks (label/value/detail/trend only). */
export const Default: Story = {
  render: () => (
    <div className="grid w-[960px] gap-4 md:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <MetricCard key={metric.label} {...metric} />
      ))}
    </div>
  ),
};

/** `unitLabel` renders a unit suffix beside the formatted value (FEA-2416). */
export const WithUnitLabel: Story = {
  args: {
    label: "Avg. session length",
    value: 42,
    unitLabel: "min",
    detail: "P50 across all agents",
  },
};

/** A positive numeric `delta` renders a green up chip beside `deltaLabel`. */
export const WithDelta: Story = {
  args: {
    label: "Events processed",
    value: "28.4k",
    delta: 12,
    deltaLabel: "vs. prior 90 days",
  },
};

/** A negative numeric `delta` renders a red down chip beside `deltaLabel`. */
export const WithNegativeDelta: Story = {
  args: {
    label: "Failed sessions",
    value: 6,
    delta: -8,
    deltaLabel: "vs. prior 90 days",
  },
};

/**
 * `delta: "unknown"` marks that no comparison baseline exists yet — the card
 * omits the change chip entirely rather than showing a placeholder.
 */
export const WithUnknownDelta: Story = {
  args: {
    label: "Estimated cost",
    value: "$219.43",
    delta: "unknown",
    detail: "Awaiting first full comparison window",
  },
};

/**
 * When `sparkline` has at least two finite points, the numeric delta chip
 * renders a real trend sparkline in place of the directional icon.
 */
export const WithSparkline: Story = {
  args: {
    label: "Running agents",
    value: 44,
    delta: 11,
    deltaLabel: "vs. prior 90 days",
    sparkline: [28, 31, 30, 34, 38, 41, 44],
  },
};

/** `info` renders an explainer popover trigger beside the label. */
export const WithInfoTooltip: Story = {
  args: {
    label: "Events processed",
    value: "28.4k",
    info: {
      what: "Total realtime events ingested across all connected agents.",
      how: "Counted from the ingest pipeline over the selected time range.",
    },
  },
  name: "With info popover",
};

/**
 * `placeholder` dims the card and adds a "Sample" badge to flag values that are
 * mock data pending real backend wiring.
 */
export const Placeholder: Story = {
  args: {
    label: "Estimated cost",
    value: "$219.43",
    detail: "Last 30 days",
    placeholder: true,
  },
};
