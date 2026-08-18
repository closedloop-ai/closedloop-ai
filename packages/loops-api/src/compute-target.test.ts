import { describe, expect, it } from "vitest";

import {
  type CheckResult,
  CheckSeverity,
  isFailingRequiredCheck,
  isIndeterminateCheckSeverity,
  resolveCheckSeverity,
} from "./compute-target";

describe("compute-target check severity", () => {
  it("honors recognized wire severities", () => {
    expect(
      resolveCheckSeverity({
        passed: true,
        error: "legacy advisory",
        severity: CheckSeverity.Blocked,
      })
    ).toBe(CheckSeverity.Blocked);
  });

  it("falls back to the legacy derivation for absent or future severities", () => {
    expect(
      resolveCheckSeverity({
        passed: false,
        severity: "future" as CheckSeverity,
      })
    ).toBe(CheckSeverity.Error);
    expect(
      resolveCheckSeverity({
        passed: true,
        error: "warning",
        severity: "future" as CheckSeverity,
      })
    ).toBe(CheckSeverity.Warning);
    expect(
      resolveCheckSeverity({
        passed: true,
        severity: "future" as CheckSeverity,
      })
    ).toBe(CheckSeverity.Passed);
    expect(resolveCheckSeverity({ passed: true, error: "warning" })).toBe(
      CheckSeverity.Warning
    );
    expect(resolveCheckSeverity({ passed: true })).toBe(CheckSeverity.Passed);
  });

  it("distinguishes indeterminate findings from actionable outcomes", () => {
    expect(isIndeterminateCheckSeverity(CheckSeverity.Blocked)).toBe(true);
    expect(isIndeterminateCheckSeverity(CheckSeverity.Unknown)).toBe(true);
    expect(isIndeterminateCheckSeverity(CheckSeverity.Error)).toBe(false);
  });
});

/**
 * ISS-5868 promoted this predicate out of `apps/app` so the cloud gate and the
 * desktop gateway's `allRequiredPassed` cannot disagree about what a blocker
 * is. The behaviour is ISS-5811's: a row the gateway could not DETERMINE stops
 * asserting a fault it has no evidence for.
 */
describe("isFailingRequiredCheck", () => {
  function makeCheck(overrides: Partial<CheckResult> = {}): CheckResult {
    return {
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: false,
      ...overrides,
    };
  }

  it("blocks on a proven required failure", () => {
    expect(isFailingRequiredCheck(makeCheck({ error: "Disabled" }))).toBe(true);
    expect(
      isFailingRequiredCheck(makeCheck({ severity: CheckSeverity.Error }))
    ).toBe(true);
  });

  it("does not block on a required row the gateway could not determine", () => {
    expect(
      isFailingRequiredCheck(makeCheck({ severity: CheckSeverity.Unknown }))
    ).toBe(false);
    expect(
      isFailingRequiredCheck(
        makeCheck({ severity: CheckSeverity.Blocked, blockedBy: "claude-cli" })
      )
    ).toBe(false);
  });

  it("does not block on a required row deliberately downgraded to a warning", () => {
    expect(
      isFailingRequiredCheck(makeCheck({ severity: CheckSeverity.Warning }))
    ).toBe(false);
  });

  it("never blocks on an optional row, whatever its severity", () => {
    expect(
      isFailingRequiredCheck(
        makeCheck({ required: false, severity: CheckSeverity.Error })
      )
    ).toBe(false);
  });

  it("keeps blocking on skew in both directions", () => {
    // Predates ISS-5369: no severity at all.
    expect(isFailingRequiredCheck(makeCheck())).toBe(true);
    // Newer than this build: an unrecognised tier falls back to the legacy
    // derivation rather than being guessed non-blocking.
    expect(
      isFailingRequiredCheck(
        makeCheck({ severity: "catastrophic" as CheckSeverity })
      )
    ).toBe(true);
  });

  it("still blocks on a self-contradictory `passed: false` with `severity: passed`", () => {
    expect(
      isFailingRequiredCheck(makeCheck({ severity: CheckSeverity.Passed }))
    ).toBe(true);
  });
});
