/**
 * ISS-5299 — Branch coverage for symphony-kill, symphony-upload, and
 * run-viewer-extract gateway operations.
 *
 * Exists as a separate file because all three operations lack a dedicated
 * suite and appending to the grandfathered gateway-server.test.ts is
 * prohibited by the shrink-only constraint.
 *
 * Unreachable branches (reported rather than tested):
 *   - symphony-kill.ts line 166 (outer catch): unreachable; resolvePid only
 *     re-throws non-DirectoryNotAllowedError from assertPathAllowed, which
 *     itself only throws DirectoryNotAllowedError.
 *   - symphony-kill.ts line 196 (rethrow in resolvePid catch): same reason.
 *   - symphony-kill.ts line 241 (catch in cancelLoop): requires existsSync or
 *     unlinkSync to throw — unreachable without filesystem-level errors.
 *   - symphony-kill.ts line 287 (catch in markStateAsStopped): same reason.
 *   - symphony-upload.ts line 129 (EXT_MAP ?? fallback): unreachable because
 *     ALLOWED_TYPES and EXT_MAP cover the same key-set; any file that passes
 *     ALLOWED_TYPES.has() always resolves in EXT_MAP.
 *   - run-viewer-extract.ts line 139 (__MACOSX/.DS_Store skip): only reachable
 *     via the unzip happy path, which the brief explicitly prohibits testing.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { vi } from "vitest";
import type { JobStore, LocalJob } from "../src/main/jobs/job-store.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerRunViewerExtractRoutes } from "../src/server/operations/run-viewer-extract.js";
import { registerSymphonyKillRoutes } from "../src/server/operations/symphony-kill.js";
import { registerSymphonyUploadRoutes } from "../src/server/operations/symphony-upload.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

// ─── Temp-dir factory (registers its own afterEach for cleanup) ───────────────
const { makeTempDir } = createGitOpTempDirs("iss5299-kill-upload-");

// ─── Restore mocked methods after every test ────────────────────────────────
afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Multipart body builder ─────────────────────────────────────────────────
const MULTIPART_BOUNDARY = "TestBoundaryISS5299";
const CRLF = "\r\n";

// ─── Module-level regex constants (useTopLevelRegex requirement) ─────────────
const RE_EITHER_PID_OR_TICKET =
  /Either pid or \(ticketId \+ repoPath\) is required/;
const RE_NO_PROCESS_TO_KILL = /No process to kill/;
const RE_PROCESS_ALREADY_TERMINATED = /Process already terminated/;
const RE_PROCESS_TERMINATED = /Process terminated/;
const RE_FAILED_TO_KILL = /Failed to kill process/;
const RE_FILE_TYPE_NOT_ALLOWED = /File type not allowed/;
const RE_FILE_TOO_LARGE = /File too large/;
const RE_PNG_EXT = /\.png$/;
const RE_ATTACHMENTS_API_URL = /\/api\/gateway\/symphony\/attachments\//;

function buildMultipartBody(
  files: Array<{
    fieldName: string;
    fileName: string;
    mimeType: string;
    content: string;
  }>
): string {
  const parts: string[] = [];
  for (const f of files) {
    parts.push(
      `--${MULTIPART_BOUNDARY}${CRLF}` +
        `Content-Disposition: form-data; name="${f.fieldName}"; filename="${f.fileName}"${CRLF}` +
        `Content-Type: ${f.mimeType}${CRLF}` +
        `${CRLF}` +
        f.content +
        CRLF
    );
  }
  parts.push(`--${MULTIPART_BOUNDARY}--${CRLF}`);
  return parts.join("");
}

// ─── Minimal JobStore fake ───────────────────────────────────────────────────
type UpsertRecord = { upserted: LocalJob[] };

function makeFakeJobStore(
  runningJobs: LocalJob[] = [],
  tracking: UpsertRecord = { upserted: [] }
): JobStore {
  return {
    listRunning: () => [...runningJobs],
    upsert(job: LocalJob): LocalJob {
      tracking.upserted.push(job);
      return job;
    },
    getById: () => undefined,
    getByLoopId: () => undefined,
    listCompleted: () => [],
    reconcile: () => [],
  } as unknown as JobStore;
}

function makeJob(overrides: Partial<LocalJob> = {}): LocalJob {
  const now = new Date().toISOString();
  return {
    id: "job-test-1",
    kind: "SYMPHONY_LOOP",
    loopId: "loop-test-1",
    command: "EXECUTE",
    status: "RUNNING",
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — line 68: invalid JSON body → 400
// ════════════════════════════════════════════════════════════════════════════

test("kill: returns 400 for invalid JSON body", async () => {
  const dispatcher = new OperationDispatcher();
  registerSymphonyKillRoutes(dispatcher, () => []);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/kill",
    body: "not-valid-json{{{",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid JSON body");
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — line 224: neither pid nor ticketId+repoPath → 400
// (also covers lines 179, 180, 181 false paths — body fields are not the
//  expected types)
// ════════════════════════════════════════════════════════════════════════════

test("kill: returns 400 when body has neither pid nor ticketId+repoPath", async () => {
  const dispatcher = new OperationDispatcher();
  registerSymphonyKillRoutes(dispatcher, () => []);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/kill",
    body: JSON.stringify({}),
  });

  assert.equal(res.statusCode, 400);
  assert.match(String(res.body.error), RE_EITHER_PID_OR_TICKET);
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — line 183 (×2, &&-chain), 180, 181 true paths, 224: repoPath
// outside allowed directories → 403
// ════════════════════════════════════════════════════════════════════════════

test("kill: returns 403 when repoPath is outside allowed directories", async () => {
  const dispatcher = new OperationDispatcher();
  // ticketId (string) + repoPath (string) are provided, covering lines 180 and
  // 181 true paths; the path fails the security check → 403.
  registerSymphonyKillRoutes(dispatcher, () => ["/tmp/some-allowed-dir"]);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/kill",
    body: JSON.stringify({
      ticketId: "TST-001",
      repoPath: "/not/allowed/repo",
    }),
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — line 206 (noPidFile), line 28 false path (pid is null in
// findJobForKill), line 259 (for-loop body in clearAgentTypes via
// markStateAsStopped)
// ════════════════════════════════════════════════════════════════════════════

test("kill: returns 200 noPidFile path; markJobStopped with null pid skips upsert; clearAgentTypes iterates files", async () => {
  const repoDir = makeTempDir();
  // Sub-directory used as the actual repo path so it is a child of repoDir.
  const subRepo = path.join(repoDir, "my-repo");
  mkdirSync(subRepo);

  // Point worktree parent inside repoDir so the attachments path stays within
  // the allowed sandbox. resolveWorktreeDir uses SYMPHONY_WORKTREE_PARENT_DIR.
  const savedEnv = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = repoDir;

  // Create a worktreeDir + an .agent-types file so clearAgentTypes iterates
  // at least one entry, exercising line 259 path 0.
  const worktreeDir = path.join(repoDir, "my-repo-TST-001");
  const agentTypesDir = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    ".agent-types"
  );
  mkdirSync(agentTypesDir, { recursive: true });
  writeFileSync(path.join(agentTypesDir, "claude"), "agent", "utf-8");

  const tracking: UpsertRecord = { upserted: [] };
  const jobStore = makeFakeJobStore([], tracking);

  const dispatcher = new OperationDispatcher();
  // Allowed dir is repoDir (parent of subRepo), so subRepo is allowed.
  registerSymphonyKillRoutes(dispatcher, () => [repoDir], jobStore);

  try {
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/kill",
      body: JSON.stringify({ ticketId: "TST-001", repoPath: subRepo }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.match(String(res.body.message), RE_NO_PROCESS_TO_KILL);
    // pid is null in findJobForKill call → running list is empty → no upsert.
    assert.equal(tracking.upserted.length, 0);
    // clearAgentTypes deleted the agent-type file.
    assert.equal(existsSync(path.join(agentTypesDir, "claude")), false);
  } finally {
    restoreEnvVars(savedEnv);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — line 211: NaN in process.pid file → 500
// ════════════════════════════════════════════════════════════════════════════

test("kill: returns 500 when process.pid file contains non-numeric content", async () => {
  const repoDir = makeTempDir();
  const subRepo = path.join(repoDir, "my-repo");
  mkdirSync(subRepo);

  const savedEnv = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = repoDir;

  // Create worktreeDir + process.pid with non-numeric content.
  const worktreeDir = path.join(repoDir, "my-repo-TST-002");
  const pidDir = path.join(worktreeDir, ".closedloop-ai", "work");
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(path.join(pidDir, "process.pid"), "not-a-number", "utf-8");

  const dispatcher = new OperationDispatcher();
  registerSymphonyKillRoutes(dispatcher, () => [repoDir]);

  try {
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/kill",
      body: JSON.stringify({ ticketId: "TST-002", repoPath: subRepo }),
    });

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, "Invalid PID in process.pid file");
  } finally {
    restoreEnvVars(savedEnv);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — line 90 (worktreeDir=null path), line 37 (findJobForKill
// return undefined), line 179 true path (pid is a number)
// Process is already dead (PID 999_999_999) and jobStore has no matching job.
// ════════════════════════════════════════════════════════════════════════════

test("kill: returns 200 when process already dead; findJobForKill returns undefined for pid-only path with empty store", async () => {
  const tracking: UpsertRecord = { upserted: [] };
  const jobStore = makeFakeJobStore([], tracking);

  const dispatcher = new OperationDispatcher();
  registerSymphonyKillRoutes(dispatcher, () => [], jobStore);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/kill",
    // pid is a number → covers line 179 true path; pid=999_999_999 is
    // guaranteed not running on any test machine → kill(pid, 0) throws ESRCH.
    body: JSON.stringify({ pid: 999_999_999 }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.match(String(res.body.message), RE_PROCESS_ALREADY_TERMINATED);
  // findJobForKill: pid != null → enters block (line 28 true path); no match
  // in empty store → falls through; worktreeDir is null → skips second block;
  // returns undefined (line 37) → no upsert.
  assert.equal(tracking.upserted.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — line 28 true path (pid != null → job found), upsert called
// ════════════════════════════════════════════════════════════════════════════

test("kill: upserts matching job as STOPPED when pid matches a running job", async () => {
  const targetPid = 999_999_999;
  const job = makeJob({ pid: targetPid });
  const tracking: UpsertRecord = { upserted: [] };
  const jobStore = makeFakeJobStore([job], tracking);

  const dispatcher = new OperationDispatcher();
  registerSymphonyKillRoutes(dispatcher, () => [], jobStore);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/kill",
    body: JSON.stringify({ pid: targetPid }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  // findJobForKill found the job by pid → markJobStopped upserted it.
  assert.equal(tracking.upserted.length, 1);
  assert.equal(tracking.upserted[0].status, "STOPPED");
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — SIGKILL escalation: process survives SIGTERM inner check
// (covers line 90 worktreeDir=null path; mock keeps process alive so the
// inner kill(pid,0) succeeds and SIGKILL is issued)
// NOTE: the 500ms production sleep makes this test take ≥500ms.
// ════════════════════════════════════════════════════════════════════════════

test("kill: process survives SIGTERM; SIGKILL issued; returns 200 Process terminated", {
  timeout: 5000,
}, async () => {
  // Mock process.kill so all calls succeed — the inner kill(pid,0) liveness
  // check does not throw, which causes SIGKILL to be sent (line 118).
  vi.spyOn(process, "kill").mockImplementation(
    (_pid: number, _signal?: string | number) => true
  );

  const dispatcher = new OperationDispatcher();
  registerSymphonyKillRoutes(dispatcher, () => []);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/kill",
    // Use a low PID that may or may not exist; the mocked kill handles it.
    body: JSON.stringify({ pid: 99_999 }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.match(String(res.body.message), RE_PROCESS_TERMINATED);
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — ESRCH during SIGTERM: process dies between liveness check
// and SIGTERM; catch branch with ESRCH returns 200 "Process already terminated"
// NOTE: the 500ms production sleep makes this test take ≥500ms.
// ════════════════════════════════════════════════════════════════════════════

test("kill: ESRCH on SIGTERM returns 200 Process already terminated", {
  timeout: 5000,
}, async () => {
  let callCount = 0;
  vi.spyOn(process, "kill").mockImplementation(
    (pid: number, signal?: string | number) => {
      callCount += 1;
      // Call 1: kill(pid, 0) liveness check — succeed (process alive).
      // Call 2: kill(-pid, "SIGTERM") — throw ESRCH (process died first).
      if (callCount === 2 && signal === "SIGTERM") {
        const err = Object.assign(new Error(`kill ESRCH ${pid}`), {
          code: "ESRCH",
        });
        throw err;
      }
      // `process.kill` returns `true` in Node; node:test's mock.method let this
      // stub fall off the end and return undefined, which Vitest's typing
      // rejects because it does not match the method it is replacing.
      return true;
    }
  );

  const dispatcher = new OperationDispatcher();
  registerSymphonyKillRoutes(dispatcher, () => []);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/kill",
    body: JSON.stringify({ pid: 99_999 }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.match(String(res.body.message), RE_PROCESS_ALREADY_TERMINATED);
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-kill — non-ESRCH error on SIGTERM → 500
// NOTE: the 500ms production sleep makes this test take ≥500ms.
// ════════════════════════════════════════════════════════════════════════════

test("kill: non-ESRCH error on SIGTERM returns 500", {
  timeout: 5000,
}, async () => {
  let callCount = 0;
  vi.spyOn(process, "kill").mockImplementation(
    (pid: number, signal?: string | number) => {
      callCount += 1;
      // Call 1: liveness check — succeed.
      // Call 2: SIGTERM — throw a non-ESRCH error.
      if (callCount === 2 && signal === "SIGTERM") {
        throw Object.assign(new Error(`EPERM operation not permitted ${pid}`), {
          code: "EPERM",
        });
      }
      return true;
    }
  );

  const dispatcher = new OperationDispatcher();
  registerSymphonyKillRoutes(dispatcher, () => []);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/kill",
    body: JSON.stringify({ pid: 99_999 }),
  });

  assert.equal(res.statusCode, 500);
  assert.match(String(res.body.error), RE_FAILED_TO_KILL);
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-upload — line 53: repoPath outside allowed directories → 403
// ════════════════════════════════════════════════════════════════════════════

test("upload: returns 403 when repoPath is outside allowed directories", async () => {
  const dispatcher = new OperationDispatcher();
  registerSymphonyUploadRoutes(dispatcher, () => ["/tmp/allowed-only"]);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/upload/TST-001",
    query: { repo: "/not/allowed" },
    body: "",
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-upload — line 62: worktreeDir does not exist → 404
// ════════════════════════════════════════════════════════════════════════════

test("upload: returns 404 when work directory does not exist", async () => {
  const repoDir = makeTempDir();

  const savedEnv = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  // Point worktree parent inside repoDir so the attachments path stays
  // within the allowed sandbox — but do NOT create the worktreeDir so
  // existsSync(worktreeDir) returns false.
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = repoDir;

  const dispatcher = new OperationDispatcher();
  registerSymphonyUploadRoutes(dispatcher, () => [repoDir]);

  try {
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/upload/NOTEXIST-001",
      query: { repo: repoDir },
      body: "",
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, "Work directory not found");
  } finally {
    restoreEnvVars(savedEnv);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-upload — line 75: attachmentsDir outside allowed directories → 403
//
// The worktreeDir is a SIBLING of repoDir (resolveWorktreeDir uses the parent
// of expandedRepoPath as its parent dir when SYMPHONY_WORKTREE_PARENT_DIR is
// unset). If allowedDirs = [repoDir], attachmentsDir (inside the sibling
// worktreeDir) is not a child of repoDir → assertPathAllowed throws → 403.
// ════════════════════════════════════════════════════════════════════════════

test("upload: returns 403 when attachments directory is outside allowed directories", async () => {
  const parentDir = makeTempDir();
  const repoDir = path.join(parentDir, "my-repo");
  mkdirSync(repoDir);

  // worktreeDir = parentDir/my-repo-TST-003 (sibling of repoDir)
  const worktreeDir = path.join(parentDir, "my-repo-TST-003");
  mkdirSync(worktreeDir);

  // Do NOT set SYMPHONY_WORKTREE_PARENT_DIR — let resolveWorktreeDir use
  // path.dirname(repoDir) = parentDir, which makes worktreeDir a sibling.
  const savedEnv = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  if (process.env.SYMPHONY_WORKTREE_PARENT_DIR) {
    delete process.env.SYMPHONY_WORKTREE_PARENT_DIR;
  }

  const dispatcher = new OperationDispatcher();
  // Only repoDir is allowed — attachmentsDir inside the sibling worktreeDir
  // will not pass the security check.
  registerSymphonyUploadRoutes(dispatcher, () => [repoDir]);

  try {
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/upload/TST-003",
      query: { repo: repoDir },
      body: "",
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "directory not allowed");
  } finally {
    restoreEnvVars(savedEnv);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-upload — line 85: content-type is not multipart → 400
// ════════════════════════════════════════════════════════════════════════════

test("upload: returns 400 when content-type is not multipart/form-data", async () => {
  const repoDir = makeTempDir();

  const savedEnv = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = repoDir;

  // Create the worktreeDir so we pass the existsSync check.
  const worktreeDir = path.join(repoDir, `${path.basename(repoDir)}-TST-004`);
  mkdirSync(worktreeDir);

  const dispatcher = new OperationDispatcher();
  registerSymphonyUploadRoutes(dispatcher, () => [repoDir]);

  try {
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/upload/TST-004",
      query: { repo: repoDir },
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Invalid form data");
  } finally {
    restoreEnvVars(savedEnv);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-upload — line 93: parseMultipartFiles rejects (no boundary) → 400
// ════════════════════════════════════════════════════════════════════════════

test("upload: returns 400 when multipart has no boundary (Busboy rejects)", async () => {
  const repoDir = makeTempDir();

  const savedEnv = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = repoDir;

  const worktreeDir = path.join(repoDir, `${path.basename(repoDir)}-TST-005`);
  mkdirSync(worktreeDir);

  const dispatcher = new OperationDispatcher();
  registerSymphonyUploadRoutes(dispatcher, () => [repoDir]);

  try {
    // content-type includes "multipart/form-data" (passes line 85 check) but
    // has no boundary parameter → Busboy throws "Boundary not found" → catch
    // at line 93 → 400.
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/upload/TST-005",
      query: { repo: repoDir },
      headers: { "content-type": "multipart/form-data" },
      body: "garbage",
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Invalid form data");
  } finally {
    restoreEnvVars(savedEnv);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-upload — line 98: parseMultipartFiles returns empty array → 400
// ════════════════════════════════════════════════════════════════════════════

test("upload: returns 400 when multipart body contains no file parts", async () => {
  const repoDir = makeTempDir();

  const savedEnv = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = repoDir;

  const worktreeDir = path.join(repoDir, `${path.basename(repoDir)}-TST-006`);
  mkdirSync(worktreeDir);

  const dispatcher = new OperationDispatcher();
  registerSymphonyUploadRoutes(dispatcher, () => [repoDir]);

  // Multipart body with only a text field — no file parts → empty files[].
  const body =
    `--${MULTIPART_BOUNDARY}${CRLF}` +
    `Content-Disposition: form-data; name="not-a-file"${CRLF}` +
    `${CRLF}` +
    `some value${CRLF}` +
    `--${MULTIPART_BOUNDARY}--${CRLF}`;

  try {
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/upload/TST-006",
      query: { repo: repoDir },
      headers: {
        "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
      body,
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "No image files provided");
  } finally {
    restoreEnvVars(savedEnv);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-upload — line 112: disallowed MIME type → 400
// ════════════════════════════════════════════════════════════════════════════

test("upload: returns 400 when file has a disallowed MIME type", async () => {
  const repoDir = makeTempDir();

  const savedEnv = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = repoDir;

  const worktreeDir = path.join(repoDir, `${path.basename(repoDir)}-TST-007`);
  mkdirSync(worktreeDir);

  const dispatcher = new OperationDispatcher();
  registerSymphonyUploadRoutes(dispatcher, () => [repoDir]);

  const body = buildMultipartBody([
    {
      fieldName: "file",
      fileName: "doc.pdf",
      mimeType: "application/pdf",
      content: "%PDF-1.4 fake",
    },
  ]);

  try {
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/upload/TST-007",
      query: { repo: repoDir },
      headers: {
        "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
      body,
    });

    assert.equal(res.statusCode, 400);
    assert.match(String(res.body.error), RE_FILE_TYPE_NOT_ALLOWED);
  } finally {
    restoreEnvVars(savedEnv);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-upload — line 119: file exceeds MAX_FILE_SIZE → 400
// ════════════════════════════════════════════════════════════════════════════

test("upload: returns 400 when file exceeds max size", async () => {
  const repoDir = makeTempDir();

  const savedEnv = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = repoDir;

  const worktreeDir = path.join(repoDir, `${path.basename(repoDir)}-TST-008`);
  mkdirSync(worktreeDir);

  const dispatcher = new OperationDispatcher();
  registerSymphonyUploadRoutes(dispatcher, () => [repoDir]);

  // Build a body where the content exceeds 10 MB (MAX_FILE_SIZE = 10 * 1024 * 1024).
  // Using a string of repeated 'x' characters — 11 MB worth.
  const oversizedContent = "x".repeat(11 * 1024 * 1024);
  const body = buildMultipartBody([
    {
      fieldName: "file",
      fileName: "big.png",
      mimeType: "image/png",
      content: oversizedContent,
    },
  ]);

  try {
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/upload/TST-008",
      query: { repo: repoDir },
      headers: {
        "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
      body,
    });

    assert.equal(res.statusCode, 400);
    assert.match(String(res.body.error), RE_FILE_TOO_LARGE);
  } finally {
    restoreEnvVars(savedEnv);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// symphony-upload — line 129 (ext lookup via EXT_MAP), successful 200 response
//
// NOTE: symphony-upload.ts line 180 path 0 (`filename || "file"` fallback) is
// unreachable via this route — Busboy treats parts with filename="" as field
// events rather than file events, so the file handler never fires for an empty
// filename and `originalName` is never set to the "file" default.
// ════════════════════════════════════════════════════════════════════════════

test("upload: saves file and returns 200 with saved file list", async () => {
  const repoDir = makeTempDir();

  const savedEnv = saveEnvVars(["SYMPHONY_WORKTREE_PARENT_DIR"]);
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = repoDir;

  const worktreeDir = path.join(repoDir, `${path.basename(repoDir)}-TST-009`);
  mkdirSync(worktreeDir);

  const dispatcher = new OperationDispatcher();
  registerSymphonyUploadRoutes(dispatcher, () => [repoDir]);

  // Use ASCII content — the handler validates MIME type, not raw file bytes.
  const body = buildMultipartBody([
    {
      fieldName: "file",
      fileName: "photo.png",
      mimeType: "image/png",
      content: "PNG_FAKE_DATA_FOR_TESTING",
    },
  ]);

  try {
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/upload/TST-009",
      query: { repo: repoDir },
      headers: {
        "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
      body,
    });

    assert.equal(res.statusCode, 200);
    const files = res.body.files as Array<{
      originalName: string;
      savedName: string;
      apiUrl: string;
      size: number;
    }>;
    assert.equal(Array.isArray(files), true);
    assert.equal(files.length, 1);
    assert.equal(files[0].originalName, "photo.png");
    assert.match(files[0].savedName, RE_PNG_EXT);
    assert.match(files[0].apiUrl, RE_ATTACHMENTS_API_URL);
  } finally {
    restoreEnvVars(savedEnv);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// run-viewer-extract POST — line 31: multipart content-type valid; no zip
// file in body → 400 "No zip file provided"
// ════════════════════════════════════════════════════════════════════════════

test("run-viewer-extract POST: returns 400 when multipart has no zip file", async () => {
  const dispatcher = new OperationDispatcher();
  registerRunViewerExtractRoutes(dispatcher);

  // Send a valid multipart body but with a text/plain file — parseZipUpload
  // skips non-application/zip files → uploaded remains null → 400.
  const body = buildMultipartBody([
    {
      fieldName: "file",
      fileName: "run.txt",
      mimeType: "text/plain",
      content: "not a zip",
    },
  ]);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/run-viewer-extract",
    headers: {
      "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
    },
    body,
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "No zip file provided");
});

// ════════════════════════════════════════════════════════════════════════════
// run-viewer-extract POST — content-type is not multipart → 400
// ════════════════════════════════════════════════════════════════════════════

test("run-viewer-extract POST: returns 400 when content-type is not multipart", async () => {
  const dispatcher = new OperationDispatcher();
  registerRunViewerExtractRoutes(dispatcher);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/run-viewer-extract",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid form data");
});

// ════════════════════════════════════════════════════════════════════════════
// run-viewer-extract DELETE — line 85: invalid JSON body → 400
// ════════════════════════════════════════════════════════════════════════════

test("run-viewer-extract DELETE: returns 400 for invalid JSON body", async () => {
  const dispatcher = new OperationDispatcher();
  registerRunViewerExtractRoutes(dispatcher);

  const res = await dispatchOperation({
    dispatcher,
    method: "DELETE",
    pathname: "/api/gateway/run-viewer-extract",
    body: "not-json{{{",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid JSON body");
});

// ════════════════════════════════════════════════════════════════════════════
// run-viewer-extract DELETE — line 90 true path (runDir is string), line 91
// (isValidRunDir fails because runDir contains ".."), line 125 true path
// ════════════════════════════════════════════════════════════════════════════

test("run-viewer-extract DELETE: returns 400 when runDir contains path traversal", async () => {
  const dispatcher = new OperationDispatcher();
  registerRunViewerExtractRoutes(dispatcher);

  const res = await dispatchOperation({
    dispatcher,
    method: "DELETE",
    pathname: "/api/gateway/run-viewer-extract",
    body: JSON.stringify({
      runDir: `${path.join(os.tmpdir(), "run-viewer-")}../evil`,
    }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid runDir");
});

// ════════════════════════════════════════════════════════════════════════════
// run-viewer-extract DELETE — line 91: runDir not a string → 400
// ════════════════════════════════════════════════════════════════════════════

test("run-viewer-extract DELETE: returns 400 when runDir is missing from body", async () => {
  const dispatcher = new OperationDispatcher();
  registerRunViewerExtractRoutes(dispatcher);

  const res = await dispatchOperation({
    dispatcher,
    method: "DELETE",
    pathname: "/api/gateway/run-viewer-extract",
    body: JSON.stringify({}),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid runDir");
});

// ════════════════════════════════════════════════════════════════════════════
// run-viewer-extract GET — line 109: runDir query param missing or invalid
// ════════════════════════════════════════════════════════════════════════════

test("run-viewer-extract GET: returns 400 when runDir query param is missing", async () => {
  const dispatcher = new OperationDispatcher();
  registerRunViewerExtractRoutes(dispatcher);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/run-viewer-extract",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid runDir");
});

// ════════════════════════════════════════════════════════════════════════════
// run-viewer-extract GET — line 114: runDir has valid format but does not
// exist on disk → 404
// ════════════════════════════════════════════════════════════════════════════

test("run-viewer-extract GET: returns 404 when runDir does not exist", async () => {
  const dispatcher = new OperationDispatcher();
  registerRunViewerExtractRoutes(dispatcher);

  // A path with the correct prefix that does not exist on disk. Created via
  // mkdtemp and immediately removed so the name is unique per run — a fixed
  // name would race a concurrent run of this file (stress mode, or the node
  // lane alongside the coverage lane) that creates the same path.
  const runDir = mkdtempSync(
    path.join(os.tmpdir(), "run-viewer-iss5299-gone-")
  );
  rmSync(runDir, { recursive: true, force: true });

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/run-viewer-extract",
    query: { runDir },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "Run directory not found");
});

// ════════════════════════════════════════════════════════════════════════════
// run-viewer-extract DELETE — valid runDir that exists; succeeds with 200
// (exercises the existsSync + rm path for coverage completeness)
// ════════════════════════════════════════════════════════════════════════════

test("run-viewer-extract DELETE: returns 200 and removes directory when runDir exists", async () => {
  const dispatcher = new OperationDispatcher();
  registerRunViewerExtractRoutes(dispatcher);

  // Create a real run-viewer-prefixed tmp directory. mkdtemp, not a fixed
  // name: this test REMOVES the directory, so a concurrent run sharing the
  // name would delete the other run.s fixture out from under it.
  const runDir = mkdtempSync(path.join(os.tmpdir(), "run-viewer-iss5299-del-"));
  writeFileSync(path.join(runDir, "data.json"), "{}", "utf-8");

  const res = await dispatchOperation({
    dispatcher,
    method: "DELETE",
    pathname: "/api/gateway/run-viewer-extract",
    body: JSON.stringify({ runDir }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(existsSync(runDir), false);
});
