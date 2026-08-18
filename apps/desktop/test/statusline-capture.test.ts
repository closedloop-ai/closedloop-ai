/**
 * @file statusline-capture.test.ts
 * @description Validates the shipped first-party statusLine capture script
 * (FEA-3492 / PRD-539): it writes a point-in-time snapshot (5h/7d used_percentage
 * + resets + total cost), composes with a wrapped user command by passing its
 * stdout through unchanged, and never crashes on malformed/empty stdin.
 *
 * In production the script runs from a userData COPY (outside the desktop's
 * `type:module` package, so its `require()` resolves as CommonJS). The test
 * mirrors that by copying the shipped script into a package.json-free temp dir
 * before spawning it via the Node binary.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

const FIVE_HOUR_SEGMENT = /5h 42%/;
const SEVEN_DAY_SEGMENT = /7d 70%/;
const COST_SEGMENT = /\$1\.23/;
const USED_PERCENTAGE_KEY = /used_percentage/;
const TOTAL_COST_KEY = /total_cost_usd/;
const ZERO_FIVE_HOUR_SEGMENT = /5h 0%/;
const ZERO_COST_SEGMENT = /\$0\.00/;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SRC = path.join(
  currentDir,
  "..",
  "resources",
  "statusline",
  "statusline-capture.js"
);

type RunResult = {
  stdout: string;
  code: number | null;
  snapshotPath: string;
};

/** Copy the shipped script to a CJS-safe temp dir, run it, capture stdout. */
function runScript(opts: {
  stdin: string;
  wrappedCommand?: string | null;
}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const dir = makeTempDir("statusline-capture-");
    const scriptCopy = path.join(dir, "statusline-capture.js");
    copyFileSync(SCRIPT_SRC, scriptCopy);

    const snapshotPath = path.join(dir, "snapshot.json");
    const configPath = path.join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        snapshotPath,
        wrappedCommand: opts.wrappedCommand ?? null,
      })
    );

    const child = spawn(process.execPath, [scriptCopy], {
      env: { ...process.env, CLOSEDLOOP_STATUSLINE_CONFIG: configPath },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code, snapshotPath }));
    child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

const FULL_PAYLOAD = JSON.stringify({
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: "2026-07-19T15:00:00.000Z" },
    seven_day: { used_percentage: 70, resets_at: "2026-07-21T12:00:00.000Z" },
  },
  cost: { total_cost_usd: 1.23 },
});

test("writes a snapshot with 5h/7d used_percentage + resets and total cost", async () => {
  const { code, snapshotPath } = await runScript({ stdin: FULL_PAYLOAD });
  assert.equal(code, 0);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.fiveHour.utilization, 42);
  assert.equal(snapshot.fiveHour.resetsAt, "2026-07-19T15:00:00.000Z");
  assert.equal(snapshot.sevenDay.utilization, 70);
  assert.equal(snapshot.sevenDay.resetsAt, "2026-07-21T12:00:00.000Z");
  assert.equal(snapshot.totalCostUsd, 1.23);
  assert.equal(typeof snapshot.fetchedAt, "string");
});

test("converts numeric epoch-seconds resets_at to an ISO string", async () => {
  // Claude Code documents `rate_limits.*.resets_at` as Unix epoch seconds.
  // 1738425600 = 2025-02-01T16:00:00.000Z.
  const payload = JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 1_738_425_600 },
      seven_day: { used_percentage: 70, resets_at: 0 },
    },
    cost: { total_cost_usd: 1.23 },
  });
  const { snapshotPath } = await runScript({ stdin: payload });
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.fiveHour.resetsAt, "2025-02-01T16:00:00.000Z");
  // 0 (and any non-positive / non-finite epoch) is treated as "no reset".
  assert.equal(snapshot.sevenDay.resetsAt, null);
});

test("minimal render (no wrapped command) prints 5h/7d/cost segments", async () => {
  const { stdout } = await runScript({ stdin: FULL_PAYLOAD });
  assert.match(stdout, FIVE_HOUR_SEGMENT);
  assert.match(stdout, SEVEN_DAY_SEGMENT);
  assert.match(stdout, COST_SEGMENT);
});

test("composition: passes a wrapped user command's stdout through unchanged", async () => {
  const { stdout, snapshotPath } = await runScript({
    stdin: FULL_PAYLOAD,
    wrappedCommand: "printf 'CUSTOM_USER_STATUS'",
  });
  // The user's line renders unchanged; our minimal render is NOT substituted.
  assert.equal(stdout, "CUSTOM_USER_STATUS\n");
  assert.doesNotMatch(stdout, FIVE_HOUR_SEGMENT);
  // The snapshot is still captured alongside the passthrough.
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.fiveHour.utilization, 42);
});

test("composition: forwards the same stdin payload to the wrapped command", async () => {
  // `cat` echoes whatever stdin it receives — proves the payload is forwarded.
  const { stdout } = await runScript({
    stdin: FULL_PAYLOAD,
    wrappedCommand: "cat",
  });
  assert.match(stdout, USED_PERCENTAGE_KEY);
  assert.match(stdout, TOTAL_COST_KEY);
});

test("composition: falls back to the built-in render when the wrapped command is silent", async () => {
  // A user command that exits 0 but prints nothing must not blank the line.
  const { stdout } = await runScript({
    stdin: FULL_PAYLOAD,
    wrappedCommand: "true",
  });
  assert.match(stdout, FIVE_HOUR_SEGMENT);
});

test("falsy-zero: captures 0% utilization and $0.00 cost (not treated as missing)", async () => {
  const payload = JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 0, resets_at: null },
      seven_day: { used_percentage: 0, resets_at: null },
    },
    cost: { total_cost_usd: 0 },
  });
  const { stdout, snapshotPath } = await runScript({ stdin: payload });
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.fiveHour.utilization, 0);
  assert.equal(snapshot.totalCostUsd, 0);
  assert.match(stdout, ZERO_FIVE_HOUR_SEGMENT);
  assert.match(stdout, ZERO_COST_SEGMENT);
});

test("resilient: malformed stdin does not crash, still prints a status line", async () => {
  const { code, stdout, snapshotPath } = await runScript({
    stdin: "not json at all",
  });
  assert.equal(code, 0);
  assert.ok(stdout.endsWith("\n"));
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.fiveHour, null);
  assert.equal(snapshot.sevenDay, null);
  assert.equal(snapshot.totalCostUsd, null);
});

test("resilient: empty stdin does not crash", async () => {
  const { code } = await runScript({ stdin: "" });
  assert.equal(code, 0);
});
