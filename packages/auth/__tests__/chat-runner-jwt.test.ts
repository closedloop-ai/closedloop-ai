import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AUDIENCE,
  authenticateChatRunner,
  ISSUER,
  issueChatRunnerToken,
  verifyChatRunnerToken,
} from "../chat-runner-jwt";

const TEST_SECRET = "test-secret-with-minimum-32-chars-1234";

function getSecretBytes(): Uint8Array {
  return new TextEncoder().encode(TEST_SECRET);
}

function signWithAudience(audience: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ orgId: "org-1", chatKey: "chat-1" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setJti("token-1")
    .setAudience(audience)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(getSecretBytes());
}

describe("chat-runner-jwt", () => {
  beforeAll(() => {
    process.env.CLOSEDLOOP_RUNNER_JWT_SECRET = TEST_SECRET;
  });

  it("issues and verifies a token round trip", async () => {
    const token = await issueChatRunnerToken({
      userId: "user-1",
      organizationId: "org-1",
      chatKey: "chat-1",
    });

    const claims = await verifyChatRunnerToken(token);

    expect(claims.userId).toBe("user-1");
    expect(claims.organizationId).toBe("org-1");
    expect(claims.chatKey).toBe("chat-1");
    expect(claims.audience).toBe(AUDIENCE);
    expect(claims.issuer).toBe(ISSUER);
    expect(typeof claims.tokenId).toBe("string");
    expect(claims.tokenId.length).toBeGreaterThan(0);
    expect(claims.expiresAt).toBeGreaterThan(claims.issuedAt);
  });

  it("rejects an expired token", async () => {
    const token = await issueChatRunnerToken({
      userId: "user-1",
      organizationId: "org-1",
      chatKey: "chat-1",
      ttlSeconds: -10,
    });

    await expect(verifyChatRunnerToken(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await signWithAudience("closedloop-runner");

    await expect(verifyChatRunnerToken(token)).rejects.toThrow();
  });

  it("rejects a token with a bad signature", async () => {
    const token = await issueChatRunnerToken({
      userId: "user-1",
      organizationId: "org-1",
      chatKey: "chat-1",
    });
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}AAAA`;

    await expect(verifyChatRunnerToken(tampered)).rejects.toThrow();
  });

  it("authenticateChatRunner returns null when the Authorization header is missing", async () => {
    const request = new Request("https://example.test/chat", {
      method: "POST",
    });

    const result = await authenticateChatRunner(request);

    expect(result).toBeNull();
  });

  it("authenticateChatRunner returns claims for a valid bearer token", async () => {
    const token = await issueChatRunnerToken({
      userId: "user-2",
      organizationId: "org-2",
      chatKey: "chat-2",
    });
    const request = new Request("https://example.test/chat", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    const claims = await authenticateChatRunner(request);

    expect(claims).not.toBeNull();
    expect(claims?.userId).toBe("user-2");
    expect(claims?.chatKey).toBe("chat-2");
  });

  it("authenticateChatRunner throws on a bad bearer token", async () => {
    const request = new Request("https://example.test/chat", {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-jwt" },
    });

    await expect(authenticateChatRunner(request)).rejects.toThrow();
  });
});
