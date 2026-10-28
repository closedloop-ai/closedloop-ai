import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  electronPath: "",
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../scripts/vibe-profile/launch-env", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../scripts/vibe-profile/launch-env")
  >()),
  resolveElectronBinary: () => mocks.electronPath,
}));

import {
  defaultVibeLaunchDeps,
  launchVibeProfile,
  type VibeLaunchDeps,
  type VibeLaunchExit,
} from "../scripts/vibe-profile/launch";
import {
  VIBE_PROFILE_FILE,
  vibeProfilePath,
} from "../scripts/vibe-profile/profile-layout";

const ORIGINS = {
  apiOrigin: "http://localhost:4123",
  webOrigin: "http://localhost:4124",
};
const COMMAND = {
  command: "pnpm",
  args: ["run", "dev:browser"],
  cwd: "synthetic-cwd",
  env: { PATH: "/synthetic/bin" },
};
const SPAWN_FAILED_RE = /spawn ENOENT/;
const dirs: string[] = [];

beforeEach(() => {
  mocks.spawn.mockReset();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-launch-12394-"));
  dirs.push(dir);
  return dir;
}

function fakeChild(): EventEmitter {
  const child = new EventEmitter();
  mocks.spawn.mockReturnValue(child);
  return child;
}

describe("defaultVibeLaunchDeps.run", () => {
  it("spawns the command with its cwd and env, child stdout on stderr, and resolves the exit pair", async () => {
    const child = fakeChild();

    const running = defaultVibeLaunchDeps.run(COMMAND);
    child.emit("exit", 3, null);

    await expect(running).resolves.toEqual({ code: 3, signal: null });
    expect(mocks.spawn).toHaveBeenCalledWith("pnpm", ["run", "dev:browser"], {
      cwd: "synthetic-cwd",
      env: { PATH: "/synthetic/bin" },
      stdio: ["inherit", 2, "inherit"],
    });
  });

  it("rejects when the child fails to spawn", async () => {
    const child = fakeChild();

    const running = defaultVibeLaunchDeps.run(COMMAND);
    child.emit("error", new Error("spawn ENOENT"));

    await expect(running).rejects.toThrow(SPAWN_FAILED_RE);
  });
});

describe("defaultVibeLaunchDeps.electronBinary", () => {
  it("returns the resolved binary when the file exists", () => {
    const binary = path.join(tempDir(), "electron");
    writeFileSync(binary, "");
    mocks.electronPath = binary;

    expect(defaultVibeLaunchDeps.electronBinary()).toBe(binary);
  });

  it("returns null when the resolved binary is not on disk", () => {
    mocks.electronPath = path.join(tempDir(), "missing-electron");

    expect(defaultVibeLaunchDeps.electronBinary()).toBeNull();
  });
});

describe("launchVibeProfile exit codes", () => {
  function signedIn(): string {
    const dir = tempDir();
    writeFileSync(vibeProfilePath(dir, VIBE_PROFILE_FILE.Session), "{}");
    return dir;
  }

  function deps(exit: VibeLaunchExit): VibeLaunchDeps {
    return {
      run: () => Promise.resolve(exit),
      electronBinary: () => "/synthetic/electron",
      baseEnv: {},
    };
  }

  it("reports a null code with no signal as generic failure 1", async () => {
    await expect(
      launchVibeProfile(
        signedIn(),
        ORIGINS,
        deps({ code: null, signal: null }),
        () => undefined
      )
    ).rejects.toThrow("Desktop exited with code 1");
  });

  it("reports an unknown signal name as generic failure 1", async () => {
    const unknownSignal: string = "SIGNOTREAL";
    await expect(
      launchVibeProfile(
        signedIn(),
        ORIGINS,
        deps({ code: null, signal: unknownSignal as NodeJS.Signals }),
        () => undefined
      )
    ).rejects.toThrow("Desktop exited with code 1");
  });
});
