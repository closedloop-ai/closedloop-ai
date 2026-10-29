import { describe, expect, it } from "vitest";
import { LoopErrorCode } from "./error-codes";
import {
  GitGatewayErrorCategory,
  GitHookType,
  resolveFriendlyError,
} from "./friendly-error";

const UNKNOWN_CATEGORY = "not_a_known_category";

describe("resolveFriendlyError git gateway category scoping", () => {
  it("uses the category copy for a process failure", () => {
    const result = resolveFriendlyError({
      code: LoopErrorCode.ProcessFailed,
      details: { category: GitGatewayErrorCategory.GitPushAuth },
    });
    expect(result.title).toBe("Git push authentication failed");
  });

  it("uses the category copy when the error code is absent", () => {
    const result = resolveFriendlyError({
      details: { category: GitGatewayErrorCategory.PreCommitHook },
    });
    expect(result.title).toBe("Pre-commit hook failed");
    expect(result).not.toHaveProperty("code");
  });

  it("uses the category copy when the error code is unrecognized", () => {
    const result = resolveFriendlyError({
      code: "SOME_FUTURE_CODE",
      details: { category: GitGatewayErrorCategory.SpawnFailed },
    });
    expect(result.title).toBe("Git could not start");
    expect(result.code).toBe("SOME_FUTURE_CODE");
  });

  it("keeps pre-run validation copy when a git category is attached", () => {
    const result = resolveFriendlyError({
      code: LoopErrorCode.PreRunValidationFailed,
      details: { category: GitGatewayErrorCategory.GitPushAuth },
    });
    expect(result.title).toBe("Pre-run validation failed");
  });

  it("ignores the category for codes outside the scoped set", () => {
    const withCategory = resolveFriendlyError({
      code: LoopErrorCode.GitCloneFailed,
      details: { category: GitGatewayErrorCategory.GitPushAuth },
    });
    const withoutCategory = resolveFriendlyError({
      code: LoopErrorCode.GitCloneFailed,
    });
    expect(withCategory.title).toBe(withoutCategory.title);
    expect(withCategory.remediation).toEqual(withoutCategory.remediation);
  });

  it("falls back to the code copy for an unknown category", () => {
    const withCategory = resolveFriendlyError({
      code: LoopErrorCode.ProcessFailed,
      details: { category: UNKNOWN_CATEGORY },
    });
    const withoutCategory = resolveFriendlyError({
      code: LoopErrorCode.ProcessFailed,
    });
    expect(withCategory.title).toBe(withoutCategory.title);
  });

  it("treats an empty category string as absent", () => {
    const result = resolveFriendlyError({
      details: { category: "" },
    });
    expect(result.title).toBe("Operation failed");
  });
});

describe("resolveFriendlyError hook-type remediation", () => {
  it("appends the hook-specific step after the template steps", () => {
    const plain = resolveFriendlyError({
      code: LoopErrorCode.ProcessFailed,
      details: { category: GitGatewayErrorCategory.PreCommitHook },
    });
    const withHook = resolveFriendlyError({
      code: LoopErrorCode.ProcessFailed,
      details: {
        category: GitGatewayErrorCategory.PreCommitHook,
        hookType: GitHookType.Lint,
      },
    });
    expect(withHook.remediation).toEqual([
      ...plain.remediation,
      "Fix the lint errors and run the commit again.",
    ]);
  });

  it("leaves remediation unchanged for an unknown hook type", () => {
    const plain = resolveFriendlyError({
      code: LoopErrorCode.ProcessFailed,
      details: { category: GitGatewayErrorCategory.PreCommitHook },
    });
    const withHook = resolveFriendlyError({
      code: LoopErrorCode.ProcessFailed,
      details: {
        category: GitGatewayErrorCategory.PreCommitHook,
        hookType: "not_a_hook",
      },
    });
    expect(withHook.remediation).toEqual(plain.remediation);
  });
});

describe("resolveFriendlyError code gating", () => {
  it("resolves RUNNER_ERROR to its code copy whatever the result subcode", () => {
    const result = resolveFriendlyError({
      code: LoopErrorCode.RunnerError,
      result: { subcode: "CLAUDE_RATE_LIMIT" },
    });
    expect(result.title).toBe(
      resolveFriendlyError({ code: LoopErrorCode.RunnerError }).title
    );
  });
});

describe("resolveFriendlyError technical details", () => {
  it("carries every supplied field and omits absent ones", () => {
    const details = { category: UNKNOWN_CATEGORY, exitCode: 2 };
    const result = { subcode: "X" };
    expect(
      resolveFriendlyError({
        code: LoopErrorCode.ProcessFailed,
        message: "boom",
        timestamp: "2026-09-28T00:00:00.000Z",
        details,
        result,
      }).technicalDetails
    ).toEqual({
      code: LoopErrorCode.ProcessFailed,
      message: "boom",
      timestamp: "2026-09-28T00:00:00.000Z",
      details,
      result,
    });
  });

  it("drops null inputs from technical details and the top level", () => {
    const output = resolveFriendlyError({
      code: null,
      message: null,
      timestamp: null,
      details: null,
      result: null,
    });
    expect(Object.keys(output.technicalDetails)).toEqual([]);
    expect(output).not.toHaveProperty("code");
    expect(output).not.toHaveProperty("timestamp");
  });
});

describe("resolveFriendlyError template variables", () => {
  // Pins current behavior; looks odd because getTemplateVariables reads
  // action/branch/exitCode/etc. from details, but no template contains a
  // {placeholder}, so those values never reach the rendered copy.
  it("renders the same copy whether or not variable details are present", () => {
    const plain = resolveFriendlyError({ code: LoopErrorCode.GitCloneFailed });
    const withVariables = resolveFriendlyError({
      code: LoopErrorCode.GitCloneFailed,
      details: {
        action: "push",
        binaryName: "git",
        branch: "main",
        exitCode: 128,
        repoFullName: "org/repo",
        repoPath: "repo",
      },
    });
    expect(withVariables.title).toBe(plain.title);
    expect(withVariables.description).toBe(plain.description);
    expect(withVariables.remediation).toEqual(plain.remediation);
  });
});
