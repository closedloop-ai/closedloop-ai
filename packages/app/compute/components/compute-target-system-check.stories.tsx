import type { CheckResult } from "@repo/api/src/types/compute-target";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import {
  ComputeTargetSystemCheck,
  type ComputeTargetSystemCheckState,
} from "./compute-target-system-check";
import { SystemCheckResults } from "./system-check-results";

const checks: CheckResult[] = [
  {
    id: "git",
    label: "Git",
    passed: true,
    required: true,
    version: "2.49.0",
  },
  {
    id: "claude-cli",
    label: "Claude Code",
    passed: false,
    required: true,
    error: "Not found",
    remediation: "Install Claude Code and retry.",
  },
];

function ComputeTargetSystemCheckDemo({
  initialState,
}: {
  initialState: ComputeTargetSystemCheckState;
}) {
  const [state, setState] =
    useState<ComputeTargetSystemCheckState>(initialState);
  const hasResults = state === "success" || state === "warning";

  return (
    <ComputeTargetSystemCheck
      actionDisabled={state === "loading" || state === "disabled"}
      checkedAtLabel={hasResults ? "May 30, 2026, 9:41 AM" : undefined}
      content={hasResults ? <SystemCheckResults checks={checks} /> : undefined}
      failureCount={state === "warning" ? 1 : 0}
      hasResult={hasResults}
      isEligible={state !== "disabled"}
      isLoading={state === "loading"}
      onAction={() => {
        setState("loading");
        setTimeout(() => {
          setState((current) =>
            current === "loading" && initialState === "success"
              ? "success"
              : "warning"
          );
        }, 700);
      }}
      targetName="Mike's MacBook Pro"
    />
  );
}

const meta = {
  title: "App Core/Compute/Compute Target System Check",
  component: ComputeTargetSystemCheckDemo,
  tags: ["autodocs"],
  args: {
    initialState: "idle",
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ComputeTargetSystemCheckDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Warning: Story = {
  args: {
    initialState: "warning",
  },
};

export const Healthy: Story = {
  args: {
    initialState: "success",
  },
};

export const Offline: Story = {
  args: {
    initialState: "disabled",
  },
};
