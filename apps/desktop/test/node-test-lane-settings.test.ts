/**
 * ISS-4933 — the two desktop main-process pools must read one set of knobs.
 *
 * `test:node` runs Vitest for the shim-compatible files and `tsx --test` for the
 * remainder, configured in two different files. Both honour
 * `NODE_TEST_TIMEOUT_MS`, and for a while they honoured it DIFFERENTLY: the
 * config's `Number.parseInt(…) || 120_000` only rejects `NaN` and `0`, so
 * `NODE_TEST_TIMEOUT_MS=-5` reached Vitest as `-5` — which Vitest accepts,
 * failing every test on that lane — while `resolveTestTimeoutMs` clamped the
 * legacy lane back to 120s. One suite, one env var, two rules.
 *
 * The assertion has to be made against a config loaded UNDER that env, because
 * both knobs are resolved at module load. So the config is probed in a child
 * process rather than imported here: importing it in-process would only ever
 * observe the ambient environment, and a test that compares
 * `nodeConfig.test.testTimeout` to `resolveTestTimeoutMs()` with no override set
 * stays green against both derivations — they agree on every input except the
 * invalid ones.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolveLaneConcurrency,
  resolveTestTimeoutMs,
} from "../scripts/node-test-lane-settings.mjs";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

/** Spawning node + tsx and loading the config (which censuses `test/`). */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * An override both derivations parse to a number but only one accepts.
 *
 * Not `"abc"`: `Number.parseInt("abc", 10)` is `NaN`, which `||` rejects too, so
 * a non-numeric value would agree under either derivation and prove nothing.
 */
const NEGATIVE_OVERRIDE = "-5";

type ProbedConfig = {
  testTimeout: number;
  hookTimeout: number;
  maxWorkers: number;
};

/** Load `vitest.node.config.ts` in a child under `env` and report its knobs. */
function probeNodeConfig(env: NodeJS.ProcessEnv): ProbedConfig {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--input-type=module",
      "-e",
      'const mod = await import("./vitest.node.config.ts");const t = mod.default.test;console.log(JSON.stringify({ testTimeout: t.testTimeout, hookTimeout: t.hookTimeout, maxWorkers: t.maxWorkers }));',
    ],
    {
      cwd: desktopDir,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: PROBE_TIMEOUT_MS,
    }
  );

  // Thrown, not asserted: a probe that failed to launch or died is a broken
  // harness rather than a failed expectation, and it must surface as that
  // instead of hanging or being read as the config's answer.
  if (result.error !== undefined) {
    throw new Error(
      `failed to spawn the config probe: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `the config probe exited ${result.status}: ${result.stderr}`
    );
  }

  const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error(`the config probe printed nothing: ${result.stderr}`);
  }
  return JSON.parse(last) as ProbedConfig;
}

describe("both main-process pools resolve one set of lane settings", () => {
  it("clamps a negative NODE_TEST_TIMEOUT_MS on the Vitest lane exactly as the legacy lane does", {
    timeout: PROBE_TIMEOUT_MS,
  }, () => {
    const override = { NODE_TEST_TIMEOUT_MS: NEGATIVE_OVERRIDE };
    const probed = probeNodeConfig(override);
    const legacyLaneTimeoutMs = resolveTestTimeoutMs(override);

    // The legacy lane's `--test-timeout` under this env, and the value the
    // shared resolver defines as correct for it.
    assert.equal(legacyLaneTimeoutMs, 120_000);
    assert.equal(
      probed.testTimeout,
      legacyLaneTimeoutMs,
      `NODE_TEST_TIMEOUT_MS=${NEGATIVE_OVERRIDE} gave Vitest ${probed.testTimeout} and the legacy pool ${legacyLaneTimeoutMs} — vitest.node.config.ts must call resolveTestTimeoutMs() rather than re-deriving the value`
    );
    assert.equal(
      probed.hookTimeout,
      probed.testTimeout,
      "hooks and tests share one cap, so a clamp that reaches only one of them is half a fix"
    );
    assert.equal(
      probed.maxWorkers,
      resolveLaneConcurrency(),
      "the same file's other knob, pinned as a value — note this one cannot fail for the SSOT reason, since the inlined `Math.min(availableParallelism(), 4)` and the resolver agree on every input"
    );
  });
});
