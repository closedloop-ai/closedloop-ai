import { existsSync } from "node:fs";
import { sha256Hex } from "@repo/api/src/definition-fingerprint";
import { readVibeAuthMaterial } from "./auth-material";
import { VIBE_PROFILE_FILE, vibeProfilePath } from "./profile-layout";

/**
 * What a branch preview needs to hold this profile's Desktop session
 * (ISS-12056 decision 5): the refresh token's hash as the API stores it
 * (`hashToken` in apps/api/lib/auth/token-hash.ts, lowercase hex SHA-256 of
 * the UTF-8 bytes), the base64 DER SPKI the session binds to, and the gateway
 * id. Neither lets anyone refresh: that takes the token and the private key,
 * which stay in the profile.
 */
export type VibeAuthClaim = {
  readonly refreshTokenHash: string;
  readonly publicKeySpki: string;
  readonly gatewayId: string;
};

export function vibeProfileAuthClaim(profileDir: string): VibeAuthClaim {
  if (existsSync(vibeProfilePath(profileDir, VIBE_PROFILE_FILE.Session))) {
    throw new Error(
      `${profileDir} is already signed in; its refresh token has rotated past the auth material, so prepare a fresh profile`
    );
  }
  const { material } = readVibeAuthMaterial(profileDir);
  return {
    refreshTokenHash: sha256Hex(material.refreshToken),
    publicKeySpki: material.publicKeySpki,
    gatewayId: material.gatewayId,
  };
}
