import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  refreshDesktopSession: vi.fn(),
  signDesktopPopHeaders: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../src/main/session/desktop-session-client.js", () => ({
  refreshDesktopSession: mocks.refreshDesktopSession,
}));
vi.mock("../src/main/auth/desktop-pop.js", () => ({
  signDesktopPopHeaders: mocks.signDesktopPopHeaders,
}));
vi.mock("../scripts/vibe-profile/launch-env", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../scripts/vibe-profile/launch-env")
  >()),
  resolveElectronBinary: () => "/synthetic/electron",
}));

import {
  generateVibeAuthMaterial,
  writeVibeAuthMaterial,
} from "../scripts/vibe-profile/auth-material";
import { VibeOriginKind } from "../scripts/vibe-profile/origin-policy";
import {
  VIBE_PROFILE_FILE,
  vibeProfilePath,
} from "../scripts/vibe-profile/profile-layout";
import { signInVibeProfile } from "../scripts/vibe-profile/sign-in";

const ORIGINS = {
  apiOrigin: "https://api-stage-git-vibe-bulk-tags.preview.stage.example",
  webOrigin: "https://app-stage-git-vibe-bulk-tags.preview.stage.example",
  originKind: VibeOriginKind.BranchPreview,
};
const TOKENS = {
  accessToken: "access",
  accessTokenExpiresAt: "2026-10-06T16:00:00.000Z",
  refreshToken: "rotated-refresh",
  refreshTokenExpiresAt: "2026-11-06T16:00:00.000Z",
  userId: "0192f0a0-0000-7000-8000-0000000000a1",
  organizationId: "0192f0a0-0000-7000-8000-0000000000b1",
};
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("signInVibeProfile", () => {
  it("refreshes against the preview and writes only encrypted session material", async () => {
    const profile = mkdtempSync(join(tmpdir(), "vibe-sign-in-"));
    dirs.push(profile);
    writeFileSync(vibeProfilePath(profile, VIBE_PROFILE_FILE.Store), "");
    const generated = generateVibeAuthMaterial();
    writeVibeAuthMaterial(profile, generated);
    const warmup = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 405 }));
    vi.stubGlobal("fetch", warmup);
    mocks.signDesktopPopHeaders.mockResolvedValue({ "x-proof": "signed" });
    mocks.refreshDesktopSession.mockImplementation(
      async (input: {
        popSigner: (request: {
          method: string;
          pathname: string;
        }) => Promise<unknown>;
      }) => {
        await input.popSigner({
          method: "POST",
          pathname: "/desktop/session/refresh",
        });
        return { ok: true, value: TOKENS };
      }
    );
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      process.nextTick(() => {
        child.stdout.emit(
          "data",
          Buffer.from('{"session":"cipher","signingKey":"sealed"}\n')
        );
        child.emit("close", 0);
      });
      return child;
    });

    const result = await signInVibeProfile(profile, ORIGINS, () => undefined);

    expect(result).toEqual({
      userId: TOKENS.userId,
      organizationId: TOKENS.organizationId,
    });
    expect(warmup).toHaveBeenCalledWith(
      new URL("/desktop/session/refresh", ORIGINS.apiOrigin),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(mocks.refreshDesktopSession).toHaveBeenCalledWith(
      expect.objectContaining({
        apiOrigin: ORIGINS.apiOrigin,
        refreshToken: generated.material.refreshToken,
      })
    );
    expect(mocks.signDesktopPopHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        pathname: "/desktop/session/refresh",
        gatewayId: generated.material.gatewayId,
        privateKeyPkcs8Pem: generated.privateKeyPkcs8Pem,
      })
    );
    expect(
      readFileSync(vibeProfilePath(profile, VIBE_PROFILE_FILE.Session), "utf8")
    ).toBe('{"encryptedSession":"cipher"}');
    const signingKeys = JSON.parse(
      readFileSync(
        vibeProfilePath(profile, VIBE_PROFILE_FILE.SigningKeys),
        "utf8"
      )
    );
    expect(
      signingKeys.encryptedPrivateKeysByGatewayId[generated.material.gatewayId]
    ).toBe("sealed");
    const settings = JSON.parse(
      readFileSync(vibeProfilePath(profile, VIBE_PROFILE_FILE.Settings), "utf8")
    );
    expect(settings).toMatchObject({
      apiOrigin: ORIGINS.apiOrigin,
      savedConfigs: [
        { name: ORIGINS.apiOrigin, webAppOrigin: ORIGINS.webOrigin },
      ],
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});
