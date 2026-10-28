/**
 * ISS-4933 — the two desktop main-process pools must read one set of knobs.
 *
 * `test:node` runs Vitest for the census's Vitest set and `tsx --test` for the
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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  laneConcurrencyFor,
  resolveLaneConcurrency,
  resolveNodeCoverageEnabled,
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
  coverage: {
    enabled: boolean;
    provider?: string;
    reportsDirectory?: string;
    include?: unknown;
    reportOnFailure?: boolean;
  };
};

/** Load `vitest.node.config.ts` in a child under `env` and report its knobs. */
function probeNodeConfig(env: NodeJS.ProcessEnv): ProbedConfig {
  return probeConfigKnobs(
    "./vitest.node.config.ts",
    "{ testTimeout: t.testTimeout, hookTimeout: t.hookTimeout, maxWorkers: t.maxWorkers, coverage: t.coverage }",
    env
  ) as ProbedConfig;
}

/**
 * Load one vitest config in a child under `env` and parse the knobs `select`
 * names.
 *
 * The whole `test` object is not printable — `reporters` holds live objects —
 * so each caller names the fields it asks about.
 */
function probeConfigKnobs(
  configFile: string,
  select: string,
  env: NodeJS.ProcessEnv
): unknown {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--input-type=module",
      "-e",
      `const mod = await import(${JSON.stringify(configFile)});const t = mod.default.test;console.log(JSON.stringify(${select}));`,
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
  return JSON.parse(last) as unknown;
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
      "the same file's other knob: vitest.node.config.ts must take its maxWorkers from resolveLaneConcurrency()"
    );
  });
});

/**
 * ISS-7085 — the third knob both pools have to agree on: whether this run
 * collects the Vitest pool's own coverage.
 *
 * The flag is SET by `test:node:coverage` in package.json and READ by
 * `vitest.node.config.ts`, and nothing else connects the two. A rename on
 * either side leaves the lane silently collecting nothing, which is precisely
 * the failure this ticket was filed for — c8 cannot see that pool, so a missing
 * map is not a smaller number, it is 1079 files reported as unreached.
 */
describe("ISS-7085: the Vitest pool's coverage flag", () => {
  it("is off unless the flag is genuinely set", () => {
    assert.equal(resolveNodeCoverageEnabled({}), false);
    // An exported-but-empty variable is what a shell that always exports the
    // name produces; it must not turn the lane on.
    assert.equal(
      resolveNodeCoverageEnabled({ DESKTOP_NODE_COVERAGE: "" }),
      false
    );
    assert.equal(
      resolveNodeCoverageEnabled({ DESKTOP_NODE_COVERAGE: "   " }),
      false
    );
    assert.equal(
      resolveNodeCoverageEnabled({ DESKTOP_NODE_COVERAGE: "0" }),
      false
    );
    // Enumerated rather than left to truthiness: someone turning the lane off
    // by writing the word must not turn it on. This value feeds
    // nodeLaneSelectionHash, so a truthy-by-accident setting would change what
    // the node partitions measure while the identity still claimed the runs
    // were comparable.
    for (const off of ["false", "FALSE", "off", "no"]) {
      assert.equal(
        resolveNodeCoverageEnabled({ DESKTOP_NODE_COVERAGE: off }),
        false,
        `${off} must not enable the lane`
      );
    }
  });

  it("is on for the values the coverage lane actually sets", () => {
    assert.equal(
      resolveNodeCoverageEnabled({ DESKTOP_NODE_COVERAGE: "1" }),
      true
    );
    assert.equal(
      resolveNodeCoverageEnabled({ DESKTOP_NODE_COVERAGE: "true" }),
      true
    );
  });

  it("the config turns coverage on under the flag and off without it", {
    timeout: PROBE_TIMEOUT_MS,
  }, () => {
    const off = probeNodeConfig({ DESKTOP_NODE_COVERAGE: "" });
    assert.equal(
      off.coverage.enabled,
      false,
      "a normal `pnpm test:node` run must not pay for coverage"
    );

    const on = probeNodeConfig({ DESKTOP_NODE_COVERAGE: "1" });
    assert.equal(on.coverage.enabled, true);
  });

  it("declares an EXECUTION-only universe, which is what the node partitions mean", {
    timeout: PROBE_TIMEOUT_MS,
  }, () => {
    const probed = probeNodeConfig({ DESKTOP_NODE_COVERAGE: "1" });

    assert.equal(probed.coverage.provider, "v8");
    assert.equal(probed.coverage.reportsDirectory, "coverage/node-vitest");
    // A measurement lane, not a gate: a failing test must still report what ran.
    assert.equal(probed.coverage.reportOnFailure, true);
    // THE load-bearing absence. Every partition this lane feeds is
    // DenominatorKind.Execution; an all-files `include` (which the RENDERER
    // config sets, because its partition is Source) would silently re-base four
    // partitions' denominators onto the source tree and make every historical
    // comparison a different question.
    assert.equal(
      probed.coverage.include,
      undefined,
      "vitest.node.config.ts must not declare coverage.include — see DenominatorKind in report-coverage-lib.mjs"
    );
  });

  it("package.json's coverage lane sets exactly the variable the config reads", () => {
    const scripts = JSON.parse(
      readFileSync(join(desktopDir, "package.json"), "utf8")
    ).scripts as Record<string, string>;

    // Read the real script string rather than restating the flag: this is the
    // only thing tying the two halves together, so the test has to fail when
    // either side is renamed.
    assert.match(scripts["test:node:coverage"], NODE_COVERAGE_FLAG_PATTERN);
    assert.doesNotMatch(
      scripts["test:node"],
      NODE_COVERAGE_FLAG_PATTERN,
      "the plain node lane must not collect coverage"
    );
  });
});

const NODE_COVERAGE_FLAG_PATTERN = /DESKTOP_NODE_COVERAGE=1/;

/**
 * ISS-9275 — the renderer lane is the resolver's third consumer.
 *
 * It used to declare no width at all, so it took Vitest's default of one worker
 * per core while its main-process sibling capped at four. Every worker there
 * builds a jsdom and mounts the whole desktop shell, and the coverage lane runs
 * on the same 8-core runner, so the 15s `asyncUtilTimeout` the app-shell
 * harness configures bought roughly 2s of progress and `findByRole` gave up on
 * headings that were always going to arrive (ISS-6732; the coverage-main red of
 * 2026-09-05).
 *
 * Asserted against the resolver rather than against a literal, and this one CAN
 * fail for the SSOT reason its main-process neighbour cannot: deleting the
 * config's `maxWorkers` line leaves `undefined` here, which is exactly the
 * unbounded state the lane was in.
 *
 * It pins the WIDTH, not the call. A hardcoded literal that happens to equal
 * the resolver's answer on the running host passes, and would keep passing
 * until the resolver's answer moved. That gap is accepted knowingly: closing it
 * means reading the config's source rather than its resolved value, and the
 * property the 2026-09-05 red was about is the width being bounded and equal to
 * what the other two lanes resolve.
 */
describe("ISS-9275: the renderer lane bounds its width from the shared resolver", () => {
  it("declares the same maxWorkers the main-process pools resolve", {
    timeout: PROBE_TIMEOUT_MS,
  }, () => {
    const probed = probeConfigKnobs(
      "./vitest.renderer.config.ts",
      "{ maxWorkers: t.maxWorkers }",
      {}
    ) as { maxWorkers?: number };

    assert.equal(
      probed.maxWorkers,
      resolveLaneConcurrency(),
      "vitest.renderer.config.ts must declare a maxWorkers equal to the width the shared resolver returns; an undefined width here is Vitest's one-worker-per-core default, which is what made this lane's async budgets unreliable"
    );
  });
});

describe("laneConcurrencyFor (ISS-12047)", () => {
  it("keeps the CI widths: every core up to 4, then 4 through 8 cores", () => {
    assert.deepEqual([1, 3, 4, 8, 9].map(laneConcurrencyFor), [1, 3, 4, 4, 4]);
  });

  it("takes half the machine above 8 cores, capped at 8", () => {
    assert.deepEqual([10, 16, 17, 32].map(laneConcurrencyFor), [5, 8, 8, 8]);
  });
});

describe("resolveTestTimeoutMs", () => {
  it("defaults to 120s when NODE_TEST_TIMEOUT_MS is unset", () => {
    assert.equal(resolveTestTimeoutMs({}), 120_000);
  });

  it("falls back to 120s on a zero NODE_TEST_TIMEOUT_MS", () => {
    assert.equal(resolveTestTimeoutMs({ NODE_TEST_TIMEOUT_MS: "0" }), 120_000);
  });

  it("takes a positive NODE_TEST_TIMEOUT_MS as given", () => {
    assert.equal(
      resolveTestTimeoutMs({ NODE_TEST_TIMEOUT_MS: "45000" }),
      45_000
    );
  });
});
