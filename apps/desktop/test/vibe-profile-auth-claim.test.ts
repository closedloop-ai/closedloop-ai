import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { VibeProfileCommand } from "../scripts/vibe-profile/args";
import {
  generateVibeAuthMaterial,
  writeVibeAuthMaterial,
} from "../scripts/vibe-profile/auth-material";
import { runVibeProfileCli } from "../scripts/vibe-profile/cli";
import {
  VIBE_PROFILE_FILE,
  vibeProfilePath,
} from "../scripts/vibe-profile/profile-layout";

/** FIPS 180-2 style vector: SHA-256 of these 43 ASCII bytes. */
const KNOWN_TOKEN = "The quick brown fox jumps over the lazy dog";
const KNOWN_TOKEN_SHA256 =
  "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592";
const ALREADY_SIGNED_IN_RE = /already signed in/;
const NO_MATERIAL_RE = /ENOENT/;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function profileWithKnownToken() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-claim-"));
  dirs.push(dir);
  const generated = generateVibeAuthMaterial();
  const material = { ...generated.material, refreshToken: KNOWN_TOKEN };
  writeVibeAuthMaterial(dir, { ...generated, material });
  return { dir, material, privateKeyPkcs8Pem: generated.privateKeyPkcs8Pem };
}

describe("vibe:profile auth-claim", () => {
  it("prints exactly the hash, SPKI and gateway id a preview registers", async () => {
    const { dir, material } = profileWithKnownToken();
    const claim = await runVibeProfileCli([
      VibeProfileCommand.AuthClaim,
      "--profile",
      dir,
    ]);
    assert.deepEqual(claim, {
      refreshTokenHash: KNOWN_TOKEN_SHA256,
      publicKeySpki: material.publicKeySpki,
      gatewayId: material.gatewayId,
    });
  });

  it("never prints the refresh token or the private key", async () => {
    const { dir, privateKeyPkcs8Pem } = profileWithKnownToken();
    const printed = JSON.stringify(
      await runVibeProfileCli([VibeProfileCommand.AuthClaim, "--profile", dir])
    );
    assert.equal(printed.includes(KNOWN_TOKEN), false);
    assert.equal(printed.includes("PRIVATE KEY"), false);
    const keyBody = privateKeyPkcs8Pem.split("\n")[1] ?? "";
    assert.ok(keyBody.length > 0);
    assert.equal(printed.includes(keyBody), false);
  });

  it("refuses a profile that is already signed in", async () => {
    const { dir } = profileWithKnownToken();
    writeFileSync(vibeProfilePath(dir, VIBE_PROFILE_FILE.Session), "{}");
    await assert.rejects(
      runVibeProfileCli([VibeProfileCommand.AuthClaim, "--profile", dir]),
      ALREADY_SIGNED_IN_RE
    );
  });

  it("fails on a profile with no auth material", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-claim-"));
    dirs.push(dir);
    await assert.rejects(
      runVibeProfileCli([VibeProfileCommand.AuthClaim, "--profile", dir]),
      NO_MATERIAL_RE
    );
  });
});
