import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import {
  DonutSliceTexture,
  donutSliceTextureBackground,
  LEGEND_SWATCH_TILE_PX,
} from "@repo/design-system/components/ui/donut-slice-textures";
import {
  mockBrowserVisitors,
  mockTrafficByMonth,
} from "@repo/design-system/storybook/mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Label,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
} from "recharts";
import { expect, userEvent, within } from "storybook/test";

// Rendered by the interactive legend only while at least one series is hidden.
const SHOW_ALL_LABEL = "Show all";

const multiSeriesConfig = {
  desktop: {
    label: "Desktop",
    color: "hsl(var(--chart-1))",
  },
  mobile: {
    label: "Mobile",
    color: "hsl(var(--chart-2))",
  },
} satisfies ChartConfig;

const singleSeriesConfig = {
  visitors: {
    label: "Visitors",
  },
  chrome: {
    label: "Chrome",
    color: "hsl(var(--chart-1))",
  },
  safari: {
    label: "Safari",
    color: "hsl(var(--chart-2))",
  },
  other: {
    label: "Other",
    color: "hsl(var(--chart-5))",
  },
} satisfies ChartConfig;

/**
 * ISS-5362 (#4514 review): the same `swatchTexture` field, on the INTERACTIVE
 * legend renderer.
 *
 * `ChartLegendContent` has two renderings — the static one the donut uses and
 * this click-to-toggle one — and both read `swatchTexture` so a shared config
 * field is never silently dropped by one of them. That second branch is only
 * reviewable if a story mounts it, which is what
 * {@link InteractiveLegendTexturedSwatches} is for: the swatches here must show
 * the SAME textures the donut's legend does, and the hidden state must still
 * hollow out to a ring rather than keeping a filled texture.
 */
const texturedSeriesConfig = {
  desktop: {
    label: "Desktop",
    color: "var(--chart-1)",
    swatchTexture: donutSliceTextureBackground(
      DonutSliceTexture.Crosshatch,
      "var(--chart-1)",
      { tilePx: LEGEND_SWATCH_TILE_PX }
    ),
  },
  mobile: {
    label: "Mobile",
    color: "var(--chart-2)",
    swatchTexture: donutSliceTextureBackground(
      DonutSliceTexture.Diagonal,
      "var(--chart-2)",
      { tilePx: LEGEND_SWATCH_TILE_PX }
    ),
  },
} satisfies ChartConfig;

/**
 * Beautiful charts. Built using Recharts. Copy and paste into your apps.
 */
const meta = {
  title: "Design System/Data Display/Chart",
  component: ChartContainer,
  tags: ["autodocs"],
  argTypes: {
    config: {
      control: "object",
      description:
        "Series key to label and color map. Drives the CSS variables the marks read.",
    },
    resetKey: {
      control: "text",
      description:
        "Change when the chart's data identity changes so hidden series reset.",
    },
    className: { control: "text" },
    id: { control: "text" },
    children: { control: false },
  },
  args: {
    children: <div />,
  },
} satisfies Meta<typeof ChartContainer>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Combine multiple Area components to create a stacked area chart.
 */
export const StackedAreaChart: Story = {
  args: {
    config: multiSeriesConfig,
  },
  render: (args) => (
    <ChartContainer {...args}>
      <AreaChart
        accessibilityLayer
        data={mockTrafficByMonth}
        margin={{
          left: 12,
          right: 12,
        }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="month"
          tickFormatter={(value) => value.slice(0, 3)}
          tickLine={false}
          tickMargin={8}
        />
        <ChartTooltip
          content={<ChartTooltipContent indicator="dot" />}
          cursor={false}
        />
        <Area
          dataKey="mobile"
          fill="var(--color-mobile)"
          fillOpacity={0.4}
          stackId="a"
          stroke="var(--color-mobile)"
          type="natural"
        />
        <Area
          dataKey="desktop"
          fill="var(--color-desktop)"
          fillOpacity={0.4}
          stackId="a"
          stroke="var(--color-desktop)"
          type="natural"
        />
      </AreaChart>
    </ChartContainer>
  ),
};

/**
 * Combine multiple Bar components to create a stacked bar chart.
 */
export const StackedBarChart: Story = {
  args: {
    config: multiSeriesConfig,
  },
  render: (args) => (
    <ChartContainer {...args}>
      <BarChart accessibilityLayer data={mockTrafficByMonth}>
        <CartesianGrid vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="month"
          tickFormatter={(value) => value.slice(0, 3)}
          tickLine={false}
          tickMargin={10}
        />
        <ChartTooltip
          content={<ChartTooltipContent indicator="dashed" />}
          cursor={false}
        />
        <Bar dataKey="desktop" fill="var(--color-desktop)" radius={4} />
        <Bar dataKey="mobile" fill="var(--color-mobile)" radius={4} />
      </BarChart>
    </ChartContainer>
  ),
};

/**
 * Combine multiple Line components to create a single line chart.
 */
export const MultiLineChart: Story = {
  args: {
    config: multiSeriesConfig,
  },
  render: (args) => (
    <ChartContainer {...args}>
      <LineChart
        accessibilityLayer
        data={mockTrafficByMonth}
        margin={{
          left: 12,
          right: 12,
        }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="month"
          tickFormatter={(value) => value.slice(0, 3)}
          tickLine={false}
          tickMargin={8}
        />
        <ChartTooltip
          content={<ChartTooltipContent hideLabel />}
          cursor={false}
        />
        <Line
          dataKey="desktop"
          dot={false}
          stroke="var(--color-desktop)"
          strokeWidth={2}
          type="natural"
        />
        <Line
          dataKey="mobile"
          dot={false}
          stroke="var(--color-mobile)"
          strokeWidth={2}
          type="natural"
        />
      </LineChart>
    </ChartContainer>
  ),
};

/**
 * The interactive legend carrying the redundant non-colour channel.
 *
 * Click an entry to hide its series: the swatch hollows to a ring in the
 * series' own colour, which is the state to check — a hidden entry must drop
 * the texture along with the fill, or "off" would read as "a different
 * category". Shown entries must draw the same textures the donut's static
 * legend draws, since the two renderers share one config field.
 */
export const InteractiveLegendTexturedSwatches: Story = {
  args: {
    config: texturedSeriesConfig,
  },
  render: (args) => (
    <ChartContainer {...args}>
      <BarChart accessibilityLayer data={mockTrafficByMonth}>
        <CartesianGrid vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="month"
          tickFormatter={(value) => value.slice(0, 3)}
          tickLine={false}
          tickMargin={10}
        />
        <ChartTooltip
          content={<ChartTooltipContent indicator="dot" />}
          cursor={false}
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="desktop" fill="var(--color-desktop)" radius={4} />
        <Bar dataKey="mobile" fill="var(--color-mobile)" radius={4} />
      </BarChart>
    </ChartContainer>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const entry = (name: string) => canvas.getByRole("button", { name });

    // `aria-pressed` is what carries visibility — true means SHOWN. A hidden
    // entry keeps its label at full contrast by design, so the text cannot
    // reveal the state and this attribute is the only honest signal.
    await expect(entry("Desktop")).toHaveAttribute("aria-pressed", "true");
    await expect(entry("Mobile")).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.queryByRole("button", { name: SHOW_ALL_LABEL })
    ).not.toBeInTheDocument();

    await userEvent.click(entry("Desktop"));
    await expect(entry("Desktop")).toHaveAttribute("aria-pressed", "false");
    await expect(entry("Mobile")).toHaveAttribute("aria-pressed", "true");
    await expect(entry(SHOW_ALL_LABEL)).toBeVisible();

    // The last visible series cannot be hidden: an empty plot is not a state
    // the legend is allowed to reach.
    await userEvent.click(entry("Mobile"));
    await expect(entry("Mobile")).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(entry(SHOW_ALL_LABEL));
    await expect(entry("Desktop")).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.queryByRole("button", { name: SHOW_ALL_LABEL })
    ).not.toBeInTheDocument();
  },
};

/**
 * Combine Pie and Label components to create a donut chart example on the shared chart foundation.
 */
export const DonutExample: Story = {
  args: {
    config: singleSeriesConfig,
  },
  render: (args) => {
    const totalVisitors = useMemo(
      () => mockBrowserVisitors.reduce((acc, curr) => acc + curr.visitors, 0),
      []
    );
    return (
      <ChartContainer {...args}>
        <PieChart>
          <ChartTooltip
            content={<ChartTooltipContent hideLabel />}
            cursor={false}
          />
          <Pie
            data={mockBrowserVisitors}
            dataKey="visitors"
            innerRadius={48}
            nameKey="browser"
            strokeWidth={5}
          >
            <Label
              content={({ viewBox }) => {
                if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                  return (
                    <text
                      dominantBaseline="middle"
                      textAnchor="middle"
                      x={viewBox.cx}
                      y={viewBox.cy}
                    >
                      <tspan
                        className="fill-foreground font-bold text-3xl"
                        x={viewBox.cx}
                        y={viewBox.cy}
                      >
                        {totalVisitors.toLocaleString()}
                      </tspan>
                      <tspan
                        className="fill-muted-foreground"
                        x={viewBox.cx}
                        y={(viewBox.cy || 0) + 24}
                      >
                        Visitors
                      </tspan>
                    </text>
                  );
                }
              }}
            />
          </Pie>
        </PieChart>
      </ChartContainer>
    );
  },
};
