/**
 * Unit tests for validateGitHubOidcToken
 *
 * Verifies:
 * (a) valid token (all claims correct) → returns null
 * (b) expired token → 401
 * (c) signature from a different keypair → 401
 * (d) wrong `repository` claim → 403
 * (e) wrong `aud` claim → 403
 * (f) `job_workflow_ref` not matching cleanup workflow → 403
 * (g) missing `job_workflow_ref` claim → 403
 * (h) missing/malformed `Authorization` header → 401
 *
 * Uses jose.generateKeyPair("RS256") + jose.createLocalJWKSet injected into
 * validateGitHubOidcToken via the jwks option to avoid remote JWKS calls.
 */

import type { KeyLike } from "jose";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

import { validateGitHubOidcToken } from "@/lib/auth/github-oidc-auth";

// ---------------------------------------------------------------------------
// Constants mirroring the implementation
// ---------------------------------------------------------------------------

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "closedloop-preview-schema-cleanup";
const REPOSITORY = "closedloop-ai/symphony-alpha";
const WORKFLOW_REF =
  "closedloop-ai/symphony-alpha/.github/workflows/cleanup-preview-schemas.yml@refs/heads/main";

// ---------------------------------------------------------------------------
// Key setup
// ---------------------------------------------------------------------------

let localJwks: ReturnType<typeof createLocalJWKSet>;
let privateKey: KeyLike;
let differentPrivateKey: KeyLike;

beforeAll(async () => {
  const keypair = await generateKeyPair("RS256");
  privateKey = keypair.privateKey;
  const publicJwk = await exportJWK(keypair.publicKey);
  localJwks = createLocalJWKSet({ keys: [{ ...publicJwk, alg: "RS256" }] });

  const differentKeypair = await generateKeyPair("RS256");
  differentPrivateKey = differentKeypair.privateKey;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRequest(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request("https://api.closedloop.ai/preview-schemas/cleanup", {
    method: "POST",
    headers,
  });
}

async function signToken(
  claims: Record<string, unknown>,
  overrides: {
    issuer?: string;
    audience?: string;
    expirationTime?: string | number;
    signingKey?: KeyLike;
  } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(overrides.expirationTime ?? now + 300)
    .sign(overrides.signingKey ?? privateKey);
}

function validClaims(): Record<string, unknown> {
  return {
    repository: REPOSITORY,
    job_workflow_ref: WORKFLOW_REF,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateGitHubOidcToken", () => {
  it("(a) returns null when all claims are correct", async () => {
    const token = await signToken(validClaims());
    const request = createRequest(`Bearer ${token}`);

    const result = await validateGitHubOidcToken(request, { jwks: localJwks });

    expect(result).toBeNull();
  });

  it("(b) returns 401 for an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(validClaims(), {
      expirationTime: now - 60,
    });
    const request = createRequest(`Bearer ${token}`);

    const result = await validateGitHubOidcToken(request, { jwks: localJwks });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("(c) returns 401 when the token is signed with a different keypair", async () => {
    const token = await signToken(validClaims(), {
      signingKey: differentPrivateKey,
    });
    const request = createRequest(`Bearer ${token}`);

    const result = await validateGitHubOidcToken(request, { jwks: localJwks });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("(d) returns 403 when the repository claim does not match", async () => {
    const token = await signToken({
      ...validClaims(),
      repository: "some-other-org/some-other-repo",
    });
    const request = createRequest(`Bearer ${token}`);

    const result = await validateGitHubOidcToken(request, { jwks: localJwks });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("(e) returns 403 when the aud claim is wrong", async () => {
    const token = await signToken(validClaims(), {
      audience: "wrong-audience",
    });
    const request = createRequest(`Bearer ${token}`);

    const result = await validateGitHubOidcToken(request, { jwks: localJwks });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("(f) returns 403 when job_workflow_ref does not start with the cleanup workflow prefix", async () => {
    const token = await signToken({
      ...validClaims(),
      job_workflow_ref:
        "closedloop-ai/symphony-alpha/.github/workflows/some-other.yml@refs/heads/main",
    });
    const request = createRequest(`Bearer ${token}`);

    const result = await validateGitHubOidcToken(request, { jwks: localJwks });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("(g) returns 403 when job_workflow_ref is missing from the token", async () => {
    const token = await signToken({
      repository: REPOSITORY,
    });
    const request = createRequest(`Bearer ${token}`);

    const result = await validateGitHubOidcToken(request, { jwks: localJwks });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("(h) returns 401 when the Authorization header is missing", async () => {
    const request = createRequest();

    const result = await validateGitHubOidcToken(request, { jwks: localJwks });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("(h) returns 401 when the Authorization header has no Bearer prefix", async () => {
    const request = createRequest("not-a-bearer-token");

    const result = await validateGitHubOidcToken(request, { jwks: localJwks });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("(h) returns 401 when the Bearer token is malformed (not a JWT)", async () => {
    const request = createRequest("Bearer not.a.jwt");

    const result = await validateGitHubOidcToken(request, { jwks: localJwks });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});
