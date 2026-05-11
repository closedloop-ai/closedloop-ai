import { resolveFriendlyError } from "@repo/api/src/types/friendly-error";
import { LoopErrorCode } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";

const SPECIFIC_GOAL_REGEX = /specific goal/i;
const LINT_ERRORS_REGEX = /lint errors/i;

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
