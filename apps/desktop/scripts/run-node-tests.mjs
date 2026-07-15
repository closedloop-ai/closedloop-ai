#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
const testDir = join(desktopDir, "test");

// Keep the SQLite baseline equivalence guard in the suite, but run it
// separately (test:prisma-baseline): Linux Node 24.16.0 can hit a native V8
// allocator check after this WASM-heavy test has already passed.
const excludedTests = new Set(["prisma-baseline-equivalence.test.ts"]);

const testFiles = readdirSync(testDir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".test.ts") &&
      !excludedTests.has(entry.name)
  )
  .map((entry) => `test/${entry.name}`)
  .sort();

if (testFiles.length === 0) {
  console.error("[run-node-tests] no test files found");
  process.exit(1);
}

// Run test files in parallel up to the CI runner shape. node:test isolates each
// file in its own child process, so concurrent files do not share mutable state;
// the previous `--test-concurrency=1` pin serialized the whole suite for no
// correctness benefit (verified: identical pass/fail at 1 vs N). The desktop PR
// gate uses a 4-core runner, and higher local widths create resource pressure
// without improving the serialized renderer/build floor documented in pr-test.
const testConcurrency = Math.min(availableParallelism(), 4);

// Per-test wall-clock cap (FEA-2399). Most tests here run in milliseconds, but
// the gateway-server suite can approach 60s under parallel desktop runs on local
// machines. Keep the cap bounded while leaving enough headroom for legitimate
// slow suites to finish before the job-level timeout. Override with
// NODE_TEST_TIMEOUT_MS if ever needed.
const parsedTestTimeout = Number.parseInt(
  process.env.NODE_TEST_TIMEOUT_MS ?? "",
  10
);
const testTimeoutMs =
  Number.isInteger(parsedTestTimeout) && parsedTestTimeout > 0
    ? parsedTestTimeout
    : 120_000;

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  pnpm,
  [
    "exec",
    "tsx",
    "--test",
    `--test-timeout=${testTimeoutMs}`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-concurrency=${testConcurrency}`,
    ...testFiles,
  ],
  {
    cwd: desktopDir,
    stdio: "inherit",
  }
);

if (result.error) {
  console.error("[run-node-tests] failed to launch test runner");
  console.error(result.error);
  process.exit(1);
}

if (result.signal) {
  console.error(`[run-node-tests] test runner exited via ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
