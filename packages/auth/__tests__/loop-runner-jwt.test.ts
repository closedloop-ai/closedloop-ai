import { SignJWT } from "jose";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AUDIENCE,
  ISSUER,
  issueLoopRunnerToken,
  SECRET_ENV,
  verifyLoopRunnerToken,
} from "../loop-runner-jwt";

const TEST_SECRET = "test-secret-with-minimum-32-chars-1234";

describe("loop-runner-jwt", () => {
  let originalSecret: string | undefined;

  beforeAll(() => {
    originalSecret = process.env[SECRET_ENV];
    process.env[SECRET_ENV] = TEST_SECRET;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      Reflect.deleteProperty(process.env, SECRET_ENV);
    } else {
      process.env[SECRET_ENV] = originalSecret;
    }
  });

  it("issues and verifies a token with jti", async () => {
    const result = await issueLoopRunnerToken({
      loopId: "loop-1",
      organizationId: "org-1",
    });

    expect(result.token).toEqual(expect.any(String));
    expect(result.token).not.toHaveLength(0);
    expect(result.tokenId).toEqual(expect.any(String));
    expect(result.tokenId).not.toHaveLength(0);
    expect(result.expiresAt).toBeInstanceOf(Date);

    await expect(verifyLoopRunnerToken(result.token)).resolves.toEqual({
      loopId: "loop-1",
      organizationId: "org-1",
      tokenId: result.tokenId,
    });
  });

  it("returns tokenId that matches the jti in the verified claims", async () => {
    const result = await issueLoopRunnerToken({
      loopId: "loop-round-trip",
      organizationId: "org-round-trip",
    });

    const claims = await verifyLoopRunnerToken(result.token);

    expect(claims.tokenId).toBe(result.tokenId);
  });

  it("produces deterministic output when all overrides are provided", async () => {
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

    expect(result1).toEqual(result2);
  });

  it.each([
    ["missing sub", { jti: "token-1", orgId: "org-1" }],
    ["non-string sub", { sub: 42, jti: "token-1", orgId: "org-1" }],
    ["missing jti", { sub: "loop-1", orgId: "org-1" }],
    ["non-string jti", { sub: "loop-1", jti: 42, orgId: "org-1" }],
    ["missing orgId", { sub: "loop-1", jti: "token-1" }],
    ["non-string orgId", { sub: "loop-1", jti: "token-1", orgId: 42 }],
  ])("rejects a token with %s", async (_label, payload) => {
    const token = await signLoopToken(payload);

    await expect(verifyLoopRunnerToken(token)).rejects.toThrow(
      "Invalid loop runner token"
    );
  });

  it.each([
    ["wrong issuer", { issuer: "other-issuer" }],
    ["wrong audience", { audience: "other-audience" }],
    ["expired", { expiresInSeconds: -1 }],
    ["bad signature", { secret: "different-secret-with-minimum-32-chars" }],
  ])("rejects a token with %s", async (_label, options) => {
    const token = await signLoopToken(
      { sub: "loop-1", jti: "token-1", orgId: "org-1" },
      options
    );

    await expect(verifyLoopRunnerToken(token)).rejects.toThrow();
  });
});

function signLoopToken(
  payload: Record<string, unknown>,
  options: {
    audience?: string;
    expiresInSeconds?: number;
    issuer?: string;
    secret?: string;
  } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 60))
    .sign(new TextEncoder().encode(options.secret ?? TEST_SECRET));
}
