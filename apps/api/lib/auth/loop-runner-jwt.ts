import { jwtVerify, SignJWT } from "jose";

const AUDIENCE = "closedloop-runner";
const ISSUER = "closedloop-api";

function getSecret(): Uint8Array {
  const secret = process.env.CLOSEDLOOP_RUNNER_JWT_SECRET;
  if (!secret) {
    throw new Error("CLOSEDLOOP_RUNNER_JWT_SECRET is not configured");
  }
  return new TextEncoder().encode(secret);
}

export type LoopRunnerClaims = {
  loopId: string;
  organizationId: string;
};

export function issueLoopRunnerToken(
  claims: LoopRunnerClaims,
  ttlSeconds = 2 * 60 * 60
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ orgId: claims.organizationId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.loopId)
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
  const orgId = payload.orgId;
  if (!orgId || typeof orgId !== "string") {
    throw new Error("Invalid loop runner token: missing orgId");
  }

  return { loopId: payload.sub, organizationId: orgId };
}
