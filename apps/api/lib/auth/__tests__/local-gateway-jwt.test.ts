import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalGatewayChallengeClaims } from "../local-gateway-jwt";

const VALID_SECRET = "test-secret-with-minimum-32-chars-xyz";
const VALID_CLAIMS: LocalGatewayChallengeClaims = {
  userId: "user-1",
  orgId: "org-1",
  origin: "http://localhost:3000",
};

function loadModule(secret?: string) {
  vi.resetModules();
  vi.doMock("@/env", () => {
    return {
      env: {
        LOCAL_GATEWAY_JWT_SECRET: secret,
      },
    };
  });

  return import("../local-gateway-jwt");
}

describe("local-gateway-jwt", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.unmock("@/env");
  });

  describe("issueLocalGatewayChallenge", () => {
    it("returns a jwt, jti, and a future expiresAt", async () => {
      const { issueLocalGatewayChallenge } = await loadModule(VALID_SECRET);
      const before = new Date();
      const result = await issueLocalGatewayChallenge({
        userId: "user-1",
        orgId: "org-1",
        origin: "http://localhost:3000",
      });

      expect(typeof result.jwt).toBe("string");
      expect(result.jwt.split(".")).toHaveLength(3);
      expect(typeof result.jti).toBe("string");
      expect(result.jti.length).toBeGreaterThan(0);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(before.getTime());
    });

    it("issues a unique jti on each call", async () => {
      const { issueLocalGatewayChallenge } = await loadModule(VALID_SECRET);
      const claims = VALID_CLAIMS;
      const a = await issueLocalGatewayChallenge(claims);
      const b = await issueLocalGatewayChallenge(claims);

      expect(a.jti).not.toBe(b.jti);
    });
  });

  describe("verifyLocalGatewayChallenge", () => {
    it("verifies a valid jwt and returns correct claims", async () => {
      const { issueLocalGatewayChallenge, verifyLocalGatewayChallenge } =
        await loadModule(VALID_SECRET);
      const issued = await issueLocalGatewayChallenge({
        userId: "user-42",
        orgId: "org-99",
        origin: "http://localhost:3000",
      });

      const verified = await verifyLocalGatewayChallenge(issued.jwt);

      expect(verified.userId).toBe("user-42");
      expect(verified.orgId).toBe("org-99");
      expect(verified.origin).toBe("http://localhost:3000");
      expect(verified.jti).toBe(issued.jti);
      expect(verified.expiresAt).toBe(issued.expiresAt.toISOString());
    });

    it("rejects a jwt signed with a different secret", async () => {
      const { issueLocalGatewayChallenge } = await loadModule(VALID_SECRET);
      const issued = await issueLocalGatewayChallenge(VALID_CLAIMS);

      const { verifyLocalGatewayChallenge } = await loadModule(
        "different-secret-with-32-chars-abcde"
      );

      await expect(verifyLocalGatewayChallenge(issued.jwt)).rejects.toThrow();
    });

    it("rejects an expired jwt", async () => {
      const { verifyLocalGatewayChallenge } = await loadModule(VALID_SECRET);
      // Build a token with exp in the past using jose directly
      const secret = new TextEncoder().encode(VALID_SECRET);
      const expiredJwt = await new SignJWT({
        orgId: "org-1",
        origin: "http://localhost:3000",
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("user-1")
        .setJti("some-jti")
        .setAudience("desktop-local-gateway")
        .setIssuer("closedloop-api")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .sign(secret);

      await expect(verifyLocalGatewayChallenge(expiredJwt)).rejects.toThrow();
    });

    it("rejects a structurally invalid token string", async () => {
      const { verifyLocalGatewayChallenge } = await loadModule(VALID_SECRET);
      await expect(verifyLocalGatewayChallenge("not.a.jwt")).rejects.toThrow();
    });

    it("rejects tokens signed with a different algorithm", async () => {
      const { verifyLocalGatewayChallenge } = await loadModule(VALID_SECRET);
      const secret = new TextEncoder().encode(VALID_SECRET);
      const hs512Jwt = await new SignJWT({
        orgId: "org-1",
        origin: "http://localhost:3000",
      })
        .setProtectedHeader({ alg: "HS512" })
        .setSubject("user-1")
        .setJti("hs512-jti")
        .setAudience("desktop-local-gateway")
        .setIssuer("closedloop-api")
        .setIssuedAt(Math.floor(Date.now() / 1000))
        .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
        .sign(secret);

      await expect(verifyLocalGatewayChallenge(hs512Jwt)).rejects.toThrow();
    });
  });

  describe("isLocalGatewayJwtConfigured", () => {
    it("returns true when secret is a valid 32+ char string with diverse characters", () => {
      return loadModule(VALID_SECRET).then(
        ({ isLocalGatewayJwtConfigured }) => {
          expect(isLocalGatewayJwtConfigured()).toBe(true);
        }
      );
    });

    it("returns false when secret is not set", () => {
      return loadModule(undefined).then(({ isLocalGatewayJwtConfigured }) => {
        expect(isLocalGatewayJwtConfigured()).toBe(false);
      });
    });

    it("rejects an invalid short secret", async () => {
      const { issueLocalGatewayChallenge } = await loadModule("short-secret");

      await expect(issueLocalGatewayChallenge(VALID_CLAIMS)).rejects.toThrow(
        "LOCAL_GATEWAY_JWT_SECRET must be at least 32 characters"
      );
    });

    it("rejects a weak secret", async () => {
      const { issueLocalGatewayChallenge } = await loadModule(
        "aaaaaaaabbbbbbbbccccccccaaaaaaaab"
      );

      await expect(issueLocalGatewayChallenge(VALID_CLAIMS)).rejects.toThrow(
        "LOCAL_GATEWAY_JWT_SECRET must include at least 8 unique characters"
      );
    });
  });
});
