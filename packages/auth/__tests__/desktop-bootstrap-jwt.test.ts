import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_BOOTSTRAP_TTL_SECONDS,
  isDesktopBootstrapToken,
  issueDesktopBootstrapToken,
  verifyDesktopBootstrapToken,
} from "../desktop-bootstrap-jwt";
import {
  DESKTOP_SESSION_JWT_SECRET_ENV,
  isDesktopSessionToken,
  issueDesktopAccessToken,
  verifyDesktopAccessToken,
} from "../desktop-session-jwt";

const TEST_SECRET = "desktop-bootstrap-secret-min-32-chars";

describe("desktop-bootstrap-jwt", () => {
  let originalSecret: string | undefined;

  beforeAll(() => {
    originalSecret = process.env[DESKTOP_SESSION_JWT_SECRET_ENV];
    process.env[DESKTOP_SESSION_JWT_SECRET_ENV] = TEST_SECRET;
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      Reflect.deleteProperty(process.env, DESKTOP_SESSION_JWT_SECRET_ENV);
    } else {
      process.env[DESKTOP_SESSION_JWT_SECRET_ENV] = originalSecret;
    }
  });

  it("round-trips only the pending-user and device binding", async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const { token } = await issueDesktopBootstrapToken({
      bootstrapId: "bootstrap-1",
      clerkUserId: "clerk-user-1",
      gatewayId: "gateway-1",
      issuedAt,
    });
    const claims = await verifyDesktopBootstrapToken(token);

    expect(claims).toEqual({
      bootstrapId: "bootstrap-1",
      clerkUserId: "clerk-user-1",
      gatewayId: "gateway-1",
      issuedAt,
      expiresAt: issuedAt + DEFAULT_DESKTOP_BOOTSTRAP_TTL_SECONDS,
    });
    expect(isDesktopBootstrapToken(token)).toBe(true);
    expect(isDesktopSessionToken(token)).toBe(false);
  });

  it("rejects each credential at the other verifier despite sharing the signing secret", async () => {
    const bootstrap = await issueDesktopBootstrapToken({
      bootstrapId: "bootstrap-1",
      clerkUserId: "clerk-user-1",
      gatewayId: "gateway-1",
    });
    const access = await issueDesktopAccessToken({
      userId: "user-1",
      organizationId: "org-1",
      sessionId: "session-1",
      gatewayId: "gateway-1",
    });

    await expect(
      verifyDesktopBootstrapToken(bootstrap.token)
    ).resolves.toBeDefined();
    await expect(verifyDesktopAccessToken(access.token)).resolves.toBeDefined();
    await expect(verifyDesktopAccessToken(bootstrap.token)).rejects.toThrow();
    await expect(verifyDesktopBootstrapToken(access.token)).rejects.toThrow();
  });
});
