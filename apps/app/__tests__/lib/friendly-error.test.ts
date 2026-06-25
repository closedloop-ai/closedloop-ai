import {
  DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE,
  resolveFriendlyError,
} from "@repo/api/src/types/friendly-error";
import { LoopErrorCode, RunnerErrorSubcode } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";

const SPECIFIC_GOAL_REGEX = /specific goal/i;
const LINT_ERRORS_REGEX = /lint errors/i;
const SYSTEM_CHECK_REGEX = /System Check/i;
const CLOSEDLOOP_PLUGINS_REGEX = /closedloop-ai plugins/i;
const MANAGED_ONBOARDING_REGEX = /managed onboarding/i;

describe("friendly error resolver", () => {
  it("has display copy for every LoopErrorCode", () => {
    for (const code of Object.values(LoopErrorCode)) {
      const friendly = resolveFriendlyError({ code });

      expect(friendly.title).not.toBe(code);
      expect(friendly.description.length).toBeGreaterThan(0);
      expect(friendly.remediation.length).toBeGreaterThan(0);
    }
  });

  it("uses runner subcode remediation for MAX_ITERATIONS_NO_PROGRESS", () => {
    const friendly = resolveFriendlyError({
      code: LoopErrorCode.RunnerError,
      message: "runner stopped",
      result: { subcode: "MAX_ITERATIONS_NO_PROGRESS" },
    });

    expect(friendly.title).toBe("Loop stopped after no progress");
    expect(friendly.remediation.join(" ")).toMatch(SPECIFIC_GOAL_REGEX);
    expect(friendly.technicalDetails.result).toEqual({
      subcode: "MAX_ITERATIONS_NO_PROGRESS",
    });
  });

  it("uses specific remediation for CLAUDE_UNKNOWN_SKILL", () => {
    const friendly = resolveFriendlyError({
      code: LoopErrorCode.RunnerError,
      message: "Claude plugin command unavailable: Unknown skill: code:code",
      result: { subcode: RunnerErrorSubcode.ClaudeUnknownSkill },
    });

    expect(friendly.title).toBe("Closedloop plugin command unavailable");
    expect(friendly.remediation.join(" ")).toMatch(SYSTEM_CHECK_REGEX);
    expect(friendly.remediation.join(" ")).toMatch(CLOSEDLOOP_PLUGINS_REGEX);
    expect(friendly.technicalDetails.result).toEqual({
      subcode: RunnerErrorSubcode.ClaudeUnknownSkill,
    });
  });

  it("maps git pre-commit hook categories without making stderr primary copy", () => {
    const friendly = resolveFriendlyError({
      code: LoopErrorCode.ProcessFailed,
      message: "Pre-commit hook failed",
      details: {
        action: "commit",
        category: "pre_commit_hook",
        hookType: "lint",
        stderrExcerpt: "eslint failed in src/app.ts",
      },
    });

    expect(friendly.title).toBe("Pre-commit hook failed");
    expect(friendly.description).not.toContain("eslint failed");
    expect(friendly.remediation.join(" ")).toMatch(LINT_ERRORS_REGEX);
    expect(friendly.technicalDetails.details).toEqual({
      action: "commit",
      category: "pre_commit_hook",
      hookType: "lint",
      stderrExcerpt: "eslint failed in src/app.ts",
    });
  });

  it("surfaces the desktop signed-launch fail-fast message in visible copy", () => {
    const friendly = resolveFriendlyError({
      code: LoopErrorCode.ProcessFailed,
      message: DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE,
    });

    expect(friendly.title).toBe("Desktop managed signing is not ready");
    expect(friendly.description).toBe(
      DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE
    );
    expect(friendly.remediation.join(" ")).toMatch(MANAGED_ONBOARDING_REGEX);
    expect(friendly.technicalDetails.message).toBe(
      DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE
    );
  });

  it("does not let git category details override known non-git error codes", () => {
    const friendly = resolveFriendlyError({
      code: LoopErrorCode.SpawnFailed,
      details: { category: "pre_commit_hook" },
      message: "spawn failed",
    });

    expect(friendly.title).toBe(
      resolveFriendlyError({ code: LoopErrorCode.SpawnFailed }).title
    );
  });

  it("uses compute target categories for pre-run validation failures", () => {
    const friendly = resolveFriendlyError({
      code: LoopErrorCode.PreRunValidationFailed,
      details: { category: "compute_target_offline" },
      message: "Compute target is offline",
    });

    expect(friendly.title).toBe("Compute target is offline");
  });

  it("does not let git categories override pre-run validation failures", () => {
    const friendly = resolveFriendlyError({
      code: LoopErrorCode.PreRunValidationFailed,
      details: { category: "pre_commit_hook" },
      message: "pre-run validation failed",
    });

    expect(friendly.title).toBe(
      resolveFriendlyError({ code: LoopErrorCode.PreRunValidationFailed }).title
    );
  });

  it("uses known git category details for unknown future codes", () => {
    const friendly = resolveFriendlyError({
      code: "FUTURE_GATEWAY_CODE",
      details: { category: "pre_commit_hook" },
      message: "hook failed",
    });

    expect(friendly.title).toBe("Pre-commit hook failed");
  });

  it("falls back safely for unknown future codes and categories", () => {
    const friendly = resolveFriendlyError({
      code: "NEW_CODE",
      message: "raw failure",
      details: { category: "new_category" },
    });

    expect(friendly.title).toBe("Operation failed");
    expect(friendly.description).not.toContain("raw failure");
    expect(friendly.technicalDetails.code).toBe("NEW_CODE");
    expect(friendly.technicalDetails.message).toBe("raw failure");
  });
});
