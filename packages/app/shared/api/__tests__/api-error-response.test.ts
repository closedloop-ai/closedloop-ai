import { LoopErrorCode } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api-error";
import {
  extractRawErrorMessage,
  parseRawErrorBody,
  throwApiErrorFromResponse,
} from "../api-error-response";

describe("raw API error parsing", () => {
  it("prefers the human error message over code", () => {
    expect(
      extractRawErrorMessage({
        code: LoopErrorCode.ProcessFailed,
        error: "Pre-commit hook failed",
      })
    ).toBe("Pre-commit hook failed");
  });

  it("turns legacy Desktop { error } bodies into ApiError without metadata", async () => {
    const response = new Response(
      JSON.stringify({ error: "Pre-commit hook failed" }),
      { status: 500 }
    );

    await expect(throwApiErrorFromResponse(response)).rejects.toMatchObject({
      message: "Pre-commit hook failed",
      status: 500,
    });
    await expect(
      throwApiErrorFromResponse(
        new Response(JSON.stringify({ error: "Pre-commit hook failed" }), {
          status: 500,
        })
      )
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("preserves new Desktop code/details/timestamp metadata", async () => {
    const response = new Response(
      JSON.stringify({
        code: LoopErrorCode.ProcessFailed,
        details: {
          action: "commit",
          category: "pre_commit_hook",
          stderrExcerpt: "lint failed",
        },
        error: "Pre-commit hook failed",
        timestamp: "2026-05-08T12:00:00.000Z",
      }),
      { status: 500 }
    );

    await expect(throwApiErrorFromResponse(response)).rejects.toMatchObject({
      code: LoopErrorCode.ProcessFailed,
      details: {
        action: "commit",
        category: "pre_commit_hook",
        stderrExcerpt: "lint failed",
      },
      message: "Pre-commit hook failed",
      timestamp: "2026-05-08T12:00:00.000Z",
    });
  });

  it("keeps unknown future metadata as fallback-friendly ApiError data", async () => {
    const response = new Response(
      JSON.stringify({
        code: "NEW_CODE",
        details: { category: "new_category" },
        error: "Future failure",
      }),
      { status: 500 }
    );

    await expect(throwApiErrorFromResponse(response)).rejects.toMatchObject({
      code: "NEW_CODE",
      details: { category: "new_category" },
      message: "Future failure",
    });
  });

  it("preserves error metadata when details is malformed", () => {
    expect(
      parseRawErrorBody({
        code: LoopErrorCode.ProcessFailed,
        details: "not a json object",
        error: "Pre-commit hook failed",
        timestamp: "2026-05-08T12:00:00.000Z",
      })
    ).toEqual({
      code: LoopErrorCode.ProcessFailed,
      error: "Pre-commit hook failed",
      timestamp: "2026-05-08T12:00:00.000Z",
    });
  });
});
