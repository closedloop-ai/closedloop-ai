import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

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

const LOOPBACK = {
  apiOrigin: "http://localhost:4123",
  webOrigin: "http://localhost:4124",
  originKind: VibeOriginKind.Loopback,
};
const PREVIEW = {
  apiOrigin: "https://api-stage-git-x.preview.stage.example",
  webOrigin: "https://app-stage-git-x.preview.stage.example",
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
const NOT_PREPARED_RE = /is not a prepared vibe profile \(no store\)/;
const ALREADY_SIGNED_IN_RE = /is already signed in/;
const LOOPBACK_DOWN_RE =
  /^the API at http:\/\/localhost:4123 did not answer: connection refused$/;
const NON_ERROR_RE = /did not answer: plain string$/;
const LOOPBACK_HINT_RE =
  /^POST http:\/\/localhost:4123\/desktop\/session\/refresh failed: revoked\. The API needs the desktop-auth seed stage's rows/;
const PREVIEW_HINT_RE =
  /failed: revoked\. The preview needs this profile's `vibe:profile auth-claim`/;
const HELPER_EXIT_RE = /^safe-storage helper exited 2: boom$/;
const HELPER_EMPTY_RE = /^safe-storage helper exited 0: $/;
const SPAWN_ERROR_RE = /spawn EACCES/;
const dirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function profileDir(options: { store?: boolean; session?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vibe-sign-in-12394-"));
  dirs.push(dir);
  if (options.store ?? true) {
    writeFileSync(vibeProfilePath(dir, VIBE_PROFILE_FILE.Store), "");
  }
  if (options.session) {
    writeFileSync(vibeProfilePath(dir, VIBE_PROFILE_FILE.Session), "{}");
  }
  writeVibeAuthMaterial(dir, generateVibeAuthMaterial());
  return dir;
}

function warmupOk() {
  const warmup = vi.fn().mockResolvedValue(new Response(null, { status: 405 }));
  vi.stubGlobal("fetch", warmup);
  return warmup;
}

function refreshOk() {
  mocks.refreshDesktopSession.mockResolvedValue({ ok: true, value: TOKENS });
}

function helperChild(script: (child: FakeChild) => void) {
  mocks.spawn.mockImplementation(() => {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    process.nextTick(() => script(child));
    return child;
  });
}

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};

describe("signInVibeProfile refusals", () => {
  it("refuses a profile with no store before reaching the API", async () => {
    const warmup = warmupOk();
    await expect(
      signInVibeProfile(profileDir({ store: false }), LOOPBACK, () => undefined)
    ).rejects.toThrow(NOT_PREPARED_RE);
    expect(warmup).not.toHaveBeenCalled();
  });

  it("refuses a profile that already holds a session before reaching the API", async () => {
    const warmup = warmupOk();
    await expect(
      signInVibeProfile(
        profileDir({ session: true }),
        LOOPBACK,
        () => undefined
      )
    ).rejects.toThrow(ALREADY_SIGNED_IN_RE);
    expect(warmup).not.toHaveBeenCalled();
  });
});

describe("signInVibeProfile warmup and refresh", () => {
  it("names the API when the warmup request fails, and never refreshes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused"))
    );
    await expect(
      signInVibeProfile(profileDir(), LOOPBACK, () => undefined)
    ).rejects.toThrow(LOOPBACK_DOWN_RE);
    expect(mocks.refreshDesktopSession).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error warmup failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("plain string"));
    await expect(
      signInVibeProfile(profileDir(), LOOPBACK, () => undefined)
    ).rejects.toThrow(NON_ERROR_RE);
  });

  it("gives the loopback warmup five minutes and the preview one", async () => {
    const timeouts: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms: number) => {
        timeouts.push(ms);
        return original(ms);
      });
    const warmup = warmupOk();
    mocks.refreshDesktopSession.mockResolvedValue({
      ok: false,
      error: "revoked",
    });
    try {
      await expect(
        signInVibeProfile(profileDir(), LOOPBACK, () => undefined)
      ).rejects.toThrow(LOOPBACK_HINT_RE);
      await expect(
        signInVibeProfile(profileDir(), PREVIEW, () => undefined)
      ).rejects.toThrow(PREVIEW_HINT_RE);
    } finally {
      timeout.mockRestore();
    }
    expect(warmup).toHaveBeenCalledTimes(2);
    expect(timeouts).toEqual([300_000, 60_000]);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe("signInVibeProfile safe-storage helper", () => {
  it("fails with the helper's stderr on a non-zero exit and writes no session", async () => {
    warmupOk();
    refreshOk();
    helperChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from('{"session":"s","signingKey":"k"}')
      );
      child.stderr.emit("data", Buffer.from("  boom \n"));
      child.emit("close", 2);
    });
    const profile = profileDir();

    await expect(
      signInVibeProfile(profile, LOOPBACK, () => undefined)
    ).rejects.toThrow(HELPER_EXIT_RE);
    expect(
      existsSync(vibeProfilePath(profile, VIBE_PROFILE_FILE.Session))
    ).toBe(false);
  });

  it("fails a zero exit that printed nothing", async () => {
    warmupOk();
    refreshOk();
    helperChild((child) => {
      child.stdout.emit("data", Buffer.from("  \n"));
      child.emit("close", 0);
    });

    await expect(
      signInVibeProfile(profileDir(), LOOPBACK, () => undefined)
    ).rejects.toThrow(HELPER_EMPTY_RE);
  });

  it("rejects a last line that is not the encrypted payload", async () => {
    warmupOk();
    refreshOk();
    helperChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from('{"session":"s","signingKey":"k"}\n{"session":""}\n')
      );
      child.emit("close", 0);
    });
    const profile = profileDir();

    const rejection = await signInVibeProfile(
      profile,
      LOOPBACK,
      () => undefined
    ).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(rejection).toBeInstanceOf(ZodError);
    expect(rejection).toMatchObject({
      issues: [{ path: ["session"] }, { path: ["signingKey"] }],
    });
    expect(
      existsSync(vibeProfilePath(profile, VIBE_PROFILE_FILE.Session))
    ).toBe(false);
  });

  it("rejects when the helper cannot be spawned", async () => {
    warmupOk();
    refreshOk();
    helperChild((child) => {
      child.emit("error", new Error("spawn EACCES"));
    });

    await expect(
      signInVibeProfile(profileDir(), LOOPBACK, () => undefined)
    ).rejects.toThrow(SPAWN_ERROR_RE);
  });

  it("logs the local-stack settings label for loopback origins and returns the account", async () => {
    warmupOk();
    refreshOk();
    helperChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from('noise\n{"session":"cipher","signingKey":"sealed"}\n')
      );
      child.emit("close", 0);
    });
    const logs: string[] = [];

    const result = await signInVibeProfile(profileDir(), LOOPBACK, (line) =>
      logs.push(line)
    );

    expect(result).toEqual({
      userId: TOKENS.userId,
      organizationId: TOKENS.organizationId,
    });
    expect(logs.at(-1)).toBe(
      "wrote the encrypted session, signing key and local-stack settings"
    );
  });
});
