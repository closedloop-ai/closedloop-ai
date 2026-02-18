import { describe, expect, it } from "vitest";
import {
  issueLoopRunnerToken,
  verifyLoopRunnerToken,
} from "@/lib/auth/loop-runner-jwt";

describe("loop-runner-jwt", () => {
  it("issues and verifies a token with jti", async () => {
    process.env.CLOSEDLOOP_RUNNER_JWT_SECRET =
      "test-secret-with-minimum-32-chars-1234";

    const token = await issueLoopRunnerToken({
      loopId: "loop-1",
      organizationId: "org-1",
    });

    const claims = await verifyLoopRunnerToken(token);

    expect(claims.loopId).toBe("loop-1");
    expect(claims.organizationId).toBe("org-1");
    expect(typeof claims.tokenId).toBe("string");
    expect(claims.tokenId.length).toBeGreaterThan(0);
  });
});
