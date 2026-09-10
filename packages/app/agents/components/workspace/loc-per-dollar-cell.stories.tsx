import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { LocPerDollarColumnValue } from "./loc-per-dollar-cell";

// Recreate the production grid-cell scope: `GridTableCell` renders a fixed-width
// flex row, which is what `alignEnd`'s `ml-auto` pushes against and what makes a
// stack of these cells read as a COLUMN. Presentation only — no table/row ARIA,
// because a canvas of cells is not a real table and a partial grid role would
// announce one that has no columnheaders behind it.
function MetricColumnFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="w-32 border-t">
      <div className="flex h-10 items-center border-l px-3 font-medium text-muted-foreground text-xs">
        <span className="ml-auto">LOC / $</span>
      </div>
      {children}
    </div>
  );
}

function MetricRow({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex h-10 items-center gap-2 border-l px-3">{children}</div>
  );
}

/**
 * ISS-5333: the meta decorator supplies the providers and the COLUMN FRAME only —
 * it deliberately does not also open a row. Storybook composes a story's own
 * decorators INSIDE the meta's, so a story that needed several rows used to wrap
 * a second `MetricColumnFrame` and got a `w-32 border-t` frame nested inside an
 * `h-10` row: the two canvases whose whole job is proving the fixed precision
 * buys a scan were unreadable. Each story now contributes its own rows through
 * `render`, so one frame wraps exactly the rows that story means to show.
 */
const meta = {
  title: "Primitives/Data Display/LOC Per Dollar Column Value",
  component: LocPerDollarColumnValue,
  tags: ["autodocs"],
  argTypes: {
    value: {
      control: { type: "number", min: 0, step: 0.01 },
      description: "LOC per dollar. `null` is the honest not-applicable cell.",
    },
    alignEnd: { control: "boolean" },
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <MetricColumnFrame>
        <Story />
      </MetricColumnFrame>
    ),
  ],
  render: (args) => (
    <MetricRow>
      <LocPerDollarColumnValue {...args} />
    </MetricRow>
  ),
} satisfies Meta<typeof LocPerDollarColumnValue>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The ordinary case: a real ratio at the column's fixed precision. */
export const Typical: Story = {
  args: { alignEnd: true, value: 12.4 },
};

/**
 * REGRESSION GUARD for the `0.00` floor (ISS-4667 / ISS-4866). `0.004` LOC/$ is
 * a genuinely measured value; a bare `toFixed(2)` would print `0.00` and claim
 * the component delivered nothing. The column formatter marks it `< 0.01`
 * instead — sub-threshold, but never zero. If this story ever reads `0.00`, the
 * floor is back.
 */
export const BelowColumnPrecision: Story = {
  args: { alignEnd: true, value: 0.004 },
};

/**
 * No ratio to report (no cost to divide by, or no merged lines). The cell shows
 * the honest not-applicable placeholder rather than a fabricated `0.00`, and it
 * still right-aligns so the em-dash sits under the digits it stands in for.
 */
export const Unavailable: Story = {
  args: { alignEnd: true, value: null },
};

/**
 * Why the fixed precision exists (review cid 3701359134). Four magnitudes
 * stacked as they appear in a sorted column: right-aligned plus `tabular-nums`
 * puts every decimal point on one x, which is the scan this ticket buys.
 * Compare against {@link LeftAligned}.
 */
export const SortedStack: Story = {
  args: { alignEnd: true, value: 1234.5 },
  render: (args) => (
    <>
      <MetricRow>
        <LocPerDollarColumnValue {...args} />
      </MetricRow>
      <MetricRow>
        <LocPerDollarColumnValue alignEnd value={12.34} />
      </MetricRow>
      <MetricRow>
        <LocPerDollarColumnValue alignEnd value={0.88} />
      </MetricRow>
      <MetricRow>
        <LocPerDollarColumnValue alignEnd value={0.004} />
      </MetricRow>
      <MetricRow>
        <LocPerDollarColumnValue alignEnd value={null} />
      </MetricRow>
    </>
  ),
};

/**
 * The same values WITHOUT `alignEnd` — the narrow-card mount site, where this
 * value sits inline beside the Type chip and must not stretch to the far edge.
 * Kept as a canvas because it is also the visual argument for the alignment:
 * left-aligned, one fixed precision buys nothing.
 */
export const LeftAligned: Story = {
  args: { value: 1234.5 },
  render: (args) => (
    <>
      <MetricRow>
        <LocPerDollarColumnValue {...args} />
      </MetricRow>
      <MetricRow>
        <LocPerDollarColumnValue value={12.34} />
      </MetricRow>
      <MetricRow>
        <LocPerDollarColumnValue value={0.88} />
      </MetricRow>
    </>
  ),
};
