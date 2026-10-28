/**
 * ISS-11285 — run-node-tests.mjs refusals that happen before any lane spawns.
 *
 * The runner executes the suite on import, so these cases spawn the real
 * entrypoint with a stub `pnpm` first on PATH. The stub records that it ran;
 * both refusals must exit before it is ever reached.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { censusTestFiles } from "../scripts/node-test-census.mjs";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
const RUNNER_SCRIPT = join(desktopDir, "scripts/run-node-tests.mjs");
const RUNNER_SPAWN_TIMEOUT_MS = 120_000;

const MALFORMED_SHARD_MESSAGE =
  /NODE_TEST_SHARD must be "<index>\/<total>" \(1-based\), got "two\/3"/;
const EMPTY_SHARD_MESSAGE =
  /\[run-node-tests\] shard (\d+\/\d+) selected 0 of (\d+) test files — more shards than files/;
const RUNNING_BANNER = /\[run-node-tests\] shard .* running/;

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { force: true, recursive: true });
  }
});

function runRunnerWithShard(shard: string) {
  const sandbox = mkdtempSync(join(tmpdir(), "run-node-tests-iss11285-"));
  sandboxes.push(sandbox);
  const binDir = join(sandbox, "bin");
  mkdirSync(binDir);
  const markerFile = join(sandbox, "spawned.txt");
  writeFileSync(
    join(binDir, "pnpm"),
    `#!/bin/sh\nprintf 'spawned\\n' > ${JSON.stringify(markerFile)}\nexit 0\n`,
    { mode: 0o755 }
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_TEST_SHARD: shard,
    PATH: binDir,
  };
  Reflect.deleteProperty(env, "GITHUB_STEP_SUMMARY");

  const result = spawnSync(process.execPath, [RUNNER_SCRIPT], {
    cwd: desktopDir,
    encoding: "utf8",
    env,
    timeout: RUNNER_SPAWN_TIMEOUT_MS,
  });
  return { result, pnpmSpawned: existsSync(markerFile) };
}

describe("run-node-tests.mjs pre-spawn refusals", () => {
  it("fails a shard that selects no files instead of running an empty green suite", {
    timeout: RUNNER_SPAWN_TIMEOUT_MS,
  }, () => {
    const census = censusTestFiles();
    const totalFiles = census.vitest.length + census.nodeTest.length;
    // A shard count far above the census size leaves this index empty in
    // both lanes.
    const shardTotal = totalFiles + 1000;
    const spec = `${shardTotal}/${shardTotal}`;

    const { result, pnpmSpawned } = runRunnerWithShard(spec);

    expect(result.status).toBe(1);
    // The count is re-read by the child, so a test file added concurrently
    // can move it by one; the refusal wording and a non-zero total are the
    // contract.
    const refusal = EMPTY_SHARD_MESSAGE.exec(result.stderr);
    expect(refusal?.[1]).toBe(spec);
    expect(Number(refusal?.[2])).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(RUNNING_BANNER);
    expect(pnpmSpawned).toBe(false);
  });

  it("refuses a malformed NODE_TEST_SHARD with the format error, spawning nothing", {
    timeout: RUNNER_SPAWN_TIMEOUT_MS,
  }, () => {
    const { result, pnpmSpawned } = runRunnerWithShard("two/3");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(MALFORMED_SHARD_MESSAGE);
    expect(pnpmSpawned).toBe(false);
  });
});
