import { LoopErrorCode } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import { handleLoopServiceError } from "@/app/loops/loop-error-responses";
import { UnauthorizedRepoError } from "@/app/loops/loop-errors";

describe("handleLoopServiceError", () => {
  it("serializes unauthorized repo details as a singular string", async () => {
    const response = handleLoopServiceError(
      new UnauthorizedRepoError(["owner/one", "owner/two"]),
      "Failed to create loop"
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: LoopErrorCode.RepoNotAllowed,
      details: { repoFullName: "owner/one, owner/two" },
      success: false,
    });
  });
});
