/**
 * ISS-5299 — Branch-coverage sweep: codex operations, output tailer helpers,
 * git-diff, git-action, and router auth helpers.
 *
 * Dead-code branches intentionally skipped (documented inline):
 *   codex.ts   416 (!ticketId) — OperationDispatcher requires 1+ non-slash chars
 *   codex.ts   448 (tryAssertPathAllowed error) — worktreeDir inside sandbox
 *   codex.ts   907 (re-throw non-DirectoryNotAllowedError)
 *   codex.ts   932 (debug log after verdict collection) — needs real binary success
 *   codex.ts   948 (catch after runCodexVerdict) — risky with real binary
 *   codex.ts  1299, 1312 (chat args construction) — requires spawning codex binary
 *   git-diff.ts  67 (re-throw non-DirectoryNotAllowedError)
 *   git-diff.ts 124 (non-Error catch in handleWorkingDiff outer catch)
 *   git-diff.ts 291 (canonicalizePath catch — TOCTOU race)
 *   git-action.ts  70 (re-throw non-DirectoryNotAllowedError)
 *   git-action.ts 134 (non-Error catch)
 *   output-tailer.ts 325 (statSync catch — TOCTOU race)
 *   output-tailer.ts 386, 408 (success path in shouldRetryOnResult/formatResultForLog)
 *   output-tailer.ts 444, 447, 472, 480 (timer/TOCTOU branches)
 *   router.ts  559 (?? "unauthorized" — reason always present)
 *   router.ts  885, 892 (?? "POST" in handleExchange — dead via isExchangeRoute guard)
 *   router.ts  945 (?? 401 — verifyChallenge always returns statusCode)
 *   router.ts 1198 (BigInt() catch — unreachable for /^\d+$/-matched strings)
 *   router.ts 1214, 1220 (byteLengthOfResponseChunk string/Uint8Array branches)
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { LocalSessionStore } from "../src/main/auth/local-session-store.js";
import { LoopSchedulerContext } from "../src/main/loop/loop-scheduler-context.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  registerCodexRoutes,
  streamCodexReview,
} from "../src/server/operations/codex.js";
import { registerGitActionRoutes } from "../src/server/operations/git-action.js";
import { registerGitDiffRoutes } from "../src/server/operations/git-diff.js";
import {
  startOutputTailer,
  summarizeJsonlRecord,
} from "../src/server/operations/output-tailer.js";
import type { GatewayApprovalRequest } from "../src/server/router.js";
import { GatewayRouter } from "../src/server/router.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  dispatchMockRequest,
  TestResponse,
} from "./gateway-server-test-doubles.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";
import { buildMockChildProcess } from "./helpers/spawn-test-utils.js";

// Module-level constant — a canned session id reused across these suites.
const FAKE_SESSION_ID = "abcdef01-2345-6789-abcd-ef0123456789";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

const allTempDirs: string[] = [];

afterEach(async () => {
  for (const dir of allTempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function makeTempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  allTempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Dispatcher factories
// ---------------------------------------------------------------------------

function makeCodexDispatcher(
  extraAllowedDirs: string[] = []
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerCodexRoutes(dispatcher, () => [os.tmpdir(), ...extraAllowedDirs]);
  return dispatcher;
}

function makeGitActionDispatcher(
  pm: FakeProcessManager,
  repoDir: string
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitActionRoutes(dispatcher, pm.asProcessManager(), () => [
    repoDir,
    os.tmpdir(),
  ]);
  return dispatcher;
}

function makeRouter(
  overrides: Partial<ConstructorParameters<typeof GatewayRouter>[0]> = {}
): GatewayRouter {
  return new GatewayRouter({
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "codex-tailer-test",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getActivePort: () => 0,
    getGatewayId: () => "test-gateway-id",
    schedulers: new LoopSchedulerContext(),
    ...overrides,
  });
}

function dispatchExchange(input: {
  router: GatewayRouter;
  headers?: Record<string, string | string[]>;
  chunks?: Array<string | Buffer>;
}): Promise<TestResponse> {
  return dispatchMockRequest({
    router: input.router,
    method: "POST",
    path: "/gateway-auth/exchange",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
      ...input.headers,
    },
    chunks: input.chunks,
  });
}

// ---------------------------------------------------------------------------
// output-tailer.ts — summarizeJsonlRecord: lines 112, 129
// ---------------------------------------------------------------------------

describe("summarizeJsonlRecord", () => {
  test("tool_use block with string file_path returns path summary (line 112)", () => {
    // line 112: typeof filePath === "string" → TRUE branch
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "/tmp/test.txt" },
          },
        ],
      },
    });
    assert.ok(result !== null);
    assert.ok(result?.includes("Write"));
    assert.ok(result?.includes("/tmp/test.txt"));
  });

  test("tool_result block with non-empty string content returns result summary (line 129)", () => {
    // line 129: typeof content === "string" && content.length > 0 → TRUE branch
    const result = summarizeJsonlRecord({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: "file written successfully",
          },
        ],
      },
    });
    assert.ok(result !== null);
    assert.ok(result?.includes("file written successfully"));
  });
});

// ---------------------------------------------------------------------------
// output-tailer.ts — parseEnvNumber fallback: line 277
// ---------------------------------------------------------------------------

test("startOutputTailer: non-numeric CLOSEDLOOP_TAILER_THROTTLE_MS uses fallback (line 277)", () => {
  // line 277: Number.isFinite(n) → false for NaN → return fallback
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "abc";
  try {
    const tailer = startOutputTailer(
      "/nonexistent.jsonl",
      "http://localhost",
      "loop-id",
      () => null,
      0
    );
    // parseEnvNumber("abc") → NaN → not finite → fallback used. The chosen
    // throttle is not exposed on the returned handle, so what is assertable
    // here is that the non-numeric value is tolerated and a usable tailer comes
    // back — a regression that let NaN through would produce a handle whose
    // timer never fires, or throw outright.
    assert.ok(tailer, "a tailer handle should be returned");
    assert.equal(typeof tailer.stop, "function");
    assert.equal(typeof tailer.flush, "function");
    tailer.stop();
  } finally {
    Reflect.deleteProperty(process.env, "CLOSEDLOOP_TAILER_THROTTLE_MS");
  }
});

// ---------------------------------------------------------------------------
// codex.ts — streamCodexReview: lines 2251, 2255, 2259, 2266, 2276
// ---------------------------------------------------------------------------

describe("streamCodexReview", () => {
  test("TestResponse.once registers close listener, Buffer on stdout is decoded, session ID captured, stderr Buffer decoded (lines 2251, 2255, 2259, 2266, 2276)", {
    timeout: 10_000,
  }, async () => {
    const tmpDir = makeTempDir("codex-review-test-");
    const logPath = path.join(tmpDir, "review.log");

    const child = buildMockChildProcess(9901);
    // TestResponse is an EventEmitter — response.once?.() is defined → line 2251 TRUE
    const response = new TestResponse();
    const sessionIdHolder: { value: string | undefined } = { value: undefined };
    const stderrHolder: { value: string } = { value: "" };

    const done = streamCodexReview(
      child as unknown as ChildProcess,
      response as unknown as ServerResponse,
      logPath,
      sessionIdHolder,
      stderrHolder
    );

    // line 2255 FALSE branch: emit Buffer on stdout → chunk.toString("utf-8")
    child.stdout.emit("data", Buffer.from("hello review\n"));

    // line 2259 TRUE: emit text containing session ID → captured
    child.stdout.emit("data", `Session ID: ${FAKE_SESSION_ID}\nmore text\n`);

    // line 2266: emit enough events to cross eventCount > 3 threshold
    for (let i = 0; i < 5; i++) {
      child.stdout.emit("data", `extra line ${i}\n`);
    }

    // line 2276 FALSE branch: emit Buffer on stderr → chunk.toString("utf-8")
    child.stderr.emit("data", Buffer.from("stderr warning\n"));

    // trigger child close → stopKeepalive() + logStream.end() → Promise resolves
    child.emit("close");

    await done;

    assert.equal(sessionIdHolder.value, FAKE_SESSION_ID);
    assert.ok(stderrHolder.value.includes("stderr warning"));

    // Verify response.once("close", ...) was registered (line 2251): simulate
    // close to ensure the stopKeepalive callback fires without error
    response.simulateClose();

    const written = response.text();
    assert.ok(written.includes("hello review"));
  });
});

// ---------------------------------------------------------------------------
// codex.ts — GET /codex/status: lines 420, 435, 459, 469, 500, 174, 177, 194, 1690, 1696
// ---------------------------------------------------------------------------

describe("GET /codex/status", () => {
  test("missing repo query param returns 400 (line 420)", async () => {
    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/codex/status/ISS-999",
      // no query.repo
    });
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.rawBody).error.includes("repo"));
  });

  test("worktree directory not found returns 200 hasReview=false (line 435)", async () => {
    const repoDir = makeTempDir("codex-status-repo-");
    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/codex/status/ISS-NOTEXIST",
      query: { repo: repoDir },
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    assert.equal(body.hasReview, false);
    assert.ok(body.message.includes("Worktree"));
  });

  test("worktree exists but no state files → resolveProvider returns null → 200 hasReview=false (lines 459, 1696)", async () => {
    const repoDir = makeTempDir("codex-status-noprov-");
    // Create the worktree dir (repoName-ticketId sibling)
    const worktreeDir = path.join(
      path.dirname(repoDir),
      `${path.basename(repoDir)}-ISS-NOPROV`
    );
    await fs.mkdir(worktreeDir, { recursive: true });
    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/codex/status/ISS-NOPROV",
      query: { repo: repoDir },
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    assert.equal(body.hasReview, false);
    assert.ok(body.message.includes("No review"));
  });

  test("resolveProvider returns 'claude' when codex-review-claude.json exists (line 1690), status=completed → processRunning=false (line 174)", async () => {
    const repoDir = makeTempDir("codex-status-claude-");
    const worktreeDir = path.join(
      path.dirname(repoDir),
      `${path.basename(repoDir)}-ISS-CLAUDE`
    );
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    await fs.mkdir(workDir, { recursive: true });
    // Presence of this file makes resolveProvider return "claude" (line 1690)
    const statePath = path.join(workDir, "codex-review-claude.json");
    writeFileSync(
      statePath,
      JSON.stringify({ status: "completed", pid: 0, provider: "claude" })
    );
    // Create empty log file
    writeFileSync(path.join(workDir, "codex-review-claude.log"), "");

    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/codex/status/ISS-CLAUDE",
      query: { repo: repoDir },
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    assert.equal(body.hasReview, true);
    // line 174: status !== "running" → checkReviewProcess returns false
    assert.equal(body.processRunning, false);
  });

  test("status=running with non-existent pid → isProcessRunning returns false (line 177)", async () => {
    const repoDir = makeTempDir("codex-status-running-");
    const worktreeDir = path.join(
      path.dirname(repoDir),
      `${path.basename(repoDir)}-ISS-RUN`
    );
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    await fs.mkdir(workDir, { recursive: true });
    const statePath = path.join(workDir, "codex-review-claude.json");
    // pid=999999999 is astronomically unlikely to exist
    writeFileSync(
      statePath,
      JSON.stringify({
        status: "running",
        pid: 999_999_999,
        provider: "claude",
      })
    );
    writeFileSync(path.join(workDir, "codex-review-claude.log"), "");

    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/codex/status/ISS-RUN",
      query: { repo: repoDir },
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    assert.equal(body.hasReview, true);
    // line 177: isProcessRunning returns false (no such pid)
    assert.equal(body.processRunning, false);
  });

  test("provider via query param but statePath absent → 200 hasReview=false (line 469)", async () => {
    const repoDir = makeTempDir("codex-status-nostate-");
    const worktreeDir = path.join(
      path.dirname(repoDir),
      `${path.basename(repoDir)}-ISS-NOSTATE`
    );
    // Create worktree dir but do NOT create the state file
    await fs.mkdir(path.join(worktreeDir, ".closedloop-ai", "work"), {
      recursive: true,
    });

    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/codex/status/ISS-NOSTATE",
      query: { repo: repoDir, provider: "claude" },
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    assert.equal(body.hasReview, false);
  });

  test("state file contains invalid JSON → 500 (line 500)", async () => {
    const repoDir = makeTempDir("codex-status-badjson-");
    const worktreeDir = path.join(
      path.dirname(repoDir),
      `${path.basename(repoDir)}-ISS-BADJSON`
    );
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    await fs.mkdir(workDir, { recursive: true });
    const statePath = path.join(workDir, "codex-review-claude.json");
    writeFileSync(statePath, "INVALID_JSON{{{{");
    writeFileSync(path.join(workDir, "codex-review-claude.log"), "");

    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/codex/status/ISS-BADJSON",
      query: { repo: repoDir },
    });
    assert.equal(result.statusCode, 500);
    assert.ok(
      JSON.parse(result.rawBody).error.includes("Failed to read status")
    );
  });

  test("log file > 100 KB triggers truncation (line 194)", {
    timeout: 10_000,
  }, async () => {
    const repoDir = makeTempDir("codex-status-biglog-");
    const worktreeDir = path.join(
      path.dirname(repoDir),
      `${path.basename(repoDir)}-ISS-BIGLOG`
    );
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    await fs.mkdir(workDir, { recursive: true });
    const statePath = path.join(workDir, "codex-review-claude.json");
    writeFileSync(
      statePath,
      JSON.stringify({ status: "completed", pid: 0, provider: "claude" })
    );
    // Write > 100KB (102_400 bytes) to the log file to trigger truncation
    const bigLog =
      `${JSON.stringify({ type: "text", content: "x".repeat(80) })}\n`.repeat(
        1400
      );
    writeFileSync(path.join(workDir, "codex-review-claude.log"), bigLog);

    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/codex/status/ISS-BIGLOG",
      query: { repo: repoDir },
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    assert.equal(body.hasReview, true);
    // logSize exceeds 100KB; log is returned (possibly truncated/empty due to
    // partial JSON at cut point, but request succeeded covering line 194)
    assert.ok(typeof body.logSize === "number" && body.logSize > 102_400);
  });
});

// ---------------------------------------------------------------------------
// codex.ts — POST /review-verdict: lines 881, 892, 910
// ---------------------------------------------------------------------------

describe("POST /review-verdict", () => {
  test("malformed JSON body returns 400 (line 881)", async () => {
    // parseBody returns {} (truthy) for empty body; only invalid JSON → null → line 881
    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/codex/review-verdict/ISS-V1",
      body: "{invalid json",
    });
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.rawBody).error.includes("Invalid"));
  });

  test("body missing sessionId returns 400 (line 892)", async () => {
    const repoDir = makeTempDir("codex-verdict-missing-");
    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/codex/review-verdict/ISS-V2",
      body: JSON.stringify({
        repoPath: repoDir,
        provider: "claude" /* no sessionId */,
      }),
    });
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.rawBody).error.includes("required"));
  });

  test("worktree not found returns 404 (line 910)", async () => {
    const repoDir = makeTempDir("codex-verdict-noworktree-");
    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/codex/review-verdict/ISS-V3",
      body: JSON.stringify({
        repoPath: repoDir,
        sessionId: "some-session-id",
        provider: "claude",
      }),
    });
    assert.equal(result.statusCode, 404);
    assert.ok(JSON.parse(result.rawBody).error.includes("not found"));
  });
});

// ---------------------------------------------------------------------------
// codex.ts — POST /chat: lines 1267, 1281
// ---------------------------------------------------------------------------

describe("POST /codex/chat", () => {
  test("malformed JSON body returns 400 (line 1267)", async () => {
    // parseBody returns {} (truthy) for empty body; only invalid JSON → null → line 1267
    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/codex/chat/ISS-C1",
      body: "{bad",
    });
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.rawBody).error.includes("Invalid"));
  });

  test("disallowed repoPath returns 403 (line 1281)", async () => {
    const dispatcher = makeCodexDispatcher();
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/codex/chat/ISS-C2",
      body: JSON.stringify({
        prompt: "hello",
        repoPath: "/root/secret/not-allowed",
      }),
    });
    assert.equal(result.statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// git-diff.ts — lines 50, 79, 197, 214, 229, 255, 279
// ---------------------------------------------------------------------------

describe("git/diff operations", () => {
  const { makeTempDir: mkGitDir } = createGitOpTempDirs("git-diff-ops-");

  test("body without repoPath returns 400 (line 50 FALSE branch: repoPath → null)", async () => {
    const pm = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [
      os.tmpdir(),
    ]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: "foo.txt" }), // no repoPath
    });
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.rawBody).error.includes("required"));
  });

  test("file exists in repo → assertPathAllowed called (line 79), git status empty → 400 no changes", async () => {
    const repoDir = mkGitDir();
    // Create the file so existsSync(fullFilePath) = true → line 79 TRUE branch
    writeFileSync(path.join(repoDir, "test.txt"), "content");
    const pm = new FakeProcessManager([
      // git status --porcelain -- test.txt → empty (no changes)
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: "test.txt", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.rawBody).error.includes("no changes"));
  });

  test("git show fails with empty stderr → throws 'unknown error' (line 197)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // handleBranchDiff calls both git show ops before asserting:
      // git show origin/main:file.txt → non-zero, empty stderr (no MISSING_PATH_SIGNATURES)
      { exitCode: 128, stdout: "", stderr: "" },
      // git show HEAD:file.txt → called first, checked after (never actually reached)
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({
        filePath: "file.txt",
        repoPath: repoDir,
        baseBranch: "main",
      }),
    });
    assert.equal(result.statusCode, 500);
    assert.ok(JSON.parse(result.rawBody).error.includes("unknown error"));
  });

  test("git status fails with empty stderr → 'Failed to get file status' (line 214)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git status --porcelain → non-zero, empty stderr
      { exitCode: 128, stdout: "", stderr: "" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: "file.txt", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 500);
    assert.ok(
      JSON.parse(result.rawBody).error.includes("Failed to get file status")
    );
  });

  test("git status returns 1-char rawLine → rawLine.length < 2 FALSE branch (line 229)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git status returns a 1-char line "M\n" — unusual but valid mock
      { exitCode: 0, stdout: "M\n", stderr: "" },
      // git show HEAD:file.txt succeeds
      { exitCode: 0, stdout: "old content", stderr: "" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: "file.txt", repoPath: repoDir }),
    });
    // rawLine = "M" (length 1) → twoChar = "M" (FALSE ternary branch at line 228)
    // isNew=false, isDeleted=false, file not on disk → newContent=""
    assert.equal(result.statusCode, 200);
  });

  test("git show HEAD: fails → oldContent set to '' (line 255 FALSE branch)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git status returns "M  file.txt\n" (modified file)
      { exitCode: 0, stdout: "M  file.txt\n", stderr: "" },
      // git show HEAD:file.txt fails (exitCode != 0)
      { exitCode: 1, stdout: "", stderr: "path not found" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: "file.txt", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    // line 255: exitCode !== 0 → oldContent = "" (FALSE branch)
    assert.equal(body.oldContent, "");
  });

  test("filePath='.' makes canonicalTarget === canonicalRoot → return true (line 279)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git status --porcelain -- . → empty (no changes)
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: ".", repoPath: repoDir }),
    });
    // repoDir/. = repoDir → canonicalTarget === canonicalRoot → containedInRepo=true (line 279)
    // git status returns empty → "File has no changes"
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.rawBody).error.includes("no changes"));
  });
});

// ---------------------------------------------------------------------------
// git-action.ts — lines 408, 503, 511, 668, 708, 756
// ---------------------------------------------------------------------------

describe("git action operations", () => {
  const { makeTempDir: mkGitDir } = createGitOpTempDirs("git-action-ops-");

  test("sync-status: rev-list returns 1 element → behindRaw=undefined ?? '0' (line 408)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git fetch origin → success
      { exitCode: 0, stdout: "", stderr: "" },
      // git rev-parse --abbrev-ref HEAD → "main"
      { exitCode: 0, stdout: "main\n", stderr: "" },
      // git branch -r → includes origin/main
      { exitCode: 0, stdout: "  origin/main\n", stderr: "" },
      // git rev-list --left-right --count → "2" (only 1 element, no tab)
      { exitCode: 0, stdout: "2\n", stderr: "" },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({ action: "sync-status", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    // behindRaw = undefined → ?? "0" → behindBy = 0 (line 408)
    assert.equal(body.behindBy, 0);
  });

  test("git status --porcelain: line with whitespace-only path → parsePorcelainLine returns null (line 503)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // rev-parse HEAD
      { exitCode: 0, stdout: "main\n", stderr: "" },
      // git status --porcelain: "M  \t" — length=4, path="\t", trim="" → !rawPath (line 503)
      { exitCode: 0, stdout: "M  \t\n", stderr: "" },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({ action: "status", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    // parsePorcelainLine returned null → entry skipped → no files
    assert.deepEqual(body.files.modified, []);
  });

  test("git status --porcelain: empty quoted path → unquotePorcelainPath returns '' → !file (line 511)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      { exitCode: 0, stdout: "main\n", stderr: "" },
      // porcelain line 'M  ""' → rawPath='""' → unquote → "" → !file (line 511)
      { exitCode: 0, stdout: 'M  ""\n', stderr: "" },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({ action: "status", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    assert.deepEqual(body.files.modified, []);
  });

  test("git commit fails with empty stderr/stdout → getGitActionOutput falls back to stderrExcerpt (line 668)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git add . → success
      { exitCode: 0, stdout: "", stderr: "" },
      // git commit -m "msg" → fails, empty stderr and stdout (line 668)
      { exitCode: 1, stdout: "", stderr: "" },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({
        action: "commit",
        repoPath: repoDir,
        message: "test commit",
      }),
    });
    // getGitActionOutput: [stderr="", stdout=""].filter(Boolean)=[] → join="" → || stderrExcerpt
    assert.equal(result.statusCode, 500);
  });

  test("git push fails with HTTP 403 → isPushAuthFailure returns true via '403' check (line 708)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git rev-parse --abbrev-ref HEAD → "main"
      { exitCode: 0, stdout: "main\n", stderr: "" },
      // git push → fails with 403 (not "authentication failed" etc.) → covers line 708
      {
        exitCode: 128,
        stdout: "",
        stderr: "HTTP 403 forbidden",
      },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({ action: "push", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 500);
    const body = JSON.parse(result.rawBody);
    assert.ok(body.details.category === "git_push_auth");
  });

  test("branch-diff: diff line with tab+space → parseNameStatusLine file is empty → null (line 756)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git rev-parse --abbrev-ref HEAD
      { exitCode: 0, stdout: "feature\n", stderr: "" },
      // git diff --name-status origin/main...HEAD → "M\t " (tab + space, file.trim()="")
      { exitCode: 0, stdout: "M\t \n", stderr: "" },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({
        action: "branch-diff",
        repoPath: repoDir,
        baseBranch: "main",
      }),
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    // parseNameStatusLine("M\t "): file=" ".trim()="" → return null → entry skipped
    assert.deepEqual(body.files.modified, []);
  });
});

// ---------------------------------------------------------------------------
// router.ts — lines 939, 969, 1021, 1134
// ---------------------------------------------------------------------------

describe("GatewayRouter exchange route", () => {
  test("getApiKeyProvenance is called when provided (line 939 non-null path)", {
    timeout: 10_000,
  }, async () => {
    let provenanceCalled = false;
    const router = makeRouter({
      getGatewayAuthToken: () => "test-auth-token",
      getApiKey: () => "sk_live_testkey",
      getApiOrigin: () => "http://api-test.local",
      sessionStore: new LocalSessionStore(),
      getApiKeyProvenance: () => {
        provenanceCalled = true;
        return "USER_CREATED";
      },
    });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "challenge rejected" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const response = await dispatchExchange({
      router,
      chunks: [JSON.stringify({ challengeToken: "test-challenge-abc" })],
    });

    // Line 939: getApiKeyProvenance?.() called (non-null) rather than "USER_CREATED" fallback
    assert.ok(provenanceCalled, "getApiKeyProvenance must have been called");
    assert.equal(response.statusCode, 401);
  });

  test("sessionStore.create called after successful verifyChallenge → 200 with session token (line 969)", {
    timeout: 10_000,
  }, async () => {
    const sessionStore = new LocalSessionStore();
    const router = makeRouter({
      getGatewayAuthToken: () => "test-auth-token",
      getApiKey: () => "sk_live_testkey",
      getApiOrigin: () => "http://api-test.local",
      sessionStore,
    });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, sessionTtlSeconds: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const response = await dispatchExchange({
      router,
      chunks: [JSON.stringify({ challengeToken: "valid-challenge-xyz" })],
    });

    // Line 969: sessionStore.create(requestOrigin, result.sessionTtlSeconds) called
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(typeof body.sessionToken === "string");
    assert.ok(typeof body.expiresAt === "string");
  });

  test("content-length ≤ limit but actual body > limit triggers 413 with bigintToSafeNumber (line 1021 FALSE branch)", async () => {
    const router = makeRouter({
      getGatewayAuthToken: () => "test-auth-token",
      getApiKey: () => "sk_live_testkey",
      getApiOrigin: () => "http://api-test.local",
    });

    // content-length: 100 ≤ 4096 (skips early reject), but actual body is 4097 bytes
    // During streaming, observedSizeBytes > 4096 → throws RequestBodyTooLargeError
    // At line 1021: declaredSizeBytes = 100n !== null → FALSE branch → bigintToSafeNumber(100n)
    const response = await dispatchExchange({
      router,
      headers: { "content-length": "100" },
      chunks: ["x".repeat(4097)],
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error, "request body too large");
  });

  test("empty-array header → firstHeaderValue returns null via ?? null (line 1134)", {
    timeout: 10_000,
  }, async () => {
    // The `firstHeaderValue` calls live inside the argument to
    // `this.options.evaluateApproval?.(...)` (router.ts:603-618), which sits
    // behind TWO gates: the route must be `/api/gateway/*` (router.ts:500,584)
    // and it must already be authorized (router.ts:557 returns early otherwise).
    // So the request carries a matching `x-desktop-gateway-token` and targets a
    // gateway path — the exchange route never reaches this block at all. With
    // no evaluateApproval configured the optional call also short-circuits and
    // the argument is never evaluated, so asserting on the response status
    // alone would prove nothing about line 1134; capturing the hook's argument
    // is what proves the branch ran.
    let captured: GatewayApprovalRequest | null = null;
    const router = makeRouter({
      getGatewayAuthToken: () => "test-auth-token",
      evaluateApproval: (request) => {
        captured = request;
        return { allow: true };
      },
    });

    // `x-desktop-source` is a custom header, so Node types it through the
    // IncomingHttpHeaders index signature as string | string[] | undefined and
    // collects repeated occurrences into an array — an empty array is the
    // degenerate case. `user-agent` is typed string | undefined and cannot
    // carry one. Empty array → Array.isArray true → value[0] undefined → ?? null.
    await dispatchMockRequest({
      router,
      method: "POST",
      path: "/api/gateway/git",
      headers: {
        "content-type": "application/json",
        "x-desktop-gateway-token": "test-auth-token",
        "x-desktop-source": [],
      },
      chunks: [JSON.stringify({})],
    });

    const approval = captured as GatewayApprovalRequest | null;
    assert.ok(approval, "evaluateApproval was never invoked");
    assert.equal(approval.source, null);
    // Contrast: user-agent was absent entirely, so it takes the `!value` arm.
    assert.equal(approval.userAgent, null);
  });
});
