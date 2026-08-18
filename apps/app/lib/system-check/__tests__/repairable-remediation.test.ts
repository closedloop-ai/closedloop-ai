import type { CheckResult } from "@repo/api/src/types/compute-target";
import { HealthCheckRepairAction } from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import {
  deferRepairableRemediation,
  REPAIR_DEFERRAL_REMEDIATION,
} from "../repairable-remediation";

/** The exact copy the review called out, as `getMcpCheckResult` writes it. */
const MANUAL_MCP_REMEDIATION =
  "Install a user/global MCP server pointing to https://mcp.example.com. Project-local MCP installs are not supported.";

const repairableMcpRow: CheckResult = {
  id: "codex-mcp",
  label: "Codex MCP",
  required: false,
  passed: false,
  error: "Not configured",
  remediation: MANUAL_MCP_REMEDIATION,
  repair: {
    repairable: true,
    action: HealthCheckRepairAction.ConfigureMcp,
  },
};

const unrepairableRow: CheckResult = {
  id: "gh-auth",
  label: "GitHub auth",
  required: true,
  passed: false,
  error: "Token expired",
  remediation: "Run `gh auth login` on that machine.",
  repair: {
    repairable: false,
    reason: "Re-authenticating gh has to happen on that machine.",
  },
};

const passingRow: CheckResult = {
  id: "git",
  label: "Git",
  required: true,
  passed: true,
  remediation: "Install git.",
};

describe("deferRepairableRemediation", () => {
  it("defers a repairable row's manual copy to the Repair control", () => {
    const [row] = deferRepairableRemediation([repairableMcpRow], true) ?? [];

    expect(row?.remediation).toBe(REPAIR_DEFERRAL_REMEDIATION);
    // Only the copy changes — repairability, the error, and the row's identity
    // all still read the same to `getRepairableChecks` and the repair panel.
    expect(row?.repair).toEqual(repairableMcpRow.repair);
    expect(row?.error).toBe("Not configured");
  });

  it("keeps the manual copy when no Repair button is on screen", () => {
    // Flag off, somebody else's target, or a gateway too old to know Repair:
    // the row is still `repairable`, but deferring to a control that is not
    // there would strand the user with no instructions at all.
    const input = [repairableMcpRow];
    const checks = deferRepairableRemediation(input, false);

    expect(checks?.[0]?.remediation).toBe(MANUAL_MCP_REMEDIATION);
    expect(checks).toBe(input);
  });

  it("leaves rows Repair cannot fix, and passing rows, untouched", () => {
    const checks =
      deferRepairableRemediation([unrepairableRow, passingRow], true) ?? [];

    // The `gh auth` row is the ONLY instruction the user has — Repair says
    // nothing about it, so it must keep saying what to do.
    expect(checks[0]?.remediation).toBe(unrepairableRow.remediation);
    expect(checks[1]?.remediation).toBe(passingRow.remediation);
  });

  it("returns the same array when nothing deferred", () => {
    const input = [unrepairableRow, passingRow];

    // Identity-preserving, so the dialog's staggered reveal (which re-triggers
    // on a new `checks` reference) is not restarted every render.
    expect(deferRepairableRemediation(input, true)).toBe(input);
  });

  it("passes undefined checks through", () => {
    expect(deferRepairableRemediation(undefined, true)).toBeUndefined();
  });
});
