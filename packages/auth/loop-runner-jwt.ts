import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { getRunnerSecret, RUNNER_JWT_SECRET_ENV } from "./runner-jwt-base";

export const AUDIENCE = "closedloop-runner";
export const ISSUER = "closedloop-api";
export const SECRET_ENV = RUNNER_JWT_SECRET_ENV;
export const DEFAULT_TTL_SECONDS = 8 * 60 * 60;
export const DEFAULT_TTL_MS = DEFAULT_TTL_SECONDS * 1000;

function getSecret(): Uint8Array {
  return getRunnerSecret(SECRET_ENV);
}

type LoopRunnerTokenIssueClaims = {
  loopId: string;
  organizationId: string;
};

export type LoopRunnerTokenIssueOverrides = {
  tokenJti?: string;
  issuedAt?: number;
  expiresAt?: number;
};

export type LoopRunnerTokenIssueResult = {
  token: string;
  tokenId: string;
  expiresAt: Date;
};

export type LoopRunnerClaims = {
  loopId: string;
  organizationId: string;
  tokenId: string;
};

export async function issueLoopRunnerToken(
  claims: LoopRunnerTokenIssueClaims,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  overrides?: LoopRunnerTokenIssueOverrides
): Promise<LoopRunnerTokenIssueResult> {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = overrides?.issuedAt ?? now;
  const expiresAtEpoch = overrides?.expiresAt ?? issuedAt + ttlSeconds;
  const tokenId = overrides?.tokenJti ?? randomUUID();

  const token = await new SignJWT({ orgId: claims.organizationId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.loopId)
    .setJti(tokenId)
    .setAudience(AUDIENCE)
    .setIssuer(ISSUER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAtEpoch)
    .sign(getSecret());

  return { token, tokenId, expiresAt: new Date(expiresAtEpoch * 1000) };
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
