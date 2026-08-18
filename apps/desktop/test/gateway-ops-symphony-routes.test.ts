/**
 * ISS-5299 Tier 3 — branch coverage for six symphony-* operation modules:
 *   symphony-logs, symphony-attachments, symphony-judges, symphony-sessions,
 *   symphony-plan, symphony-status.
 *
 * Each test drives a real OperationDispatcher through dispatchOperation() and
 * asserts the status code and parsed response body.  No production source is
 * read as text; all assertions exercise actual runtime behaviour.
 *
 * Unreachable branches (documented, not tested):
 *   • symphony-judges  line 21  — :ticketId route param requires ≥1 char, param is always present
 *   • symphony-plan    line 37  — same
 *   • symphony-status  line 42  — same
 *   • symphony-attachments line 35 — *attachmentPath wildcard compiles to (.+), needs ≥1 char
 *   • symphony-attachments line 63 (path 0) — path.join() never produces trailing path.sep
 *   • symphony-sessions line 265 — assertPathAllowed only throws DirectoryNotAllowedError
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createStubJobStore } from "../src/main/jobs/job-store.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerSymphonyAttachmentsRoutes } from "../src/server/operations/symphony-attachments.js";
import { registerSymphonyJudgesRoutes } from "../src/server/operations/symphony-judges.js";
import { registerSymphonyLogsRoutes } from "../src/server/operations/symphony-logs.js";
import { registerSymphonyPlanRoutes } from "../src/server/operations/symphony-plan.js";
import { registerSymphonySessionRoutes } from "../src/server/operations/symphony-sessions.js";
import { registerSymphonyStatusRoutes } from "../src/server/operations/symphony-status.js";
import { SymphonyDirNotConfiguredError } from "../src/server/operations/symphony-utils.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  pinDefaultWorktreeParentDir,
} from "./helpers/git-gateway-op-harness.js";

// resolveWorktreeDir prefers SYMPHONY_WORKTREE_PARENT_DIR over the default
// dirname(repoPath) branch these fixtures are built for, so pin it unset.
pinDefaultWorktreeParentDir();

// Module-level: createGitOpTempDirs registers its own afterEach cleanup.
const { makeTempDir } = createGitOpTempDirs("iss5299-sym-");

/**
 * Create a temp dir, derive the repo path and worktree dir that the symphony
 * route handlers will compute for ticketId "ISS-123".
 *
 * resolveWorktreeDir(repoPath, "ISS-123") = dirname(repoPath)/<basename(repoPath)>-ISS-123
 */
function makeWorkspace(ticketId = "ISS-123"): {
  allowedDir: string;
  repoPath: string;
  worktreeDir: string;
} {
  const allowedDir = makeTempDir();
  const repoPath = path.join(allowedDir, "repo");
  const worktreeDir = path.join(allowedDir, `repo-${ticketId}`);
  return { allowedDir, repoPath, worktreeDir };
}

// ---------------------------------------------------------------------------
// symphony-logs
// ---------------------------------------------------------------------------

test("symphony-logs: returns 400 when repo param is missing", async () => {
  const dispatcher = new OperationDispatcher();
  registerSymphonyLogsRoutes(dispatcher, () => [makeTempDir()]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/logs/ISS-123",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repo parameter is required");
});

test("symphony-logs: returns 403 when repo is outside allowed directories", async () => {
  const { repoPath } = makeWorkspace();
  const otherDir = makeTempDir();
  const dispatcher = new OperationDispatcher();
  registerSymphonyLogsRoutes(dispatcher, () => [otherDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/logs/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(typeof res.body.error, "string");
});

test("symphony-logs: returns exists:false when no log file exists", async () => {
  const { allowedDir, repoPath } = makeWorkspace();
  const dispatcher = new OperationDispatcher();
  registerSymphonyLogsRoutes(dispatcher, () => [allowedDir]);

  // worktreeDir is never created — no JSONL and no launch log
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/logs/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, false);
  assert.equal(res.body.format, "text");
  assert.equal(res.body.content, "");
});

test("symphony-logs: returns text content from launch log when no JSONL file", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "symphony-launch.log"),
    "Starting...\nDone"
  );

  const dispatcher = new OperationDispatcher();
  registerSymphonyLogsRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/logs/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, true);
  assert.equal(res.body.format, "text");
  assert.equal(typeof res.body.content, "string");
});

// ---------------------------------------------------------------------------
// symphony-attachments
// ---------------------------------------------------------------------------

test("symphony-attachments: returns 400 when repo param is missing", async () => {
  const dispatcher = new OperationDispatcher();
  registerSymphonyAttachmentsRoutes(dispatcher, () => [makeTempDir()]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/attachments/ISS-123/image.png",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repo parameter is required");
});

test("symphony-attachments: returns 403 when repo is outside allowed directories", async () => {
  const { repoPath } = makeWorkspace();
  const otherDir = makeTempDir();
  const dispatcher = new OperationDispatcher();
  registerSymphonyAttachmentsRoutes(dispatcher, () => [otherDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/attachments/ISS-123/image.png",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(typeof res.body.error, "string");
});

test("symphony-attachments: returns 403 for path traversal outside attachments dir", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const attachmentsDir = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "attachments"
  );
  await fs.mkdir(attachmentsDir, { recursive: true });
  const dispatcher = new OperationDispatcher();
  registerSymphonyAttachmentsRoutes(dispatcher, () => [allowedDir]);

  // ../../secret.txt traverses above attachmentsDir
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/attachments/ISS-123/../../secret.txt",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "Invalid path");
});

test("symphony-attachments: returns 404 when attachment file does not exist", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const attachmentsDir = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "attachments"
  );
  await fs.mkdir(attachmentsDir, { recursive: true });
  const dispatcher = new OperationDispatcher();
  registerSymphonyAttachmentsRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/attachments/ISS-123/missing.png",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "File not found");
});

test("symphony-attachments: sets application/octet-stream for unknown file extension", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const attachmentsDir = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "attachments"
  );
  await fs.mkdir(attachmentsDir, { recursive: true });
  await fs.writeFile(
    path.join(attachmentsDir, "data.bin"),
    Buffer.from("bytes")
  );
  const dispatcher = new OperationDispatcher();
  registerSymphonyAttachmentsRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/attachments/ISS-123/data.bin",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(
    res.response.headers.get("content-type"),
    "application/octet-stream"
  );
});

test("symphony-attachments: returns 500 when attachment path is a directory", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const attachmentsDir = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "attachments"
  );
  // Create a directory at the attachment path — existsSync passes, readFile throws EISDIR
  const dirAttachment = path.join(attachmentsDir, "subdir.png");
  await fs.mkdir(dirAttachment, { recursive: true });
  const dispatcher = new OperationDispatcher();
  registerSymphonyAttachmentsRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/attachments/ISS-123/subdir.png",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 500);
  assert.equal(typeof res.body.error, "string");
});

// ---------------------------------------------------------------------------
// symphony-judges
// ---------------------------------------------------------------------------

test("symphony-judges: returns 400 when repo param is missing", async () => {
  const dispatcher = new OperationDispatcher();
  registerSymphonyJudgesRoutes(dispatcher, () => [makeTempDir()]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/judges/ISS-123",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repo query parameter is required");
});

test("symphony-judges: returns 403 when repo is outside allowed directories", async () => {
  const { repoPath } = makeWorkspace();
  const otherDir = makeTempDir();
  const dispatcher = new OperationDispatcher();
  registerSymphonyJudgesRoutes(dispatcher, () => [otherDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/judges/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(typeof res.body.error, "string");
});

test("symphony-judges: returns 404 when worktree does not exist", async () => {
  const { allowedDir, repoPath } = makeWorkspace();
  const dispatcher = new OperationDispatcher();
  registerSymphonyJudgesRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/judges/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.exists, false);
});

test("symphony-judges: repairs trailing-comma JSON and returns parsed data", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  // Trailing comma — stock JSON.parse rejects, replaceAll repairs it
  await fs.writeFile(
    path.join(workDir, "judges.json"),
    '{"verdict":"approve","score":9,}'
  );
  const dispatcher = new OperationDispatcher();
  registerSymphonyJudgesRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/judges/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, true);
  const data = res.body.data as Record<string, unknown>;
  assert.equal(data.verdict, "approve");
  assert.equal(data.score, 9);
});

test("symphony-judges: returns 500 for completely corrupt judges JSON", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  // Cannot be repaired by trailing-comma fix
  await fs.writeFile(
    path.join(workDir, "judges.json"),
    "{not valid json at all"
  );
  const dispatcher = new OperationDispatcher();
  registerSymphonyJudgesRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/judges/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 500);
  assert.ok(String(res.body.error).includes("corrupted"));
});

test("symphony-judges: returns exists:false when judges file is absent", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  await fs.mkdir(worktreeDir, { recursive: true });
  const dispatcher = new OperationDispatcher();
  registerSymphonyJudgesRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/judges/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, false);
  assert.equal(typeof res.body.message, "string");
});

// ---------------------------------------------------------------------------
// symphony-sessions
// ---------------------------------------------------------------------------

test("symphony-sessions: POST with contextRepoPaths and all optional fields stores them", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  await fs.mkdir(worktreeDir, { recursive: true });
  const getSymphonyDir = (): string => allowedDir;
  const dispatcher = new OperationDispatcher();
  registerSymphonySessionRoutes(dispatcher, () => [allowedDir], getSymphonyDir);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/sessions",
    body: JSON.stringify({
      ticketId: "ISS-123",
      repoPath,
      worktreePath: worktreeDir,
      pid: 1234,
      contextRepoPaths: [repoPath],
      baseBranch: "main",
      parentTicketId: "ISS-000",
      loopId: "loop-abc",
      artifactId: "art-xyz",
    }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);

  // Verify stored session contains the optional fields
  const getRes = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/sessions",
  });
  const sessions = getRes.body.sessions as Record<string, unknown>[];
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].baseBranch, "main");
  assert.equal(sessions[0].loopId, "loop-abc");
  assert.deepEqual(sessions[0].contextRepoPaths, [repoPath]);
});

test("symphony-sessions: second POST with same ticketId updates existing session", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  await fs.mkdir(worktreeDir, { recursive: true });
  const getSymphonyDir = (): string => allowedDir;
  const dispatcher = new OperationDispatcher();
  registerSymphonySessionRoutes(dispatcher, () => [allowedDir], getSymphonyDir);

  await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/sessions",
    body: JSON.stringify({
      ticketId: "ISS-123",
      repoPath,
      worktreePath: worktreeDir,
    }),
  });

  await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/sessions",
    body: JSON.stringify({
      ticketId: "ISS-123",
      repoPath,
      worktreePath: worktreeDir,
      loopId: "loop-updated",
    }),
  });

  const getRes = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/sessions",
  });
  const sessions = getRes.body.sessions as Record<string, unknown>[];
  // Still only one session — the upsert path updated it
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].loopId, "loop-updated");
});

test("symphony-sessions: GET filters out sessions whose worktrees are gone", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  await fs.mkdir(worktreeDir, { recursive: true });
  const missing = path.join(allowedDir, "repo-GONE");
  const getSymphonyDir = (): string => allowedDir;
  const dispatcher = new OperationDispatcher();
  registerSymphonySessionRoutes(dispatcher, () => [allowedDir], getSymphonyDir);

  await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/sessions",
    body: JSON.stringify({
      ticketId: "ISS-123",
      repoPath,
      worktreePath: worktreeDir,
    }),
  });
  // Write second session directly to skip the security check for the missing path
  const sessionsFile = path.join(allowedDir, "sessions.json");
  const raw = await fs.readFile(sessionsFile, "utf-8");
  const config = JSON.parse(raw) as { sessions: unknown[] };
  config.sessions.push({
    ticketId: "ISS-GONE",
    repoPath,
    worktreePath: missing,
    startedAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
  });
  await fs.writeFile(sessionsFile, JSON.stringify(config));

  const getRes = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/sessions",
  });
  const sessions = getRes.body.sessions as Record<string, unknown>[];
  // The missing-worktree session is filtered out
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].ticketId, "ISS-123");
});

test("symphony-sessions: POST returns 400 for invalid JSON body", async () => {
  const allowedDir = makeTempDir();
  const getSymphonyDir = (): string => allowedDir;
  const dispatcher = new OperationDispatcher();
  registerSymphonySessionRoutes(dispatcher, () => [allowedDir], getSymphonyDir);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/sessions",
    body: "{not json",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid JSON body");
});

test("symphony-sessions: POST returns 400 when required fields are missing", async () => {
  const allowedDir = makeTempDir();
  const getSymphonyDir = (): string => allowedDir;
  const dispatcher = new OperationDispatcher();
  registerSymphonySessionRoutes(dispatcher, () => [allowedDir], getSymphonyDir);

  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/symphony/sessions",
    body: JSON.stringify({ ticketId: "ISS-123" }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(typeof res.body.error, "string");
});

test("symphony-sessions: DELETE returns 400 when ticketId param is missing", async () => {
  const allowedDir = makeTempDir();
  const getSymphonyDir = (): string => allowedDir;
  const dispatcher = new OperationDispatcher();
  registerSymphonySessionRoutes(dispatcher, () => [allowedDir], getSymphonyDir);

  const res = await dispatchOperation({
    dispatcher,
    method: "DELETE",
    pathname: "/api/gateway/symphony/sessions",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "ticketId parameter is required");
});

test("symphony-sessions: GET returns empty sessions when sessions.json has non-array sessions key", async () => {
  const allowedDir = makeTempDir();
  await fs.writeFile(
    path.join(allowedDir, "sessions.json"),
    JSON.stringify({ sessions: "not-an-array" })
  );
  const getSymphonyDir = (): string => allowedDir;
  const dispatcher = new OperationDispatcher();
  registerSymphonySessionRoutes(dispatcher, () => [allowedDir], getSymphonyDir);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/sessions",
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.sessions, []);
});

test("symphony-sessions: GET returns empty sessions when sessions.json is malformed JSON", async () => {
  const allowedDir = makeTempDir();
  await fs.writeFile(path.join(allowedDir, "sessions.json"), "{ invalid json");
  const getSymphonyDir = (): string => allowedDir;
  const dispatcher = new OperationDispatcher();
  registerSymphonySessionRoutes(dispatcher, () => [allowedDir], getSymphonyDir);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/sessions",
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.sessions, []);
});

test("symphony-sessions: returns 503 when getSymphonyDir throws SymphonyDirNotConfiguredError", async () => {
  const allowedDir = makeTempDir();
  const getSymphonyDir = (): string => {
    throw new SymphonyDirNotConfiguredError();
  };
  const dispatcher = new OperationDispatcher();
  registerSymphonySessionRoutes(dispatcher, () => [allowedDir], getSymphonyDir);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/sessions",
  });

  assert.equal(res.statusCode, 503);
  assert.equal(typeof res.body.error, "string");
});

// ---------------------------------------------------------------------------
// symphony-plan
// ---------------------------------------------------------------------------

test("symphony-plan: returns 400 when repo param is missing", async () => {
  const dispatcher = new OperationDispatcher();
  registerSymphonyPlanRoutes(dispatcher, () => [makeTempDir()]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/plan/ISS-123",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(typeof res.body.error, "string");
});

test("symphony-plan: returns 403 when repo is outside allowed directories", async () => {
  const { repoPath } = makeWorkspace();
  const otherDir = makeTempDir();
  const dispatcher = new OperationDispatcher();
  registerSymphonyPlanRoutes(dispatcher, () => [otherDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/plan/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(typeof res.body.error, "string");
});

test("symphony-plan: returns 404 when worktree does not exist", async () => {
  const { allowedDir, repoPath } = makeWorkspace();
  const dispatcher = new OperationDispatcher();
  registerSymphonyPlanRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/plan/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.exists, false);
});

test("symphony-plan: returns 404 when plan.json does not exist in worktree", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  await fs.mkdir(worktreeDir, { recursive: true });
  const dispatcher = new OperationDispatcher();
  registerSymphonyPlanRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/plan/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.planExists, false);
});

test("symphony-plan: returns 500 when plan.json contains corrupt JSON", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, "plan.json"), "{corrupt json");
  const dispatcher = new OperationDispatcher();
  registerSymphonyPlanRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/plan/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 500);
  assert.equal(typeof res.body.error, "string");
});

test("symphony-plan: generates markdown from tasks when content field is empty", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "plan.json"),
    JSON.stringify({
      title: "Test Plan",
      description: "A description",
      tasks: [{ id: "T1", title: "First task", description: "Do the thing" }],
    })
  );
  const dispatcher = new OperationDispatcher();
  registerSymphonyPlanRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/plan/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.planExists, true);
  // generateMarkdownFromPlan produces a non-empty markdown string
  assert.equal(typeof res.body.content, "string");
  assert.ok(String(res.body.content).includes("Test Plan"));
});

test("symphony-plan: falls back to plan.md when content field is empty and plan.md exists", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "plan.json"),
    JSON.stringify({ title: "Fallback Plan" })
  );
  await fs.writeFile(
    path.join(workDir, "plan.md"),
    "# Fallback Plan\n\nFull plan content here."
  );
  const dispatcher = new OperationDispatcher();
  registerSymphonyPlanRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/plan/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.planExists, true);
  assert.ok(String(res.body.content).includes("Full plan content here."));
});

// ---------------------------------------------------------------------------
// symphony-status
// ---------------------------------------------------------------------------

test("symphony-status: returns 400 when repo param is missing", async () => {
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(dispatcher, () => [makeTempDir()]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(typeof res.body.error, "string");
});

test("symphony-status: returns 403 when repo is outside allowed directories", async () => {
  const { repoPath } = makeWorkspace();
  const otherDir = makeTempDir();
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(dispatcher, () => [otherDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(typeof res.body.error, "string");
});

test("symphony-status: returns exists:false without jobStore when worktree is missing", async () => {
  const { allowedDir, repoPath } = makeWorkspace();
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, false);
});

test("symphony-status: returns exists:false with jobStore when worktree is missing and no matching job", async () => {
  const { allowedDir, repoPath } = makeWorkspace();
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(
    dispatcher,
    () => [allowedDir],
    createStubJobStore()
  );

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, false);
});

test("symphony-status: returns STARTING when worktree exists but state.json is absent", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  await fs.mkdir(worktreeDir, { recursive: true });
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "STARTING");
  assert.equal(res.body.stateExists, false);
});

test("symphony-status: returns 500 when state.json contains corrupt JSON", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, "state.json"), "{corrupt");
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 500);
  assert.equal(typeof res.body.error, "string");
});

test("symphony-status: returns STOPPED when IN_PROGRESS state has a dead PID", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "state.json"),
    JSON.stringify({ status: "IN_PROGRESS", phase: "Running" })
  );
  // PID 99999999 is above Linux max (4194304) — process.kill throws ESRCH
  await fs.writeFile(path.join(workDir, "process.pid"), "99999999");
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "STOPPED");
  assert.equal(res.body.processRunning, false);
});

test("symphony-status: normalises non-string status and phase to UNKNOWN/Unknown", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "state.json"),
    JSON.stringify({ status: 42, phase: null })
  );
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "UNKNOWN");
  assert.equal(res.body.phase, "Unknown");
});

test("symphony-status: returns current IN_PROGRESS state when lock file is present", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  const lockDir = path.join(workDir, ".learnings");
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "state.json"),
    JSON.stringify({ status: "IN_PROGRESS", phase: "Running" })
  );
  // No PID file → pid = null, so dead-PID branch is skipped
  await fs.writeFile(path.join(lockDir, ".lock"), "");
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "IN_PROGRESS");
  assert.equal(res.body.fallbackDetected, false);
});

test("symphony-status: returns IN_PROGRESS for stale state when log has no completion marker", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  const statePath = path.join(workDir, "state.json");
  await fs.writeFile(
    statePath,
    JSON.stringify({ status: "IN_PROGRESS", phase: "Running" })
  );
  // No PID file, no lock file — backdate to trigger stale-state path
  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
  await fs.utimes(statePath, threeMinutesAgo, threeMinutesAgo);
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "IN_PROGRESS");
  assert.equal(res.body.fallbackDetected, false);
});

test("symphony-status: returns AWAITING_USER for stale state when log signals awaiting-user", async () => {
  const { allowedDir, repoPath, worktreeDir } = makeWorkspace();
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  const statePath = path.join(workDir, "state.json");
  await fs.writeFile(
    statePath,
    JSON.stringify({ status: "IN_PROGRESS", phase: "Running" })
  );
  await fs.writeFile(
    path.join(workDir, "symphony-launch.log"),
    "<promise>COMPLETE</promise>AWAITING_USER"
  );
  // No PID file, no lock file — backdate state.json to trigger fallback path
  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
  await fs.utimes(statePath, threeMinutesAgo, threeMinutesAgo);
  const dispatcher = new OperationDispatcher();
  registerSymphonyStatusRoutes(dispatcher, () => [allowedDir]);

  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status/ISS-123",
    query: { repo: repoPath },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "AWAITING_USER");
  assert.equal(res.body.fallbackDetected, true);
});
