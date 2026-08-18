/**
 * ISS-5299 — Branch coverage for symphony-kill (ticketId+repoPath paths) and
 * symphony-status (jobStore fallback, dead-process switch, log-based fallback).
 *
 * Unreachable branches reported here rather than tested:
 *   - symphony-kill.ts 166, 196, 241, 262, 287, 303: best-effort catch/rethrow
 *     blocks; assertPathAllowed only throws DirectoryNotAllowedError; cleanup
 *     catches need fs-level injection.
 *   - symphony-kill.ts 136 false branch: requires throwing a non-Error from
 *     process.kill — prohibited by Biome's useThrowOnlyError lint rule.
 *   - symphony-status.ts 42, 60, 168: router requires a non-empty `:ticketId`
 *     segment ([^/]+), making the falsy-ticketId guard structurally dead;
 *     assertPathAllowed only throws DirectoryNotAllowedError; the outer handler
 *     catch has no reachable throw path.
 */

import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { vi } from "vitest";
import type { JobStore, LocalJob } from "../src/main/jobs/job-store.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerSymphonyKillRoutes } from "../src/server/operations/symphony-kill.js";
import { registerSymphonyStatusRoutes } from "../src/server/operations/symphony-status.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

// ─── Temp-dir factory (registers its own afterEach for cleanup) ───────────────
const { makeTempDir } = createGitOpTempDirs("iss5299-state-ops-");

// ─── Restore mocked process methods after every test ─────────────────────────
afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Shared test fixtures ─────────────────────────────────────────────────────
const TEST_NOW = new Date().toISOString();

function makeTestJob(overrides: Partial<LocalJob> = {}): LocalJob {
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

function makeTestJobStore(
  runningJobs: LocalJob[] = [],
  completedJobs: LocalJob[] = []
): JobStore {
  return {
    listRunning: () => [...runningJobs],
    listCompleted: () => [...completedJobs],
    upsert: (job: LocalJob) => job,
    getById: () => undefined,
    getByLoopId: () => undefined,
    reconcile: () => [],
  } as unknown as JobStore;
}

// Helper: create a worktreeDir with a process.pid file.
function writeWorktreePidFile(worktreeDir: string, pid: number): void {
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, "process.pid"), String(pid));
}

// Helper: write state.json with optional mtime backdating (ms before now).
function writeStateJson(
  worktreeDir: string,
  content: Record<string, unknown>,
  backdateMs?: number
): string {
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  mkdirSync(workDir, { recursive: true });
  const statePath = path.join(workDir, "state.json");
  writeFileSync(statePath, JSON.stringify(content));
  if (backdateMs !== undefined) {
    const ts = new Date(Date.now() - backdateMs);
    utimesSync(statePath, ts, ts);
  }
  return statePath;
}

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — ticketId+repoPath paths
// ════════════════════════════════════════════════════════════════════════════

// Lines 92 (cancelLoop), 100 (worktreeDir → markStateAsStopped when already
// dead), 218 (resolvePid ticketId+repoPath success return), 299 (deletePidFile
// try block entered when pidFilePath != null).
test("kill: ticketId+repoPath with dead PID — cancelLoop fires, state marked stopped", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const worktreeDir = path.join(sandboxDir, "repo-T001");
    writeWorktreePidFile(worktreeDir, 999_999_999);

    const dispatcher = new OperationDispatcher();
    registerSymphonyKillRoutes(dispatcher, () => [sandboxDir]);

    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/kill",
      body: JSON.stringify({ ticketId: "T001", repoPath: repoDir }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, "Process already terminated");
    assert.equal(res.body.pid, 999_999_999);
  } finally {
    restoreEnvVars(saved);
  }
});

// Lines 119 (inner catch: "Process already gone") and 124 (worktreeDir →
// markStateAsStopped in "Process terminated" path). Mock kill so the outer
// liveness check and SIGTERM pass but the inner liveness check throws, then
// wait 500 ms for the production grace period (real sleep, not mocked).
test("kill: ticketId+repoPath — inner kill(0) throws after SIGTERM, process-gone branch fires", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const worktreeDir = path.join(sandboxDir, "repo-T002");
    writeWorktreePidFile(worktreeDir, 55_555);

    let killCallCount = 0;
    vi.spyOn(process, "kill").mockImplementation(
      (_pid: number, _sig?: string | number) => {
        killCallCount += 1;
        // call 1: outer kill(55_555, 0) — alive check passes.
        // call 2: kill(-55_555, SIGTERM) — sent successfully.
        if (killCallCount <= 2) {
          return true;
        }
        // call 3: inner kill(55_555, 0) — process already gone.
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
    );

    const dispatcher = new OperationDispatcher();
    registerSymphonyKillRoutes(dispatcher, () => [sandboxDir]);

    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/kill",
      body: JSON.stringify({ ticketId: "T002", repoPath: repoDir }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, "Process terminated");
  } finally {
    restoreEnvVars(saved);
  }
});

// Lines 136 true branch (error instanceof Error → error.message), 139
// (worktreeDir true → markStateAsStopped), 142 (jobStore true → upsert STOPPED).
test("kill: ticketId+repoPath + jobStore — SIGTERM throws Error ESRCH, worktreeDir and jobStore branches fire", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const worktreeDir = path.join(sandboxDir, "repo-T003");
    writeWorktreePidFile(worktreeDir, 44_444);

    const upserted: LocalJob[] = [];
    const fakeStore: JobStore = {
      listRunning: () => [makeTestJob({ pid: 44_444, worktreeDir })],
      listCompleted: () => [],
      upsert: (job: LocalJob) => {
        upserted.push(job);
        return job;
      },
      getById: () => undefined,
      getByLoopId: () => undefined,
      reconcile: () => [],
    } as unknown as JobStore;

    let killCallCount = 0;
    vi.spyOn(process, "kill").mockImplementation(
      (_pid: number, _sig?: string | number) => {
        killCallCount += 1;
        if (killCallCount === 1) {
          return true; // outer liveness check passes
        }
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); // SIGTERM throws
      }
    );

    const dispatcher = new OperationDispatcher();
    registerSymphonyKillRoutes(dispatcher, () => [sandboxDir], fakeStore);

    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/kill",
      body: JSON.stringify({ ticketId: "T003", repoPath: repoDir }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, "Process already terminated");
    assert.equal(upserted.length, 1);
    assert.equal(upserted[0]?.status, "STOPPED");
  } finally {
    restoreEnvVars(saved);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-status — jobStore fallback paths
// ════════════════════════════════════════════════════════════════════════════

// Lines 72-83: initial worktreeDir absent + jobStore running job matches
// ticketId → worktreeDir resolved from running-job registry (line 73 loop).
test("status: running-job fallback resolves worktreeDir when initial path is absent (line 73)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const jobWorktreeDir = path.join(sandboxDir, "job-wt-running");
  mkdirSync(jobWorktreeDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const jobStore = makeTestJobStore([
      makeTestJob({ ticketId: "T010", worktreeDir: jobWorktreeDir }),
    ]);

    const dispatcher = new OperationDispatcher();
    registerSymphonyStatusRoutes(dispatcher, () => [sandboxDir], jobStore);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status/T010",
      query: { repo: repoDir },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.exists, true);
    assert.equal(res.body.stateExists, false);
    assert.equal(res.body.status, "STARTING");
  } finally {
    restoreEnvVars(saved);
  }
});

// Lines 85-97: running jobs checked with no match → completed jobs loop entered
// (line 86). Completed job with matching ticketId resolves worktreeDir.
test("status: completed-job fallback entered when no running job matches ticketId (line 86)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const completedWorktreeDir = path.join(sandboxDir, "job-wt-completed");
  mkdirSync(completedWorktreeDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const jobStore = makeTestJobStore(
      [], // no running jobs — running loop exits with no match
      [
        makeTestJob({
          ticketId: "T011",
          worktreeDir: completedWorktreeDir,
          status: "COMPLETED",
        }),
      ]
    );

    const dispatcher = new OperationDispatcher();
    registerSymphonyStatusRoutes(dispatcher, () => [sandboxDir], jobStore);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status/T011",
      query: { repo: repoDir },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.exists, true);
    assert.equal(res.body.stateExists, false);
    assert.equal(res.body.status, "STARTING");
  } finally {
    restoreEnvVars(saved);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-status — dead-process switch (lines 245–280)
// ════════════════════════════════════════════════════════════════════════════

// Line 255 (case "unreadable"): state IN_PROGRESS + dead PID +
// claude-output.jsonl is a directory → EISDIR → "unreadable" outcome → STOPPED.
test("status: unreadable JSONL (directory) triggers case 'unreadable' → STOPPED (line 255)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const worktreeDir = path.join(sandboxDir, "repo-T020");
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    mkdirSync(workDir, { recursive: true });

    writeFileSync(path.join(workDir, "process.pid"), "999999999");
    writeFileSync(
      path.join(workDir, "state.json"),
      JSON.stringify({ status: "IN_PROGRESS" })
    );
    // Create claude-output.jsonl as a DIRECTORY → EISDIR on readFileSync.
    mkdirSync(path.join(workDir, "claude-output.jsonl"));

    const dispatcher = new OperationDispatcher();
    registerSymphonyStatusRoutes(dispatcher, () => [sandboxDir]);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status/T020",
      query: { repo: repoDir },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "STOPPED");
  } finally {
    restoreEnvVars(saved);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-status — log-based completion fallback (lines 283–330)
// ════════════════════════════════════════════════════════════════════════════

// Line 199 (true branch): log exists but has no COMPLETE marker.
// Old state.json, no pid file, no lock → detectCompletionFromLogs returns
// {completed:false} → status stays IN_PROGRESS.
test("status: log without COMPLETE marker — line 199 true, status stays IN_PROGRESS", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const worktreeDir = path.join(sandboxDir, "repo-T030");
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    mkdirSync(workDir, { recursive: true });

    // Backdate state.json beyond the 2-minute threshold.
    writeStateJson(worktreeDir, { status: "IN_PROGRESS" }, 3 * 60 * 1000);
    // No process.pid → pid=null → skips dead-process switch block.
    // No lock file → skips lock-present early-return.
    writeFileSync(
      path.join(workDir, "symphony-launch.log"),
      "symphony started\nstill running\n"
    );

    const dispatcher = new OperationDispatcher();
    registerSymphonyStatusRoutes(dispatcher, () => [sandboxDir]);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status/T030",
      query: { repo: repoDir },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "IN_PROGRESS");
    assert.equal(res.body.fallbackDetected, false);
  } finally {
    restoreEnvVars(saved);
  }
});

// Lines 203–208 (awaitingUser = true) and 320 (resolvedStatus = "AWAITING_USER").
// Old state.json, no pid file, log has COMPLETE + AWAITING_USER marker.
test("status: log with COMPLETE + AWAITING_USER → awaitingUser true, status AWAITING_USER (lines 204, 320)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const worktreeDir = path.join(sandboxDir, "repo-T031");
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    mkdirSync(workDir, { recursive: true });

    writeStateJson(worktreeDir, { status: "IN_PROGRESS" }, 3 * 60 * 1000);
    writeFileSync(
      path.join(workDir, "symphony-launch.log"),
      "<promise>COMPLETE</promise>\nAWAITING_USER review\n"
    );

    const dispatcher = new OperationDispatcher();
    registerSymphonyStatusRoutes(dispatcher, () => [sandboxDir]);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status/T031",
      query: { repo: repoDir },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "AWAITING_USER");
    assert.equal(res.body.fallbackDetected, true);
  } finally {
    restoreEnvVars(saved);
  }
});

// Line 322 (resolvedPhase false branch: "Completed").
// Old state.json, no pid file, log has COMPLETE but no AWAITING_USER text.
test("status: log with COMPLETE only → awaitingUser false, status COMPLETED, phase Completed (line 322)", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const worktreeDir = path.join(sandboxDir, "repo-T032");
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    mkdirSync(workDir, { recursive: true });

    writeStateJson(worktreeDir, { status: "IN_PROGRESS" }, 3 * 60 * 1000);
    writeFileSync(
      path.join(workDir, "symphony-launch.log"),
      "<promise>COMPLETE</promise>\nclean finish\n"
    );

    const dispatcher = new OperationDispatcher();
    registerSymphonyStatusRoutes(dispatcher, () => [sandboxDir]);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status/T032",
      query: { repo: repoDir },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "COMPLETED");
    assert.equal(res.body.phase, "Completed");
    assert.equal(res.body.fallbackDetected, true);
  } finally {
    restoreEnvVars(saved);
  }
});

// Line 209 (catch in detectCompletionFromLogs): log path is a directory →
// readFile throws EISDIR → catch fires → returns {completed:false}.
test("status: log path is directory → detectCompletionFromLogs catch fires (line 209), fallback false", {
  timeout: 5000,
}, async () => {
  const sandboxDir = makeTempDir();
  const repoDir = path.join(sandboxDir, "repo");
  mkdirSync(repoDir);

  const saved = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = sandboxDir;
  try {
    const worktreeDir = path.join(sandboxDir, "repo-T033");
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    mkdirSync(workDir, { recursive: true });

    writeStateJson(worktreeDir, { status: "IN_PROGRESS" }, 3 * 60 * 1000);
    // Make the log path a directory — existsSync true but readFile throws EISDIR.
    mkdirSync(path.join(workDir, "symphony-launch.log"));

    const dispatcher = new OperationDispatcher();
    registerSymphonyStatusRoutes(dispatcher, () => [sandboxDir]);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status/T033",
      query: { repo: repoDir },
    });

    assert.equal(res.statusCode, 200);
    // fallbackDetected=false: catch returned {completed:false} so no override.
    assert.equal(res.body.fallbackDetected, false);
    assert.equal(res.body.status, "IN_PROGRESS");
  } finally {
    restoreEnvVars(saved);
  }
});
