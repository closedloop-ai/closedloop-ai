import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  AUTH_FILE_MODE,
  generateVibeAuthMaterial,
  readVibeAuthMaterial,
  vibeDesktopAuthMaterialSchema,
  writeVibeAuthMaterial,
} from "../scripts/vibe-profile/auth-material";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateVibeAuthMaterial", () => {
  it("matches the VibeDesktopAuthMaterial contract exactly", () => {
    const { material } = generateVibeAuthMaterial();
    assert.deepEqual(Object.keys(material).sort(), [
      "gatewayId",
      "publicKeySpki",
      "refreshToken",
    ]);
    assert.deepEqual(vibeDesktopAuthMaterialSchema.parse(material), material);
  });

  it("issues a production-shaped refresh token: 32 random bytes, base64url", () => {
    const { material } = generateVibeAuthMaterial();
    assert.match(material.refreshToken, BASE64URL_RE);
    assert.equal(Buffer.from(material.refreshToken, "base64url").length, 32);
    assert.notEqual(
      material.refreshToken,
      generateVibeAuthMaterial().material.refreshToken
    );
  });

  it("pairs an Ed25519 SPKI with the private key that signs for it", () => {
    const { material, privateKeyPkcs8Pem } = generateVibeAuthMaterial();
    const publicKey = createPublicKey({
      key: Buffer.from(material.publicKeySpki, "base64"),
      format: "der",
      type: "spki",
    });
    assert.equal(publicKey.asymmetricKeyType, "ed25519");
    const message = Buffer.from("POST\n/desktop/session/refresh\n1\ngateway");
    const signature = sign(null, message, createPrivateKey(privateKeyPkcs8Pem));
    assert.equal(verify(null, message, publicKey, signature), true);
  });

  it("refuses material carrying the private key", () => {
    const { material, privateKeyPkcs8Pem } = generateVibeAuthMaterial();
    assert.equal(
      vibeDesktopAuthMaterialSchema.safeParse({
        ...material,
        privateKeyPkcs8Pem,
      }).success,
      false
    );
  });
});

describe("writeVibeAuthMaterial", () => {
  it("writes both files owner-only and reads back what it wrote", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-auth-"));
    dirs.push(dir);
    const generated = generateVibeAuthMaterial();
    const { materialPath, signingKeyPath } = writeVibeAuthMaterial(
      dir,
      generated
    );
    assert.equal(fileMode(materialPath), AUTH_FILE_MODE);
    assert.equal(fileMode(signingKeyPath), AUTH_FILE_MODE);
    assert.deepEqual(readVibeAuthMaterial(dir), generated);
  });
});

/** The permission bits of a file, as `ls -l` shows them. */
function fileMode(filePath: string): number {
  return statSync(filePath).mode % 0o1000;
}
