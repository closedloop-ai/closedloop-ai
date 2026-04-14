import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

export const AUDIENCE = "closedloop-chat-runner";
export const ISSUER = "closedloop-api";
export const SECRET_ENV = "CLOSEDLOOP_RUNNER_JWT_SECRET";
export const MIN_SECRET_LENGTH = 32;
const MIN_UNIQUE_SECRET_CHARS = 8;
export const DEFAULT_TTL_SECONDS = 4 * 60 * 60;

function getSecret(): Uint8Array {
  const secret = process.env[SECRET_ENV];
  if (!secret) {
    throw new Error(`${SECRET_ENV} is not configured`);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${SECRET_ENV} must be at least ${MIN_SECRET_LENGTH} characters`
    );
  }
  if (new Set(secret).size < MIN_UNIQUE_SECRET_CHARS) {
    throw new Error(
      `${SECRET_ENV} is too weak (not enough character diversity)`
    );
  }
  return new TextEncoder().encode(secret);
}

export type ChatRunnerTokenIssueClaims = {
  userId: string;
  organizationId: string;
  chatKey: string;
  ttlSeconds?: number;
};

export type ChatRunnerClaims = {
  userId: string;
  organizationId: string;
  chatKey: string;
  tokenId: string;
  audience: string;
  issuer: string;
  issuedAt: number;
  expiresAt: number;
};

export function issueChatRunnerToken(
  claims: ChatRunnerTokenIssueClaims
): Promise<string> {
  const ttlSeconds = claims.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    orgId: claims.organizationId,
    chatKey: claims.chatKey,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setJti(randomUUID())
    .setAudience(AUDIENCE)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(getSecret());
}

export async function verifyChatRunnerToken(
  token: string
): Promise<ChatRunnerClaims> {
  const { payload } = await jwtVerify(token, getSecret(), {
    audience: AUDIENCE,
    issuer: ISSUER,
  });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Invalid chat runner token: missing sub");
  }
  if (!payload.jti || typeof payload.jti !== "string") {
    throw new Error("Invalid chat runner token: missing jti");
  }
  const orgId = payload.orgId;
  if (!orgId || typeof orgId !== "string") {
    throw new Error("Invalid chat runner token: missing orgId");
  }
  const chatKey = payload.chatKey;
  if (!chatKey || typeof chatKey !== "string") {
    throw new Error("Invalid chat runner token: missing chatKey");
  }
  if (typeof payload.iat !== "number") {
    throw new Error("Invalid chat runner token: missing iat");
  }
  if (typeof payload.exp !== "number") {
    throw new Error("Invalid chat runner token: missing exp");
  }

  return {
    userId: payload.sub,
    organizationId: orgId,
    chatKey,
    tokenId: payload.jti,
    audience: AUDIENCE,
    issuer: ISSUER,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

export function authenticateChatRunner(
  request: Request
): Promise<ChatRunnerClaims | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Promise.resolve(null);
  }
  const token = authHeader.slice("Bearer ".length);
  if (!token) {
    return Promise.resolve(null);
  }
  return verifyChatRunnerToken(token);
}
