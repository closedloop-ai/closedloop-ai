import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  TRACER_PRELOAD_TOKENS,
  withoutTracerPreload,
} from "../../../scripts/tracer-preload-tokens.mjs";

// ISS-8174. All three lanes pin `root` to their own directory instead of
// letting it default to `process.cwd()`.
//
// Nothing in a normal run notices: turbo, the package scripts, and a bare
// `pnpm -C apps/api test` all start in this directory, so the default and the
// anchor agree. What notices is a run started somewhere else with `--config`
// naming one of these files — which is exactly how Stryker drives the
// repo-root mutation sandbox. There, `root` became the sandbox root while the
// aliases below it stayed anchored here, so `setupFiles: ["./__tests__/setup.ts"]`
// resolved to a path that did not exist, every collected suite died with
// `Cannot find module`, and the mutation run reported the misleading
// `No tests were found` rather than a failure.
//
// Asserted from a SUBPROCESS launched outside this package (#6077 review).
// Reading `config.root` in-process cannot fail: this suite's own cwd is already
// apps/api, so `process.cwd()` and the anchor return the same string and the
// substitution the anchor exists to prevent stays green. `process.chdir()` is
// not the fix — it is process-wide and would move the cwd out from under every
// sibling test in the worker.
//
// What this does NOT cover: Node's cwd. Vitest's `root` moves module and config
// resolution, not `process.cwd()`, so a suite that reads `join(process.cwd(),
// …)` still resolves against the sandbox root under Stryker. That is a
// different contract, recorded on the ROOT_SANDBOX_PACKAGES entry.
const APP_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const PROBE = path.join(
  APP_ROOT,
  "__tests__",
  "support",
  "vitest-config-root-probe.mts"
);
const PROBE_TIMEOUT_MS = 60_000;

// Somewhere that is neither this package nor the repo, so a cwd-derived root
// would be unmistakably wrong rather than accidentally right.
// realpath because macOS hands out /var/... and a child process reports the
// /private/var/... it resolves to.
const foreignCwd = realpathSync(
  mkdtempSync(path.join(tmpdir(), "vitest-root-anchor-"))
);

afterAll(() => {
  rmSync(foreignCwd, { recursive: true, force: true });
});

// The CI lanes set `NODE_OPTIONS=-r dd-trace/ci/init --import dd-trace/register.js`
// so the tracer instruments Vitest. A `-r`/`--import` specifier is resolved
// against the CHILD's cwd, and this child's cwd is a temp directory with no
// node_modules, so an inherited token becomes `Cannot find module
// 'dd-trace/ci/init'` and the probe never runs. Stripped through the shared
// helper rather than by deleting NODE_OPTIONS outright: other lanes carry a
// load-bearing `--max-old-space-size` in there.
const PROBE_ENV = withoutTracerPreload(process.env);

function rootReportedFrom(
  foreignDirectory: string,
  configName: string
): string {
  return execFileSync(TSX, [PROBE, configName], {
    cwd: foreignDirectory,
    encoding: "utf8",
    env: PROBE_ENV,
    timeout: PROBE_TIMEOUT_MS,
  }).trim();
}

describe("apps/api Vitest configs anchor their own root (ISS-8174)", () => {
  it.each([
    "vitest.config.mts",
    "vitest.config.integration.mts",
    "vitest.config.compatibility.mts",
  ])("%s roots at the package even when launched elsewhere", (configName) => {
    expect(rootReportedFrom(foreignCwd, configName)).toBe(APP_ROOT);
  });

  it("does not hand the child CI's tracer preload, which it cannot resolve", () => {
    // The failure this reproduces is not hypothetical: the first revision
    // inherited NODE_OPTIONS and every case above died in CI with
    // `Cannot find module 'dd-trace/ci/init'` while passing locally, because a
    // developer machine does not set the token. Asserting the stripped env
    // alone would not catch dropping `env: PROBE_ENV` from the spawn, so this
    // runs the probe BOTH ways.
    const poisoned = {
      ...process.env,
      NODE_OPTIONS: `${TRACER_PRELOAD_TOKENS.join(" ")} --max-old-space-size=4096`,
    };

    expect(() =>
      execFileSync(TSX, [PROBE, "vitest.config.mts"], {
        cwd: foreignCwd,
        encoding: "utf8",
        env: poisoned,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PROBE_TIMEOUT_MS,
      })
    ).toThrow();

    // Narrow, not a blanket delete: an unrelated option survives the strip.
    expect(withoutTracerPreload(poisoned).NODE_OPTIONS).toBe(
      "--max-old-space-size=4096"
    );
    expect(
      execFileSync(TSX, [PROBE, "vitest.config.mts"], {
        cwd: foreignCwd,
        encoding: "utf8",
        env: withoutTracerPreload(poisoned),
        timeout: PROBE_TIMEOUT_MS,
      }).trim()
    ).toBe(APP_ROOT);
  });

  it("would notice a cwd-derived root — the probe reports the launch cwd", () => {
    // Guards the guard. If the probe reported the config's own location
    // regardless of how it was launched, the three assertions above would pass
    // against `root: process.cwd()` too, and prove nothing.
    expect(foreignCwd).not.toBe(APP_ROOT);
    expect(
      execFileSync(TSX, ["--eval", "process.stdout.write(process.cwd())"], {
        cwd: foreignCwd,
        encoding: "utf8",
        env: PROBE_ENV,
        timeout: PROBE_TIMEOUT_MS,
      }).trim()
    ).toBe(foreignCwd);
  });
});
