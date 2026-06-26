import {
  issueLoopRunnerToken,
  verifyLoopRunnerToken,
} from "@repo/auth/loop-runner-jwt";
import { describe, expect, it } from "vitest";

describe("loop-runner-jwt", () => {
  it("issues and verifies a token with jti", async () => {
    process.env.CLOSEDLOOP_RUNNER_JWT_SECRET =
      "test-secret-with-minimum-32-chars-1234";

    const result = await issueLoopRunnerToken({
      loopId: "loop-1",
      organizationId: "org-1",
    });

    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThan(0);
    expect(typeof result.tokenId).toBe("string");
    expect(result.tokenId.length).toBeGreaterThan(0);
    expect(result.expiresAt).toBeInstanceOf(Date);

    const claims = await verifyLoopRunnerToken(result.token);

    expect(claims.loopId).toBe("loop-1");
    expect(claims.organizationId).toBe("org-1");
    expect(claims.tokenId).toBe(result.tokenId);
  });

  it("returns tokenId that matches the jti in the verified claims", async () => {
    process.env.CLOSEDLOOP_RUNNER_JWT_SECRET =
      "test-secret-with-minimum-32-chars-1234";

    const result = await issueLoopRunnerToken({
      loopId: "loop-round-trip",
      organizationId: "org-round-trip",
    });

    const claims = await verifyLoopRunnerToken(result.token);
    expect(claims.tokenId).toBe(result.tokenId);
  });

  it("produces deterministic output when all overrides are provided", async () => {
    process.env.CLOSEDLOOP_RUNNER_JWT_SECRET =
      "test-secret-with-minimum-32-chars-1234";

    const overrides = {
      tokenJti: "deterministic-jti",
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_028_800,
    };

    const result1 = await issueLoopRunnerToken(
      { loopId: "loop-4", organizationId: "org-4" },
      undefined,
      overrides
    );
    const result2 = await issueLoopRunnerToken(
      { loopId: "loop-4", organizationId: "org-4" },
      undefined,
      overrides
    );

    expect(result1.token).toBe(result2.token);
    expect(result1.tokenId).toBe(result2.tokenId);
    expect(result1.expiresAt).toEqual(result2.expiresAt);
  });
});
