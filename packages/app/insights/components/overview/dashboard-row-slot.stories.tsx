import type { Meta, StoryObj } from "@storybook/react";
import { DashboardRowState } from "./dashboard-row-sections";
import { DashboardRowSlot } from "./dashboard-row-slot";
import { DASHBOARD_ROWS, DashboardRowTour } from "./dashboard-tiles";

/**
 * `DashboardRowSlot` was promoted out of the overview dashboard's render by
 * ISS-10486, which is the moment `packages/app/AGENTS.md` says a prop-driven
 * component owes its own story: it is a three-way state matrix and the parent
 * only ever renders one leg of it per fixture.
 *
 * What is genuinely this component's own is that the three legs have to read as
 * ONE row. Before ISS-10486 a failed section replaced the whole page, so the
 * error treatment only ever had to look like a page; now it sits inline between
 * rows that are showing real charts, and a background refetch can swap a chart
 * for it with nothing else on screen moving. So the degraded card has to wear
 * this page's card idiom at this page's row height, or a reader reads the swap
 * as the layout breaking rather than as one row losing its data — which no
 * assertion about a class name can check.
 */
const meta: Meta<typeof DashboardRowSlot> = {
  title: "Composites v1.0/Insights/Dashboard Row Slot",
  component: DashboardRowSlot,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  args: { onRetry: () => undefined },
};

export default meta;
type Story = StoryObj<typeof DashboardRowSlot>;

const statsRow =
  DASHBOARD_ROWS.find((row) => row.tour === DashboardRowTour.Stats) ??
  DASHBOARD_ROWS[0];
const chartRow =
  DASHBOARD_ROWS.find((row) => row.tour === DashboardRowTour.Models) ??
  DASHBOARD_ROWS[0];

/** Stand-in for a real row's content, so `Ready` is visibly the passthrough. */
function RowContent({ label }: { label: string }) {
  return (
    <div className="flex min-h-[112px] items-center justify-center rounded-xl border border-border/70 bg-card p-6 text-muted-foreground text-sm">
      {label}
    </div>
  );
}

/** The passthrough: the slot draws its children and nothing of its own. */
export const Ready: Story = {
  args: {
    row: statsRow,
    state: DashboardRowState.Ready,
    retrying: false,
    children: <RowContent label="Headline metrics" />,
  },
};

/** The row's own skeleton, shaped like the row it stands in for. */
export const Loading: Story = {
  args: {
    row: statsRow,
    state: DashboardRowState.Loading,
    retrying: false,
    children: <RowContent label="Headline metrics" />,
  },
};

/**
 * The state this component exists for. It NAMES the row, because one failed
 * section degrades several rows at once and a generic sentence would leave a
 * reader facing identical boxes with no way to tell what is missing.
 */
export const Failed: Story = {
  args: {
    row: statsRow,
    state: DashboardRowState.Failed,
    retrying: false,
    children: <RowContent label="Headline metrics" />,
  },
};

/**
 * Mid-retry. Worth its own story because the press is otherwise invisible:
 * TanStack keeps `status: "error"` through a refetch and flips only
 * `fetchStatus`, so this label and the disabled control are the entire visible
 * response to the click.
 */
export const FailedRetrying: Story = {
  args: {
    row: statsRow,
    state: DashboardRowState.Failed,
    retrying: true,
    children: <RowContent label="Headline metrics" />,
  },
};

/** A second row's copy, so the naming is visibly per-row rather than fixed. */
export const FailedChartRow: Story = {
  args: {
    row: chartRow,
    state: DashboardRowState.Failed,
    retrying: false,
    children: <RowContent label="Model cost over time" />,
  },
};

/**
 * The real arrangement ISS-10486 created and the one the page-level error card
 * never had to survive: a degraded row between two healthy ones. This is where
 * a mismatch in card idiom, border weight or row height shows up.
 */
export const DegradedAmongHealthyRows: Story = {
  render: () => (
    <div className="flex flex-col gap-5">
      <DashboardRowSlot
        onRetry={() => undefined}
        retrying={false}
        row={statsRow}
        state={DashboardRowState.Ready}
      >
        <RowContent label="Headline metrics" />
      </DashboardRowSlot>
      <DashboardRowSlot
        onRetry={() => undefined}
        retrying={false}
        row={chartRow}
        state={DashboardRowState.Failed}
      >
        <RowContent label="Model cost over time" />
      </DashboardRowSlot>
      <DashboardRowSlot
        onRetry={() => undefined}
        retrying={false}
        row={statsRow}
        state={DashboardRowState.Ready}
      >
        <RowContent label="Headline metrics" />
      </DashboardRowSlot>
    </div>
  ),
};
