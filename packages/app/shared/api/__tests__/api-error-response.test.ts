import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api-error";
import {
  extractRawErrorMessage,
  parseRawErrorBody,
  serverErrorMessage,
  throwApiErrorFromResponse,
} from "../api-error-response";
import { createApiClient } from "../create-api-client";

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

/**
 * ISS-11741: the Google import toast shows the server's own message and no
 * description when there is none, so the message is read from failures the
 * real API client throws, not from `ApiError`s built by hand.
 */
describe("serverErrorMessage", () => {
  async function rejectionFor(response: Response): Promise<unknown> {
    const client = createApiClient({
      deploymentId: null,
      doFetch: () => Promise.resolve(response),
      getToken: () => Promise.resolve("token"),
      honorsAbortSignal: true,
      orgId: "org-1",
      resolveApiOrigin: () => "https://api.example.test",
      userId: "user-1",
      waitForAuthLoaded: () => Promise.resolve(),
    });
    return await client.post("/integrations/google/import", {}).then(
      () => {
        throw new Error("expected the request to fail");
      },
      (error: unknown) => error
    );
  }

  it("returns the error the server sent", async () => {
    const error = await rejectionFor(
      new Response(
        JSON.stringify({ error: "Drive folder not found", success: false }),
        { status: 404 }
      )
    );

    expect(serverErrorMessage(error)).toBe("Drive folder not found");
  });

  it("returns nothing for a failed response without an error field", async () => {
    const error = await rejectionFor(
      new Response(JSON.stringify({ success: false }), { status: 500 })
    );

    expect((error as ApiError).message).toBe("API request failed");
    expect(serverErrorMessage(error)).toBeUndefined();
  });

  it("returns nothing for a non-JSON failure", async () => {
    const error = await rejectionFor(
      new Response("<html>Bad gateway</html>", { status: 502 })
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(serverErrorMessage(error)).toBeUndefined();
  });

  it("returns nothing for an error that is not an ApiError", () => {
    expect(
      serverErrorMessage(new TypeError("Failed to fetch"))
    ).toBeUndefined();
  });
});
