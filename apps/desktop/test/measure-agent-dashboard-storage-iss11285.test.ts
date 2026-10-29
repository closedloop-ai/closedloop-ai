import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { USER_DATA_FLAG } from "../scripts/measure-agent-dashboard-storage-lib.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/measure-agent-dashboard-storage.mjs", import.meta.url)
);
const MISSING_VALUE_MESSAGE = /--user-data requires a path value/;
const SPAWN_TIMEOUT_MS = 30_000;

describe("measure-agent-dashboard-storage CLI", () => {
  it(
    "refuses a trailing --user-data flag with no path, in the real child process",
    () => {
      const result = spawnSync(
        process.execPath,
        [SCRIPT_PATH, USER_DATA_FLAG],
        { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS }
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(MISSING_VALUE_MESSAGE);
    },
    SPAWN_TIMEOUT_MS * 2
  );
});
