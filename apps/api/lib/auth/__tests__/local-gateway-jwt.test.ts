import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isLocalGatewayJwtConfigured,
  issueLocalGatewayChallenge,
  verifyLocalGatewayChallenge,
} from "../local-gateway-jwt";

const VALID_SECRET = "test-secret-with-minimum-32-chars-xyz";

describe("local-gateway-jwt", () => {
  beforeEach(() => {
    process.env.LOCAL_GATEWAY_JWT_SECRET = VALID_SECRET;
  });

  afterEach(() => {
    process.env.LOCAL_GATEWAY_JWT_SECRET = undefined;
  });

  describe("issueLocalGatewayChallenge", () => {
    it("returns a jwt, jti, and a future expiresAt", async () => {
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
      const claims = {
        userId: "user-1",
        orgId: "org-1",
        origin: "http://localhost:3000",
      };
      const a = await issueLocalGatewayChallenge(claims);
      const b = await issueLocalGatewayChallenge(claims);

      expect(a.jti).not.toBe(b.jti);
    });
  });

  describe("verifyLocalGatewayChallenge", () => {
    it("verifies a valid jwt and returns correct claims", async () => {
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
    });

    it("rejects a jwt signed with a different secret", async () => {
      const issued = await issueLocalGatewayChallenge({
        userId: "user-1",
        orgId: "org-1",
        origin: "http://localhost:3000",
      });

      process.env.LOCAL_GATEWAY_JWT_SECRET =
        "different-secret-with-32-chars-abcde";

      await expect(verifyLocalGatewayChallenge(issued.jwt)).rejects.toThrow();
    });

    it("rejects an expired jwt", async () => {
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
      await expect(verifyLocalGatewayChallenge("not.a.jwt")).rejects.toThrow();
    });
  });

  describe("isLocalGatewayJwtConfigured", () => {
    it("returns true when secret is a valid 32+ char string with diverse characters", () => {
      process.env.LOCAL_GATEWAY_JWT_SECRET = VALID_SECRET;
      expect(isLocalGatewayJwtConfigured()).toBe(true);
    });

    it("returns false when secret is not set", () => {
      process.env.LOCAL_GATEWAY_JWT_SECRET = undefined;
      expect(isLocalGatewayJwtConfigured()).toBe(false);
    });

    it("returns false when secret is shorter than 32 characters", () => {
      process.env.LOCAL_GATEWAY_JWT_SECRET = "short-secret";
      expect(isLocalGatewayJwtConfigured()).toBe(false);
    });

    it("returns false when secret lacks character diversity (< 8 unique chars)", () => {
      // 32 chars but only 3 unique characters
      process.env.LOCAL_GATEWAY_JWT_SECRET =
        "aaaaaaaabbbbbbbbccccccccaaaaaaaab";
      expect(isLocalGatewayJwtConfigured()).toBe(false);
    });
  });
});
