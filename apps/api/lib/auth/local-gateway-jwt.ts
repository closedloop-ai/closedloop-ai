import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const AUDIENCE = "desktop-local-gateway";
const ISSUER = "closedloop-api";
const MIN_SECRET_LENGTH = 32;
const MIN_UNIQUE_SECRET_CHARS = 8;
const CHALLENGE_TTL_SECONDS = 60;

function getSecret(): Uint8Array {
  const secret = process.env.LOCAL_GATEWAY_JWT_SECRET;
  if (!secret) {
    throw new Error("LOCAL_GATEWAY_JWT_SECRET is not configured");
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `LOCAL_GATEWAY_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`
    );
  }
  if (new Set(secret).size < MIN_UNIQUE_SECRET_CHARS) {
    throw new Error(
      "LOCAL_GATEWAY_JWT_SECRET is too weak (not enough character diversity)"
    );
  }
  return new TextEncoder().encode(secret);
}

export type LocalGatewayChallengeClaims = {
  userId: string;
  orgId: string;
  origin: string;
};

export type LocalGatewayChallengeToken = {
  jwt: string;
  jti: string;
  expiresAt: Date;
};

export type VerifiedLocalGatewayChallenge = {
  jti: string;
  userId: string;
  orgId: string;
  origin: string;
};

export async function issueLocalGatewayChallenge(
  claims: LocalGatewayChallengeClaims
): Promise<LocalGatewayChallengeToken> {
  const now = Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  const exp = now + CHALLENGE_TTL_SECONDS;

  const jwt = await new SignJWT({ orgId: claims.orgId, origin: claims.origin })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setJti(jti)
    .setAudience(AUDIENCE)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(getSecret());

  return { jwt, jti, expiresAt: new Date(exp * 1000) };
}

export async function verifyLocalGatewayChallenge(
  token: string
): Promise<VerifiedLocalGatewayChallenge> {
  const { payload } = await jwtVerify(token, getSecret(), {
    audience: AUDIENCE,
    issuer: ISSUER,
  });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Invalid challenge token: missing sub");
  }
  if (!payload.jti || typeof payload.jti !== "string") {
    throw new Error("Invalid challenge token: missing jti");
  }
  const orgId = payload.orgId;
  if (!orgId || typeof orgId !== "string") {
    throw new Error("Invalid challenge token: missing orgId");
  }
  const origin = payload.origin;
  if (!origin || typeof origin !== "string") {
    throw new Error("Invalid challenge token: missing origin");
  }

  return {
    jti: payload.jti,
    userId: payload.sub,
    orgId,
    origin,
  };
}

export function isLocalGatewayJwtConfigured(): boolean {
  const secret = process.env.LOCAL_GATEWAY_JWT_SECRET;
  return (
    !!secret &&
    secret.length >= MIN_SECRET_LENGTH &&
    new Set(secret).size >= MIN_UNIQUE_SECRET_CHARS
  );
}
