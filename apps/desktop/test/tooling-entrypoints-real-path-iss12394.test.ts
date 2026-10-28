import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// These run the REAL entrypoints, not tmp copies, in modes that write nothing:
// the desktop c8 lane credits only the path a child process actually loads.

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const runnerScript = path.join(desktopDir, "scripts/run-node-tests.mjs");
const CHILD_TIMEOUT_MS = 60_000;
const TOO_MANY_SHARDS_RE =
  /^\[run-node-tests\] shard 99999\/99999 selected 0 of \d+ test files — more shards than files$/m;

function runNode(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: desktopDir,
    encoding: "utf8",
    env,
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

describe("tooling entrypoints on their real paths", () => {
  it(
    "run-node-tests refuses a shard spec that selects no files, before running anything",
    () => {
      const result = runNode(runnerScript, [], {
        ...process.env,
        NODE_TEST_SHARD: "99999/99999",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(TOO_MANY_SHARDS_RE);
      expect(result.stdout).not.toContain("file(s) on Vitest");
    },
    CHILD_TIMEOUT_MS
  );
});
