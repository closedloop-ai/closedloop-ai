import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { VIBE_PROFILE_FILE, vibeProfilePath } from "./profile-layout";

/**
 * The part of the auth material the web seed reads (`VibeDesktopAuthMaterial`
 * in apps/api/scripts/vibe-seed/stage.ts): the refresh token the API stores
 * hashed, the SPKI it binds the session to, and the gateway id the Desktop
 * signs as. The private key never enters this file.
 */
export const vibeDesktopAuthMaterialSchema = z
  .object({
    refreshToken: z.string().min(32),
    publicKeySpki: z.string().min(1),
    gatewayId: z.uuid(),
  })
  .strict();
export type VibeDesktopAuthMaterial = z.infer<
  typeof vibeDesktopAuthMaterialSchema
>;

export type GeneratedAuthMaterial = {
  readonly material: VibeDesktopAuthMaterial;
  readonly privateKeyPkcs8Pem: string;
};

/** Owner read/write only: both files are credentials. */
export const AUTH_FILE_MODE = 0o600;

/**
 * Fresh material for one profile. The refresh token has the production shape
 * (`generateRefreshToken` in apps/api/app/desktop/session/service.ts: 32 random
 * bytes, base64url) and the key is Ed25519, the only kind PoP accepts.
 */
export function generateVibeAuthMaterial(): GeneratedAuthMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    material: {
      refreshToken: randomBytes(32).toString("base64url"),
      publicKeySpki: publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      gatewayId: randomUUID(),
    },
    privateKeyPkcs8Pem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  };
}

export function writeVibeAuthMaterial(
  profileDir: string,
  generated: GeneratedAuthMaterial
): { materialPath: string; signingKeyPath: string } {
  const materialPath = vibeProfilePath(
    profileDir,
    VIBE_PROFILE_FILE.AuthMaterial
  );
  const signingKeyPath = vibeProfilePath(
    profileDir,
    VIBE_PROFILE_FILE.SigningKey
  );
  writeFileSync(
    materialPath,
    `${JSON.stringify(generated.material, null, 2)}\n`,
    {
      mode: AUTH_FILE_MODE,
    }
  );
  writeFileSync(signingKeyPath, generated.privateKeyPkcs8Pem, {
    mode: AUTH_FILE_MODE,
  });
  chmodSync(materialPath, AUTH_FILE_MODE);
  chmodSync(signingKeyPath, AUTH_FILE_MODE);
  return { materialPath, signingKeyPath };
}

export function readVibeAuthMaterial(
  profileDir: string
): GeneratedAuthMaterial {
  const material = vibeDesktopAuthMaterialSchema.parse(
    JSON.parse(
      readFileSync(
        vibeProfilePath(profileDir, VIBE_PROFILE_FILE.AuthMaterial),
        "utf8"
      )
    )
  );
  const privateKeyPkcs8Pem = readFileSync(
    vibeProfilePath(profileDir, VIBE_PROFILE_FILE.SigningKey),
    "utf8"
  );
  return { material, privateKeyPkcs8Pem };
}
