/**
 * ISS-11285: the boundary gate entrypoint's default-argument path and its two
 * refusals on an unusable depcruise report. Every case spawns the shipped
 * script, because its exit code is the contract.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const DESKTOP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GATE_SCRIPT = path.join(
  DESKTOP_ROOT,
  "scripts",
  "assert-design-system-boundary.mjs"
);
const ONE_MODULE_CLEAN =
  /no dependency violations found \(1 modules, \d+ dependencies cruised\)/;
const REFUSED = /design-system boundary gate REFUSED/;
const NO_REPORT = /depcruise produced no report \(exit [1-9]\d*\)/;
const SILENT_NO_REPORT =
  /depcruise produced no report \(exit 0\)\.\n\(no stderr\)/;
const DID_NOT_PARSE = /depcruise's JSON report did not parse \(exit 0\)/;
const CRUISE_TIMEOUT_MS = 60_000;

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

function cleanFixture(): string {
  const fixture = mkdtempSync(path.join(tmpdir(), "ds-boundary-iss11285-"));
  scratchDirs.push(fixture);
  mkdirSync(path.join(fixture, "src"));
  writeFileSync(path.join(fixture, "src", "a.js"), "export const a = 1;\n");
  return fixture;
}

function runGate(args: readonly string[], cwd = tmpdir()) {
  const result = spawnSync(process.execPath, [GATE_SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("assert-design-system-boundary entrypoint", () => {
  it("cruises from the desktop root with the default config when neither --cwd nor --config is given, whatever the caller's cwd", {
    timeout: CRUISE_TIMEOUT_MS,
  }, () => {
    const result = runGate([
      "--target",
      "scripts/dev-launch-steps.mjs",
      "--floor",
      "1",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(ONE_MODULE_CLEAN);
  });

  it("refuses, exit 1, when depcruise writes no report", {
    timeout: CRUISE_TIMEOUT_MS,
  }, () => {
    const fixture = cleanFixture();

    const result = runGate([
      "--cwd",
      fixture,
      "--config",
      path.join(fixture, "does-not-exist.cjs"),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(REFUSED);
    expect(result.stderr).toMatch(NO_REPORT);
  });

  it("refuses, exit 1, and says so when depcruise exits 0 with no output at all", {
    timeout: CRUISE_TIMEOUT_MS,
  }, () => {
    const fixture = cleanFixture();
    const config = path.join(fixture, "silent.cjs");
    // A config that exits on load ends depcruise before it reports anything.
    writeFileSync(config, "process.exit(0);\n");

    const result = runGate(["--cwd", fixture, "--config", config]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(SILENT_NO_REPORT);
  });

  it("refuses, exit 1, when depcruise's stdout is not JSON", {
    timeout: CRUISE_TIMEOUT_MS,
  }, () => {
    const fixture = cleanFixture();
    const config = path.join(fixture, "noisy.cjs");
    // A config that prints on load puts non-JSON text ahead of the report.
    writeFileSync(
      config,
      'process.stdout.write("not json\\n");\nmodule.exports = { forbidden: [] };\n'
    );

    const result = runGate(["--cwd", fixture, "--config", config]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(REFUSED);
    expect(result.stderr).toMatch(DID_NOT_PARSE);
  });
});
