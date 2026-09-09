import {
  HealthCheckRepairAction,
  HealthCheckRepairStepStatus,
} from "@closedloop-ai/loops-api/compute-target";
import type { Meta, StoryObj } from "@storybook/react";
import { SystemCheckRepairPanel } from "./system-check-repair";

const meta: Meta<typeof SystemCheckRepairPanel> = {
  title: "App Core/Compute/System Check Repair Panel",
  component: SystemCheckRepairPanel,
  tags: ["autodocs"],
  argTypes: {
    steps: { control: "object" },
  },
  parameters: { layout: "padded" },
  args: {
    steps: [],
    isRepairing: false,
    errorMessage: null,
    joinedInFlight: false,
  },
};

export default meta;

type Story = StoryObj<typeof SystemCheckRepairPanel>;

export const Running: Story = {
  args: { isRepairing: true },
};

/**
 * The case ISS-5389 exists to end: the Claude CLI path override was stale, so
 * Repair cleared it and deliberately did NOT fire five doomed plugin-enable
 * commands. "not run" has to read as a decision, with its reason attached.
 */
export const RootFixedCascadeSkipped: Story = {
  args: {
    steps: [
      {
        action: HealthCheckRepairAction.ClearBinaryOverride,
        label: "Clear stale binary path override: Claude CLI",
        status: HealthCheckRepairStepStatus.Succeeded,
        checkIds: ["claude-cli"],
        detail: "Removed Claude CLI (/Users/dev/.old/bin/claude)",
      },
      {
        action: HealthCheckRepairAction.EnablePlugins,
        label: "Enable Closedloop Claude Code plugins",
        status: HealthCheckRepairStepStatus.Skipped,
        checkIds: ["plugin-code", "plugin-platform"],
        detail:
          "Not run: the Claude CLI still does not resolve, so `claude plugin enable` could not have succeeded. Fix the Claude CLI row first, then repair again.",
      },
    ],
  },
};

export const AllFixed: Story = {
  args: {
    steps: [
      {
        action: HealthCheckRepairAction.EnablePlugins,
        label: "Enable Closedloop Claude Code plugins",
        status: HealthCheckRepairStepStatus.Succeeded,
        checkIds: ["plugin-code", "plugin-platform", "plugin-judges"],
      },
    ],
  },
};

export const StepFailedWithReason: Story = {
  args: {
    steps: [
      {
        action: HealthCheckRepairAction.EnablePlugins,
        label: "Enable Closedloop Claude Code plugins",
        status: HealthCheckRepairStepStatus.Failed,
        checkIds: ["plugin-judges"],
        detail: "Judges Plugin: Automatic enable failed",
      },
    ],
  },
};

export const TransportFailure: Story = {
  args: {
    errorMessage:
      "This gateway build does not support Repair. Update the Closedloop Gateway app on that machine.",
  },
};

export const JoinedInFlight: Story = {
  args: {
    joinedInFlight: true,
    steps: [
      {
        action: HealthCheckRepairAction.EnablePlugins,
        label: "Enable Closedloop Claude Code plugins",
        status: HealthCheckRepairStepStatus.Succeeded,
        checkIds: ["plugin-code"],
      },
    ],
  },
};
