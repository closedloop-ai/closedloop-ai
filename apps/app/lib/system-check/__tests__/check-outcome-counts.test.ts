import type { CheckResult } from "@repo/api/src/types/compute-target";
import {
  CLAUDE_CLI_CHECK_ID,
  CODEX_CLI_CHECK_ID,
} from "@repo/api/src/types/compute-target";
import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import { describe, expect, it } from "vitest";
import { getCheckOutcomeCounts } from "../check-outcome-counts";

/**
 * ISS-5687. The reported machine had two green CLIs and two OPTIONAL,
 * unconfigured MCP rows, and System Check announced "2 failures" — a number the
 * pre-loop gate never agreed with, because the gate only ever counted
 * `required && !passed`.
 */
describe("getCheckOutcomeCounts", () => {
  it("counts unconfigured optional MCP rows as warnings, never as failures", () => {
    const counts = getCheckOutcomeCounts([
      makeCheck({ id: CLAUDE_CLI_CHECK_ID, required: true, passed: true }),
      makeCheck({ id: CODEX_CLI_CHECK_ID, required: true, passed: true }),
      makeCheck({
        id: "claude-mcp",
        required: false,
        passed: false,
        error: "Not configured",
      }),
      makeCheck({
        id: "codex-mcp",
        required: false,
        passed: false,
        error: "Not configured",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 0, warningCount: 2 });
  });

  it("counts a failing required row as a failure", () => {
    const counts = getCheckOutcomeCounts([
      makeCheck({ id: "git", required: true, passed: false, error: "Missing" }),
      makeCheck({
        id: "claude-mcp",
        required: false,
        passed: false,
        error: "Not configured",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 1, warningCount: 1 });
  });

  it("reports zero of both when every row passes", () => {
    const counts = getCheckOutcomeCounts([
      makeCheck({ id: "git", required: true, passed: true }),
      makeCheck({
        id: "codex-mcp",
        required: false,
        passed: true,
        severity: CheckSeverity.Passed,
      }),
    ]);

    expect(counts).toEqual({ failureCount: 0, warningCount: 0 });
  });

  /**
   * ISS-5369 severity rows. `passed: true` on these means "does not block", NOT
   * "is fine" — `checkAppVersion` in the gateway returns `passed: true` on every
   * branch on purpose, so older web builds cannot be blocked by a version
   * finding, and puts the real state in `severity`. Counting on `passed` alone
   * dropped every one of these and let the badge say "All checks passed" over a
   * live advisory.
   */
  it("counts the Gateway Version update advisory (passed + warning) as a warning", () => {
    const counts = getCheckOutcomeCounts([
      makeCheck({ id: "git", required: true, passed: true }),
      // Verbatim shape of `checkAppVersion`'s out-of-date branch.
      makeCheck({
        id: "app-version",
        label: "Gateway Version",
        required: false,
        passed: true,
        severity: CheckSeverity.Warning,
        error: "Update available: 1.4.0",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 0, warningCount: 1 });
  });

  it.each([
    CheckSeverity.Unknown,
    CheckSeverity.Blocked,
  ])("counts an undeterminable %s row as a warning, not as a pass", (severity) => {
    const counts = getCheckOutcomeCounts([
      makeCheck({
        id: "app-version",
        required: false,
        passed: true,
        severity,
        error: "Version not verified",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 0, warningCount: 1 });
  });

  it("counts a legacy passed-with-error row (no severity field) as a warning", () => {
    const counts = getCheckOutcomeCounts([
      makeCheck({
        id: "app-version",
        required: false,
        passed: true,
        error: "Update available: 1.4.0",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 0, warningCount: 1 });
  });

  /**
   * ISS-5811. The verbatim row the reported machine produced five of: the
   * plugin is installed (it reports a version) but `claude plugin list` could
   * not confirm its enabled state, so the gateway marks it
   * `severity: "unknown"` — "not-determinable, not a proven failure" — and
   * `repair.repairable: false`. Read as a blocker, these five refused every
   * Generate/Execute launch with no action the user could take, and no request
   * ever reached the API.
   */
  it.each([
    CheckSeverity.Unknown,
    CheckSeverity.Blocked,
  ])("does not block on an undeterminable required %s row", (severity) => {
    const counts = getCheckOutcomeCounts([
      makeCheck({
        id: "plugin-code",
        label: "Symphony Plugin",
        required: true,
        passed: false,
        severity,
        version: "1.14.7",
        error: "Could not verify enabled state",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 0, warningCount: 1 });
  });

  /**
   * A REQUIRED row the gateway deliberately downgraded. `CheckSeverity.Warning`
   * is defined as "Non-blocking finding. The command can still run.", so
   * blocking on one contradicts the shared contract — and it did, purely
   * because the row also carried `passed: false`, the same `passed`-only read
   * ISS-5811 removed for the undeterminable tiers.
   */
  it("does not block on a required row the gateway downgraded to a warning", () => {
    const counts = getCheckOutcomeCounts([
      makeCheck({
        id: "plugin-code",
        required: true,
        passed: false,
        severity: CheckSeverity.Warning,
        error: "Update available",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 0, warningCount: 1 });
  });

  /**
   * The other half of ISS-5811, and the reason the fix keys on severity rather
   * than on the error string: a plugin PROVEN disabled is a real, actionable
   * finding and must keep blocking.
   */
  it("still blocks on a required row proven disabled", () => {
    const counts = getCheckOutcomeCounts([
      makeCheck({
        id: "plugin-code",
        required: true,
        passed: false,
        severity: CheckSeverity.Error,
        error: "Disabled",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 1, warningCount: 0 });
  });

  /**
   * Version skew, both directions. A gateway predating ISS-5369 sends no
   * `severity` at all, and a newer one can send a tier this build has never
   * heard of. Neither is evidence of indeterminacy, so both must keep blocking
   * rather than be guessed non-blocking off a signal that was never sent.
   */
  it("still blocks a failing required row from a gateway that sends no severity", () => {
    const counts = getCheckOutcomeCounts([
      makeCheck({
        id: "plugin-code",
        required: true,
        passed: false,
        error: "Could not verify enabled state",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 1, warningCount: 0 });
  });

  it("still blocks a failing required row carrying an unrecognised severity", () => {
    const counts = getCheckOutcomeCounts([
      makeCheck({
        id: "plugin-code",
        required: true,
        passed: false,
        // A tier from a gateway newer than this build.
        severity: "indeterminate-ish" as CheckSeverity,
        error: "Could not verify enabled state",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 1, warningCount: 0 });
  });

  /**
   * The badge must never undercount what the pre-loop gate blocks on. Both read
   * the same predicate, so a gateway sending a contradictory `severity:
   * "passed"` on a failing required row must not talk either out of the
   * failure — `"passed"` is a KNOWN tier and not an indeterminate one, so it
   * does not reach the ISS-5811 carve-out.
   */
  it("still counts a failing required row as a failure when severity says passed", () => {
    const counts = getCheckOutcomeCounts([
      makeCheck({
        id: "git",
        required: true,
        passed: false,
        severity: CheckSeverity.Passed,
        error: "Missing",
      }),
    ]);

    expect(counts).toEqual({ failureCount: 1, warningCount: 0 });
  });

  it("reports zero of both when the checks list is absent", () => {
    expect(getCheckOutcomeCounts(undefined)).toEqual({
      failureCount: 0,
      warningCount: 0,
    });
  });
});

function makeCheck(overrides: Partial<CheckResult> & { id: string }) {
  return {
    label: overrides.id,
    required: false,
    passed: true,
    ...overrides,
  } satisfies CheckResult;
}
