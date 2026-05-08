import { LoopErrorCode } from "@repo/api/src/types/loop";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import { gitStatusOptions } from "@/lib/git/queries";

describe("raw gateway consumers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("propagates structured git gateway errors as ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: LoopErrorCode.ProcessFailed,
              details: {
                action: "commit",
                category: "pre_commit_hook",
                stderrExcerpt: "lint failed",
              },
              error: "Pre-commit hook failed",
            }),
            { status: 500 }
          )
      )
    );

    const queryFn = gitStatusOptions("/repo").queryFn as () => Promise<unknown>;
    await expect(queryFn()).rejects.toMatchObject({
      code: LoopErrorCode.ProcessFailed,
      details: {
        action: "commit",
        category: "pre_commit_hook",
        stderrExcerpt: "lint failed",
      },
      message: "Pre-commit hook failed",
    });
    await expect(queryFn()).rejects.toBeInstanceOf(ApiError);
  });
});
