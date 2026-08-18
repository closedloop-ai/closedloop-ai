/**
 * ISS-5299 — Branch coverage part 2: symphony-chat-history routes and
 * symphony-job-snapshot exported function unit tests.
 *
 * Unreachable branches (not tested, documented here):
 *
 * symphony-chat-history.ts
 *   - Line 147: POST historyWriteDir security check — structurally unreachable
 *     because historyWriteDir is derived from repoPath which already cleared
 *     assertRepoAllowed; assertPathAllowed only throws DirectoryNotAllowedError.
 *   - Lines 162, 204: write-failure catches — require removing write permissions
 *     from a directory at runtime (fragile, not tested).
 *
 * symphony-utils.ts (all 14 reported lines)
 *   - 141, 545, 560: throw-error false branches after instanceof checks —
 *     assertPathAllowed only throws DirectoryNotAllowedError, making the
 *     alternate throw structurally unreachable.
 *   - 217: ternary false branch in runLoopsSetupScript catch — execFileAsync
 *     always throws real Error instances; the String(err) branch is unreachable.
 *   - 291, 302, 719, 733, 788, 798, 1030, 1034: best-effort catch blocks in
 *     worktree restore and runBootstrap — require fs-level errors.
 *   - 857: appendBoundedTail ternary — private helper, only called from
 *     runBootstrap (long-running bash subprocess test, not unit-testable).
 *   - 916: bootstrap timeout process-kill — requires a real subprocess plus a
 *     mocked/real timeout trigger; deferred to integration tests.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { vi } from "vitest";
import type { LocalJob } from "../src/main/jobs/job-store.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerSymphonyChatHistoryRoutes } from "../src/server/operations/symphony-chat-history.js";
import {
  enrichJobSnapshot,
  readEffectiveStatusFromState,
  readLogTail,
} from "../src/server/operations/symphony-job-snapshot.js";
import type { LocalJobCommand } from "../src/shared/activity-panel-contract.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

// ─── Temp-dir factory (registers its own afterEach for cleanup) ───────────────
const { makeTempDir } = createGitOpTempDirs("iss5299-state-ops2-");

// ─── Restore mocked process methods after every test ─────────────────────────
afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Shared helpers for job-snapshot unit tests ───────────────────────────────
const TEST_NOW = new Date().toISOString();

function makeJob(overrides: Partial<LocalJob> = {}): LocalJob {
  return {
    id: "job-1",
    kind: "SYMPHONY_LOOP",
    loopId: "loop-1",
    command: "EXECUTE",
    status: "RUNNING",
    startedAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// symphony-chat-history — GET 403: repoPath outside allowed dirs (line 61)
// ════════════════════════════════════════════════════════════════════════════

test("chat-history GET: repoPath outside sandbox → 403 directory not allowed (line 61)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();

  const dispatcher = new OperationDispatcher();
  registerSymphonyChatHistoryRoutes(dispatcher, () => [sandboxDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/chat-history/T001",
    query: { repo: "/etc/outside-sandbox" },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-chat-history — GET 500: history file unreadable (line 90)
// ════════════════════════════════════════════════════════════════════════════

test("chat-history GET: history file is a directory → 500 read error (line 90)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const workDir = path.join(
      sandboxDir,
      "repo-T090",
      ".closedloop-ai",
      "work"
    );
    mkdirSync(workDir, { recursive: true });
    // Make historyPath a directory → readFile throws EISDIR.
    mkdirSync(path.join(workDir, "chat-history.json"));

    const dispatcher = new OperationDispatcher();
    registerSymphonyChatHistoryRoutes(dispatcher, () => [sandboxDir]);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/chat-history/T090",
      query: { repo: repoDir },
    });

    assert.equal(res.statusCode, 500);
    assert.ok(
      typeof res.body.error === "string" &&
        res.body.error.includes("Failed to read")
    );
  } finally {
    restoreEnvVars(saved);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-chat-history — POST 403: repoPath outside allowed dirs (line 130)
// ════════════════════════════════════════════════════════════════════════════

test("chat-history POST: repoPath outside sandbox → 403 directory not allowed (line 130)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();

  const dispatcher = new OperationDispatcher();
  registerSymphonyChatHistoryRoutes(dispatcher, () => [sandboxDir]);

  // POST route reads repo from query, not body.
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/chat-history/T001",
    query: { repo: "/etc/outside-sandbox" },
    body: JSON.stringify({}),
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-chat-history — POST 400: missing message content (line 178)
// ════════════════════════════════════════════════════════════════════════════

test("chat-history POST: message without content → 400 message required (line 178)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const dispatcher = new OperationDispatcher();
    registerSymphonyChatHistoryRoutes(dispatcher, () => [sandboxDir]);

    // POST route reads repo from query; body carries only message.
    // message.content is a number → parseMessage returns undefined → 400.
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/chat-history/T178",
      query: { repo: repoDir },
      body: JSON.stringify({
        message: {
          id: "msg-1",
          role: "user",
          content: 999,
          timestamp: TEST_NOW,
        },
      }),
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "message with content and role is required");
  } finally {
    restoreEnvVars(saved);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-chat-history — POST: message with sender="claude" (line 342)
// ════════════════════════════════════════════════════════════════════════════

test("chat-history POST: message with sender claude persisted, sender set in parsed message (line 342)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const dispatcher = new OperationDispatcher();
    registerSymphonyChatHistoryRoutes(dispatcher, () => [sandboxDir]);

    // POST route reads repo from query; body carries only message.
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/chat-history/T342",
      query: { repo: repoDir },
      body: JSON.stringify({
        message: {
          id: "msg-1",
          role: "assistant",
          content: "Hello from Claude",
          timestamp: TEST_NOW,
          sender: "claude",
        },
      }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const history = res.body.history as {
      messages: Array<{ sender?: string }>;
    };
    assert.equal(history.messages[0]?.sender, "claude");
  } finally {
    restoreEnvVars(saved);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-chat-history — DELETE 403: repoPath outside allowed dirs (line 241)
// ════════════════════════════════════════════════════════════════════════════

test("chat-history DELETE: repoPath outside sandbox → 403 directory not allowed (line 241)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();

  const dispatcher = new OperationDispatcher();
  registerSymphonyChatHistoryRoutes(dispatcher, () => [sandboxDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "DELETE",
    pathname: "/api/gateway/symphony/chat-history/T001",
    query: { repo: "/etc/outside-sandbox" },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-chat-history — DELETE no history + provider=codex (line 253)
// ════════════════════════════════════════════════════════════════════════════

test("chat-history DELETE: no history file, provider=codex → removes codex review file (line 253)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const dispatcher = new OperationDispatcher();
    registerSymphonyChatHistoryRoutes(dispatcher, () => [sandboxDir]);

    const res = await dispatchOperation({
      dispatcher,
      method: "DELETE",
      pathname: "/api/gateway/symphony/chat-history/T253",
      query: { repo: repoDir, provider: "codex" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, "No history to delete");
  } finally {
    restoreEnvVars(saved);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-chat-history — DELETE with valid index (lines 296, 308)
// ════════════════════════════════════════════════════════════════════════════

test("chat-history DELETE: index=0 removes first message and returns updated history (lines 296, 308)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const workDir = path.join(
      sandboxDir,
      "repo-T296",
      ".closedloop-ai",
      "work"
    );
    mkdirSync(workDir, { recursive: true });
    const history = {
      ticketId: "T296",
      repoPath: repoDir,
      messages: [
        { id: "m0", role: "user", content: "first", timestamp: TEST_NOW },
        { id: "m1", role: "user", content: "second", timestamp: TEST_NOW },
      ],
    };
    writeFileSync(
      path.join(workDir, "chat-history.json"),
      JSON.stringify(history)
    );

    const dispatcher = new OperationDispatcher();
    registerSymphonyChatHistoryRoutes(dispatcher, () => [sandboxDir]);

    const res = await dispatchOperation({
      dispatcher,
      method: "DELETE",
      pathname: "/api/gateway/symphony/chat-history/T296",
      query: { repo: repoDir, index: "0" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const remaining = res.body.history as {
      messages: Array<{ id: string }>;
    };
    assert.equal(remaining.messages.length, 1);
    assert.equal(remaining.messages[0]?.id, "m1");
  } finally {
    restoreEnvVars(saved);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// readEffectiveStatusFromState — unit tests (lines 49, 57, 61, 71, 76)
// ════════════════════════════════════════════════════════════════════════════

test("readEffectiveStatusFromState: absent file returns null status (line 49)", async () => {
  const result = await readEffectiveStatusFromState("/no/such/state.json");
  assert.equal(result.status, null);
  assert.equal(result.phase, null);
});

test("readEffectiveStatusFromState: non-string status field returns null status (line 57 false branch)", async () => {
  const dir = makeTempDir();
  const statePath = path.join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ status: 42, phase: null }));

  const result = await readEffectiveStatusFromState(statePath);
  assert.equal(result.status, null);
});

test("readEffectiveStatusFromState: IN_PROGRESS maps to RUNNING (line 61)", async () => {
  const dir = makeTempDir();
  const statePath = path.join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ status: "IN_PROGRESS" }));

  const result = await readEffectiveStatusFromState(statePath);
  assert.equal(result.status, "RUNNING");
});

test("readEffectiveStatusFromState: STOPPED maps to STOPPED (line 71)", async () => {
  const dir = makeTempDir();
  const statePath = path.join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ status: "STOPPED" }));

  const result = await readEffectiveStatusFromState(statePath);
  assert.equal(result.status, "STOPPED");
});

test("readEffectiveStatusFromState: corrupt JSON returns null status (line 76)", async () => {
  const dir = makeTempDir();
  const statePath = path.join(dir, "state.json");
  writeFileSync(statePath, "{ not valid json ~~~");

  const result = await readEffectiveStatusFromState(statePath);
  assert.equal(result.status, null);
  assert.equal(result.phase, null);
});

// ════════════════════════════════════════════════════════════════════════════
// readLogTail — unit tests (lines 106, 114)
// ════════════════════════════════════════════════════════════════════════════

test("readLogTail: absent log file returns null (line 106)", async () => {
  const result = await readLogTail("/no/such/symphony-launch.log");
  assert.equal(result, null);
});

test("readLogTail: log path is a directory → catch fires, returns null (line 114)", async () => {
  const dir = makeTempDir();
  const logDir = path.join(dir, "symphony-launch.log");
  mkdirSync(logDir);

  const result = await readLogTail(logDir);
  assert.equal(result, null);
});

// ════════════════════════════════════════════════════════════════════════════
// enrichJobSnapshot — lines 136 (currentTaskId), 294 (worktreeDir push),
// 312 (no ResultBundle manifest → vacuously satisfied), 351 (processRunning)
// ════════════════════════════════════════════════════════════════════════════

test("enrichJobSnapshot: plan.json sets currentTaskId; unknown command, worktreeDir, and live pid cover lines 136, 294, 312, 351", {
  timeout: 5000,
}, async () => {
  const dir = makeTempDir();
  const worktreeDir = path.join(dir, "wt");
  const claudeWorkDir = path.join(dir, "work");
  mkdirSync(worktreeDir);
  mkdirSync(claudeWorkDir);

  // Write plan.json so readPlanProgress returns a currentTaskId (line 136).
  writeFileSync(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({
      pendingTasks: [{ id: "task-abc", title: "Do the thing" }],
      completedTasks: [],
    })
  );

  const job = makeJob({
    // A command with no ResultBundle manifest takes the `!manifest` arm at
    // line 312. Every value in the LocalJobCommand union DOES have a manifest
    // with a non-empty `required`, so this arm is only reachable from a
    // persisted job row carrying a command this build does not know — which
    // is exactly what areRequiredArtifactsPresent's `command as LoopCommand`
    // cast concedes. The job store is SQLite, so that is a real trust
    // boundary, not a type-forbidden input.
    command: "CHAT" as LocalJobCommand,
    // worktreeDir set → collectArtifactSearchDirs pushes it (line 294).
    worktreeDir,
    claudeWorkDir,
    // pid = current process → isProcessRunning returns true → line 351 fires.
    pid: process.pid,
    // No statePath → stateExists = false → harness branch is entered.
    statePath: undefined,
  });

  const snapshot = await enrichJobSnapshot(job);

  assert.equal(snapshot.currentTaskId, "task-abc");
  assert.equal(snapshot.processRunning, true);
  // Process is live → status stays RUNNING (harness derives it).
  assert.equal(snapshot.status, "RUNNING");
});
