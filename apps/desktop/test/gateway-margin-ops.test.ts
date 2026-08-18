/**
 * ISS-5299 — margin branch coverage for:
 *   symphony-chat-history.ts  lines 288-290, 296
 *   metadata-routes.ts        lines 100, 113, 137, 150, 197, 205
 *   chat-session.ts           lines 85, 91, 105, 454, 457, 460, 463, 467
 *   ticket-chat.ts            line 103
 *   deploy.ts                 lines 738, 749, 770, 805, 850
 *   codex.ts                  line 502
 *
 * Every test drives the real production handler; no logic is replicated.
 *
 * Structurally unreachable branches (documented and skipped):
 *   symphony-chat-history.ts  147 — POST historyWriteDir 403 — derived from
 *     already-cleared assertRepoAllowed; assertPathAllowed only throws
 *     DirectoryNotAllowedError, never a second type.
 *   symphony-chat-history.ts  162, 204 — write-failure catches — require
 *     removing filesystem write permissions at runtime.
 *   symphony-chat-history.ts  308 — DELETE catch 500 — requires
 *     filesystem-level write failure after read succeeds.
 *   metadata-routes.ts  103 — throw error re-throw in symphony/status —
 *     assertPathAllowed only throws DirectoryNotAllowedError.
 *   metadata-routes.ts  161, 265, 276, 306 — ticketId check and
 *     checkPendingClaudeMd/checkBranchStatus bodies — require real git repos.
 *   chat-session.ts  212, 291, 320, 350, 454 (blocks/array branch) —
 *     require real upsert/spawn against live backend.
 *   ticket-chat.ts  106 — throw error re-throw — same as above.
 *   ticket-chat.ts  125, 143, 157, 162, 189, 214, 217, 301 — streaming paths
 *     require a real claude binary.
 *   deploy.ts  408, 426, 495, 544 — throw error re-throws —
 *     enforceAllowed only throws DirectoryNotAllowedError.
 *   deploy.ts  906 — readTextFile catch — requires causing a read error on
 *     an existing file without chmod (fragile).
 *   deploy.ts  1057 — health poll catch — background async with no direct
 *     entry point.
 *   codex.ts  416, 448, 907, 932, 948, 1289, 1299, 1312 — documented skips
 *     in codex-tailer-ops.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { ProviderRegistry } from "../src/server/operations/chat-providers.js";
import { registerChatSessionRoutes } from "../src/server/operations/chat-session.js";
import { registerCodexRoutes } from "../src/server/operations/codex.js";
import { registerDeployRoutes } from "../src/server/operations/deploy.js";
import { registerMetadataRoutes } from "../src/server/operations/metadata-routes.js";
import { registerSymphonyChatHistoryRoutes } from "../src/server/operations/symphony-chat-history.js";
import { registerTicketChatRoutes } from "../src/server/operations/ticket-chat.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

// ── Module-level regex (Biome useTopLevelRegex) ────────────────────────────────
const RE_DIR_NOT_ALLOWED = /directory not allowed/;
const RE_INVALID_INDEX = /Invalid index/;
const RE_OUT_OF_BOUNDS = /Index out of bounds/;
const RE_FAILED_READ_STATUS = /Failed to read status/;

// ── Shared temp dir factory ────────────────────────────────────────────────────
const { makeTempDir } = createGitOpTempDirs("iss5299-margin-");

// ── Shared env-restore helper ──────────────────────────────────────────────────
const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const [key, prev] of savedEnv) {
    if (prev === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = prev;
    }
  }
  savedEnv.clear();
});

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key]);
  }
  process.env[key] = value;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeChatHistoryDispatcher(allowedDirs: string[]): OperationDispatcher {
  const d = new OperationDispatcher();
  registerSymphonyChatHistoryRoutes(d, () => allowedDirs);
  return d;
}

function makeMetadataDispatcher(
  allowedDirs: string[],
  symphonyDir: string
): OperationDispatcher {
  const d = new OperationDispatcher();
  registerMetadataRoutes(
    d,
    () => allowedDirs,
    () => symphonyDir
  );
  return d;
}

function makeDeployDispatcher(
  allowedDir: string,
  symphonyDir?: string
): OperationDispatcher {
  const d = new OperationDispatcher();
  registerDeployRoutes(
    d,
    () => [allowedDir],
    () => symphonyDir ?? path.join(allowedDir, ".symphony")
  );
  return d;
}

function makeCodexDispatcher(allowedDir: string): OperationDispatcher {
  const d = new OperationDispatcher();
  registerCodexRoutes(d, () => [allowedDir]);
  return d;
}

function makeChatSessionDispatcher(
  registry: ProviderRegistry
): OperationDispatcher {
  const d = new OperationDispatcher();
  registerChatSessionRoutes(
    d,
    new FakeProcessManager().asProcessManager(),
    registry,
    () => "gw-test"
  );
  return d;
}

/** Minimal valid userMessage for chat-session POST body. */
const VALID_USER_MSG = {
  id: "msg-1",
  role: "user",
  content: "hello",
  timestamp: "2026-01-01T00:00:00Z",
};

/** Minimal valid chat-session body covering all required fields. */
const VALID_CHAT_BODY = {
  chatKey: "k1",
  apiBaseUrl: "http://localhost:4000",
  apiAuthToken: "tok-abc",
  provider: "claude",
  userMessage: VALID_USER_MSG,
};

// ═══════════════════════════════════════════════════════════════════════════════
// PART 1 — symphony-chat-history.ts DELETE route validation
//   target lines: 288-290 (NaN/negative → 400), 296 (out of bounds → 404)
// ═══════════════════════════════════════════════════════════════════════════════

describe("symphony-chat-history DELETE validation", () => {
  /**
   * Set up a sandbox with repo + worktree directory containing a history file
   * so that the handler reaches the index-validation logic.
   */
  function makeHistorySetup(
    ticketId: string,
    messages: unknown[]
  ): {
    sandboxDir: string;
    repoDir: string;
    dispatcher: OperationDispatcher;
  } {
    const sandboxDir = makeTempDir();
    const repoDir = path.join(sandboxDir, "repo");
    mkdirSync(repoDir);

    // SYMPHONY_WORKTREE_PARENT_DIR controls where resolveWorktreeDir places the worktree.
    setEnv("SYMPHONY_WORKTREE_PARENT_DIR", sandboxDir);

    const worktreeDir = path.join(sandboxDir, `repo-${ticketId}`);
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      path.join(workDir, "chat-history.json"),
      JSON.stringify({ messages, ticketId, repoPath: repoDir }),
      "utf-8"
    );

    return {
      sandboxDir,
      repoDir,
      dispatcher: makeChatHistoryDispatcher([sandboxDir]),
    };
  }

  test("DELETE with non-numeric index → 400 Invalid index (line 289)", async () => {
    const { dispatcher, repoDir } = makeHistorySetup("T001", [
      {
        id: "m1",
        role: "user",
        content: "hi",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
    const res = await dispatchOperation({
      dispatcher,
      method: "DELETE",
      pathname: "/api/gateway/symphony/chat-history/T001",
      query: { repo: repoDir, index: "abc" },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(RE_INVALID_INDEX.test(String(res.body.error)));
  });

  test("DELETE with negative index → 400 Invalid index (line 290)", async () => {
    const { dispatcher, repoDir } = makeHistorySetup("T002", [
      {
        id: "m1",
        role: "user",
        content: "hi",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
    const res = await dispatchOperation({
      dispatcher,
      method: "DELETE",
      pathname: "/api/gateway/symphony/chat-history/T002",
      query: { repo: repoDir, index: "-1" },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(RE_INVALID_INDEX.test(String(res.body.error)));
  });

  test("DELETE with index >= messages.length → 404 Index out of bounds (line 296)", async () => {
    const { dispatcher, repoDir } = makeHistorySetup("T003", [
      {
        id: "m1",
        role: "user",
        content: "hi",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
    const res = await dispatchOperation({
      dispatcher,
      method: "DELETE",
      pathname: "/api/gateway/symphony/chat-history/T003",
      query: { repo: repoDir, index: "5" },
    });
    assert.equal(res.statusCode, 404);
    assert.ok(RE_OUT_OF_BOUNDS.test(String(res.body.error)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 2 — metadata-routes.ts GET /api/gateway/symphony/status
//   target lines: 100 (403), 113 (200 not-running), 137 (isRunning ternary), 150 (500)
// ═══════════════════════════════════════════════════════════════════════════════

describe("metadata-routes GET /api/gateway/symphony/status", () => {
  function makeStatusDispatcher(sandboxDir: string): OperationDispatcher {
    return makeMetadataDispatcher(
      [sandboxDir],
      path.join(sandboxDir, ".symphony")
    );
  }

  test("workDir outside sandbox → 403 directory not allowed (line 100)", async () => {
    const sandboxDir = makeTempDir();
    const dispatcher = makeStatusDispatcher(sandboxDir);
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
      query: { workDir: "/etc/outside-sandbox" },
    });
    assert.equal(res.statusCode, 403);
    assert.ok(RE_DIR_NOT_ALLOWED.test(String(res.body.error)));
  });

  test("state.json not present → 200 isRunning=false (line 113)", async () => {
    const sandboxDir = makeTempDir();
    const workDir = path.join(sandboxDir, "mywork");
    mkdirSync(workDir);
    const dispatcher = makeStatusDispatcher(sandboxDir);
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
      query: { workDir },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isRunning, false);
    assert.equal(res.body.reason, "state.json not found");
  });

  test("state.json with status RUNNING → 200 isRunning=true (line 137 true branch)", async () => {
    const sandboxDir = makeTempDir();
    const workDir = path.join(sandboxDir, "mywork");
    const dotDir = path.join(workDir, ".closedloop-ai", "work");
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(
      path.join(dotDir, "state.json"),
      JSON.stringify({ status: "RUNNING", phase: "execute", iteration: 2 }),
      "utf-8"
    );
    const dispatcher = makeStatusDispatcher(sandboxDir);
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
      query: { workDir },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isRunning, true);
    assert.equal(res.body.phase, "execute");
  });

  test("state.json with status COMPLETED → 200 isRunning=false (line 137 false branch)", async () => {
    const sandboxDir = makeTempDir();
    const workDir = path.join(sandboxDir, "mywork");
    const dotDir = path.join(workDir, ".closedloop-ai", "work");
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(
      path.join(dotDir, "state.json"),
      JSON.stringify({ status: "COMPLETED" }),
      "utf-8"
    );
    const dispatcher = makeStatusDispatcher(sandboxDir);
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
      query: { workDir },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isRunning, false);
  });

  test("state.json parse error → 500 (line 150)", async () => {
    const sandboxDir = makeTempDir();
    const workDir = path.join(sandboxDir, "mywork");
    const dotDir = path.join(workDir, ".closedloop-ai", "work");
    mkdirSync(dotDir, { recursive: true });
    // Make state.json a directory so readFile throws EISDIR (an Error instance).
    mkdirSync(path.join(dotDir, "state.json"));
    const dispatcher = makeStatusDispatcher(sandboxDir);
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
      query: { workDir },
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.isRunning, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 3 — metadata-routes.ts GET /api/gateway/work-directory/:ticketId
//   target lines: 197 (sessions.json parse error), 205 (repo not allowed)
// ═══════════════════════════════════════════════════════════════════════════════

describe("metadata-routes GET /api/gateway/work-directory/:ticketId", () => {
  test("sessions.json with invalid JSON is silently skipped (line 197)", async () => {
    const sandboxDir = makeTempDir();
    const symphonyDir = path.join(sandboxDir, ".symphony");
    mkdirSync(path.join(symphonyDir, "config"), { recursive: true });
    // Write invalid JSON to sessions.json so parse throws.
    writeFileSync(
      path.join(symphonyDir, "sessions.json"),
      "NOT VALID JSON",
      "utf-8"
    );
    // repos.json with no repos → after parse error, falls through to empty config scan.
    writeFileSync(
      path.join(symphonyDir, "config", "repos.json"),
      JSON.stringify({ repos: [], settings: {} }),
      "utf-8"
    );
    const dispatcher = makeMetadataDispatcher([sandboxDir], symphonyDir);
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/work-directory/T-parse-err",
    });
    // Should return exists=false (no matching worktree found) rather than 500.
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.exists, false);
  });

  test("repo path outside allowed dirs is skipped in config scan (line 205)", async () => {
    const sandboxDir = makeTempDir();
    const symphonyDir = path.join(sandboxDir, ".symphony");
    mkdirSync(path.join(symphonyDir, "config"), { recursive: true });
    // Repo path that is NOT inside sandboxDir → isPathAllowed returns false.
    writeFileSync(
      path.join(symphonyDir, "config", "repos.json"),
      JSON.stringify({
        repos: [
          { path: "/etc/outside-sandbox", addedAt: new Date().toISOString() },
        ],
        settings: {},
      }),
      "utf-8"
    );
    const dispatcher = makeMetadataDispatcher([sandboxDir], symphonyDir);
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/work-directory/T-skip-repo",
    });
    // Repo is outside sandbox so it is skipped; no match found → exists=false.
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.exists, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 4 — chat-session.ts POST /api/gateway/chat validation
//   target lines: 85 (invalid JSON → 400), 91 (validateBody → 400),
//   105 (unsupported provider → 400), 454/457/460/463 (parseUserMessage nulls)
// ═══════════════════════════════════════════════════════════════════════════════

describe("chat-session POST /api/gateway/chat validation", () => {
  // Empty registry → provider will not be found after validation passes.
  const emptyRegistry = new ProviderRegistry();

  test("non-JSON body → 400 Invalid JSON body (line 85)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: "NOT{{JSON",
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Invalid JSON body");
  });

  test("missing chatKey → 400 chatKey is required (validateBody, line 91)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const { chatKey: _, ...bodyWithoutKey } = VALID_CHAT_BODY;
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify(bodyWithoutKey),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "chatKey is required");
  });

  test("missing apiBaseUrl → 400 apiBaseUrl is required (validateBody, line 91)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const { apiBaseUrl: _, ...bodyWithout } = VALID_CHAT_BODY;
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify(bodyWithout),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "apiBaseUrl is required");
  });

  test("missing apiAuthToken → 400 apiAuthToken is required (validateBody, line 91)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const { apiAuthToken: _, ...bodyWithout } = VALID_CHAT_BODY;
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify(bodyWithout),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "apiAuthToken is required");
  });

  test("missing provider → 400 provider is required (validateBody, line 91)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const { provider: _, ...bodyWithout } = VALID_CHAT_BODY;
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify(bodyWithout),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "provider is required");
  });

  test("invalid provider value → 400 unsupported provider (validateBody, line 91)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify({ ...VALID_CHAT_BODY, provider: "gemini" }),
    });
    assert.equal(res.statusCode, 400);
    assert.ok(String(res.body.error).includes("unsupported provider"));
  });

  test("missing userMessage → 400 userMessage is required (validateBody, line 91)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const { userMessage: _, ...bodyWithout } = VALID_CHAT_BODY;
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify(bodyWithout),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "userMessage is required");
  });

  test("userMessage.id empty string → 400 userMessage required (parseUserMessage, line 454)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify({
        ...VALID_CHAT_BODY,
        userMessage: { ...VALID_USER_MSG, id: "" },
      }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "userMessage is required");
  });

  test("userMessage.role = 'assistant' → 400 userMessage required (parseUserMessage, line 457)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify({
        ...VALID_CHAT_BODY,
        userMessage: { ...VALID_USER_MSG, role: "assistant" },
      }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "userMessage is required");
  });

  test("userMessage.content is a number → 400 userMessage required (parseUserMessage, line 460)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify({
        ...VALID_CHAT_BODY,
        userMessage: { ...VALID_USER_MSG, content: 42 },
      }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "userMessage is required");
  });

  test("userMessage.timestamp empty → 400 userMessage required (parseUserMessage, line 463)", async () => {
    const dispatcher = makeChatSessionDispatcher(emptyRegistry);
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify({
        ...VALID_CHAT_BODY,
        userMessage: { ...VALID_USER_MSG, timestamp: "" },
      }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "userMessage is required");
  });

  test("provider not registered in ProviderRegistry → 400 (line 105)", async () => {
    // Use a registry that has no providers registered.
    const dispatcher = makeChatSessionDispatcher(new ProviderRegistry());
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/chat",
      body: JSON.stringify(VALID_CHAT_BODY),
    });
    assert.equal(res.statusCode, 400);
    assert.ok(String(res.body.error).includes("Unsupported provider: claude"));
    assert.ok(String(res.body.error).includes("(none registered)"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 5 — ticket-chat.ts POST /api/gateway/ticket-chat
//   target line: 103 (repoPath outside sandbox → 403)
// ═══════════════════════════════════════════════════════════════════════════════

describe("ticket-chat POST /api/gateway/ticket-chat repoPath guard", () => {
  test("repoPath outside allowed dirs → 403 directory not allowed (line 103)", async () => {
    const sandboxDir = makeTempDir();
    const symphonyDir = path.join(sandboxDir, ".symphony");
    mkdirSync(symphonyDir, { recursive: true });
    const fpm = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    registerTicketChatRoutes(
      dispatcher,
      fpm.asProcessManager(),
      () => [sandboxDir],
      () => symphonyDir,
      async () => ({})
    );
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/ticket-chat",
      body: JSON.stringify({
        ticketId: "T-001",
        message: "help me",
        repoPath: "/etc/outside-sandbox",
        ticketContext: {
          identifier: "T-001",
          title: "My ticket",
          url: "https://example.com/T-001",
        },
      }),
    });
    assert.equal(res.statusCode, 403);
    assert.ok(RE_DIR_NOT_ALLOWED.test(String(res.body.error)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 6 — deploy.ts detectDeployment paths via POST /api/gateway/deploy/detect
//   target lines: 738 (no start script → null → detected=false), 749 (success return),
//   770 (resolveInstallCommand default "pnpm install"), 805 (yarn start with yarn.lock),
//   850 (persistDeploymentConfig: no matching repos.json entry → early return)
// ═══════════════════════════════════════════════════════════════════════════════

describe("deploy POST /api/gateway/deploy/detect — detectDeployment paths", () => {
  /**
   * Create a package.json in repoDir and optionally a lock file, then dispatch
   * POST /api/gateway/deploy/detect with repoPath = repoDir.
   */
  function detectRepo(opts: {
    pkg: Record<string, unknown>;
    lockFile?: string;
    sandboxDir: string;
    repoDir: string;
    symphonyDir?: string;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const { pkg, lockFile, sandboxDir, repoDir } = opts;
    const symphonyDir = opts.symphonyDir ?? path.join(sandboxDir, ".symphony");
    writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify(pkg),
      "utf-8"
    );
    if (lockFile) {
      writeFileSync(path.join(repoDir, lockFile), "", "utf-8");
    }
    const dispatcher = makeDeployDispatcher(sandboxDir, symphonyDir);
    return dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/deploy/detect",
      body: JSON.stringify({ repoPath: repoDir }),
    });
  }

  test("package.json with no scripts → detected=false (line 738 null return path)", async () => {
    const sandboxDir = makeTempDir();
    const repoDir = path.join(sandboxDir, "myrepo");
    mkdirSync(repoDir);
    const res = await detectRepo({
      pkg: { name: "myrepo", dependencies: {} },
      sandboxDir,
      repoDir,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.detected, false);
  });

  test("package.json with dev script + pnpm-lock.yaml → detected with 'pnpm dev' (line 749)", async () => {
    const sandboxDir = makeTempDir();
    const repoDir = path.join(sandboxDir, "myrepo");
    mkdirSync(repoDir);
    const symphonyDir = path.join(sandboxDir, ".symphony");
    mkdirSync(path.join(symphonyDir, "config"), { recursive: true });
    writeFileSync(
      path.join(symphonyDir, "config", "repos.json"),
      JSON.stringify({ repos: [], settings: {} }),
      "utf-8"
    );
    const res = await detectRepo({
      pkg: {
        name: "myrepo",
        scripts: { dev: "next dev" },
        dependencies: { next: "14.0.0" },
        packageManager: "pnpm@8.0.0",
      },
      lockFile: "pnpm-lock.yaml",
      sandboxDir,
      repoDir,
      symphonyDir,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.detected, true);
    const config = res.body.config as Record<string, unknown>;
    assert.equal(config.command, "pnpm dev");
    assert.equal(config.framework, "next");
    assert.equal(config.installCommand, "pnpm install");
  });

  test("package.json start script + yarn.lock → detected with 'yarn start' (line 805)", async () => {
    const sandboxDir = makeTempDir();
    const repoDir = path.join(sandboxDir, "myrepo");
    mkdirSync(repoDir);
    const symphonyDir = path.join(sandboxDir, ".symphony");
    mkdirSync(path.join(symphonyDir, "config"), { recursive: true });
    writeFileSync(
      path.join(symphonyDir, "config", "repos.json"),
      JSON.stringify({ repos: [], settings: {} }),
      "utf-8"
    );
    const res = await detectRepo({
      pkg: {
        name: "myrepo",
        scripts: { start: "node server.js" },
        dependencies: { express: "4.18.0" },
        packageManager: "yarn@3.0.0",
      },
      lockFile: "yarn.lock",
      sandboxDir,
      repoDir,
      symphonyDir,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.detected, true);
    const config = res.body.config as Record<string, unknown>;
    assert.equal(config.command, "yarn start");
    assert.equal(config.installCommand, "yarn install");
  });

  test("package.json no packageManager → installCommand='pnpm install' default (line 770)", async () => {
    const sandboxDir = makeTempDir();
    const repoDir = path.join(sandboxDir, "myrepo");
    mkdirSync(repoDir);
    const symphonyDir = path.join(sandboxDir, ".symphony");
    mkdirSync(path.join(symphonyDir, "config"), { recursive: true });
    writeFileSync(
      path.join(symphonyDir, "config", "repos.json"),
      JSON.stringify({ repos: [], settings: {} }),
      "utf-8"
    );
    const res = await detectRepo({
      pkg: {
        name: "myrepo",
        scripts: { dev: "vite" },
        dependencies: { vite: "4.0.0" },
        // no packageManager field
      },
      lockFile: "pnpm-lock.yaml",
      sandboxDir,
      repoDir,
      symphonyDir,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.detected, true);
    const config = res.body.config as Record<string, unknown>;
    assert.equal(config.installCommand, "pnpm install");
    assert.equal(config.framework, "vite");
  });

  test("persistDeploymentConfig: no matching repos.json entry → skips save (line 850)", async () => {
    // repos.json has repos, but none matching this repo → persistDeploymentConfig returns early.
    const sandboxDir = makeTempDir();
    const repoDir = path.join(sandboxDir, "myrepo");
    mkdirSync(repoDir);
    const symphonyDir = path.join(sandboxDir, ".symphony");
    mkdirSync(path.join(symphonyDir, "config"), { recursive: true });
    writeFileSync(
      path.join(symphonyDir, "config", "repos.json"),
      JSON.stringify({
        repos: [
          {
            path: path.join(sandboxDir, "other-repo"),
            addedAt: "2026-01-01T00:00:00Z",
          },
        ],
        settings: {},
      }),
      "utf-8"
    );
    writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({
        name: "myrepo",
        scripts: { dev: "next dev" },
        dependencies: { next: "14" },
      }),
      "utf-8"
    );
    writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "", "utf-8");
    const dispatcher = makeDeployDispatcher(sandboxDir, symphonyDir);
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/deploy/detect",
      body: JSON.stringify({ repoPath: repoDir }),
    });
    // Even with no matching repo entry, the route still returns detected=true.
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.detected, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 7 — codex.ts GET /api/gateway/codex/status/:ticketId
//   target line: 502 (error instanceof Error ternary in catch block)
// ═══════════════════════════════════════════════════════════════════════════════

describe("codex GET /api/gateway/codex/status/:ticketId — stateFile parse error", () => {
  test("statePath is a directory → readFile throws EISDIR → 500 Failed to read status (line 502)", async () => {
    const sandboxDir = makeTempDir();
    const repoDir = path.join(sandboxDir, "myrepo");
    mkdirSync(repoDir);

    // resolveWorktreeDir: parentDir = dirname(expandedRepoPath) = sandboxDir
    // worktreeDir = sandboxDir/myrepo-T502
    const worktreeDir = path.join(sandboxDir, "myrepo-T502");
    const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
    mkdirSync(workDir, { recursive: true });

    // getReviewPaths(worktreeDir, "claude") → statePath = <workDir>/codex-review-claude.json
    // Make it a directory so fs.readFile throws EISDIR (an Error).
    mkdirSync(path.join(workDir, "codex-review-claude.json"));

    const dispatcher = makeCodexDispatcher(sandboxDir);
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/codex/status/T502",
      query: { repo: repoDir, provider: "claude" },
    });
    assert.equal(res.statusCode, 500);
    assert.ok(
      RE_FAILED_READ_STATUS.test(String(res.body.error)),
      `Expected 'Failed to read status' in: ${res.body.error}`
    );
  });
});
