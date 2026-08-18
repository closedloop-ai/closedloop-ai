import type { Meta, StoryObj } from "@storybook/react";
import { CostAvailability } from "../../lib/cost-availability";
import { SessionCostCell } from "./session-cost-cell";

/**
 * ISS-5840: the Sessions list Cost cell, isolated.
 *
 * The state matrix IS the point of this canvas. In the reported screenshot the
 * column rendered twelve outlined pills and one bare `$1.01`, and nothing about
 * the values explained the split — the pill was keyed on whether the row had a
 * TOOLTIP, which is a property of its {@link CostAvailability}, not of its cost.
 * These stories put all five availabilities side by side so that keying is
 * visible rather than inferred, and so a future change cannot quietly give the
 * explained rows a different look from the unexplained ones again.
 *
 * {@link Column} is the story that actually proves the fix: a stack of real
 * figures at mixed magnitudes and mixed availabilities, which is the only view
 * where the `tabular-nums` decimal alignment — the thing a centred pill defeated
 * — either reads or does not.
 */
const meta: Meta<typeof SessionCostCell> = {
  component: SessionCostCell,
  title: "App Core/Agents/Session Cost Cell",
};

export default meta;

type Story = StoryObj<typeof SessionCostCell>;

/**
 * The `$1.01` row from the report. A real, API-billed cost: `COST_TOOLTIP` maps
 * `Available` to `null` because a genuine figure needs no explanation, so this
 * row never had a tooltip and therefore never had a pill.
 */
export const Available: Story = {
  args: {
    availability: CostAvailability.Available,
    label: "$1.01",
    tooltip: null,
  },
};

/**
 * The twelve pilled rows. Subscription-covered spend DOES carry an explanation,
 * which is what drew the chip. The explanation survives this change — only the
 * chrome is gone — and it stays reachable by keyboard.
 */
export const Subscription: Story = {
  args: {
    availability: CostAvailability.Subscription,
    label: "$658.29",
    tooltip: "Billed through your subscription",
  },
};

/** Consumed real tokens, but the model has no rate to price them at. */
export const Unpriced: Story = {
  args: {
    availability: CostAvailability.Unavailable,
    label: "—",
    tooltip: "No pricing data for this model",
  },
};

/** Registered a turn or a tool use but consumed zero tokens — nothing to price. */
export const NoTokenUsage: Story = {
  args: {
    availability: CostAvailability.NoTokenUsage,
    label: "—",
    tooltip: "No token usage recorded to price",
  },
};

/**
 * A session that never did measurable work. Renders the shared grid empty glyph,
 * not a `$0.00` it never earned (ISS-4418).
 */
export const NoUsage: Story = {
  args: {
    availability: CostAvailability.NoUsage,
    label: "—",
    tooltip: null,
  },
};

/**
 * The column, which is the state the ask was really about. Mixed magnitudes and
 * mixed availabilities in one narrow track: with the pill gone every figure is
 * flush right on the same `tabular-nums` advance, so the decimal points line up
 * and `$1,226.40` no longer has to truncate inside a border to fit.
 */
export const Column: Story = {
  render: () => (
    <div className="w-[112px] space-y-1">
      {COLUMN_ROWS.map((row) => (
        <div className="flex justify-end" key={row.label}>
          <SessionCostCell
            availability={row.availability}
            label={row.label}
            tooltip={row.tooltip}
          />
        </div>
      ))}
    </div>
  ),
};

/**
 * The over-wide state (wongk review): an API-billed figure too long for the Cost
 * track, in a box narrowed to the track's content width. `Available` has no
 * tooltip by contract, so an ellipsis here would be unrecoverable — and a
 * clipped `$1,226,540.10` does not read as a shortened label, it reads as a
 * smaller number (ISS-4891). The figure therefore overflows its box WHOLE rather
 * than truncating, which this canvas is the only place you can actually see.
 */
export const OversizeValue: Story = {
  render: () => (
    <div className="w-[112px] border border-dashed">
      <div className="flex justify-end">
        <SessionCostCell
          availability={CostAvailability.Available}
          label={OVERSIZE_COST_LABEL}
          tooltip={null}
        />
      </div>
    </div>
  ),
};

const COLUMN_ROWS: Array<{
  availability: CostAvailability;
  label: string;
  tooltip: string | null;
}> = [
  {
    availability: CostAvailability.Subscription,
    label: "$1,226.40",
    tooltip: "Billed through your subscription",
  },
  {
    availability: CostAvailability.Subscription,
    label: "$658.29",
    tooltip: "Billed through your subscription",
  },
  {
    availability: CostAvailability.Subscription,
    label: "$49.89",
    tooltip: "Billed through your subscription",
  },
  { availability: CostAvailability.Available, label: "$1.01", tooltip: null },
  {
    availability: CostAvailability.Subscription,
    label: "$0.22",
    tooltip: "Billed through your subscription",
  },
  {
    availability: CostAvailability.Unavailable,
    label: "—",
    tooltip: "No pricing data for this model",
  },
  { availability: CostAvailability.NoUsage, label: "—", tooltip: null },
];

/** Wider than the 124px Cost track at `text-sm`, and inside `formatCost`'s range. */
const OVERSIZE_COST_LABEL = "$1,226,540.10";
