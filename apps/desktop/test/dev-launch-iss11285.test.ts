/**
 * ISS-11285: the dev launcher's build-step sequencing, driven end to end with a
 * fake `pnpm` on PATH. Every case passes `--prepare-only`, so the launcher
 * never starts Vite (no port, no shared `node_modules/.vite` cache) or Electron.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const DESKTOP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCHER = path.join(DESKTOP_ROOT, "scripts", "dev-launch.mjs");
const LAUNCH_TIMEOUT_MS = 60_000;
const FAKE_PNPM_FAIL_ON = "FAKE_PNPM_FAIL_ON";
const FAKE_PNPM_LOG = "FAKE_PNPM_LOG";

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

/**
 * A `pnpm` stand-in that logs `<args> bridge=<flag>` per call and exits 7 when
 * its script name equals $FAKE_PNPM_FAIL_ON.
 */
function fakePnpmBin(): { binDir: string; logFile: string } {
  const binDir = mkdtempSync(path.join(tmpdir(), "dev-launch-iss11285-"));
  scratchDirs.push(binDir);
  const logFile = path.join(binDir, "calls.log");
  const pnpm = path.join(binDir, "pnpm");
  writeFileSync(
    pnpm,
    [
      "#!/bin/sh",
      `echo "$* bridge=\${VITE_DESKTOP_BROWSER_BRIDGE_ENABLED:-unset}" >> "$${FAKE_PNPM_LOG}"`,
      `if [ "$2" = "$${FAKE_PNPM_FAIL_ON}" ]; then exit 7; fi`,
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(pnpm, 0o755);
  return { binDir, logFile };
}

function launch(args: readonly string[], failOn = "") {
  const { binDir, logFile } = fakePnpmBin();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    [FAKE_PNPM_LOG]: logFile,
    [FAKE_PNPM_FAIL_ON]: failOn,
  };
  Reflect.deleteProperty(env, "VITE_DESKTOP_BROWSER_BRIDGE_ENABLED");
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: DESKTOP_ROOT,
    encoding: "utf8",
    env,
    timeout: LAUNCH_TIMEOUT_MS,
  });
  const calls = existsSync(logFile)
    ? readFileSync(logFile, "utf8").split("\n").filter(Boolean)
    : [];
  return { status: result.status, stdout: result.stdout ?? "", calls };
}

describe("dev-launch build steps", () => {
  it("--prepare-only runs every build step in order and exits 0", {
    timeout: LAUNCH_TIMEOUT_MS,
  }, () => {
    const result = launch(["--prepare-only"]);

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "run build:deps bridge=unset",
      "run prebuild bridge=unset",
      "run db:generate bridge=unset",
      "run build:main:dev bridge=unset",
    ]);
  });

  it("--browser-bridge enables the bridge flag for the steps and --static-renderer adds the renderer build", {
    timeout: LAUNCH_TIMEOUT_MS,
  }, () => {
    const result = launch([
      "--prepare-only",
      "--browser-bridge",
      "--static-renderer",
    ]);

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "run build:deps bridge=1",
      "run prebuild bridge=1",
      "run db:generate bridge=1",
      "run build:main:dev bridge=1",
      "run build:renderer bridge=1",
    ]);
    // The client URL is printed only after Electron spawns; prepare-only never does.
    expect(result.stdout).not.toContain("Desktop browser URL:");
  });

  it("a failing step exits the launcher with that step's status and runs nothing after it", {
    timeout: LAUNCH_TIMEOUT_MS,
  }, () => {
    const result = launch(["--prepare-only"], "build:deps");

    expect(result.status).toBe(7);
    expect(result.calls).toEqual(["run build:deps bridge=unset"]);
  });
});
