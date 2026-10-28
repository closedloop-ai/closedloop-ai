import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  launchVibeProfile,
  type VibeLaunchCommand,
  type VibeLaunchDeps,
  type VibeLaunchExit,
  VibeStopSignal,
} from "../scripts/vibe-profile/launch";
import { vibeProfileLaunchEnv } from "../scripts/vibe-profile/launch-env";
import {
  DESKTOP_APP_DIR,
  VIBE_PROFILE_FILE,
  vibeProfilePath,
} from "../scripts/vibe-profile/profile-layout";

const ORIGINS = {
  apiOrigin: "https://api-stage-git-feat-x.preview.stage.example",
  webOrigin: "https://app-stage-git-feat-x.preview.stage.example",
};
const NOT_SIGNED_IN_RE = /is not signed in; run vibe:profile sign-in/;
const NO_ELECTRON_RE = /pnpm --filter desktop verify:electron-binary/;
const EXITED_RE = /Desktop exited with code 3/;
const CRASHED_RE = /Desktop exited with code 139/;
const ABORTED_RE = /Desktop exited with code 134/;
const SHELL_CLAUDE_CONFIG_DIR = "/synthetic/shell-claude-config";
const CLEAN_EXIT: VibeLaunchExit = { code: 0, signal: null };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function signedInProfile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-launch-"));
  dirs.push(dir);
  writeFileSync(vibeProfilePath(dir, VIBE_PROFILE_FILE.Session), "{}");
  return dir;
}

function recordingDeps(overrides: Partial<VibeLaunchDeps> = {}): {
  deps: VibeLaunchDeps;
  launches: VibeLaunchCommand[];
} {
  const launches: VibeLaunchCommand[] = [];
  return {
    launches,
    deps: {
      run: (launch) => {
        launches.push(launch);
        return Promise.resolve(CLEAN_EXIT);
      },
      electronBinary: () => "/synthetic/electron",
      baseEnv: {
        PATH: "/synthetic/bin",
        CL_RELAY_ORIGIN: "https://relay",
        CLAUDE_CONFIG_DIR: SHELL_CLAUDE_CONFIG_DIR,
      },
      ...overrides,
    },
  };
}

const noLog = () => undefined;

describe("launchVibeProfile", () => {
  it("runs the browser-bridge dev launcher on the profile with launch-env's environment", async () => {
    const profile = signedInProfile();
    const { deps, launches } = recordingDeps();
    const result = await launchVibeProfile(profile, ORIGINS, deps, noLog);
    const expected = vibeProfileLaunchEnv(profile, ORIGINS);
    const env: NodeJS.ProcessEnv = launches[0]?.env ?? {};
    assert.equal(env.CL_AUTH_API_ORIGIN, ORIGINS.apiOrigin);
    assert.equal(env.CL_WEB_APP_ORIGIN, ORIGINS.webOrigin);
    assert.notEqual(env.CL_RELAY_ORIGIN, "https://relay");
    assert.equal(env.CLAUDE_CONFIG_DIR, expected.env.CLAUDE_CONFIG_DIR);
    assert.notEqual(env.CLAUDE_CONFIG_DIR, SHELL_CLAUDE_CONFIG_DIR);
    assert.deepEqual(result, { exitCode: 0 });
    assert.deepEqual(launches, [
      {
        command: "pnpm",
        args: ["run", "dev:browser", "--", ...expected.args],
        cwd: DESKTOP_APP_DIR,
        env: { PATH: "/synthetic/bin", ...expected.env },
      },
    ]);
  });

  it("refuses a profile that was never signed in, before running anything", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-launch-"));
    dirs.push(dir);
    const { deps, launches } = recordingDeps();
    await assert.rejects(
      launchVibeProfile(dir, ORIGINS, deps, noLog),
      NOT_SIGNED_IN_RE
    );
    assert.deepEqual(launches, []);
  });

  it("names the install command when the Electron binary is missing", async () => {
    const { deps, launches } = recordingDeps({ electronBinary: () => null });
    await assert.rejects(
      launchVibeProfile(signedInProfile(), ORIGINS, deps, noLog),
      NO_ELECTRON_RE
    );
    assert.deepEqual(launches, []);
  });

  it("fails when the Desktop exits non-zero", async () => {
    const { deps } = recordingDeps({
      run: () => Promise.resolve({ code: 3, signal: null }),
    });
    await assert.rejects(
      launchVibeProfile(signedInProfile(), ORIGINS, deps, noLog),
      EXITED_RE
    );
  });

  it("fails when the Desktop dies by a crash signal", async () => {
    const { deps } = recordingDeps({
      run: () => Promise.resolve({ code: null, signal: "SIGSEGV" }),
    });
    await assert.rejects(
      launchVibeProfile(signedInProfile(), ORIGINS, deps, noLog),
      CRASHED_RE
    );
  });

  it("fails on the launcher's crash status that sits beside the stop statuses", async () => {
    const { deps } = recordingDeps({
      run: () => Promise.resolve({ code: 134, signal: null }),
    });
    await assert.rejects(
      launchVibeProfile(signedInProfile(), ORIGINS, deps, noLog),
      ABORTED_RE
    );
  });

  it.each([
    [{ code: 143, signal: null }, VibeStopSignal.Sigterm, 143],
    [{ code: 130, signal: null }, VibeStopSignal.Sigint, 130],
    [{ code: null, signal: "SIGTERM" }, VibeStopSignal.Sigterm, 143],
    [{ code: null, signal: "SIGINT" }, VibeStopSignal.Sigint, 130],
  ] satisfies [VibeLaunchExit, VibeStopSignal, number][])(
    "treats %o as a clean stop",
    async (exit, stoppedBy, exitCode) => {
      const { deps } = recordingDeps({ run: () => Promise.resolve(exit) });
      const result = await launchVibeProfile(
        signedInProfile(),
        ORIGINS,
        deps,
        noLog
      );
      assert.deepEqual(result, { exitCode, stoppedBy });
    }
  );
});
