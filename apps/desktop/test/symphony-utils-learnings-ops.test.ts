/**
 * ISS-5299 — Branch coverage for uncovered paths in:
 *   apps/desktop/src/server/operations/learnings.ts         lines 105, 139, 195, 226, 383, 410, 489, 545
 *   apps/desktop/src/server/operations/symphony-utils.ts    lines 217, 291, 302, 1030, 1034
 *   apps/desktop/src/server/operations/symphony-interactive.ts lines 505, 990
 *
 * Each test drives real handlers or exported functions and asserts observable
 * outcomes (status codes, return values). No production source files are touched.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { RetrySpawnDeps } from "../src/main/util/spawn-retry.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerLearningsRoutes } from "../src/server/operations/learnings.js";
import { registerSymphonyInteractiveRoutes } from "../src/server/operations/symphony-interactive.js";
import { configureBinaryPathsResolver } from "../src/server/operations/symphony-loop.js";
import {
  restoreWorktreeState,
  runBootstrapIfNeeded,
  runLoopsSetupScript,
  saveWorktreeState,
} from "../src/server/operations/symphony-utils.js";
import type { ClaudeCodeShellEnvProvider } from "../src/server/otel/claude-code-env.js";
import { resetShellPathCache } from "../src/server/shell-path.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  pinDefaultWorktreeParentDir,
} from "./helpers/git-gateway-op-harness.js";

import {
  initGitRepo,
  setupStubClaude,
  writeBootstrapPluginRegistry,
} from "./symphony-test-utils.js";

// resolveWorktreeDir prefers SYMPHONY_WORKTREE_PARENT_DIR over the default
// dirname(repoPath) branch these fixtures are built for, so pin it unset.
pinDefaultWorktreeParentDir();

// ---------------------------------------------------------------------------
// Module-level regex constants (Ultracite useTopLevelRegex)
// ---------------------------------------------------------------------------

const RE_NOT_ALLOWED = /not allowed/i;
const RE_TICKET_ID_REPO_PATH = /ticketId and repoPath/i;
const RE_NO_CHAT_HISTORY = /No chat history found/i;

// ---------------------------------------------------------------------------
// Shared stubs used by the interactive-dispatcher factory
// ---------------------------------------------------------------------------

const stubDeps: RetrySpawnDeps = {
  log: () => {},
  refreshTray: () => {},
  isShuttingDown: () => false,
  delay: () => Promise.resolve(),
};

const stubShellEnv: ClaudeCodeShellEnvProvider = async () => ({});

// ---------------------------------------------------------------------------
// Env save/restore — runs after every test in this file
// ---------------------------------------------------------------------------

const savedHome = process.env.HOME;
const savedPath = process.env.PATH;

afterEach(() => {
  if (savedHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = savedHome;
  }
  if (savedPath === undefined) {
    Reflect.deleteProperty(process.env, "PATH");
  } else {
    process.env.PATH = savedPath;
  }
  configureBinaryPathsResolver(null);
  resetShellPathCache();
});

// Synchronous temp-dir factory with automatic cleanup after each test.
const { makeTempDir } = createGitOpTempDirs("iss5299-ul-ops-");

// ---------------------------------------------------------------------------
// Dispatcher factories
// ---------------------------------------------------------------------------

function makeLearningsDispatcher(
  allowedDirs: string[],
  symphonyDir: string
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerLearningsRoutes(
    dispatcher,
    () => allowedDirs,
    () => symphonyDir
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

/**
 * Create a minimal workspace layout so assertRepoAllowed and assertPathAllowed
 * both pass without setting SYMPHONY_WORKTREE_PARENT_DIR:
 *   repoDir    = allowedDir/repo       (repoPath the route sees)
 *   worktreeDir = allowedDir/repo-<ticketId>   (computed by resolveWorktreeDir)
 * Both are children of allowedDir, so allowedDirs = [allowedDir] satisfies
 * every security check.
 */
function makeWorkspace(
  allowedDir: string,
  ticketId: string
): { repoDir: string; worktreeDir: string } {
  const repoDir = path.join(allowedDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  const worktreeDir = path.join(allowedDir, `repo-${ticketId}`);
  mkdirSync(worktreeDir, { recursive: true });
  return { repoDir, worktreeDir };
}

// ---------------------------------------------------------------------------
// learnings.ts — POST /extract-learnings  (lines 105, 139)
// ---------------------------------------------------------------------------

describe("POST /extract-learnings — lines 105 and 139", () => {
  test("returns 404 when worktreeDir exists but chat history is absent (line 105)", async () => {
    const allowedDir = makeTempDir();
    const { repoDir } = makeWorkspace(allowedDir, "ISS-105");
    // worktreeDir is created by makeWorkspace but has no chat-history.json
    const dispatcher = makeLearningsDispatcher([allowedDir], allowedDir);

    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/extract-learnings",
      body: JSON.stringify({ ticketId: "ISS-105", repoPath: repoDir }),
    });

    assert.equal(res.statusCode, 404);
    assert.match((res.body as { error: string }).error, RE_NO_CHAT_HISTORY);
  });

  test("returns 200 processing when chat history exists, triggering void IIFE (line 139)", {
    timeout: 5000,
  }, async () => {
    const allowedDir = makeTempDir();
    const { repoDir, worktreeDir } = makeWorkspace(allowedDir, "ISS-139");
    // Populate the chat history file so the route passes the existsSync check
    const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(
      path.join(claudeWorkDir, "chat-history.json"),
      JSON.stringify([{ role: "user", content: "hello" }])
    );
    // The route creates this directory; pre-know the status path so we can
    // poll for the IIFE's "completed" write to drain it before afterEach cleanup.
    const statusPath = path.join(
      claudeWorkDir,
      ".learnings",
      "chat-extraction-status.json"
    );
    const dispatcher = makeLearningsDispatcher([allowedDir], allowedDir);

    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/extract-learnings",
      body: JSON.stringify({ ticketId: "ISS-139", repoPath: repoDir }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { status: string }).status, "processing");

    // The void IIFE sleeps 250 ms then writes "completed". Poll until it does
    // so the file write completes before afterEach removes the temp dir.
    // Bounded, and THROWS when the bound is exhausted rather than falling
    // through: a silent fall-through would let afterEach `fs.rm` the temp dir
    // while the background write is still in flight, turning a real regression
    // into an unrelated flake elsewhere in the run
    // (apps/desktop/AGENTS.md — "test:node determinism").
    const deadline = Date.now() + 2000;
    let completed = false;
    while (Date.now() < deadline) {
      try {
        const parsed = JSON.parse(readFileSync(statusPath, "utf-8")) as {
          status: string;
        };
        if (parsed.status === "completed") {
          completed = true;
          break;
        }
      } catch {
        // File not yet updated — yield to event loop and retry.
      }
      await new Promise((r) => setImmediate(r));
    }
    if (!completed) {
      throw new Error(
        `background write never reached status "completed" within 2000ms; ${statusPath} was not updated`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// learnings.ts — GET /process-learnings  (line 195)
// ---------------------------------------------------------------------------

describe("GET /process-learnings — line 195", () => {
  test("returns parsed JSON when processing-status.json exists (line 195 reached)", async () => {
    const allowedDir = makeTempDir();
    const { repoDir, worktreeDir } = makeWorkspace(allowedDir, "ISS-195");
    const statusPath = path.join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      ".learnings",
      "processing-status.json"
    );
    mkdirSync(path.dirname(statusPath), { recursive: true });
    writeFileSync(
      statusPath,
      JSON.stringify({ status: "completed", count: 5 })
    );
    const dispatcher = makeLearningsDispatcher([allowedDir], allowedDir);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/process-learnings",
      query: { ticketId: "ISS-195", repo: repoDir },
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { status: string }).status, "completed");
    assert.equal((res.body as { count: number }).count, 5);
  });
});

// ---------------------------------------------------------------------------
// learnings.ts — POST /process-learnings  (line 226 — 403 on disallowed repo)
// ---------------------------------------------------------------------------

describe("POST /process-learnings — line 226", () => {
  test("returns 403 when repoPath is outside allowed directories (line 226)", async () => {
    const allowedDir = makeTempDir();
    const dispatcher = makeLearningsDispatcher([allowedDir], allowedDir);

    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/process-learnings",
      body: JSON.stringify({ ticketId: "ISS-226", repoPath: "/etc" }),
    });

    assert.equal(res.statusCode, 403);
    assert.match((res.body as { error: string }).error, RE_NOT_ALLOWED);
  });
});

// ---------------------------------------------------------------------------
// learnings.ts — GET /learnings-status/:ticketId catch  (line 383)
// ---------------------------------------------------------------------------

describe("GET /learnings-status — line 383", () => {
  test("returns 200 status=none when status file is a directory (EISDIR → catch at line 383)", async () => {
    const allowedDir = makeTempDir();
    const { repoDir, worktreeDir } = makeWorkspace(allowedDir, "ISS-383");
    // Create the status file path AS A DIRECTORY so fs.readFile throws EISDIR
    const statusPath = path.join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      ".learnings",
      "chat-extraction-status.json"
    );
    mkdirSync(statusPath, { recursive: true });
    const dispatcher = makeLearningsDispatcher([allowedDir], allowedDir);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/learnings-status/ISS-383",
      query: { repo: repoDir },
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { status: string }).status, "none");
    assert.equal((res.body as { count: number }).count, 0);
  });
});

// ---------------------------------------------------------------------------
// learnings.ts — POST /record-learning-use  (line 410 — true branch)
// ---------------------------------------------------------------------------

describe("POST /record-learning-use — line 410", () => {
  test("returns 400 when ticketId is absent (true branch of if (!(ticketId && repoPath)))", async () => {
    const allowedDir = makeTempDir();
    const dispatcher = makeLearningsDispatcher([allowedDir], allowedDir);

    // Send repoPath and learnings but omit ticketId → condition fires
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/record-learning-use",
      body: JSON.stringify({
        repoPath: allowedDir,
        learnings: [{ summary: "learned something" }],
      }),
    });

    assert.equal(res.statusCode, 400);
    assert.match((res.body as { error: string }).error, RE_TICKET_ID_REPO_PATH);
  });
});

// ---------------------------------------------------------------------------
// learnings.ts — GET /pending-learnings  (line 489 — for-loop body executes)
// ---------------------------------------------------------------------------

describe("GET /pending-learnings — line 489", () => {
  test("counts pending .json files when a git repo has a pending-learnings dir (line 489)", {
    timeout: 15_000,
  }, async () => {
    const allowedDir = makeTempDir();
    const repoDir = path.join(allowedDir, "git-repo");

    // Real git repo so listAllWorktrees(repoDir) returns [repoDir]
    await initGitRepo(repoDir);

    // Pending dir with one .json file inside the repo itself
    const pendingDir = path.join(
      repoDir,
      ".closedloop-ai",
      "work",
      ".learnings",
      "pending"
    );
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(
      path.join(pendingDir, "learning-001.json"),
      JSON.stringify({ summary: "learned something useful" })
    );

    // symphonyDir with repos.json pointing at repoDir
    const symphonyDir = makeTempDir();
    const configDir = path.join(symphonyDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "repos.json"),
      JSON.stringify({
        repos: [{ path: repoDir, addedAt: new Date().toISOString() }],
        settings: {},
      })
    );
    const dispatcher = makeLearningsDispatcher([repoDir], symphonyDir);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/pending-learnings",
    });

    assert.equal(res.statusCode, 200);
    assert.ok(
      (res.body as { totalCount: number }).totalCount >= 1,
      "at least one pending learning should be counted"
    );
  });
});

// ---------------------------------------------------------------------------
// learnings.ts — GET /process-all-learnings catch  (line 545)
// ---------------------------------------------------------------------------

describe("GET /process-all-learnings — line 545", () => {
  test("returns 200 status=none when status file is a directory (EISDIR → catch at line 545)", async () => {
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    // Create the status path AS A DIRECTORY so fs.readFile throws EISDIR
    const statusPath = path.join(
      homeDir,
      ".closedloop-ai",
      "learnings",
      "batch-processing-status.json"
    );
    mkdirSync(statusPath, { recursive: true });
    const dispatcher = makeLearningsDispatcher([], homeDir);

    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/process-all-learnings",
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { status: string }).status, "none");
  });
});

// ---------------------------------------------------------------------------
// symphony-utils.ts — runLoopsSetupScript catch  (line 217)
// ---------------------------------------------------------------------------

describe("runLoopsSetupScript — line 217", () => {
  test("does not throw when loops-setup.sh exits non-zero (catch at line 217)", async () => {
    const worktreeDir = makeTempDir();
    const scriptDir = path.join(worktreeDir, ".closedloop-ai");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      path.join(scriptDir, "loops-setup.sh"),
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 }
    );

    // failure is caught internally and logged — must not propagate
    await assert.doesNotReject(() =>
      runLoopsSetupScript(worktreeDir, "loop-217")
    );
  });
});

// ---------------------------------------------------------------------------
// symphony-utils.ts — restoreWorktreeState catches  (lines 291, 302)
// ---------------------------------------------------------------------------

describe("restoreWorktreeState — lines 291 and 302", () => {
  test("does not throw when savedClaudeAgentsDir is deleted before restore (catch at line 291)", () => {
    const worktreeDir = makeTempDir();
    const agentsDir = path.join(worktreeDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "agent.md"), "# test agent");

    const saved = saveWorktreeState(worktreeDir);
    assert.ok(
      saved.savedClaudeAgentsDir !== null,
      "claude agents dir should have been moved to tmp"
    );

    // Remove the saved dir so readdirSync inside restoreWorktreeState throws
    rmSync(saved.savedClaudeAgentsDir as string, {
      recursive: true,
      force: true,
    });

    // catch at line 291 fires — must not throw
    assert.doesNotThrow(() => restoreWorktreeState(saved, worktreeDir));
  });

  test("does not throw when savedClosedloopDir is deleted before restore (catch at line 302)", () => {
    const worktreeDir = makeTempDir();
    const closedloopDir = path.join(worktreeDir, ".closedloop-ai");
    mkdirSync(closedloopDir, { recursive: true });
    writeFileSync(path.join(closedloopDir, "config.json"), "{}");

    const saved = saveWorktreeState(worktreeDir);
    assert.ok(
      saved.savedClosedloopDir !== null,
      ".closedloop-ai dir should have been moved to tmp"
    );

    // Remove the saved dir so cpSync inside restoreWorktreeState throws
    rmSync(saved.savedClosedloopDir as string, {
      recursive: true,
      force: true,
    });

    // catch at line 302 fires — must not throw
    assert.doesNotThrow(() => restoreWorktreeState(saved, worktreeDir));
  });
});

// ---------------------------------------------------------------------------
// symphony-utils.ts — runBootstrapIfNeeded  (lines 1030, 1034)
// ---------------------------------------------------------------------------

describe("runBootstrapIfNeeded — lines 1030 and 1034", () => {
  test("catch at line 1034 fires when getClaudeShellEnv throws", async () => {
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    await writeBootstrapPluginRegistry(homeDir);
    const worktreeDir = makeTempDir();

    // Synchronous throw inside an async-typed callback: returning a rejected
    // Promise satisfies ClaudeCodeShellEnvProvider without an async keyword
    // (which would trigger lint/suspicious/useAwait for the missing await).
    const throwingEnv: ClaudeCodeShellEnvProvider = () =>
      Promise.reject(
        new Error("env provider failed intentionally (line 1034 test)")
      );

    const result = await runBootstrapIfNeeded(
      worktreeDir,
      "loop-1034",
      throwingEnv
    );

    // catch at line 1034 always returns { status: "failed", exitCode: null }
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.exitCode, null);
    }
  });

  test("exitCode is null when spawn cannot find binary (child.on(error) path at line 1030)", {
    timeout: 10_000,
  }, async () => {
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    await writeBootstrapPluginRegistry(homeDir);
    const worktreeDir = makeTempDir();

    // Override claude path to a non-existent binary so spawn emits "error"
    configureBinaryPathsResolver(() => ({
      claude: path.join(homeDir, "__no-such-binary__"),
    }));

    const result = await runBootstrapIfNeeded(worktreeDir, "loop-1030");

    assert.equal(result.status, "failed");
    // exitCode: null is set by the child.on("error") handler (line 1030)
    if (result.status === "failed") {
      assert.equal(result.exitCode, null);
    }
  });
});

// ---------------------------------------------------------------------------
// symphony-interactive.ts — GET /commit-message large diff  (lines 505, 990)
// ---------------------------------------------------------------------------

describe("GET /commit-message — lines 505 and 990", () => {
  test("truncates diff >15000 chars then falls back to default when claude fails (lines 505, 990)", {
    timeout: 20_000,
  }, async () => {
    const allowedDir = makeTempDir();
    const repoDir = path.join(allowedDir, "repo");
    mkdirSync(repoDir, { recursive: true });

    // Real git repo at worktreeDir — getGitDiff() runs git commands here
    const worktreeDir = path.join(allowedDir, "repo-ISS-990");
    await initGitRepo(worktreeDir);

    // Write a large file (>15000 chars in the diff output) and commit it
    const bigFile = path.join(worktreeDir, "large.txt");
    const lineContent = `${"x".repeat(200)}\n`; // 201 chars per line
    writeFileSync(bigFile, lineContent.repeat(100)); // 100 lines ≈ 20100 chars
    execFileSync("git", ["add", "large.txt"], {
      cwd: worktreeDir,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "-m", "add large file"], {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    // Overwrite with different content → git diff HEAD shows a large diff
    const changedLine = `${"y".repeat(200)}\n`;
    writeFileSync(bigFile, changedLine.repeat(100));

    // Stub claude to fail (non-zero exit, no JSON stdout) — triggers line 505
    await setupStubClaude(allowedDir, [
      "#!/bin/sh",
      "echo 'stub claude: simulated failure' >&2",
      "exit 2",
    ]);

    const dispatcher = makeInteractiveDispatcher(allowedDir);
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/commit-message/ISS-990",
      query: { repo: repoDir },
    });

    // Route falls back to default title when generateCommitWithClaude throws
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { source: string }).source, "default");
  });
});
