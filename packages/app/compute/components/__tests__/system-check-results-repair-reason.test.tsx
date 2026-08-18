import type { CheckResult } from "@closedloop-ai/loops-api/compute-target";
import { HealthCheckRepairAction } from "@closedloop-ai/loops-api/compute-target";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SystemCheckResults } from "../system-check-results";

/**
 * The gateway's "Repair cannot fix this" reason belongs on the row it describes
 * (ISS-5389 review). It used to be listed in a panel above the results, which
 * pre-empted the check rows with a verdict and, on the settings card, pointed at
 * a worktree picker that surface does not have.
 */

const RE_MANUAL_STEP = /needs a manual step on the gateway machine/;

const GATEWAY_VERSION_REASON =
  "Updating the Closedloop Gateway app has to happen on that machine. It cannot be done from here.";

describe("SystemCheckResults repair reasons", () => {
  it("shows the gateway's reason on the failing row it describes", () => {
    const checks: CheckResult[] = [
      {
        id: "app-version",
        label: "Gateway Version",
        required: true,
        passed: false,
        repair: { repairable: false, reason: GATEWAY_VERSION_REASON },
      },
    ];

    render(<SystemCheckResults checks={checks} />);

    expect(screen.getByText("Gateway Version")).toBeInTheDocument();
    expect(screen.getByText(GATEWAY_VERSION_REASON)).toBeInTheDocument();
  });

  it("says nothing on a row Repair can actually fix", () => {
    const checks: CheckResult[] = [
      {
        id: "claude-cli",
        label: "Claude CLI",
        required: true,
        passed: false,
        repair: {
          repairable: true,
          action: HealthCheckRepairAction.ClearBinaryOverride,
        },
      },
    ];

    render(<SystemCheckResults checks={checks} />);

    expect(screen.getByText("Claude CLI")).toBeInTheDocument();
    expect(screen.queryByText(RE_MANUAL_STEP)).toBeNull();
  });

  it("says nothing on a passing row, even one carrying a stale annotation", () => {
    const checks: CheckResult[] = [
      {
        id: "git",
        label: "Git",
        required: true,
        passed: true,
        repair: { repairable: false, reason: GATEWAY_VERSION_REASON },
      },
    ];

    render(<SystemCheckResults checks={checks} />);

    expect(screen.getByText("Git")).toBeInTheDocument();
    expect(screen.queryByText(GATEWAY_VERSION_REASON)).toBeNull();
  });

  it("renders no reason block for a gateway build that predates Repair", () => {
    const checks: CheckResult[] = [
      { id: "gh-auth", label: "GitHub Auth", required: true, passed: false },
    ];

    render(<SystemCheckResults checks={checks} />);

    expect(screen.getByText("GitHub Auth")).toBeInTheDocument();
    expect(screen.queryByText(RE_MANUAL_STEP)).toBeNull();
  });
});
