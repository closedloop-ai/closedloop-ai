import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { errorResponse } from "@/lib/route-utils";

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

/**
 * Extract a Bearer token from the Authorization header.
 * Returns the token string on success, or a 401 Response on failure.
 */
export function extractBearerToken(request: Request): string | Response {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  if (!token) {
    return errorResponse(
      "Missing runner token",
      new Error("Unauthorized"),
      401
    );
  }
  return token;
}

type LoopRunnerAuthResult =
  | { ok: true; claims: LoopRunnerClaims }
  | { ok: false; response: Response };

/**
 * Authenticate a loop runner request: extract bearer token, verify JWT,
 * and cross-check the loopId claim against the URL param.
 *
 * Returns a result object so callers avoid duplicating try/catch + early-return.
 */
export async function authenticateLoopRunner(
  request: Request,
  loopId: string
): Promise<LoopRunnerAuthResult> {
  const token = extractBearerToken(request);
  if (token instanceof Response) {
    return { ok: false, response: token };
  }
  let claims: LoopRunnerClaims;
  try {
    claims = await verifyLoopRunnerToken(token);
  } catch (jwtError) {
    return {
      ok: false,
      response: errorResponse("Invalid or expired runner token", jwtError, 401),
    };
  }
  if (claims.loopId !== loopId) {
    return {
      ok: false,
      response: errorResponse(
        "Token does not match loop",
        new Error("Forbidden"),
        403
      ),
    };
  }
  return { ok: true, claims };
}
