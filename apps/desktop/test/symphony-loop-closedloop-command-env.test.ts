/**
 * Spawn-env tests for native command launches: verify the desktop propagates the
 * websocket-derived LoopCommand to the harness via CLOSEDLOOP_COMMAND so
 * loop.perf.* events and runs.log rows are attributed to the actual
 * command (PLAN, EXECUTE, …), not generic fallback labels.
 *
 * Companion to PRD-254 §FR-1 / §FR-5.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopHarness } from "@closedloop-ai/loops-api/desktop-request";
import { setShellPathForTest } from "../src/server/shell-path.js";
import {
  makeFakeWorktreeProvider,
  makeMultiRepoGateway,
  makeMultiRepoTestHarness,
  startMockApiServer,
  waitForTerminalEvent,
} from "./symphony-test-utils.js";

const fakeWorktreeProvider = makeFakeWorktreeProvider(
  "symphony/closedloop-command-env-test"
);

const { serversToClose, mockServersToClose, tempPathsToClean, cleanup } =
  makeMultiRepoTestHarness();
afterEach(cleanup);

function createTestGateway(tmpDir: string, mockPort: number) {
  return makeMultiRepoGateway({
    tmpDir,
    mockPort,
    machineName: "closedloop-command-env-test",
    worktreeProvider: fakeWorktreeProvider,
    serversToClose,
  });
}

// ---------------------------------------------------------------------------
// Parameterized: each native loop command must propagate as
// CLOSEDLOOP_COMMAND with the canonical uppercase string value.
// ---------------------------------------------------------------------------

// Native command-pack commands share the same spawnEnv construction
// site (apps/desktop/src/server/operations/symphony-loop.ts:6108), so PLAN
// is sufficient to verify the propagation mechanism. EXECUTE additionally
// requires a prompt-or-artifacts payload which is orthogonal to this test.
const NATIVE_LOOP_COMMANDS: ReadonlyArray<{
  enum: LoopCommand;
  expected: string;
  loopId: string;
}> = [
  {
    enum: LoopCommand.Plan,
    expected: "PLAN",
    loopId: "00000000-0000-4000-8000-000000007301",
  },
];

for (const { enum: cmd, expected, loopId } of NATIVE_LOOP_COMMANDS) {
  test(`${expected} loop propagates CLOSEDLOOP_COMMAND=${expected} to the native Claude pipeline`, async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        `closedloop-command-env-${expected.toLowerCase()}-`
      )
    );
    tempPathsToClean.push(tmpDir);

    const primaryRepo = path.join(tmpDir, "primary-repo");
    await fs.mkdir(primaryRepo, { recursive: true });

    const worktreeParent = path.join(tmpDir, "worktrees");
    await fs.mkdir(worktreeParent, { recursive: true });

    process.env.HOME = tmpDir;
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

    const captureFile = path.join(tmpDir, "captured-plan-env.txt");
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });
    const spyScript = [
      "#!/bin/sh",
      `printf '%s' "$CLOSEDLOOP_COMMAND" > ${JSON.stringify(captureFile)}`,
      "cat > /dev/null",
      `echo '{"type":"result"}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "claude"), spyScript, {
      mode: 0o755,
    });

    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    const mock = await startMockApiServer();
    mockServersToClose.push(mock.server);
    const server = await createTestGateway(tmpDir, mock.port);

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loopId,
          command: cmd,
          closedLoopAuthToken: "tok",
          artifacts: [],
          repo: {
            fullName: `cmdenv-test/${path.basename(primaryRepo)}`,
            branch: "main",
          },
        }),
      }
    );

    if (response.status !== 200) {
      const errorBody = await response.text();
      throw new Error(
        `POST /symphony/loop returned ${response.status}: ${errorBody}`
      );
    }

    const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
    assert.equal(
      terminalEvent.type,
      "completed",
      `Expected terminal event 'completed', got '${terminalEvent.type}': ${JSON.stringify(terminalEvent)}`
    );

    const captured = (await fs.readFile(captureFile, "utf-8")).trim();
    assert.equal(
      captured,
      expected,
      `Expected CLOSEDLOOP_COMMAND="${expected}" in spawn env, got "${captured}". ` +
        "If empty, the desktop dropped the env var on the spawn site. If non-empty " +
        "but wrong, the propagation is mis-mapped."
    );
  });
}

// ---------------------------------------------------------------------------
// DECOMPOSE — different spawn branch (raw-claude pipeline, not run-loop.sh).
// The spawnEnv is constructed at the same site (line 6110) for all branches,
// but a future per-command override would silently regress non-run-loop paths
// if PLAN were the only coverage. Codex round-2 finding.
// ---------------------------------------------------------------------------

test("DECOMPOSE loop propagates CLOSEDLOOP_COMMAND=DECOMPOSE to the raw-claude pipeline", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "closedloop-command-env-decompose-")
  );
  tempPathsToClean.push(tmpDir);

  const primaryRepo = path.join(tmpDir, "primary-repo");
  await fs.mkdir(primaryRepo, { recursive: true });
  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  // DECOMPOSE doesn't spawn run-loop.sh; it spawns the raw-claude pipeline
  // directly. The fake `claude` binary captures CLOSEDLOOP_COMMAND from its
  // env into a dedicated capture file outside the worktree (so it survives
  // cleanup and is locatable without scanning per-loop workdirs). The
  // pipeline pipes the prompt via stdin and expects a JSON `result` line on
  // stdout for completion.
  const captureFile = path.join(tmpDir, "captured-decompose-env.txt");
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const spyScript = [
    "#!/bin/sh",
    `printf '%s' "$CLOSEDLOOP_COMMAND" > ${JSON.stringify(captureFile)}`,
    // Drain stdin so the pipeline doesn't SIGPIPE.
    "cat > /dev/null",
    `echo '{"type":"result"}'`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), spyScript, { mode: 0o755 });

  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const loopId = "00000000-0000-4000-8000-000000007303";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Decompose,
        closedLoopAuthToken: "tok",
        artifacts: [
          {
            id: "art-prd-1",
            type: "prd",
            title: "Test PRD",
            content: "A small PRD for decomposition.",
          },
        ],
        prompt: "Decompose the PRD into features.",
        repo: {
          fullName: `cmdenv-test/${path.basename(primaryRepo)}`,
          branch: "main",
        },
      }),
    }
  );

  if (response.status !== 200) {
    const errorBody = await response.text();
    throw new Error(
      `POST /symphony/loop returned ${response.status}: ${errorBody}`
    );
  }

  const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(
    terminalEvent.type,
    "completed",
    `Expected terminal event 'completed', got '${terminalEvent.type}': ${JSON.stringify(terminalEvent)}`
  );

  const captured = (await fs.readFile(captureFile, "utf-8")).trim();
  assert.equal(
    captured,
    "DECOMPOSE",
    `Expected CLOSEDLOOP_COMMAND="DECOMPOSE" in raw-claude pipeline env, got "${captured}". ` +
      "A non-run-loop spawn branch is dropping the env var."
  );
});

test("Codex native prompt pipeline passes prompt content through stdin", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "closedloop-command-env-codex-stdin-")
  );
  tempPathsToClean.push(tmpDir);

  const primaryRepo = path.join(tmpDir, "primary-repo");
  await fs.mkdir(primaryRepo, { recursive: true });
  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  const argvFile = path.join(tmpDir, "captured-codex-argv.txt");
  const stdinFile = path.join(tmpDir, "captured-codex-stdin.txt");
  const envFile = path.join(tmpDir, "captured-codex-env.txt");
  const harnessEnvFile = path.join(tmpDir, "captured-codex-harness-env.txt");
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const spyScript = [
    "#!/bin/sh",
    `printf '%s' "$*" > ${JSON.stringify(argvFile)}`,
    `printf '%s' "$CLOSEDLOOP_COMMAND" > ${JSON.stringify(envFile)}`,
    `printf '%s' "$CLOSEDLOOP_HARNESS" > ${JSON.stringify(harnessEnvFile)}`,
    `cat > ${JSON.stringify(stdinFile)}`,
    `echo '{"type":"result"}'`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "codex"), spyScript, { mode: 0o755 });

  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const loopId = "00000000-0000-4000-8000-000000007304";
  const prompt = "Plan the Codex stdin transport with sentinel COD3X-STDIN.";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        harness: LoopHarness.Codex,
        closedLoopAuthToken: "tok",
        artifacts: [],
        prompt,
        repo: {
          fullName: `cmdenv-test/${path.basename(primaryRepo)}`,
          branch: "main",
        },
      }),
    }
  );

  if (response.status !== 200) {
    const errorBody = await response.text();
    throw new Error(
      `POST /symphony/loop returned ${response.status}: ${errorBody}`
    );
  }

  const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(
    terminalEvent.type,
    "completed",
    `Expected terminal event 'completed', got '${terminalEvent.type}': ${JSON.stringify(terminalEvent)}`
  );

  const capturedArgv = await fs.readFile(argvFile, "utf-8");
  assert.equal(capturedArgv, "exec --full-auto --json -");
  assert.equal(
    capturedArgv.includes("COD3X-STDIN"),
    false,
    "Codex prompt content must not be passed as command-line argv"
  );

  const capturedStdin = await fs.readFile(stdinFile, "utf-8");
  assert.equal(
    capturedStdin.includes(prompt),
    true,
    "Codex prompt content should be delivered through stdin"
  );

  const capturedEnv = (await fs.readFile(envFile, "utf-8")).trim();
  assert.equal(capturedEnv, "PLAN");
  const capturedHarnessEnv = (
    await fs.readFile(harnessEnvFile, "utf-8")
  ).trim();
  assert.equal(capturedHarnessEnv, LoopHarness.Codex);
});

test("omitted harness defaults to the Claude runtime and env value", async () => {
  const result = await runHarnessDefaultCase({
    loopId: "00000000-0000-4000-8000-000000007305",
  });
  assert.equal(
    result.terminalEventType,
    "completed",
    `Expected terminal event 'completed', got '${result.terminalEventType}': ${JSON.stringify(result.terminalEvent)}`
  );
  assert.equal(result.capturedHarnessEnv, LoopHarness.Claude);
});

test("unknown harness defaults to the Claude runtime and env value", async () => {
  const result = await runHarnessDefaultCase({
    loopId: "00000000-0000-4000-8000-000000007306",
    harness: "unknown-harness",
  });
  assert.equal(
    result.terminalEventType,
    "completed",
    `Expected terminal event 'completed', got '${result.terminalEventType}': ${JSON.stringify(result.terminalEvent)}`
  );
  assert.equal(result.capturedHarnessEnv, LoopHarness.Claude);
});

async function runHarnessDefaultCase({
  loopId,
  harness,
}: {
  loopId: string;
  harness?: string;
}) {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "closedloop-command-env-harness-default-")
  );
  tempPathsToClean.push(tmpDir);

  const primaryRepo = path.join(tmpDir, "primary-repo");
  await fs.mkdir(primaryRepo, { recursive: true });
  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  const envFile = path.join(tmpDir, "captured-harness-env.txt");
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const spyScript = [
    "#!/bin/sh",
    `printf '%s' "$CLOSEDLOOP_HARNESS" > ${JSON.stringify(envFile)}`,
    "cat > /dev/null",
    `echo '{"type":"result"}'`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), spyScript, {
    mode: 0o755,
  });

  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);
  const body: Record<string, unknown> = {
    loopId,
    command: LoopCommand.Plan,
    closedLoopAuthToken: "tok",
    artifacts: [],
    prompt: "Verify harness defaulting.",
    repo: {
      fullName: `cmdenv-test/${path.basename(primaryRepo)}`,
      branch: "main",
    },
  };
  if (harness !== undefined) {
    body.harness = harness;
  }

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (response.status !== 200) {
    const errorBody = await response.text();
    throw new Error(
      `POST /symphony/loop returned ${response.status}: ${errorBody}`
    );
  }

  const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
  const capturedHarnessEnv = (await fs.readFile(envFile, "utf-8")).trim();

  return {
    capturedHarnessEnv,
    terminalEvent,
    terminalEventType: terminalEvent.type,
  };
}
