#!/usr/bin/env node
// @ts-check

/**
 * ISS-8326 — the `test:node` entry gate. Fails, named, before either test lane
 * starts when `build:prereqs` has not run. See `assert-test-prereqs-lib.mjs`
 * for what is checked and why the wall of collect errors it replaces was
 * misread as "0 tests".
 *
 * Its own entrypoint rather than a branch inside `run-node-tests.mjs`: that
 * script runs the whole suite on import, so the only way to execute its decision
 * from a test is to let it try, and the state under test — a tree WITHOUT the
 * generated modules — cannot be produced in the tree the suite is running in.
 * A separate entrypoint takes the directory as an argument, so
 * `test/assert-test-prereqs.test.ts` drives this exact file against a synthetic
 * tree and asserts the exit code.
 *
 * REACHED VIA `pnpm assert:test-prereqs`, not via a second `node scripts/…`
 * on the `test:node` command line, and that indirection is load-bearing.
 * `scripts/lint/node-test-lane-coverage.ts`'s `readLocalRunner` takes the FIRST
 * `node <file>` in a script body and reads that file to decide which runner the
 * lane executes — the only reason the desktop suite is visible to the lane
 * registers at all (ISS-4933). Prepending a second `node scripts/…` would make
 * THIS file that first match, and the ~1338-file Vitest lane would silently drop
 * out of both the Vitest and node:test registers.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prerequisiteProblem } from "./assert-test-prereqs-lib.mjs";

const desktopDir =
  process.argv[2] ??
  dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const problem = prerequisiteProblem(desktopDir);
if (problem !== undefined) {
  console.error(problem);
  // `process.exitCode`, not `process.exit()`: stdio is a pipe under CI and an
  // immediate exit can truncate the message this gate exists to deliver.
  process.exitCode = 1;
}
