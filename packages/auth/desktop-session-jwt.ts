import { randomUUID } from "node:crypto";
import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { getRunnerSecret as loadHsSecretFromEnv } from "./runner-jwt-base";

/**
 * First-party desktop session access-token helpers (FEA-1514 / FEA-2215).
 *
 * Desktop access tokens are short-lived HS256 JWTs minted by `apps/api` after a
 * system-browser approval plus a device proof-of-possession exchange. They are
 * deliberately distinct from Clerk bearer tokens and runner JWTs so the central
 * auth resolver (FEA-2217) can preclassify and route them by their `iss`/`aud`/
 * `typ` metadata BEFORE attempting Clerk verification, with no cross-fallthrough.
 *
 * The signing secret is a DEDICATED env var (`DESKTOP_SESSION_JWT_SECRET`). It
 * must never reuse the runner JWT secret, the local-gateway JWT secret, Clerk
 * secrets, API-key material, or webhook secrets. The secret is read and
 * validated at issue/verify time (not at module load) so unrelated imports do
 * not require it to be configured.
 */

export const DESKTOP_SESSION_ISSUER = "closedloop-api";
export const DESKTOP_SESSION_AUDIENCE = "closedloop-desktop";

/**
 * Distinct JWT `typ` header value. The central resolver reads this from the
 * (untrusted but non-secret) protected header to route desktop tokens to the
 * desktop verifier instead of Clerk bearer verification.
 */
export const DESKTOP_SESSION_JWT_TYP = "desktop-session+jwt";

export const DESKTOP_SESSION_JWT_SECRET_ENV = "DESKTOP_SESSION_JWT_SECRET";

/** Access-token TTL. Intentionally short-lived (10-15 min); refresh handles longevity. */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

function getSecret(): Uint8Array {
  return loadHsSecretFromEnv(DESKTOP_SESSION_JWT_SECRET_ENV);
}

export type DesktopAccessTokenIssueClaims = {
  userId: string;
  organizationId: string;
  sessionId: string;
  gatewayId?: string;
};

export type DesktopAccessTokenIssueOverrides = {
  tokenJti?: string;
  issuedAt?: number;
  expiresAt?: number;
};

export type DesktopAccessTokenIssueResult = {
  token: string;
  tokenId: string;
  expiresAt: Date;
};

export type DesktopSessionClaims = {
  userId: string;
  organizationId: string;
  sessionId: string;
  gatewayId?: string;
  tokenId: string;
  issuedAt: number;
  expiresAt: number;
};

/**
 * Mint a desktop session access token. `sub` carries the internal `userId`;
 * `orgId`/`sid` carry the organization and desktop-session ids; `gatewayId` is
 * included only when bound to a specific device/gateway.
 */
export async function issueDesktopAccessToken(
  claims: DesktopAccessTokenIssueClaims,
  ttlSeconds = DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  overrides?: DesktopAccessTokenIssueOverrides
): Promise<DesktopAccessTokenIssueResult> {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = overrides?.issuedAt ?? now;
  const expiresAtEpoch = overrides?.expiresAt ?? issuedAt + ttlSeconds;
  const tokenId = overrides?.tokenJti ?? randomUUID();

  const payload: Record<string, string> = {
    orgId: claims.organizationId,
    sid: claims.sessionId,
  };
  if (claims.gatewayId) {
    payload.gatewayId = claims.gatewayId;
  }

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: DESKTOP_SESSION_JWT_TYP })
    .setSubject(claims.userId)
    .setJti(tokenId)
    .setAudience(DESKTOP_SESSION_AUDIENCE)
    .setIssuer(DESKTOP_SESSION_ISSUER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAtEpoch)
    .sign(getSecret());

  return { token, tokenId, expiresAt: new Date(expiresAtEpoch * 1000) };
}

/**
 * Verify a desktop session access token. Rejects tokens with the wrong issuer,
 * audience, `typ`, expiry, or signature. Does NOT fall back to any other
 * verification scheme — callers route by `typ`/`iss`/`aud` before reaching here.
 */
export async function verifyDesktopAccessToken(
  token: string
): Promise<DesktopSessionClaims> {
  const { payload, protectedHeader } = await jwtVerify(token, getSecret(), {
    audience: DESKTOP_SESSION_AUDIENCE,
    issuer: DESKTOP_SESSION_ISSUER,
  });

  if (protectedHeader.typ !== DESKTOP_SESSION_JWT_TYP) {
    throw new Error("Invalid desktop session token: wrong typ");
  }
  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Invalid desktop session token: missing sub");
  }
  if (!payload.jti || typeof payload.jti !== "string") {
    throw new Error("Invalid desktop session token: missing jti");
  }
  const orgId = payload.orgId;
  if (!orgId || typeof orgId !== "string") {
    throw new Error("Invalid desktop session token: missing orgId");
  }
  const sessionId = payload.sid;
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("Invalid desktop session token: missing sid");
  }
  if (typeof payload.iat !== "number") {
    throw new Error("Invalid desktop session token: missing iat");
  }
  if (typeof payload.exp !== "number") {
    throw new Error("Invalid desktop session token: missing exp");
  }

  const claims: DesktopSessionClaims = {
    userId: payload.sub,
    organizationId: orgId,
    sessionId,
    tokenId: payload.jti,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
  if (typeof payload.gatewayId === "string") {
    claims.gatewayId = payload.gatewayId;
  }
  return claims;
}

/**
 * Non-secret preclassification for the central API auth resolver (FEA-2217).
 *
 * Reads ONLY the unverified protected header and reports whether the bearer
 * token carries the dedicated desktop-session `typ`. Performs NO signature,
 * issuer, audience, or expiry check — that is `verifyDesktopAccessToken`'s job.
 * The resolver uses this to route a token to the desktop verifier BEFORE Clerk
 * verification, with no cross-fallthrough: a token classified here as desktop is
 * verified by the desktop verifier and never retried as a Clerk token, and a
 * token NOT classified here never reaches the desktop verifier.
 *
 * Returns false for any malformed token or any token without the desktop `typ`
 * (Clerk bearer tokens never carry it), so classification cannot throw.
 */
export function isDesktopSessionToken(token: string): boolean {
  try {
    return decodeProtectedHeader(token).typ === DESKTOP_SESSION_JWT_TYP;
  } catch {
    return false;
  }
}
