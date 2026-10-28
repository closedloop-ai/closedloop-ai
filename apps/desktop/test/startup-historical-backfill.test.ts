/**
 * ISS-11596 (PLN-2165 S21): the Agent Dashboard's "Startup historical
 * backfill" task, moved verbatim out of `createAgentDashboardDesignSystemRuntime`
 * so the git path it hands the db-host can be observed.
 *
 * Declared behavior change (Daveth Oakhurst, 2026-10-06, ISS-11596 decision 2):
 * the task resolves git through the same configured-path resolver as every
 * other git site, so a git path configured in Settings reaches
 * `runHistoricalBackfill`. Before the change it always used the login-shell
 * git. The no-override, closed and rejection cases hold on both sides of the
 * change; the override, resolver-failure, main-thread and close-during-
 * resolution cases are the red-first evidence for it.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { afterEach, beforeEach, describe, test } from "vitest";
import { createStartupHistoricalBackfillTask } from "../src/main/dashboard/startup-historical-backfill.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import { withShellPathEnvForTest } from "../src/server/shell-path.js";
import { createGitOpTempDirs } from "./helpers/git-gateway-op-harness.js";
import {
  assertProbesNeverBlocked,
  CacheScope,
  type ColdShellProbe,
  coldShellProbe,
  withColdShell,
} from "./helpers/git-path-resolution-fixtures.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const RUNTIME_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/dashboard/agent-dashboard-design-system-runtime.ts"
);
const TASK_NAME = "Startup historical backfill";
const SCHEDULER_CALL = "runAfterInitialBackgroundWorkAllowed";
const TASK_FACTORY = "createStartupHistoricalBackfillTask";
const BATCH_SIZE = 50;
const RESOLVER_ERROR = "binary paths settings unreadable";

const { makeTempDir } = createGitOpTempDirs("iss11596-backfill-");

type BackfillCall = { gitPath: string; batchSize: number };

let root = "";
let calls: BackfillCall[] = [];
let logs: string[] = [];

beforeEach(() => {
  configureBinaryPathsResolver(null);
  root = makeTempDir();
  calls = [];
  logs = [];
});

afterEach(() => {
  configureBinaryPathsResolver(null);
});

function recordingDatabase(
  outcome: "resolve" | "reject" = "resolve"
): Pick<DbHostAgentDatabase, "runHistoricalBackfill"> {
  return {
    runHistoricalBackfill(gitPath: string, batchSize: number) {
      calls.push({ gitPath, batchSize });
      return outcome === "resolve"
        ? Promise.resolve(0)
        : Promise.reject(new Error("db-host closed"));
    },
  };
}

function recordingLog(scope: string, message: string): void {
  logs.push(`${scope}: ${message}`);
}

/** A login shell that answers at once with `binDir` on PATH. */
async function instantLoginShell(binDir: string): Promise<NodeJS.ProcessEnv> {
  const shell = path.join(root, "instant-login-shell");
  await fs.writeFile(
    shell,
    `#!/bin/sh\necho "__CLPATH_START__${binDir}:/usr/bin:/bin__CLPATH_END__"\n`,
    { mode: 0o755 }
  );
  return { ...process.env, SHELL: shell, PATH: "/usr/bin:/bin" };
}

async function binDirWithGit(name: string): Promise<string> {
  const binDir = path.join(root, name);
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "git"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  return binDir;
}

describe("startup historical backfill task", () => {
  test("with no override it passes the login-shell git and a batch of 50", async () => {
    const binDir = await binDirWithGit("login-bin");
    const task = createStartupHistoricalBackfillTask({
      isClosed: () => false,
      agentDatabase: recordingDatabase(),
      log: recordingLog,
    });

    await withShellPathEnvForTest(await instantLoginShell(binDir), task);

    assert.deepEqual(calls, [
      { gitPath: path.join(binDir, "git"), batchSize: BATCH_SIZE },
    ]);
    assert.deepEqual(logs, []);
  });

  test("a closed runtime makes no backfill call", async () => {
    const task = createStartupHistoricalBackfillTask({
      isClosed: () => true,
      agentDatabase: recordingDatabase(),
      log: recordingLog,
    });

    await task();

    assert.deepEqual(calls, []);
  });

  test("a rejected backfill is logged and the task still resolves", async () => {
    const binDir = await binDirWithGit("login-bin");
    const task = createStartupHistoricalBackfillTask({
      isClosed: () => false,
      agentDatabase: recordingDatabase("reject"),
      log: recordingLog,
    });

    await withShellPathEnvForTest(await instantLoginShell(binDir), task);

    assert.equal(calls.length, 1);
    assert.deepEqual(logs, [
      "agent-enrichment: Startup backfill failed: db-host closed",
    ]);
  });

  test("a git path configured in Settings reaches the backfill", async () => {
    const loginBin = await binDirWithGit("login-bin");
    const overrideBin = await binDirWithGit("override-bin");
    const override = path.join(overrideBin, "git");
    configureBinaryPathsResolver(() => ({ git: override }));
    const task = createStartupHistoricalBackfillTask({
      isClosed: () => false,
      agentDatabase: recordingDatabase(),
      log: recordingLog,
    });

    await withShellPathEnvForTest(await instantLoginShell(loginBin), task);

    assert.deepEqual(calls, [{ gitPath: override, batchSize: BATCH_SIZE }]);
  });

  test("a binary-paths resolver that throws rejects the task for the scheduler to log", async () => {
    const binDir = await binDirWithGit("login-bin");
    configureBinaryPathsResolver(() => {
      throw new Error(RESOLVER_ERROR);
    });
    const task = createStartupHistoricalBackfillTask({
      isClosed: () => false,
      agentDatabase: recordingDatabase(),
      log: recordingLog,
    });

    await assert.rejects(
      withShellPathEnvForTest(await instantLoginShell(binDir), task),
      { message: RESOLVER_ERROR }
    );
    assert.deepEqual(calls, []);
  });
});

describe("startup historical backfill task on a cold PATH cache", () => {
  let probe: ColdShellProbe;

  beforeEach(async () => {
    probe = await coldShellProbe({ root, scope: CacheScope.Context });
    await fs.writeFile(path.join(probe.binDir, "git"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  });

  afterEach(() => {
    probe.stop();
  });

  test("the git resolution leaves the event loop free", async () => {
    const task = createStartupHistoricalBackfillTask({
      isClosed: () => false,
      agentDatabase: recordingDatabase(),
      log: recordingLog,
    });

    await withColdShell(probe, task);

    await assertProbesNeverBlocked(probe);
  });

  test("a shutdown that lands while git is being resolved stops the backfill", async () => {
    // The runtime reads as closed once the login-shell probe has started, so
    // it is open at the task's first check and closed by the time git resolves.
    const shutDownDuringResolution = (): boolean =>
      readdirSync(probe.probeDir).some((name) => name.startsWith("started-"));
    const task = createStartupHistoricalBackfillTask({
      isClosed: shutDownDuringResolution,
      agentDatabase: recordingDatabase(),
      log: recordingLog,
    });

    await withColdShell(probe, task);

    assert.equal(shutDownDuringResolution(), true);
    assert.deepEqual(calls, []);
  });
});

describe("startup historical backfill wiring in the dashboard runtime", () => {
  /** Every `runAfterInitialBackgroundWorkAllowed("Startup historical backfill", …)` call. */
  function backfillSchedulingCalls(): ts.CallExpression[] {
    const found: ts.CallExpression[] = [];
    forEachNode(parseTypeScriptFile(RUNTIME_PATH), (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === SCHEDULER_CALL &&
        node.arguments.length === 2 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === TASK_NAME
      ) {
        found.push(node);
      }
    });
    return found;
  }

  test("the runtime schedules the task by name through the startup scheduler", () => {
    assert.equal(backfillSchedulingCalls().length, 1);
  });

  test("the scheduled task is the one this module builds", () => {
    const [call] = backfillSchedulingCalls();
    assert.ok(call);
    const task = call.arguments[1];
    assert.ok(
      ts.isCallExpression(task) &&
        ts.isIdentifier(task.expression) &&
        task.expression.text === TASK_FACTORY,
      `the "${TASK_NAME}" task must be built by ${TASK_FACTORY}`
    );
  });
});
