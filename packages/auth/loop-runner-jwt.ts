import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { getRunnerSecret } from "./runner-jwt-base";

export const AUDIENCE = "closedloop-runner";
export const ISSUER = "closedloop-api";
export const SECRET_ENV = "CLOSEDLOOP_RUNNER_JWT_SECRET";
export const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

function getSecret(): Uint8Array {
  return getRunnerSecret(SECRET_ENV);
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
  ttlSeconds = DEFAULT_TTL_SECONDS
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
