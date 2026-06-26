#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
const coverageDir = join(desktopDir, "coverage");
const testDir = join(desktopDir, "test");

// Keep the SQLite baseline equivalence guard in the suite, but outside
// experimental coverage. Linux Node 24.16.0 can hit a native V8 allocator check
// after this WASM-heavy test has already passed.
const coverageExcludedTests = new Set(["prisma-baseline-equivalence.test.ts"]);

const testFiles = readdirSync(testDir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".test.ts") &&
      !coverageExcludedTests.has(entry.name)
  )
  .map((entry) => `test/${entry.name}`)
  .sort();

if (testFiles.length === 0) {
  console.error("[run-covered-node-tests] no test files found");
  process.exit(1);
}

mkdirSync(coverageDir, { recursive: true });

// Run test files in parallel across the runner's cores. node:test isolates each
// file in its own child process, so concurrent files do not share mutable state;
// the previous `--test-concurrency=1` pin serialized the whole suite for no
// correctness benefit (verified: identical pass/fail at 1 vs N). Derive the
// width from the actual machine so it adapts to local dev and CI runners alike.
const testConcurrency = availableParallelism();

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  pnpm,
  [
    "exec",
    "tsx",
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    "--test-coverage-include=../../packages/design-system/**",
    "--test-reporter=lcov",
    "--test-reporter-destination=coverage/lcov.info",
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
  console.error("[run-covered-node-tests] failed to launch test runner");
  console.error(result.error);
  process.exit(1);
}

if (result.signal) {
  console.error(
    `[run-covered-node-tests] test runner exited via ${result.signal}`
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
