import { SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DESKTOP_SESSION_AUDIENCE,
  DESKTOP_SESSION_ISSUER,
  DESKTOP_SESSION_JWT_SECRET_ENV,
  DESKTOP_SESSION_JWT_TYP,
  isDesktopSessionToken,
  issueDesktopAccessToken,
  verifyDesktopAccessToken,
} from "../desktop-session-jwt";
import { RUNNER_JWT_SECRET_ENV } from "../runner-jwt-base";

const TEST_SECRET = "desktop-session-secret-min-32-chars-1234";

const TYP_ERROR = /typ/;
const NOT_CONFIGURED_ERROR = /not configured/;
const TOO_SHORT_ERROR = /at least/;

function secretBytes(secret = TEST_SECRET): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Craft a token with arbitrary header/claim overrides so each negative test can
 * isolate exactly one mismatch (issuer, audience, typ, signature, expiry).
 */
function craftToken(opts: {
  issuer?: string;
  audience?: string;
  typ?: string;
  secret?: string;
  expSeconds?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ orgId: "org-1", sid: "session-1" })
    .setProtectedHeader({
      alg: "HS256",
      typ: opts.typ ?? DESKTOP_SESSION_JWT_TYP,
    })
    .setSubject("user-1")
    .setJti("token-1")
    .setAudience(opts.audience ?? DESKTOP_SESSION_AUDIENCE)
    .setIssuer(opts.issuer ?? DESKTOP_SESSION_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expSeconds ?? 60))
    .sign(secretBytes(opts.secret));
}

describe("desktop-session-jwt", () => {
  let originalSecret: string | undefined;

  beforeAll(() => {
    originalSecret = process.env[DESKTOP_SESSION_JWT_SECRET_ENV];
    process.env[DESKTOP_SESSION_JWT_SECRET_ENV] = TEST_SECRET;
  });

  afterEach(() => {
    process.env[DESKTOP_SESSION_JWT_SECRET_ENV] = TEST_SECRET;
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      Reflect.deleteProperty(process.env, DESKTOP_SESSION_JWT_SECRET_ENV);
    } else {
      process.env[DESKTOP_SESSION_JWT_SECRET_ENV] = originalSecret;
    }
  });

  it("issues and verifies a token round trip", async () => {
    const { token, tokenId, expiresAt } = await issueDesktopAccessToken({
      userId: "user-1",
      organizationId: "org-1",
      sessionId: "session-1",
      gatewayId: "gateway-1",
    });

    const claims = await verifyDesktopAccessToken(token);

    expect(claims.userId).toBe("user-1");
    expect(claims.organizationId).toBe("org-1");
    expect(claims.sessionId).toBe("session-1");
    expect(claims.gatewayId).toBe("gateway-1");
    expect(claims.tokenId).toBe(tokenId);
    expect(claims.expiresAt).toBeGreaterThan(claims.issuedAt);
    expect(expiresAt).toBeInstanceOf(Date);
  });

  it("omits gatewayId when not bound to a device", async () => {
    const { token } = await issueDesktopAccessToken({
      userId: "user-1",
      organizationId: "org-1",
      sessionId: "session-1",
    });

    const claims = await verifyDesktopAccessToken(token);

    expect(claims.gatewayId).toBeUndefined();
  });

  it("defaults to a short access-token TTL", async () => {
    const { token } = await issueDesktopAccessToken({
      userId: "user-1",
      organizationId: "org-1",
      sessionId: "session-1",
    });

    const claims = await verifyDesktopAccessToken(token);

    expect(claims.expiresAt - claims.issuedAt).toBe(
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS
    );
  });

  it("rejects an expired token", async () => {
    const token = await craftToken({ expSeconds: -10 });

    await expect(verifyDesktopAccessToken(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = await craftToken({ issuer: "evil-issuer" });

    await expect(verifyDesktopAccessToken(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await craftToken({ audience: "closedloop-runner" });

    await expect(verifyDesktopAccessToken(token)).rejects.toThrow();
  });

  it("rejects a token with a non-desktop typ", async () => {
    const token = await craftToken({ typ: "JWT" });

    await expect(verifyDesktopAccessToken(token)).rejects.toThrow(TYP_ERROR);
  });

  it("rejects a token with a bad signature", async () => {
    const token = await craftToken({});
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}AAAA`;

    await expect(verifyDesktopAccessToken(tampered)).rejects.toThrow();
  });

  it("rejects a desktop-shaped token signed with a different secret", async () => {
    // Correct iss/aud/typ but signed with foreign key material -> must fail.
    const token = await craftToken({
      secret: "a-totally-different-secret-of-32+chars",
    });

    await expect(verifyDesktopAccessToken(token)).rejects.toThrow();
  });

  it("uses a dedicated secret, never the runner or gateway JWT secret", () => {
    expect(DESKTOP_SESSION_JWT_SECRET_ENV).toBe("DESKTOP_SESSION_JWT_SECRET");
    expect(DESKTOP_SESSION_JWT_SECRET_ENV).not.toBe(RUNNER_JWT_SECRET_ENV);
    expect(DESKTOP_SESSION_JWT_SECRET_ENV).not.toBe("LOCAL_GATEWAY_JWT_SECRET");
  });

  it("fails clearly when the secret is missing", async () => {
    Reflect.deleteProperty(process.env, DESKTOP_SESSION_JWT_SECRET_ENV);

    await expect(
      issueDesktopAccessToken({
        userId: "user-1",
        organizationId: "org-1",
        sessionId: "session-1",
      })
    ).rejects.toThrow(NOT_CONFIGURED_ERROR);
  });

  it("rejects an empty secret", async () => {
    process.env[DESKTOP_SESSION_JWT_SECRET_ENV] = "";

    await expect(
      issueDesktopAccessToken({
        userId: "user-1",
        organizationId: "org-1",
        sessionId: "session-1",
      })
    ).rejects.toThrow(NOT_CONFIGURED_ERROR);
  });

  it("rejects a too-short secret", async () => {
    process.env[DESKTOP_SESSION_JWT_SECRET_ENV] = "too-short";

    await expect(
      issueDesktopAccessToken({
        userId: "user-1",
        organizationId: "org-1",
        sessionId: "session-1",
      })
    ).rejects.toThrow(TOO_SHORT_ERROR);
  });
});

describe("isDesktopSessionToken", () => {
  beforeAll(() => {
    process.env[DESKTOP_SESSION_JWT_SECRET_ENV] = TEST_SECRET;
  });

  it("classifies a freshly issued desktop access token as desktop", async () => {
    const { token } = await issueDesktopAccessToken({
      userId: "user-1",
      organizationId: "org-1",
      sessionId: "session-1",
    });

    expect(isDesktopSessionToken(token)).toBe(true);
  });

  it("classifies by `typ` alone — a desktop-typ token with the wrong issuer/audience is still routed to the desktop verifier", async () => {
    // Classification must be `typ`-only so a desktop-typed token with a bad
    // iss/aud is REJECTED by the verifier rather than falling through to Clerk.
    const token = await craftToken({
      issuer: "evil-issuer",
      audience: "closedloop-runner",
    });

    expect(isDesktopSessionToken(token)).toBe(true);
    await expect(verifyDesktopAccessToken(token)).rejects.toThrow();
  });

  it("does not classify a non-desktop `typ` token as desktop", async () => {
    const token = await craftToken({ typ: "JWT" });

    expect(isDesktopSessionToken(token)).toBe(false);
  });

  it("returns false for malformed or empty tokens without throwing", () => {
    expect(isDesktopSessionToken("not-a-jwt")).toBe(false);
    expect(isDesktopSessionToken("")).toBe(false);
    expect(isDesktopSessionToken("a.b.c")).toBe(false);
  });
});
