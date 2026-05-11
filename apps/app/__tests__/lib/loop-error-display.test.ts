import { resolveFriendlyError } from "@repo/api/src/types/friendly-error";
import { LoopErrorCode, RunnerErrorSubcode } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import {
  getLoopErrorReason,
  getLoopErrorTitle,
} from "@/lib/loop-error-display";

describe("loop error display", () => {
  it("maps known runner subcodes to user-facing reasons", () => {
    const error = {
      code: LoopErrorCode.RunnerError,
      message: "Claude rate limit reached.",
      result: { subcode: RunnerErrorSubcode.ClaudeRateLimit },
    };

    expect(getLoopErrorReason(error)).toBe("Claude rate limit reached");
    expect(getLoopErrorTitle(error)).toBe("Claude rate limit reached");
  });

  it("formats unknown runner subcodes without hiding the message", () => {
    const error = {
      code: LoopErrorCode.RunnerError,
      message: "Runner failed.",
      result: { subcode: "SOME_NEW_FAILURE" },
    };

    expect(getLoopErrorReason(error)).toBe("Some New Failure");
    expect(getLoopErrorTitle(error)).toBe("Some New Failure");
  });

  it("uses friendly labels for non-runner errors by default", () => {
    const error = {
      code: LoopErrorCode.ContextLimitExceeded,
      message: "Context limit hit.",
    };

    expect(getLoopErrorTitle(error)).toBe("Context limit exceeded");
    expect(getLoopErrorTitle(error, { useFriendlyCodeLabels: false })).toBe(
      "CONTEXT_LIMIT_EXCEEDED"
    );
    expect(getLoopErrorTitle(error, { useFriendlyCodeLabels: true })).toBe(
      "Context limit exceeded"
    );
  });

  it("falls back to the canonical runner label when runner result is malformed", () => {
    const error = {
      code: LoopErrorCode.RunnerError,
      message: "Runner failed.",
      result: { subcode: "" },
    };

    expect(getLoopErrorReason(error)).toBeNull();
    expect(getLoopErrorTitle(error)).toBe(
      resolveFriendlyError({
        code: LoopErrorCode.RunnerError,
        message: error.message,
        result: error.result,
      }).title
    );
  });
});
