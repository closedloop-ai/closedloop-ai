/**
 * ISS-12394 — branch coverage for `scripts/node-test-lane-settings.mjs`: the
 * default-argument paths and the spellings the existing suite does not reach.
 *
 * The calls run in a plain Node child, because the node lane's c8 only
 * credits code that runs outside a Vite-transformed worker. The child gets its
 * own env, so this process's env is never mutated.
 */
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { laneConcurrencyFor } from "../scripts/node-test-lane-settings.mjs";
import {
  CHILD_CASE_TIMEOUT_MS,
  runModuleInChild,
} from "./support/module-child";

const MODULE_URL = new URL(
  "../scripts/node-test-lane-settings.mjs",
  import.meta.url
).href;
const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT_KEY = "NODE_TEST_TIMEOUT_MS";
const COVERAGE_KEY = "DESKTOP_NODE_COVERAGE";

/** Run `body` in a child whose env drops the two keys under test, then adds `env`. */
function runInChild<T>(body: string, env: NodeJS.ProcessEnv = {}): T {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  Reflect.deleteProperty(childEnv, TIMEOUT_KEY);
  Reflect.deleteProperty(childEnv, COVERAGE_KEY);
  Object.assign(childEnv, env);
  return runModuleInChild<T>({
    body,
    cwd: DESKTOP_DIR,
    env: childEnv,
    moduleUrl: MODULE_URL,
  });
}

describe("resolveTestTimeoutMs", () => {
  it(
    "reads process.env when no env is passed",
    () => {
      expect(
        runInChild("out(m.resolveTestTimeoutMs());", { [TIMEOUT_KEY]: "7000" })
      ).toBe(7000);
      expect(runInChild("out(m.resolveTestTimeoutMs());")).toBe(120_000);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "falls back to 120s for a non-numeric, zero or negative override, and parses a numeric prefix",
    () => {
      expect(
        runInChild(
          `out(["abc", "0", "-5", "5s", "45000"].map((v) => m.resolveTestTimeoutMs({ ${TIMEOUT_KEY}: v })));`
        )
      ).toEqual([
        120_000, 120_000, 120_000,
        // pins current behavior; looks odd because parseInt reads the "5s"
        // typo as 5ms rather than rejecting it.
        5, 45_000,
      ]);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});

describe("resolveNodeCoverageEnabled", () => {
  it(
    "reads process.env when no env is passed",
    () => {
      expect(
        runInChild("out(m.resolveNodeCoverageEnabled());", {
          [COVERAGE_KEY]: "1",
        })
      ).toBe(true);
      expect(runInChild("out(m.resolveNodeCoverageEnabled());")).toBe(false);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "is off for blank and the trimmed, case-folded off spellings, on otherwise",
    () => {
      expect(
        runInChild(
          `out(["", "   ", "0", "FALSE", "  No  ", "off", "1", "true", "yes"].map((v) => m.resolveNodeCoverageEnabled({ ${COVERAGE_KEY}: v })));`
        )
      ).toEqual([false, false, false, false, false, false, true, true, true]);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});

describe("lane concurrency", () => {
  it(
    "resolves this host's width and the per-host table",
    () => {
      const [host, table] = runInChild<[number, number[]]>(
        "out([m.resolveLaneConcurrency(), [1, 3, 4, 8, 9, 10, 16, 17, 32].map(m.laneConcurrencyFor)]);"
      );
      expect(host).toBe(laneConcurrencyFor(availableParallelism()));
      expect(table).toEqual([1, 3, 4, 4, 4, 5, 8, 8, 8]);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});
