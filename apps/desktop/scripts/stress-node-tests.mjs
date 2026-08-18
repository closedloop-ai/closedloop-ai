#!/usr/bin/env node
// Stress-run a single desktop test file repeatedly to surface non-deterministic
// flakes (e.g. fake-timer/real-async races) that a single pass hides. Used by
// the nightly `desktop-testnode-stress` workflow (FEA-2399) and locally to prove
// a de-flake fix is deterministic before requiring the `desktop` check (FEA-2338).
//
// The runner is the one the census routes that file to (ISS-4934) — see
// `stressLane`.
//
// Config via env:
//   STRESS_FILE  — test file to run, relative to apps/desktop (default: the
//                  historically-flaky ingest-orchestrator suite)
//   STRESS_ITERS — number of iterations (default: 50)
//
// Exits non-zero on the FIRST failing iteration, printing that iteration's full
// output, so CI goes red the moment a flake reproduces.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticGitEnv } from "./hermetic-git-env.mjs";
import { censusTestFiles } from "./node-test-census.mjs";
import {
  positiveIntEnv,
  StressLane,
  stressLane,
} from "./stress-node-tests-lib.mjs";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

const testFile = process.env.STRESS_FILE ?? "test/ingest-orchestrator.test.ts";
const iterations = positiveIntEnv("STRESS_ITERS", 50);
// Per-test timeout handed to node:test so a hung test (e.g. an awaited signal
// that never fires under a real regression) fails fast+loud instead of hanging
// the run. The iteration timeout is an outer safety net on the whole spawned
// process — without it, a hang would silently block the stress tool forever,
// defeating the "surface the flake" purpose.
const testTimeoutMs = positiveIntEnv("STRESS_TEST_TIMEOUT_MS", 60_000);
const iterationTimeoutMs = positiveIntEnv("STRESS_TIMEOUT_MS", 180_000);

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

// ISS-4934: which runner this file belongs to is the census's call, not this
// script's. See stressLane, including why the argv stays here.
const lane = stressLane(testFile, censusTestFiles());
const runnerArgs =
  lane === StressLane.Vitest
    ? [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.node.config.ts",
        // A positional argument is a filename FILTER for Vitest, not a file
        // list, so this run is `include` (the census, same as the real lane)
        // narrowed to one file. A filter matching nothing exits non-zero, which
        // the loop below already reports as a failing iteration.
        `--testTimeout=${testTimeoutMs}`,
        testFile,
      ]
    : ["exec", "tsx", "--test", `--test-timeout=${testTimeoutMs}`, testFile];

console.log(
  `[stress-node-tests] running ${testFile} x${iterations} on the ${lane} lane (cwd=${desktopDir}, test-timeout=${testTimeoutMs}ms, iter-timeout=${iterationTimeoutMs}ms)`
);

const startedAt = process.hrtime.bigint();

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const result = spawnSync(pnpm, runnerArgs, {
    cwd: desktopDir,
    encoding: "utf8",
    timeout: iterationTimeoutMs,
    // ISS-5836, same reason as run-node-tests.mjs: this is the OTHER documented
    // runner, and it spawns its lane itself rather than going through that one.
    // Point STRESS_FILE at a git-heavy suite and the production `git
    // worktree`/`git push` calls under test would otherwise execute whatever
    // hooks the operator's `~/.gitconfig` points `core.hooksPath` at — x50,
    // once per iteration, which is also the run most likely to read a flake off
    // machine state. See hermetic-git-env.mjs.
    env: hermeticGitEnv(),
  });

  // spawnSync sets result.error to an ETIMEDOUT Error (and kills the child)
  // when the iteration timeout trips — treat that as a reproduced hang, not a
  // launch failure.
  if (result.error && result.error.code === "ETIMEDOUT") {
    console.error(
      `[stress-node-tests] FAILED on iteration ${iteration}/${iterations} (timed out after ${iterationTimeoutMs}ms — a hung test)`
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(1);
  }

  if (result.error) {
    console.error(
      `[stress-node-tests] iteration ${iteration}: failed to launch test runner`
    );
    console.error(result.error);
    process.exit(1);
  }

  const failed = result.signal != null || (result.status ?? 1) !== 0;
  if (failed) {
    const reason = result.signal
      ? `signal ${result.signal}`
      : `exit ${result.status}`;
    console.error(
      `[stress-node-tests] FAILED on iteration ${iteration}/${iterations} (${reason})`
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(1);
  }

  // Concise progress: one line per iteration, no per-run test spew on success.
  console.log(`[stress-node-tests] iteration ${iteration}/${iterations} ok`);
}

const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
console.log(
  `[stress-node-tests] ${iterations}/${iterations} iterations passed in ${Math.round(
    elapsedMs
  )}ms`
);
