/**
 * ISS-5299 — Branch coverage for chat-history and helper gateway operations.
 *
 * Targets (all under apps/desktop/src/server/operations/):
 *   parse-body.ts             (1 branch  — non-empty body path)
 *   response-utils.ts         (2 branches — code / details ternaries in jsonError)
 *   chat-history-store.ts     (1 branch  — catch block on corrupt JSON)
 *   agent-utils.ts            (6 branches — dir exists path, native-loop fork ×2,
 *                                            plan ternaries ×2, catch on corrupt plan)
 *   peer-context.ts           (5 branches — baseBranch provided, shortRepoName without "/",
 *                                            dedupeNames collision, buildPeerEnvVars empty;
 *                                            line 109 reported unreachable below)
 *   chat-tools.ts             (1 branch  — withResolvedMcpTools with serverName)
 *   symphony-chat-history.ts  (22 branches — all three route handlers + parseMessage helpers)
 *
 * Lives beside gateway-server.test.ts but is a separate file because that suite is on
 * the shrink-only noExcessiveLinesPerFile list in biome.jsonc and must never grow.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  readActiveAgents,
  readAgentTypeFiles,
  readPlanProgress,
} from "../src/server/operations/agent-utils.js";
import {
  loadJsonFile,
  saveJsonFile,
} from "../src/server/operations/chat-history-store.js";
import {
  buildMcpToolPattern,
  withResolvedMcpTools,
} from "../src/server/operations/chat-tools.js";
import {
  clearActiveAgents,
  markNativeLoop,
  recordActiveAgentDelta,
} from "../src/server/operations/observability/active-agents-registry.js";
import { parseBody } from "../src/server/operations/parse-body.js";
import {
  buildMountPathsFooter,
  buildPeerEnvVars,
  toPeerWorktreeRefs,
  writePeerReposManifest,
} from "../src/server/operations/peer-context.js";
import { json, jsonError } from "../src/server/operations/response-utils.js";
import { registerSymphonyChatHistoryRoutes } from "../src/server/operations/symphony-chat-history.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  pinDefaultWorktreeParentDir,
} from "./helpers/git-gateway-op-harness.js";

// resolveWorktreeDir prefers SYMPHONY_WORKTREE_PARENT_DIR over the default
// dirname(repoPath) branch these fixtures are built for, so pin it unset.
pinDefaultWorktreeParentDir();

// ---------------------------------------------------------------------------
// Shared cleanup registries
// ---------------------------------------------------------------------------

/** Loop IDs registered as native — cleared in afterEach to prevent inter-test leakage. */
const nativeLoopIds: string[] = [];
afterEach(() => {
  for (const id of nativeLoopIds.splice(0)) {
    clearActiveAgents(id);
  }
});

/** All temp dirs used in this file are registered here and cleaned after each test. */
const { makeTempDir } = createGitOpTempDirs("iss5299-chathelpers-");

// ---------------------------------------------------------------------------
// Helper: symphony-chat-history route dispatcher
// ---------------------------------------------------------------------------

/** The ticketId embedded in every route path for the chat-history tests. */
const TICKET_ID = "ISS-9999";

/**
 * Build a dispatcher with all three chat-history routes registered.
 * The `tmpDir` must be the parent of the virtual repo — chat-history routes
 * resolve the worktree dir as a sibling of the repo inside the same parent, so
 * the allowed-directories list must point at the parent (tmpDir) rather than at
 * the repo itself so both the security check on `repoPath` and the second check
 * on `historyWriteDir` pass.
 */
function makeHistoryDispatcher(tmpDir: string): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerSymphonyChatHistoryRoutes(dispatcher, () => [tmpDir]);
  return dispatcher;
}

/**
 * Compute the expected worktree dir path for the given repoDir and TICKET_ID.
 * Mirrors the production `resolveWorktreeDir` logic (when SYMPHONY_WORKTREE_PARENT_DIR
 * is not set): worktreeDir = parent(repoDir)/basename(repoDir)-ticketId.
 */
function worktreeDirFor(repoDir: string): string {
  return path.join(
    path.dirname(repoDir),
    `${path.basename(repoDir)}-${TICKET_ID}`
  );
}

/** Create the standard history-file directory structure inside `worktreeDir`. */
async function createHistoryFile(
  worktreeDir: string,
  content: string
): Promise<string> {
  const historyDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(historyDir, { recursive: true });
  const historyFile = path.join(historyDir, "chat-history.json");
  await fs.writeFile(historyFile, content, "utf-8");
  return historyFile;
}

// ---------------------------------------------------------------------------
// parse-body.ts
// ---------------------------------------------------------------------------

test("parseBody: non-empty valid JSON → parsed object", async () => {
  const dispatcher = new OperationDispatcher();
  let result: Record<string, unknown> | null | undefined;
  dispatcher.register("POST", "/pb-valid", (ctx) => {
    result = parseBody(ctx);
    json(ctx, 200, {});
  });
  await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/pb-valid",
    body: '{"hello":"world","count":3}',
  });
  assert.deepEqual(result, { hello: "world", count: 3 });
});

test("parseBody: invalid JSON → null", async () => {
  const dispatcher = new OperationDispatcher();
  let result: Record<string, unknown> | null | undefined;
  dispatcher.register("POST", "/pb-invalid", (ctx) => {
    result = parseBody(ctx);
    json(ctx, 200, {});
  });
  await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/pb-invalid",
    body: "{not valid json",
  });
  assert.equal(result, null);
});

test("parseBody: empty body → {}", async () => {
  const dispatcher = new OperationDispatcher();
  let result: Record<string, unknown> | null | undefined;
  dispatcher.register("POST", "/pb-empty", (ctx) => {
    result = parseBody(ctx);
    json(ctx, 200, {});
  });
  await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/pb-empty",
    body: "   ",
  });
  assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// response-utils.ts
// ---------------------------------------------------------------------------

test("json: sets status code and serialises payload", async () => {
  const dispatcher = new OperationDispatcher();
  dispatcher.register("GET", "/ru-json", (ctx) => {
    json(ctx, 201, { created: true });
  });
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/ru-json",
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(JSON.parse(res.rawBody), { created: true });
});

test("jsonError: no code, no details → only error key present", async () => {
  const dispatcher = new OperationDispatcher();
  dispatcher.register("GET", "/ru-err-min", (ctx) => {
    jsonError(ctx, 400, { error: "bad input" });
  });
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/ru-err-min",
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.rawBody), { error: "bad input" });
});

test("jsonError: with code and details — undefined detail values omitted", async () => {
  const dispatcher = new OperationDispatcher();
  dispatcher.register("GET", "/ru-err-full", (ctx) => {
    jsonError(ctx, 422, {
      error: "validation failed",
      code: "INVALID_FIELD",
      details: { field: "name", extra: undefined },
    });
  });
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/ru-err-full",
  });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(JSON.parse(res.rawBody), {
    error: "validation failed",
    code: "INVALID_FIELD",
    details: { field: "name" },
  });
});

// ---------------------------------------------------------------------------
// chat-history-store.ts
// ---------------------------------------------------------------------------

test("loadJsonFile: missing file returns fallback", async () => {
  const tmpDir = makeTempDir();
  const result = await loadJsonFile(path.join(tmpDir, "missing.json"), {
    ok: false,
  });
  assert.deepEqual(result, { ok: false });
});

test("loadJsonFile: corrupt JSON returns fallback", async () => {
  const tmpDir = makeTempDir();
  const filePath = path.join(tmpDir, "corrupt.json");
  await fs.writeFile(filePath, "{not-valid-json", "utf-8");
  const result = await loadJsonFile(filePath, { fallback: true });
  assert.deepEqual(result, { fallback: true });
});

test("loadJsonFile: valid JSON returns parsed data", async () => {
  const tmpDir = makeTempDir();
  const filePath = path.join(tmpDir, "valid.json");
  await fs.writeFile(filePath, JSON.stringify({ answer: 42 }), "utf-8");
  const result = await loadJsonFile<{ answer: number }>(filePath, {
    answer: 0,
  });
  assert.deepEqual(result, { answer: 42 });
});

test("saveJsonFile: creates parent directory and writes formatted JSON", async () => {
  const tmpDir = makeTempDir();
  const filePath = path.join(tmpDir, "nested", "dir", "data.json");
  await saveJsonFile(filePath, { items: [1, 2, 3] });
  const content = await fs.readFile(filePath, "utf-8");
  assert.deepEqual(JSON.parse(content), { items: [1, 2, 3] });
});

// ---------------------------------------------------------------------------
// peer-context.ts
// ---------------------------------------------------------------------------

test("toPeerWorktreeRefs: fullName provided is used as-is", () => {
  const refs = toPeerWorktreeRefs([
    { dir: "/projects/alpha", fullName: "org/alpha", baseBranch: "develop" },
  ]);
  assert.deepEqual(refs, [
    { fullName: "org/alpha", branch: "develop", localPath: "/projects/alpha" },
  ]);
});

test("toPeerWorktreeRefs: baseBranch absent defaults to 'main'", () => {
  const refs = toPeerWorktreeRefs([
    { dir: "/projects/alpha", fullName: "org/alpha" },
  ]);
  assert.equal(refs[0]?.branch, "main");
});

test("toPeerWorktreeRefs: fullName absent falls back to basename of dir", () => {
  const refs = toPeerWorktreeRefs([{ dir: "/projects/beta" }]);
  assert.equal(refs[0]?.fullName, "beta");
});

test("writePeerReposManifest: empty peers → returns false, no file written", async () => {
  const tmpDir = makeTempDir();
  const ctxDir = path.join(tmpDir, "ctx");
  const result = await writePeerReposManifest(ctxDir, []);
  assert.equal(result, false);
  await assert.rejects(async () => {
    await fs.readdir(ctxDir);
  });
});

test("writePeerReposManifest: non-empty → creates dir, writes manifest, returns true", async () => {
  const tmpDir = makeTempDir();
  const ctxDir = path.join(tmpDir, "ctx");
  const result = await writePeerReposManifest(ctxDir, [
    { fullName: "org/repo", branch: "main", localPath: "/projects/repo" },
  ]);
  assert.equal(result, true);
  const raw = await fs.readFile(path.join(ctxDir, "peer-repos.json"), "utf-8");
  assert.deepEqual(JSON.parse(raw), {
    peers: [
      { fullName: "org/repo", branch: "main", localPath: "/projects/repo" },
    ],
  });
});

test("buildMountPathsFooter: empty peers → empty string", () => {
  assert.equal(buildMountPathsFooter([]), "");
});

test("buildMountPathsFooter: non-empty peers → formatted block", () => {
  const footer = buildMountPathsFooter([
    { fullName: "org/alpha", branch: "main", localPath: "/mnt/alpha" },
    { fullName: "beta", branch: "dev", localPath: "/mnt/beta" },
  ]);
  assert.ok(footer.includes("## Mounted paths"));
  assert.ok(footer.includes("`org/alpha` @ `main` → `/mnt/alpha`"));
  assert.ok(footer.includes("`beta` @ `dev` → `/mnt/beta`"));
});

test("buildPeerEnvVars: empty entries → {}", () => {
  assert.deepEqual(buildPeerEnvVars([]), {});
});

test("buildPeerEnvVars: fullName without slash used directly as short name", () => {
  // Exercises shortRepoName's length-check branch (line 111) — fullName has no "/" so
  // shortRepoName returns fullName directly rather than calling .split().pop().
  const env = buildPeerEnvVars([{ dir: "/a/myrepo", fullName: "myrepo" }]);
  assert.equal(env.CLOSEDLOOP_ADD_DIR_NAMES, "myrepo");
});

test("buildPeerEnvVars: colliding short names get -2 and -3 suffixes", () => {
  // All three entries map to short name "repo" via "org/repo" pattern, triggering the
  // dedupeNames collision loop (line 129) and the counter increment (counter += 1).
  const env = buildPeerEnvVars([
    { dir: "/a/repo", fullName: "org-a/repo" },
    { dir: "/b/repo", fullName: "org-b/repo" },
    { dir: "/c/repo", fullName: "org-c/repo" },
  ]);
  assert.deepEqual(env.CLOSEDLOOP_ADD_DIR_NAMES?.split("|"), [
    "repo",
    "repo-2",
    "repo-3",
  ]);
  assert.equal(env.CLOSEDLOOP_ADD_DIRS, "/a/repo|/b/repo|/c/repo");
});

// ---------------------------------------------------------------------------
// agent-utils.ts
// ---------------------------------------------------------------------------

test("readAgentTypeFiles: absent directory → []", async () => {
  const tmpDir = makeTempDir();
  const result = await readAgentTypeFiles(
    path.join(tmpDir, "nonexistent"),
    "test"
  );
  assert.deepEqual(result, []);
});

test("readAgentTypeFiles: empty directory → []", async () => {
  const tmpDir = makeTempDir();
  const agentDir = path.join(tmpDir, "agent-types");
  await fs.mkdir(agentDir);
  const result = await readAgentTypeFiles(agentDir, "test");
  assert.deepEqual(result, []);
});

test("readAgentTypeFiles: dash-named files skipped; bad file logged; valid file returned", async () => {
  const tmpDir = makeTempDir();
  const agentDir = path.join(tmpDir, "agent-types");
  await fs.mkdir(agentDir);
  // Valid: no dash in name, pipe-delimited content
  await fs.writeFile(
    path.join(agentDir, "abc123"),
    "worker|MyAgent|2024-01-01T00:00:00Z"
  );
  // Skipped: file name contains a dash
  await fs.writeFile(path.join(agentDir, "skip-me"), "worker|Skip|2024-01-01");
  // Bad: create a *directory* with this name so readFile throws EISDIR
  await fs.mkdir(path.join(agentDir, "badagent"));

  const result = await readAgentTypeFiles(agentDir, "test");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.agentId, "abc123");
  assert.equal(result[0]?.agentType, "worker");
  assert.equal(result[0]?.agentName, "MyAgent");
  assert.equal(result[0]?.startedAt, "2024-01-01T00:00:00Z");
});

test("readActiveAgents: no loopId → falls through to directory scan", async () => {
  const tmpDir = makeTempDir();
  const agentDir = path.join(tmpDir, "agent-types");
  await fs.mkdir(agentDir);
  await fs.writeFile(
    path.join(agentDir, "xyz"),
    "coder|Bob|2024-01-01T00:00:00Z"
  );
  const result = await readActiveAgents(agentDir, "test");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.agentName, "Bob");
});

test("readActiveAgents: non-native loopId → falls through to directory scan", async () => {
  const tmpDir = makeTempDir();
  const agentDir = path.join(tmpDir, "agent-types");
  await fs.mkdir(agentDir);
  // loopId is not registered as native — falls through to readAgentTypeFiles
  const result = await readActiveAgents(agentDir, "test", "not-a-native-loop");
  assert.deepEqual(result, []);
});

test("readActiveAgents: native loopId → returns in-memory registry snapshot", async () => {
  const loopId = "loop-iss5299-native-test";
  nativeLoopIds.push(loopId);
  markNativeLoop(loopId);
  recordActiveAgentDelta(loopId, {
    kind: "start",
    agentId: "agent-a1",
    agentType: "planner",
    agentName: "PlannerAgent",
    startedAt: "2024-01-01T00:00:00Z",
  });
  const result = await readActiveAgents("/unused-dir", "test", loopId);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.agentId, "agent-a1");
  assert.equal(result[0]?.agentType, "planner");
});

test("readPlanProgress: absent plan file → {}", async () => {
  const tmpDir = makeTempDir();
  const result = await readPlanProgress(path.join(tmpDir, "plan.json"));
  assert.deepEqual(result, {});
});

test("readPlanProgress: corrupt plan JSON → {}", async () => {
  const tmpDir = makeTempDir();
  const planPath = path.join(tmpDir, "plan.json");
  await fs.writeFile(planPath, "{unclosed json", "utf-8");
  const result = await readPlanProgress(planPath);
  assert.deepEqual(result, {});
});

test("readPlanProgress: valid plan with arrays → task counts and currentTaskId", async () => {
  const tmpDir = makeTempDir();
  const planPath = path.join(tmpDir, "plan.json");
  await fs.writeFile(
    planPath,
    JSON.stringify({
      pendingTasks: [{ id: "task-1" }, { id: "task-2" }],
      completedTasks: [{ id: "task-0" }],
    }),
    "utf-8"
  );
  const result = await readPlanProgress(planPath);
  assert.deepEqual(result.taskProgress, { pending: 2, completed: 1, total: 3 });
  assert.equal(result.currentTaskId, "task-1");
});

test("readPlanProgress: non-array pendingTasks and completedTasks → zero counts", async () => {
  const tmpDir = makeTempDir();
  const planPath = path.join(tmpDir, "plan.json");
  await fs.writeFile(
    planPath,
    JSON.stringify({ pendingTasks: "oops", completedTasks: null }),
    "utf-8"
  );
  const result = await readPlanProgress(planPath);
  assert.deepEqual(result.taskProgress, { pending: 0, completed: 0, total: 0 });
});

// ---------------------------------------------------------------------------
// chat-tools.ts
// ---------------------------------------------------------------------------

test("buildMcpToolPattern: returns mcp__serverName__* pattern", () => {
  assert.equal(buildMcpToolPattern("context7"), "mcp__context7__*");
  assert.equal(buildMcpToolPattern("my-server"), "mcp__my-server__*");
});

test("withResolvedMcpTools: with serverName → appends MCP glob to tool list", () => {
  const result = withResolvedMcpTools("Read,Write", "context7");
  assert.equal(result, "Read,Write,mcp__context7__*");
});

// ---------------------------------------------------------------------------
// symphony-chat-history.ts — GET
// ---------------------------------------------------------------------------

test("GET chat-history: missing repo → 400", async () => {
  const tmpDir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "GET",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repo parameter is required");
});

test("GET chat-history: invalid provider → 400", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "GET",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir, provider: "unknown-ai" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "unsupported provider");
});

test("GET chat-history: repo outside allowed dirs → 403", async () => {
  const tmpDir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "GET",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: "/tmp/not-an-allowed-path-iss5299-get" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

test("GET chat-history: history file absent → 200 with empty messages", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "GET",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.messages, []);
  assert.equal(res.body.ticketId, TICKET_ID);
});

test("GET chat-history: valid history file → 200 with messages", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const historyData = {
    messages: [
      { id: "m1", role: "user", content: "hello", timestamp: "2024-01-01" },
    ],
    ticketId: TICKET_ID,
    repoPath: repoDir,
  };
  await createHistoryFile(worktreeDirFor(repoDir), JSON.stringify(historyData));
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "GET",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir },
  });
  assert.equal(res.statusCode, 200);
  assert.equal((res.body.messages as unknown[]).length, 1);
  assert.equal(res.body.ticketId, TICKET_ID);
});

test("GET chat-history: corrupt history file → 500", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  await createHistoryFile(worktreeDirFor(repoDir), "{corrupt json");
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "GET",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir },
  });
  assert.equal(res.statusCode, 500);
  assert.ok(
    (res.body.error as string).startsWith("Failed to read chat history")
  );
});

// ---------------------------------------------------------------------------
// symphony-chat-history.ts — POST
// ---------------------------------------------------------------------------

test("POST chat-history: missing repo → 400", async () => {
  const tmpDir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "POST",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    body: "{}",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repo parameter is required");
});

test("POST chat-history: invalid provider → 400", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "POST",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir, provider: "gpt-99" },
    body: "{}",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "unsupported provider");
});

test("POST chat-history: invalid JSON body → 400", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "POST",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir },
    body: "{broken json",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid JSON body");
});

test("POST chat-history: repo outside allowed dirs → 403", async () => {
  const tmpDir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "POST",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: "/tmp/not-allowed-iss5299-post" },
    body: "{}",
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

test("POST chat-history: sessionId without message → saves sessionId, 200", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "POST",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir },
    body: JSON.stringify({ sessionId: "sess-abc-123" }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessionId, "sess-abc-123");
  assert.equal(res.body.success, true);
});

test("POST chat-history: valid message with sender field → 200, message appended", async () => {
  // Also exercises the parseMessage sender branch (line 356): sender = "claude".
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const message = {
    id: "msg-1",
    role: "user",
    content: "Hello from the test",
    timestamp: "2024-01-01T00:00:00Z",
    sender: "claude",
  };
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "POST",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir },
    body: JSON.stringify({ message }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const history = res.body.history as { messages: Array<{ sender?: string }> };
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0]?.sender, "claude");
});

test("POST chat-history: message missing required fields → 400", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "POST",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir },
    // message object missing content and timestamp
    body: JSON.stringify({ message: { id: "x", role: "user" } }),
  });
  assert.equal(res.statusCode, 400);
  assert.ok(
    (res.body.error as string).includes("message with content and role")
  );
});

// ---------------------------------------------------------------------------
// symphony-chat-history.ts — DELETE
// ---------------------------------------------------------------------------

test("DELETE chat-history: missing repo → 400", async () => {
  const tmpDir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "DELETE",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repo parameter is required");
});

test("DELETE chat-history: invalid provider → 400", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "DELETE",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir, provider: "bad-provider" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "unsupported provider");
});

test("DELETE chat-history: repo outside allowed → 403", async () => {
  const tmpDir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "DELETE",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: "/tmp/not-allowed-iss5299-delete" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

test("DELETE chat-history: history absent → 200 no-op", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "DELETE",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, "No history to delete");
});

test("DELETE chat-history: invalid (non-numeric) index → 400", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  await createHistoryFile(
    worktreeDirFor(repoDir),
    JSON.stringify({
      messages: [
        { id: "m1", role: "user", content: "hi", timestamp: "2024-01-01" },
      ],
      ticketId: TICKET_ID,
      repoPath: repoDir,
    })
  );
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "DELETE",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir, index: "not-a-number" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid index");
});

test("DELETE chat-history: valid index → removes targeted message, returns updated history", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  await createHistoryFile(
    worktreeDirFor(repoDir),
    JSON.stringify({
      messages: [
        { id: "m1", role: "user", content: "first", timestamp: "2024-01-01" },
        {
          id: "m2",
          role: "assistant",
          content: "second",
          timestamp: "2024-01-02",
        },
      ],
      ticketId: TICKET_ID,
      repoPath: repoDir,
    })
  );
  const res = await dispatchOperation({
    dispatcher: makeHistoryDispatcher(tmpDir),
    method: "DELETE",
    pathname: `/api/gateway/symphony/chat-history/${TICKET_ID}`,
    query: { repo: repoDir, index: "0" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const history = res.body.history as { messages: Array<{ id: string }> };
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0]?.id, "m2");
});
