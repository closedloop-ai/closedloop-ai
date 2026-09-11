import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { SystemCheckRepairButton } from "./system-check-repair";

/** Matches the single-failure button's accessible name, "Repair 1 failure". */
const REPAIR_ONE_FAILURE_NAME = /repair 1 failure/i;

// The Repair control, separate from the panel that narrates a run
// (`System Check Repair Panel`). Everything it does is decided by props, so the
// states below are the whole matrix: offered or not, mid-run, blocked by a
// concurrent check, and the two treatments the two host surfaces ask for.
/**
 * A button that starts an automatic fix for whatever a compute target's
 * check found wrong, appearing only when the gateway actually has something
 * it can repair.
 */
const meta = {
  title: "Composites/Compute/System Check Repair Button",
  component: SystemCheckRepairButton,
  tags: ["autodocs"],
  argTypes: {
    repairableCount: { control: { type: "number", min: 0 } },
    variant: { control: { type: "radio" }, options: ["default", "secondary"] },
    onRepair: { control: false, table: { category: "Events" } },
  },
  parameters: { layout: "padded" },
  args: {
    repairableCount: 1,
    isSupported: true,
    isRepairing: false,
    isCheckRunning: false,
    variant: "default",
    // Presentational story: the surface owns the transport.
    onRepair: fn(),
  },
} satisfies Meta<typeof SystemCheckRepairButton>;

export default meta;

type Story = StoryObj<typeof meta>;

/** One repairable row, in the pre-loop dialog treatment: "Repair 1 failure". */
export const Repairable: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: REPAIR_ONE_FAILURE_NAME })
    );
    await expect(args.onRepair).toHaveBeenCalled();
  },
};

/** Several repairable rows, so the plural label is visible: "Repair 3 failures". */
export const RepairableMultiple: Story = {
  args: { repairableCount: 3 },
};

/**
 * The settings-card treatment. A solid button would be the loudest thing on a
 * page whose subject is not this one collapsed sub-panel, so it steps back to
 * `secondary` without changing what it says.
 */
export const SecondaryOnSettingsCard: Story = {
  args: { repairableCount: 2, variant: "secondary" },
};

/**
 * Mid-run: the wrench swaps for a spinner, the label states what is happening,
 * and the control is disabled so a second press cannot start a second repair.
 */
export const Repairing: Story = {
  args: { repairableCount: 2, isRepairing: true },
};

/**
 * A check is already running. Repair and Re-check both write the same
 * health-check result, so Repair is disabled while the other is in flight
 * rather than racing it. It keeps its normal label, because nothing is being
 * repaired yet.
 */
export const DisabledWhileCheckRunning: Story = {
  args: { repairableCount: 3, isCheckRunning: true },
};

/**
 * Offered, in the real footer, as the reference for the two cases below: Repair
 * sits ahead of Re-check.
 */
export const OfferedInFooter: Story = {
  render: (args) => (
    <SystemCheckFooter>
      <SystemCheckRepairButton {...args} />
    </SystemCheckFooter>
  ),
};

/**
 * The gateway build predates Repair, so the button renders nothing at all. This
 * is the case the component's own comment calls out as a footer-ordering trap:
 * a caller must not infer "I passed a node, so something is on screen". Re-check
 * stays exactly where it is and is still the footer's primary action.
 */
export const NotOfferedUnsupportedGateway: Story = {
  args: { isSupported: false, repairableCount: 3 },
  render: (args) => (
    <SystemCheckFooter>
      <SystemCheckRepairButton {...args} />
    </SystemCheckFooter>
  ),
};

/**
 * The gateway supports Repair but nothing failing is repairable from here. Same
 * outcome as an old gateway: no control, because pressing it would do nothing.
 * Why each row is beyond Repair is stated on that row in `System Check Results`.
 */
export const NotOfferedNothingRepairable: Story = {
  args: { isSupported: true, repairableCount: 0 },
  render: (args) => (
    <SystemCheckFooter>
      <SystemCheckRepairButton {...args} />
    </SystemCheckFooter>
  ),
};

/**
 * The footer the button actually ships into, reproduced so the "renders
 * nothing" stories show what the user is left looking at.
 */
function SystemCheckFooter({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      {children}
      <Button className="shrink-0 gap-1.5" size="sm" variant="outline">
        <RefreshCw aria-hidden="true" className="size-3.5" />
        Re-check
      </Button>
    </div>
  );
}
