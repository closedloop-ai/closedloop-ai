import type { CheckResult } from "@repo/api/src/types/compute-target";
import { CheckSeverity } from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import { normalizeHealthCheck } from "@/lib/system-check/normalize-health-check";

/**
 * ISS-5369: a Gateway Version finding informs, it never blocks. Enforced
 * client-side so the already-installed desktop fleet — which still reports
 * "a newer release exists" as a required failure — stops blocking commands
 * without waiting for every gateway to update.
 */
describe("normalizeHealthCheck — app-version is never a blocker", () => {
  const legacyOutdated: CheckResult = {
    id: "app-version",
    label: "Desktop App Version",
    required: true,
    passed: false,
    version: "0.16.69",
    error: "Update available: 0.17.0",
    remediation: "Open the Closedloop Gateway app to update",
  };

  it("downgrades an old gateway's blocking version failure to a warning", () => {
    const result = normalizeHealthCheck(legacyOutdated);

    expect(result.required).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.severity).toBe(CheckSeverity.Warning);
    expect(result.error).toBe("Update available: 0.17.0");
    expect(result.label).toBe("Gateway Version");
  });

  it("keeps a clean version row passing with no fabricated finding", () => {
    const result = normalizeHealthCheck({
      id: "app-version",
      label: "Gateway Version",
      required: true,
      passed: true,
      version: "0.17.0",
    });

    expect(result.severity).toBe(CheckSeverity.Passed);
    expect(result.required).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("preserves a severity the gateway already resolved", () => {
    const result = normalizeHealthCheck({
      id: "app-version",
      label: "Gateway Version",
      required: false,
      passed: true,
      severity: CheckSeverity.Unknown,
      version: "0.16.69",
      error: "Version not verified (latest release: 0.17.0)",
    });

    expect(result.severity).toBe(CheckSeverity.Unknown);
    expect(result.required).toBe(false);
  });

  it("relabels plugin-versions without touching its blocking semantics", () => {
    const result = normalizeHealthCheck({
      id: "plugin-versions",
      label: "raw",
      required: true,
      passed: false,
      error: "Update available: 2.0.0",
    });

    expect(result.label).toBe("Plugin Updates");
    expect(result.required).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("leaves every other check untouched, including blocked plugin rows", () => {
    const blocked: CheckResult = {
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: false,
      severity: CheckSeverity.Blocked,
      blockedBy: "claude-cli",
      error: "Not checked, Claude CLI unavailable",
    };

    expect(normalizeHealthCheck(blocked)).toEqual(blocked);
  });
});
