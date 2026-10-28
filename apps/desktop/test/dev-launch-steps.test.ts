/**
 * @file dev-launch-steps.test.ts
 * @description ISS-8252 — a dev launch must be able to reuse `dist/` instead of
 * rebuilding it.
 *
 * `build:main:dev` runs `build:main`, whose main compile EMPTIES `dist/main`
 * before re-emitting it, and `dist/main/index.js` is the entry every desktop E2E spec
 * launches. Playwright runs that suite on two workers, so a spec that drives the
 * launcher deletes the entry out from under a spec launching in the other one:
 * on run 33203453180 `session-detail-branch-link` failed with `Cannot find
 * module .../dist/main/index.js` 22s into the sidecar spec, then passed on a
 * retry 4s after the rebuild finished. `--reuse-build` is what keeps a launch
 * from doing that; without it there is no way to drive `dev-launch.mjs` from a
 * spec without destroying the lane around it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  devLaunchBuildSteps,
  REUSE_BUILD_ARG,
} from "../scripts/dev-launch-steps.mjs";

const DESKTOP_ROOT = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
const DEV_LAUNCH = path.join(DESKTOP_ROOT, "scripts/dev-launch.mjs");
/**
 * Generous, because it bounds a process that should spawn NOTHING. A launcher
 * that ignored the flag would run `build:deps` here and blow straight past it.
 */
const PREPARE_ONLY_TIMEOUT_MS = 60_000;

test("an ordinary launch rebuilds the main bundle", () => {
  const steps = devLaunchBuildSteps(["--browser-bridge"]);

  assert.deepEqual(steps.beforeServer, ["build:deps"]);
  assert.deepEqual(steps.afterServer, [
    "prebuild",
    "db:generate",
    "build:main:dev",
  ]);
});

test("--static-renderer adds the renderer build to an ordinary launch", () => {
  const steps = devLaunchBuildSteps(["--static-renderer"]);

  assert.deepEqual(steps.afterServer, [
    "prebuild",
    "db:generate",
    "build:main:dev",
    "build:renderer",
  ]);
});

test("--reuse-build runs no build step, in either position", () => {
  for (const argv of [
    [REUSE_BUILD_ARG],
    ["--browser-bridge", REUSE_BUILD_ARG],
    ["--static-renderer", REUSE_BUILD_ARG],
  ]) {
    const steps = devLaunchBuildSteps(argv);

    assert.deepEqual(
      steps.beforeServer,
      [],
      `${REUSE_BUILD_ARG} still ran a pre-server build for ${argv.join(" ")}`
    );
    assert.deepEqual(
      steps.afterServer,
      [],
      `${REUSE_BUILD_ARG} still ran a post-server build for ${argv.join(" ")} — ` +
        "`build:main:dev` empties dist/main and must never run under it"
    );
  }
});

// The launcher itself, not just the helper: `dev-launch.mjs` starts a Vite
// server and an Electron process on import, so `--prepare-only` is the only
// way to reach its build-step loops and return. Under `--reuse-build` both
// loops are empty, so a correct launcher spawns no child at all and exits 0
// having written nothing. Drop the wiring and it shells out to `build:deps`
// instead, which neither stays silent nor finishes inside the bound.
test("the launcher honors --reuse-build and shells out to nothing", {
  timeout: PREPARE_ONLY_TIMEOUT_MS,
}, async () => {
  const result = await runLauncher([
    "--prepare-only",
    REUSE_BUILD_ARG,
    "--browser-bridge",
  ]);

  assert.equal(result.code, 0, `launcher stderr: ${result.stderr}`);
  assert.equal(
    result.stdout,
    "",
    "a reused-build launch must run no build step"
  );
});

function runLauncher(
  args: readonly string[]
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DEV_LAUNCH, ...args], {
      cwd: DESKTOP_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}
