import {
  CHART_COLOR_TOKENS,
  chartColor,
} from "@repo/design-system/components/ui/chart-colors";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Swatch view of the categorical chart palette (`--chart-1..5`). This story also
 * satisfies the "adding a public module" rule for the `chart-colors` entry —
 * it's the smallest renderable proof that the public export resolves.
 */
function ChartColorsPalette({ count }: { count: number }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      {Array.from({ length: count }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: swatches are positional and have no stable id.
          key={index}
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 8,
              background: chartColor(index),
            }}
          />
          <code style={{ fontSize: 11 }}>
            chartColor({index}) →{" "}
            {CHART_COLOR_TOKENS[index % CHART_COLOR_TOKENS.length]}
          </code>
        </div>
      ))}
    </div>
  );
}

const meta = {
  title: "Design System/Data Display/Data Visualization/Chart Colors",
  component: ChartColorsPalette,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { count: CHART_COLOR_TOKENS.length },
} satisfies Meta<typeof ChartColorsPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The five base palette tokens. */
export const Palette: Story = {};

/** More than five swatches to show the modulo cycling `chartColor` does. */
export const Cycling: Story = {
  args: { count: CHART_COLOR_TOKENS.length * 2 + 1 },
};
