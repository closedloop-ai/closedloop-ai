/**
 * ISS-5299 — branch coverage for symphony-plan.ts, symphony-plan-loop.ts,
 * and accessible branches in symphony-interactive.ts.
 *
 * Unreachable branches intentionally NOT tested (rationale):
 *   • symphony-plan.ts   line 37  — :ticketId route param always present (no empty-param dispatch)
 *   • symphony-plan.ts   line 58  — tryAssertRepoAllowed only returns DirectoryNotAllowedError
 *   • symphony-plan.ts   line 126 — outer catch receives only Error instances
 *   • symphony-interactive.ts 140, 155, 221, 439, 457, 477 — rethrow on non-DirectoryNotAllowedError
 *   • symphony-interactive.ts 163, 505, 598+, 639+, 708, 747, 990, 1011+ — require spawning Claude
 *   • symphony-interactive.ts 1056, 1081, 1083, 1086 — inside generateCommitWithClaude
 *   • symphony-plan-loop.ts 402 third branch (isProcessRunning returns true) tested via T12
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { JobStore, LocalJob } from "../src/main/jobs/job-store.js";
import type { RetrySpawnDeps } from "../src/main/util/spawn-retry.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerSymphonyInteractiveRoutes } from "../src/server/operations/symphony-interactive.js";
import { registerSymphonyPlanRoutes } from "../src/server/operations/symphony-plan.js";
import { registerSymphonyPlanLoopRoutes } from "../src/server/operations/symphony-plan-loop.js";
import type { ClaudeCodeShellEnvProvider } from "../src/server/otel/claude-code-env.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  pinDefaultWorktreeParentDir,
} from "./helpers/git-gateway-op-harness.js";

// resolveWorktreeDir prefers SYMPHONY_WORKTREE_PARENT_DIR over the default
// dirname(repoPath) branch these fixtures are built for, so pin it unset.
pinDefaultWorktreeParentDir();

// ---------------------------------------------------------------------------
// Module-level stubs
// ---------------------------------------------------------------------------

const stubDeps: RetrySpawnDeps = {
  log: () => {},
  refreshTray: () => {},
  isShuttingDown: () => false,
  delay: () => Promise.resolve(),
};

const stubShellEnv: ClaudeCodeShellEnvProvider = async () => ({});

const { makeTempDir } = createGitOpTempDirs("iss5299-plan-ops-");

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Workspace helper
// ---------------------------------------------------------------------------

/**
 * Creates the standard worktree directory layout so the security boundary
 * check (assertPathAllowed) succeeds:
 *   allowedDir — the sandbox root
 *   repoPath   = allowedDir/repo   (within the root)
 *   worktreeDir = allowedDir/repo-<ticketId>  (sibling, still within root)
 *
 * resolveWorktreeDir(repoPath, ticketId) = path.join(dirname(repoPath),
 *   basename(repoPath) + "-" + sanitized(ticketId))
 * = path.join(allowedDir, "repo-" + sanitized(ticketId))
 * which is inside allowedDir — so assertPathAllowed succeeds.
 */
function makeWorkspace(ticketId = "ISS-123"): {
  allowedDir: string;
  repoPath: string;
  worktreeDir: string;
  workDir: string;
} {
  const allowedDir = makeTempDir();
  const repoPath = path.join(allowedDir, "repo");
  const sanitized = ticketId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  const worktreeDir = path.join(allowedDir, `repo-${sanitized}`);
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  return { allowedDir, repoPath, worktreeDir, workDir };
}

// ---------------------------------------------------------------------------
// Dispatcher factories
// ---------------------------------------------------------------------------

function makePlanDispatcher(allowedDir: string): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerSymphonyPlanRoutes(dispatcher, () => [allowedDir]);
  return dispatcher;
}

function makeLoopDispatcher(
  allowedDir: string,
  opts: {
    getApiKey?: () => string | null;
    jobStore?: JobStore;
  } = {}
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerSymphonyPlanLoopRoutes(
    dispatcher,
    () => [allowedDir],
    opts.getApiKey ?? (() => "sk_test_key"),
    () => "http://localhost:3002",
    opts.jobStore
  );
  return dispatcher;
}

function makeInteractiveDispatcher(allowedDir: string): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerSymphonyInteractiveRoutes(
    dispatcher,
    () => [allowedDir],
    stubDeps,
    stubShellEnv
  );
  return dispatcher;
}

// ---------------------------------------------------------------------------
// Custom job-store builder
// ---------------------------------------------------------------------------

const TEST_NOW = "2024-01-01T00:00:00.000Z";

function makeJobStoreWithEntry(
  loopId: string,
  extra: Partial<LocalJob> = {}
): { jobStore: JobStore; upserted: LocalJob[] } {
  const baseJob: LocalJob = {
    id: loopId,
    kind: "SYMPHONY_LOOP",
    loopId,
    command: LoopCommand.Plan,
    status: "RUNNING",
    startedAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...extra,
  };
  const jobs = new Map<string, LocalJob>([[loopId, baseJob]]);
  const upserted: LocalJob[] = [];
  const jobStore = {
    getByLoopId: (id: string) => jobs.get(id),
    getById: (id: string) => jobs.get(id),
    upsert: (j: LocalJob) => {
      jobs.set(j.loopId, j);
      upserted.push(j);
      return j;
    },
    listRunning: () => [],
    listCompleted: () => [],
    reconcile: () => [],
  } as unknown as JobStore;
  return { jobStore, upserted };
}

// ---------------------------------------------------------------------------
// Plan route helper — write plan.json (and optional extra files), dispatch GET
// ---------------------------------------------------------------------------

async function dispatchPlan(
  plan: Record<string, unknown>,
  ticketId = "ISS-MD",
  extraFiles: Record<string, string> = {}
): Promise<{
  statusCode: number;
  content: string;
  body: Record<string, unknown>;
}> {
  const { allowedDir, repoPath, workDir } = makeWorkspace(ticketId);
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, "plan.json"), JSON.stringify(plan));
  for (const [name, content] of Object.entries(extraFiles)) {
    await fs.writeFile(path.join(workDir, name), content);
  }
  const dispatcher = makePlanDispatcher(allowedDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: `/api/gateway/symphony/plan/${ticketId}`,
    query: { repo: repoPath },
  });
  return {
    statusCode: res.statusCode,
    content: String(res.body.content ?? ""),
    body: res.body,
  };
}

// ===========================================================================
// Section 1: symphony-plan.ts — generateMarkdownFromPlan branches
// Lines covered: 105, 137, 141, 146×2, 159×2, 167×2, 175×2, 179×2, 186×2
// ===========================================================================

test("symphony-plan: missing title uses 'Untitled' in generated markdown (line 137 ??)", async () => {
  const result = await dispatchPlan({
    tasks: [{ id: "T1", title: "My Task", description: "Do it" }],
  });
  assert.equal(result.statusCode, 200);
  assert.ok(
    result.content.includes("Untitled"),
    `expected "Untitled" in content, got:\n${result.content}`
  );
});

test("symphony-plan: missing description uses empty string in generated markdown (line 141 ??)", async () => {
  // title present, description absent → ?? returns ""
  const result = await dispatchPlan({
    title: "My Plan",
    tasks: [{ id: "T1", title: "My Task", description: "Do it" }],
  });
  assert.equal(result.statusCode, 200);
  assert.ok(
    result.content.includes("## Summary"),
    "expected ## Summary section in content"
  );
});

test("symphony-plan: architectureDecisions present → section rendered (line 146 true)", async () => {
  const result = await dispatchPlan({
    title: "My Plan",
    description: "A plan",
    architectureDecisions: [
      { decision: "Use REST", reasoning: "Simple and battle-tested" },
    ],
    tasks: [{ id: "T1", title: "Task", description: "Desc" }],
  });
  assert.equal(result.statusCode, 200);
  assert.ok(
    result.content.includes("## Architecture Decisions"),
    "expected ## Architecture Decisions in content"
  );
  assert.ok(result.content.includes("Use REST"));
  assert.ok(result.content.includes("Simple and battle-tested"));
});

test("symphony-plan: task with subtasks → Subtasks rendered (line 159 true)", async () => {
  const result = await dispatchPlan({
    tasks: [
      {
        id: "T1",
        title: "Task",
        description: "Desc",
        subtasks: ["Step A", "Step B"],
      },
    ],
  });
  assert.equal(result.statusCode, 200);
  assert.ok(
    result.content.includes("**Subtasks:**"),
    "expected **Subtasks:** in content"
  );
  assert.ok(result.content.includes("Step A"));
});

test("symphony-plan: task with acceptanceCriteria → Acceptance Criteria rendered (line 167 true)", async () => {
  const result = await dispatchPlan({
    tasks: [
      {
        id: "T1",
        title: "Task",
        description: "Desc",
        acceptanceCriteria: ["The thing works", "Tests pass"],
      },
    ],
  });
  assert.equal(result.statusCode, 200);
  assert.ok(
    result.content.includes("**Acceptance Criteria:**"),
    "expected **Acceptance Criteria:** in content"
  );
  assert.ok(result.content.includes("The thing works"));
});

test("symphony-plan: task with files → Files rendered (line 175 true)", async () => {
  const result = await dispatchPlan({
    tasks: [
      {
        id: "T1",
        title: "Task",
        description: "Desc",
        files: ["src/foo.ts", "src/bar.ts"],
      },
    ],
  });
  assert.equal(result.statusCode, 200);
  assert.ok(
    result.content.includes("**Files:**"),
    "expected **Files:** in content"
  );
  assert.ok(result.content.includes("src/foo.ts"));
});

test("symphony-plan: task with dependencies → Dependencies rendered (line 179 true)", async () => {
  const result = await dispatchPlan({
    tasks: [
      {
        id: "T1",
        title: "Task",
        description: "Desc",
        dependencies: ["T0"],
      },
    ],
  });
  assert.equal(result.statusCode, 200);
  assert.ok(
    result.content.includes("**Dependencies:**"),
    "expected **Dependencies:** in content"
  );
  assert.ok(result.content.includes("T0"));
});

test("symphony-plan: openQuestions present → Open Questions rendered (line 186 true)", async () => {
  const result = await dispatchPlan({
    tasks: [{ id: "T1", title: "Task", description: "Desc" }],
    openQuestions: ["How do we handle X?", "Who owns this?"],
  });
  assert.equal(result.statusCode, 200);
  assert.ok(
    result.content.includes("## Open Questions"),
    "expected ## Open Questions in content"
  );
  assert.ok(result.content.includes("How do we handle X?"));
});

test("symphony-plan: plan.md fallback with undefined title — ?? null branch (line 105)", async () => {
  // plan.json has no title → plan.title is undefined → String(undefined ?? '') = ''
  // planTitle = '' → condition (planTitle && ...) is false → plan.md NOT used
  // No tasks → markdownContent stays '' → response content is ''
  const result = await dispatchPlan({}, "ISS-PM", {
    "plan.md": "# Some Plan\n\nFull content here.",
  });
  assert.equal(result.statusCode, 200);
  assert.equal(typeof result.content, "string");
  assert.ok(
    !result.content.includes("Some Plan"),
    "plan.md should not be used because planTitle is empty"
  );
});

// ===========================================================================
// Section 2: symphony-plan-loop.ts — cancel handler branches
// Lines covered: 380, 391×2, 402×3, 411, 428, 452, 487
// ===========================================================================

// Shared cancel dispatch helper: sets fetch mock, dispatches, restores fetch.
function dispatchCancel(
  allowedDir: string,
  repoPath: string,
  loopId: string,
  opts: {
    fetchMock?: typeof globalThis.fetch;
    jobStore?: JobStore;
    getApiKey?: () => string | null;
  } = {}
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  globalThis.fetch =
    opts.fetchMock ??
    (async () => new Response(JSON.stringify({}), { status: 200 }));
  const dispatcher = makeLoopDispatcher(allowedDir, {
    getApiKey: opts.getApiKey,
    jobStore: opts.jobStore,
  });
  return dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/plan-loop/ISS-CANCEL/cancel",
    body: JSON.stringify({ repoPath, loopId }),
  });
}

test("cancel: fetch rejects with non-Error string → 502 with String(err) in error (line 380 false branch)", async () => {
  const allowedDir = makeTempDir();
  const repoPath = path.join(allowedDir, "repo");

  const res = await dispatchCancel(allowedDir, repoPath, "loop-str-err", {
    fetchMock: () =>
      Promise.reject("network-string-error") as Promise<Response>,
  });

  assert.equal(res.statusCode, 502);
  assert.ok(
    String(res.body.error).includes("network-string-error"),
    `expected 'network-string-error' in error, got: ${String(res.body.error)}`
  );
});

test("cancel: job has worktreeDir → reassigns worktreeDir (lines 391 true, 402 null branch, 411 true)", async () => {
  // Job is in store with worktreeDir set → line 391 TRUE branch fires.
  // job.worktreeDir has no pid file → readProcessPidSync = null.
  // job.pid is undefined → job?.pid != null evaluates to false (line 402 sub-branch 1).
  // pid stays null → existingJob found → upsert CANCEL_PENDING (line 411 true).
  const allowedDir = makeTempDir();
  const repoPath = path.join(allowedDir, "repo");
  const loopId = "loop-with-wt";
  const customWt = path.join(allowedDir, "custom-worktree");
  const { jobStore, upserted } = makeJobStoreWithEntry(loopId, {
    worktreeDir: customWt,
  });

  const res = await dispatchCancel(allowedDir, repoPath, loopId, {
    jobStore,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cancelled, true);
  assert.equal(res.body.warning, "process-unknown");
  assert.ok(
    upserted.length > 0,
    "expected upsert to be called for CANCEL_PENDING"
  );
  assert.equal(upserted.at(-1)?.status, "CANCEL_PENDING");
});

test("cancel: job pid non-null + stateful kill mock → pid set via job store (line 402 sub-branch 3), SIGTERM throws → catch at 487", async () => {
  // No PID file → readProcessPidSync = null.
  // Job in store with pid=99999.
  // First isProcessRunning(99999) call → mock returns true → pid = 99999.
  // process.kill(-99999, SIGTERM) → mock throws → catch at line 487.
  // isProcessRunning(99999) again → mock throws → alive=false → {cancelled: true}.
  const allowedDir = makeTempDir();
  const repoPath = path.join(allowedDir, "repo");
  const loopId = "loop-job-running";
  const { jobStore } = makeJobStoreWithEntry(loopId, { pid: 99_999 });

  let livenessCalls = 0;
  const origKill = process.kill.bind(process);
  Reflect.set(
    process,
    "kill",
    (_pid: number, signal?: string | number | NodeJS.Signals): true => {
      if (signal === 0) {
        livenessCalls++;
        if (livenessCalls === 1) {
          return true; // first check: "process exists"
        }
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      // SIGTERM or SIGKILL: throw immediately (process gone at signal send)
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    }
  );

  try {
    const res = await dispatchCancel(allowedDir, repoPath, loopId, {
      jobStore,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cancelled, true);
    assert.ok(
      !res.body.warning,
      `expected no warning, got: ${String(res.body.warning)}`
    );
    assert.ok(livenessCalls >= 2, "expected at least 2 liveness calls");
  } finally {
    Reflect.set(process, "kill", origKill);
  }
});

test("cancel: PID file present, SIGTERM succeeds, liveness check throws → processGone → 200 (lines 428 try, 452 catch)", {
  timeout: 5000,
}, async () => {
  // readProcessPidSync reads 99999 from the pid file → pid = 99999.
  // Mock: SIGTERM returns true (succeeds). kill(pid, 0) → throws → catch at 452 → processGone.
  // Response: {cancelled: true} with no warning.
  const allowedDir = makeTempDir();
  const repoPath = path.join(allowedDir, "repo");
  const worktreeDir = path.join(allowedDir, "repo-ISS-CANCEL");
  const pidDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(pidDir, { recursive: true });
  await fs.writeFile(path.join(pidDir, "process.pid"), "99999");

  const origKill = process.kill.bind(process);
  Reflect.set(
    process,
    "kill",
    (_pid: number, signal?: string | number | NodeJS.Signals): true => {
      if (signal === 0) {
        // All liveness checks see the process as gone
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      // SIGTERM / SIGKILL: succeed silently (kills the process)
      return true;
    }
  );

  try {
    const res = await dispatchCancel(allowedDir, repoPath, "loop-sigterm-gone");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cancelled, true);
    assert.ok(
      !res.body.warning,
      `expected no warning, got: ${String(res.body.warning)}`
    );
  } finally {
    Reflect.set(process, "kill", origKill);
  }
});

test("cancel: job pid out-of-range → isProcessRunning false → pid stays null → CANCEL_PENDING (line 402 sub-branch 2, line 411 true)", async () => {
  // No PID file → readProcessPidSync = null.
  // Job has pid=99999999 (out-of-range PID → kernel EINVAL/ESRCH → isProcessRunning=false).
  // pid stays null → getByLoopId again → existingJob non-null → upsert CANCEL_PENDING.
  const allowedDir = makeTempDir();
  const repoPath = path.join(allowedDir, "repo");
  const loopId = "loop-dead-pid";
  const { jobStore, upserted } = makeJobStoreWithEntry(loopId, {
    pid: 99_999_999,
  });

  const res = await dispatchCancel(allowedDir, repoPath, loopId, {
    jobStore,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cancelled, true);
  assert.equal(res.body.warning, "process-unknown");
  assert.ok(upserted.length > 0, "expected upsert to be called");
  assert.equal(upserted.at(-1)?.status, "CANCEL_PENDING");
});

// ===========================================================================
// Section 3: symphony-interactive.ts accessible branches
// Lines covered: 115, 132, 224, 995
// ===========================================================================

test("chat: contextRepoPaths is an array → array branch taken, disallowed context repo → 403 (lines 115, 132)", async () => {
  // Line 115: Array.isArray(body.contextRepoPaths) → TRUE branch.
  // Line 132: for-loop iterates; first contextRepoPath ("/etc") fails assertRepoAllowed → 403.
  const tmpDir = makeTempDir();
  const dispatcher = makeInteractiveDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/chat/ISS-CTX",
    body: JSON.stringify({
      message: "hello",
      repoPath: tmpDir,
      contextRepoPaths: ["/etc"],
    }),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

test("comment-chat GET: valid ticketId + repo → 200 with empty history (line 224)", async () => {
  // Line 224: getCommentHistoryPath(ticketId, expandedRepoPath, commentId) is reached
  // because assertRepoAllowed succeeds. No history file → default {messages: []} returned.
  const allowedDir = makeTempDir();
  const repoPath = path.join(allowedDir, "repo");
  const dispatcher = makeInteractiveDispatcher(allowedDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/comment-chat/c-abc",
    query: { ticketId: "ISS-5555", repo: repoPath },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.messages), "expected messages array");
  assert.deepEqual(res.body.messages, []);
  assert.equal(res.body.ticketId, "ISS-5555");
});

test("commit-message: worktreeDir exists but no git repo → getGitDiff catch → 200 default (line 995)", async () => {
  // worktreeDir exists (existsSync = true) but has no .git directory.
  // execSync("git diff HEAD ...") throws → catch at line 995 → getGitDiff returns "".
  // if (!diff) → true → json(200, {title: "Work on ...", source: "default"}).
  const allowedDir = makeTempDir();
  const repoPath = path.join(allowedDir, "repo");
  const worktreeDir = path.join(allowedDir, "repo-ISS-CM");
  await fs.mkdir(worktreeDir, { recursive: true });

  const dispatcher = makeInteractiveDispatcher(allowedDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/commit-message/ISS-CM",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, "default");
  assert.equal(res.body.title, "Work on ISS-CM");
});
