/**
 * ISS-12394 — branch coverage for `scripts/stress-node-tests.mjs`.
 *
 * The branches left open are the ones a real `pnpm` cannot reach on this
 * host: the win32 `pnpm.cmd` name, and the defensive `??` fallbacks for a
 * spawn result whose output or status is missing. Each case runs the real
 * entrypoint in a child with a preload that pins `process.platform` and
 * replaces `child_process.spawnSync` with a double returning a scripted
 * result. The double records each command it was handed on stderr. The
 * preload also swaps the script's census import for a stub with no Vitest
 * files, so a case does not pay for a parse of the whole `test/` tree; every
 * file then routes to the node:test lane, still one `pnpm` invocation.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StressLane } from "../scripts/stress-node-tests-lib.mjs";

const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
const STRESS_SCRIPT = join(DESKTOP_DIR, "scripts", "stress-node-tests.mjs");
const SPAWN_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 2 * SPAWN_TIMEOUT_MS;
const FAKE_SPAWN_LINE = /^FAKE_SPAWN (\S+) (.*)$/gm;
const TYPE_ERROR_PATTERN = /TypeError/;

const CENSUS_STUB_SOURCE = `
export function censusTestFiles() {
  return { vitest: [], nodeTest: [] };
}
`;

const CENSUS_HOOKS_SOURCE = `
const STUB_URL = new URL("./census-stub.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "./node-test-census.mjs" &&
    context.parentURL?.endsWith("/scripts/stress-node-tests.mjs")
  ) {
    return { shortCircuit: true, url: STUB_URL };
  }
  return nextResolve(specifier, context);
}
`;

const PRELOAD_SOURCE = `
import childProcess from "node:child_process";
import { register, syncBuiltinESMExports } from "node:module";
register("./census-hooks.mjs", import.meta.url);
const plan = JSON.parse(process.env.ISS12394_SPAWN_PLAN);
if (plan.platform) {
  Object.defineProperty(process, "platform", { value: plan.platform });
}
let call = 0;
childProcess.spawnSync = (command, args) => {
  process.stderr.write("FAKE_SPAWN " + command + " " + args.join(" ") + "\\n");
  const scripted = plan.results[Math.min(call, plan.results.length - 1)];
  call += 1;
  const error = scripted.error
    ? Object.assign(new Error(scripted.error.message), scripted.error)
    : undefined;
  return { ...scripted, error };
};
syncBuiltinESMExports();
`;

type ScriptedResult = {
  status: number | null;
  signal: string | null;
  stdout: string | null;
  stderr: string | null;
  error?: { code: string; message: string };
};

type SpawnPlan = { platform?: string; results: ScriptedResult[] };

let sandbox = "";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "stress-node-tests-iss12394-"));
});

afterEach(() => {
  rmSync(sandbox, { force: true, recursive: true });
});

function runStress(plan: SpawnPlan) {
  const preload = join(sandbox, "fake-spawn.mjs");
  writeFileSync(preload, PRELOAD_SOURCE);
  writeFileSync(join(sandbox, "census-hooks.mjs"), CENSUS_HOOKS_SOURCE);
  writeFileSync(join(sandbox, "census-stub.mjs"), CENSUS_STUB_SOURCE);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ISS12394_SPAWN_PLAN: JSON.stringify(plan),
    STRESS_ITERS: "1",
  };
  for (const inherited of [
    "STRESS_FILE",
    "STRESS_TEST_TIMEOUT_MS",
    "STRESS_TIMEOUT_MS",
  ]) {
    Reflect.deleteProperty(env, inherited);
  }
  const result = spawnSync(
    process.execPath,
    ["--import", preload, STRESS_SCRIPT],
    { cwd: DESKTOP_DIR, encoding: "utf8", env, timeout: SPAWN_TIMEOUT_MS }
  );
  if (result.error) {
    throw new Error(`stress runner did not run: ${result.error.message}`);
  }
  const commands = [...result.stderr.matchAll(FAKE_SPAWN_LINE)].map(
    (match) => match[1]
  );
  return { ...result, commands };
}

describe("stress-node-tests.mjs on win32", () => {
  it(
    "spawns pnpm.cmd",
    () => {
      const run = runStress({
        platform: "win32",
        results: [{ status: 0, signal: null, stdout: "", stderr: "" }],
      });
      expect(run.status).toBe(0);
      expect(run.commands).toEqual(["pnpm.cmd"]);
      expect(run.stdout).toContain("[stress-node-tests] 1/1 iterations passed");
      // The census stub answered, so no case parsed the real tree.
      expect(run.stdout).toContain(
        `(${StressLane.Vitest}: 0, ${StressLane.NodeTest}: 2;`
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    "spawns plain pnpm off win32",
    () => {
      const run = runStress({
        platform: "linux",
        results: [{ status: 0, signal: null, stdout: "", stderr: "" }],
      });
      expect(run.status).toBe(0);
      expect(run.commands).toEqual(["pnpm"]);
    },
    CASE_TIMEOUT_MS
  );
});

describe("stress-node-tests.mjs with missing spawn output", () => {
  it(
    "reports a timed-out iteration whose output is null without crashing",
    () => {
      const run = runStress({
        results: [
          {
            status: null,
            signal: "SIGTERM",
            stdout: null,
            stderr: null,
            error: { code: "ETIMEDOUT", message: "spawnSync pnpm ETIMEDOUT" },
          },
        ],
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "[stress-node-tests] FAILED on iteration 1/1 (timed out after 180000ms — a hung test)"
      );
      expect(run.stderr).not.toMatch(TYPE_ERROR_PATTERN);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "reports a failed iteration whose output is null without crashing",
    () => {
      const run = runStress({
        results: [{ status: 2, signal: null, stdout: null, stderr: null }],
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "[stress-node-tests] FAILED on iteration 1/1 (exit 2)"
      );
      expect(run.stderr).not.toMatch(TYPE_ERROR_PATTERN);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "fails an iteration with neither a status nor a signal",
    () => {
      const run = runStress({
        results: [{ status: null, signal: null, stdout: "", stderr: "" }],
      });
      expect(run.status).toBe(1);
      // pins current behavior; looks odd because the missing status is
      // treated as a failure (status ?? 1) but the message prints the raw
      // null rather than the 1 it was judged by.
      expect(run.stderr).toContain(
        "[stress-node-tests] FAILED on iteration 1/1 (exit null)"
      );
    },
    CASE_TIMEOUT_MS
  );
});
