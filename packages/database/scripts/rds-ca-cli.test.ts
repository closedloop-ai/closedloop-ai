import { expect, test } from "vitest";
import {
  readStatusJsonPath,
  shouldCheck,
  shouldRunMain,
  statusExitCode,
} from "./rds-ca-cli";
import { RdsCaBundleStatus } from "./rds-ca-status.js";

/*
 * The operator-facing CLI contract for the RDS CA drift check. Extracted from
 * `generate-rds-ca-bundle.ts` so these branches can be exercised without
 * invoking `main`, which fetches from AWS and calls `process.exit`.
 */

const NODE = "/usr/bin/node";
const SCRIPT = "/repo/packages/database/scripts/generate-rds-ca-bundle.ts";

test("RDS CA exit code distinguishes drift from a failed check", () => {
  // The whole point of the three-way split: CI must be able to tell "AWS
  // rotated the CA, regenerate" (2) from "the check could not run" (1).
  expect(statusExitCode(RdsCaBundleStatus.Match)).toBe(0);
  expect(statusExitCode(RdsCaBundleStatus.Drift)).toBe(2);
  expect(statusExitCode(RdsCaBundleStatus.FetchFailed)).toBe(1);
  expect(statusExitCode(RdsCaBundleStatus.InvalidBundle)).toBe(1);
  expect(statusExitCode(RdsCaBundleStatus.UnexpectedFailure)).toBe(1);
});

test("RDS CA exit code never collapses drift into success", () => {
  // A regression that returned 0 for drift would make the scheduled check
  // green while the embedded bundle silently went stale.
  expect(statusExitCode(RdsCaBundleStatus.Drift)).not.toBe(0);
});

test("RDS CA status-json path is read from the argument after the flag", () => {
  expect(
    readStatusJsonPath([NODE, SCRIPT, "--status-json", "out/status.json"])
  ).toBe("out/status.json");
});

test("RDS CA status-json path is undefined when the flag is absent", () => {
  expect(readStatusJsonPath([NODE, SCRIPT])).toBeUndefined();
  expect(readStatusJsonPath([NODE, SCRIPT, "--check"])).toBeUndefined();
});

test("RDS CA status-json REFUSES the flag without a path", () => {
  // Failing closed matters here: silently skipping the write would leave the
  // caller reading a stale status file, or none, as if the check had passed.
  expect(() => readStatusJsonPath([NODE, SCRIPT, "--status-json"])).toThrow(
    "--status-json requires an output path"
  );
});

test("RDS CA status-json refuses an empty path argument", () => {
  expect(() => readStatusJsonPath([NODE, SCRIPT, "--status-json", ""])).toThrow(
    "--status-json requires an output path"
  );
});

test("RDS CA check flag is detected anywhere in argv", () => {
  expect(shouldCheck([NODE, SCRIPT, "--check"])).toBe(true);
  expect(shouldCheck([NODE, SCRIPT, "--status-json", "x", "--check"])).toBe(
    true
  );
  expect(shouldCheck([NODE, SCRIPT])).toBe(false);
});

test("RDS CA main runs only when the script is the entry point", () => {
  expect(shouldRunMain([NODE, SCRIPT])).toBe(true);
  // Imported by a test or another module rather than executed directly --
  // running `main` here would fetch from AWS and call process.exit.
  expect(shouldRunMain([NODE, "/repo/node_modules/.bin/vitest"])).toBe(false);
});

test("RDS CA main entry check tolerates a missing argv slot", () => {
  expect(shouldRunMain([NODE])).toBe(false);
  expect(shouldRunMain([])).toBe(false);
});
