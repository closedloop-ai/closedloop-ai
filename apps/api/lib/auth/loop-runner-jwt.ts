import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const AUDIENCE = "closedloop-runner";
const ISSUER = "closedloop-api";
const MIN_SECRET_LENGTH = 32;
const MIN_UNIQUE_SECRET_CHARS = 8;

function getSecret(): Uint8Array {
  const secret = process.env.CLOSEDLOOP_RUNNER_JWT_SECRET;
  if (!secret) {
    throw new Error("CLOSEDLOOP_RUNNER_JWT_SECRET is not configured");
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `CLOSEDLOOP_RUNNER_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`
    );
  }
  if (new Set(secret).size < MIN_UNIQUE_SECRET_CHARS) {
    throw new Error(
      "CLOSEDLOOP_RUNNER_JWT_SECRET is too weak (not enough character diversity)"
    );
  }
  return new TextEncoder().encode(secret);
}

export type LoopRunnerTokenIssueClaims = {
  loopId: string;
  organizationId: string;
};

export type LoopRunnerClaims = {
  loopId: string;
  organizationId: string;
  tokenId: string;
};

export function issueLoopRunnerToken(
  claims: LoopRunnerTokenIssueClaims,
  ttlSeconds = 2 * 60 * 60
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ orgId: claims.organizationId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.loopId)
    .setJti(randomUUID())
    .setAudience(AUDIENCE)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(getSecret());
}

export async function verifyLoopRunnerToken(
  token: string
): Promise<LoopRunnerClaims> {
  const { payload } = await jwtVerify(token, getSecret(), {
    audience: AUDIENCE,
    issuer: ISSUER,
  });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Invalid loop runner token: missing sub");
  }
  if (!payload.jti || typeof payload.jti !== "string") {
    throw new Error("Invalid loop runner token: missing jti");
  }
  const orgId = payload.orgId;
  if (!orgId || typeof orgId !== "string") {
    throw new Error("Invalid loop runner token: missing orgId");
  }

  return { loopId: payload.sub, organizationId: orgId, tokenId: payload.jti };
}
