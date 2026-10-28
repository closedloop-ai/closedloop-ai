/**
 * ISS-12321 — `scripts/smoke-linux-package.mjs`, the packaged-Linux launch
 * smoke the release and packaging-validation workflows run under xvfb.
 *
 * The happy path needs a packaged Linux Electron binary, which the node lane
 * does not build. The two refusal paths need none, and both are contracts the
 * workflows depend on: a missing executable argument fails loudly instead of
 * passing vacuously, and a failed launch still removes the throwaway HOME the
 * script created. Each case drives the real entrypoint as a subprocess, so c8
 * credits this path to the tooling partition.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = join(DESKTOP_DIR, "scripts", "smoke-linux-package.mjs");
const MISSING_ARGUMENT_PATTERN =
  /Pass the extracted Linux application executable/;
const LAUNCHED_PATTERN = /Linux packaged application launched/;
const LAUNCH_FAILED_PATTERN = /Failed to launch: Error: spawn .* ENOENT/;
const SMOKE_HOME_PREFIX = "closedloop-linux-smoke-";

// spawnSync blocks the worker's event loop, so the case timeout cannot
// interrupt it; the child carries its own deadline.
const SPAWN_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 120_000;

function runSmoke(args: readonly string[], tempRoot: string) {
  const result = spawnSync(process.execPath, [ENTRYPOINT, ...args], {
    cwd: DESKTOP_DIR,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tempRoot },
    killSignal: "SIGKILL",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(
      `smoke-linux-package did not exit: ${result.error.message}`
    );
  }
  return result;
}

// TMPDIR also hosts Playwright's own artifacts dir, so only the script's
// smoke home is the contract here.
function smokeHomes(tempRoot: string): string[] {
  return readdirSync(tempRoot).filter((entry) =>
    entry.startsWith(SMOKE_HOME_PREFIX)
  );
}

function withTempRoot(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "smoke-linux-package-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ISS-12321: smoke-linux-package entrypoint", () => {
  test(
    "refuses to run without an executable argument",
    () => {
      withTempRoot((tempRoot) => {
        const result = runSmoke([], tempRoot);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, MISSING_ARGUMENT_PATTERN);
        assert.deepEqual(smokeHomes(tempRoot), []);
      });
    },
    CASE_TIMEOUT_MS
  );

  test(
    "fails a launch of a missing executable and removes its smoke home",
    () => {
      withTempRoot((tempRoot) => {
        const result = runSmoke(
          [join(tempRoot, "no-such-closedloop-binary")],
          tempRoot
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, LAUNCH_FAILED_PATTERN);
        assert.doesNotMatch(result.stdout, LAUNCHED_PATTERN);
        assert.deepEqual(smokeHomes(tempRoot), []);
      });
    },
    CASE_TIMEOUT_MS
  );
});
