import {
  HealthCheckRepairAction,
  HealthCheckRepairStepStatus,
} from "@closedloop-ai/loops-api/compute-target";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  SystemCheckRepairButton,
  SystemCheckRepairPanel,
} from "../system-check-repair";

const RE_CLEAR_OVERRIDE_STEP = /Clear stale binary path override/;
const RE_REMOVED_CLAUDE_CLI = /Removed Claude CLI/;
const RE_STILL_UNRESOLVED = /still does not resolve/;
const RE_ALREADY_RUNNING = /already running/;

describe("SystemCheckRepairButton", () => {
  it("is not rendered when the gateway has nothing it can repair", () => {
    render(
      <SystemCheckRepairButton
        isRepairing={false}
        isSupported={true}
        onRepair={vi.fn()}
        repairableCount={0}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is not rendered against a gateway build that predates Repair", () => {
    render(
      <SystemCheckRepairButton
        isRepairing={false}
        isSupported={false}
        onRepair={vi.fn()}
        repairableCount={3}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names how many rows it will repair", async () => {
    const onRepair = vi.fn();
    render(
      <SystemCheckRepairButton
        isRepairing={false}
        isSupported={true}
        onRepair={onRepair}
        repairableCount={2}
      />
    );

    const button = screen.getByRole("button", { name: "Repair 2 failures" });
    await userEvent.click(button);

    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("cannot be pressed again while a repair is running", async () => {
    const onRepair = vi.fn();
    render(
      <SystemCheckRepairButton
        isRepairing={true}
        isSupported={true}
        onRepair={onRepair}
        repairableCount={2}
      />
    );

    const button = screen.getByRole("button", { name: "Repairing…" });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onRepair).not.toHaveBeenCalled();
  });
});

describe("SystemCheckRepairPanel", () => {
  // The panel narrates a RUN, so an idle mount must stay silent. It used to
  // render whenever any failing row was un-repairable, which put the verdict on
  // what Repair cannot do above the check results before the user had touched
  // anything (ISS-5389 review). Those reasons now live on their own check rows.
  it("renders nothing before a repair has been asked for", () => {
    const { container } = render(<SystemCheckRepairPanel />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("region", { name: "Repair" })).toBeNull();
  });

  it("reports a skipped step as a decision with its reason, not a shrug", () => {
    render(
      <SystemCheckRepairPanel
        steps={[
          {
            action: HealthCheckRepairAction.ClearBinaryOverride,
            label: "Clear stale binary path override: Claude CLI",
            status: HealthCheckRepairStepStatus.Succeeded,
            checkIds: ["claude-cli"],
            detail: "Removed Claude CLI (/old/bin/claude)",
          },
          {
            action: HealthCheckRepairAction.EnablePlugins,
            label: "Enable Closedloop Claude Code plugins",
            status: HealthCheckRepairStepStatus.Skipped,
            checkIds: ["plugin-code"],
            detail:
              "Not run: the Claude CLI still does not resolve, so `claude plugin enable` could not have succeeded.",
          },
        ]}
      />
    );

    expect(screen.getByText(RE_CLEAR_OVERRIDE_STEP)).toBeInTheDocument();
    expect(screen.getByText(RE_REMOVED_CLAUDE_CLI)).toBeInTheDocument();
    expect(screen.getByText("not run")).toBeInTheDocument();
    expect(screen.getByText(RE_STILL_UNRESOLVED)).toBeInTheDocument();
  });

  it("names the step and the reason on a failure rather than a generic red", () => {
    render(
      <SystemCheckRepairPanel
        steps={[
          {
            action: HealthCheckRepairAction.EnablePlugins,
            label: "Enable Closedloop Claude Code plugins",
            status: HealthCheckRepairStepStatus.Failed,
            checkIds: ["plugin-judges"],
            detail: "Judges Plugin: Automatic enable failed",
          },
        ]}
      />
    );

    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(
      screen.getByText("Judges Plugin: Automatic enable failed")
    ).toBeInTheDocument();
  });

  it("appears only once a repair is actually in flight", () => {
    render(<SystemCheckRepairPanel isRepairing={true} />);

    expect(screen.getByRole("region", { name: "Repair" })).toBeInTheDocument();
  });

  it("says a second press joined the run already in flight", () => {
    render(
      <SystemCheckRepairPanel
        joinedInFlight={true}
        steps={[
          {
            action: HealthCheckRepairAction.EnablePlugins,
            label: "Enable Closedloop Claude Code plugins",
            status: HealthCheckRepairStepStatus.Succeeded,
            checkIds: ["plugin-code"],
          },
        ]}
      />
    );

    expect(screen.getByText(RE_ALREADY_RUNNING)).toBeInTheDocument();
  });

  it("surfaces a transport failure as an alert", () => {
    render(
      <SystemCheckRepairPanel errorMessage="This gateway build does not support Repair." />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This gateway build does not support Repair."
    );
  });
});
