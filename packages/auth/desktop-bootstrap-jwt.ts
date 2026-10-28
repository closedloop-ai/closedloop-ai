import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { getRunnerSecret as loadHsSecretFromEnv } from "./runner-jwt-base";

export const DESKTOP_BOOTSTRAP_ISSUER = "closedloop-api";
export const DESKTOP_BOOTSTRAP_AUDIENCE = "closedloop-desktop-bootstrap";
export const DESKTOP_BOOTSTRAP_JWT_TYP = "desktop-bootstrap+jwt";
export const DEFAULT_DESKTOP_BOOTSTRAP_TTL_SECONDS = 5 * 60;

type DesktopBootstrapClaims = {
  bootstrapId: string;
  clerkUserId: string;
  gatewayId: string;
  issuedAt: number;
  expiresAt: number;
};

export async function issueDesktopBootstrapToken(input: {
  bootstrapId: string;
  clerkUserId: string;
  gatewayId: string;
  issuedAt?: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + DEFAULT_DESKTOP_BOOTSTRAP_TTL_SECONDS;
  const token = await new SignJWT({ gatewayId: input.gatewayId })
    .setProtectedHeader({ alg: "HS256", typ: DESKTOP_BOOTSTRAP_JWT_TYP })
    .setSubject(input.clerkUserId)
    .setJti(input.bootstrapId)
    .setAudience(DESKTOP_BOOTSTRAP_AUDIENCE)
    .setIssuer(DESKTOP_BOOTSTRAP_ISSUER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(loadHsSecretFromEnv("DESKTOP_SESSION_JWT_SECRET"));
  return { token, expiresAt: new Date(expiresAt * 1000) };
}

export async function verifyDesktopBootstrapToken(
  token: string
): Promise<DesktopBootstrapClaims> {
  const { payload, protectedHeader } = await jwtVerify(
    token,
    loadHsSecretFromEnv("DESKTOP_SESSION_JWT_SECRET"),
    {
      audience: DESKTOP_BOOTSTRAP_AUDIENCE,
      issuer: DESKTOP_BOOTSTRAP_ISSUER,
    }
  );
  if (protectedHeader.typ !== DESKTOP_BOOTSTRAP_JWT_TYP) {
    throw new Error("Invalid desktop bootstrap token: wrong typ");
  }
  if (!(payload.sub && payload.jti && typeof payload.gatewayId === "string")) {
    throw new Error("Invalid desktop bootstrap token: missing claims");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("Invalid desktop bootstrap token: missing timestamps");
  }
  return {
    bootstrapId: payload.jti,
    clerkUserId: payload.sub,
    gatewayId: payload.gatewayId,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

export function isDesktopBootstrapToken(token: string): boolean {
  try {
    return decodeProtectedHeader(token).typ === DESKTOP_BOOTSTRAP_JWT_TYP;
  } catch {
    return false;
  }
}
