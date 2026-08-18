/**
 * ISS-5299 — Branch coverage for:
 *   apps/desktop/src/server/operations/learnings.ts   (routes not reached by learnings-routes.test.ts)
 *   apps/desktop/src/server/operations/plugin-cache.ts (edge cases not covered by plugin-cache.test.ts)
 *   apps/desktop/src/server/operations/symphony-utils.ts (edge cases not covered by symphony-utils.test.ts)
 *   apps/desktop/src/server/operations/command-pack-factory.ts (not-in-pack + default switch)
 *
 * Exists as a sibling of the per-module primary suites because each of those is already
 * nearing its responsible line count and this batch is orthogonal to what they cover.
 *
 * SECURITY CRITICAL: learnings route sandbox-enforcement paths (403 rejections on
 * disallowed paths) are exercised here.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  createClosedloopWebCommandPackFactory,
  outputInstructionForCommand,
} from "../src/server/operations/command-pack-factory.js";
import { registerLearningsRoutes } from "../src/server/operations/learnings.js";
import {
  compareSemverDescending,
  getInstalledPluginVersions,
  getPluginInstallStatus,
  parseClaudePluginListJson,
} from "../src/server/operations/plugin-cache.js";
import {
  acquireLaunchLock,
  hasBootstrapArtifacts,
  readLaunchMetadata,
  releaseLaunchLock,
  resolveBootstrapTimeoutMs,
  resolveRef,
  restoreWorktreeState,
  saveWorktreeState,
  writeLaunchMetadata,
} from "../src/server/operations/symphony-utils.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

// ── module-level regex constants (Ultracite useTopLevelRegex) ─────────────────

const RE_INVALID_JSON = /invalid json/i;
const RE_TICKET_ID_REPO_PATH = /ticketId.*repoPath/i;
const RE_TICKET_ID_REPO = /ticketId.*repo/i;
const RE_NOT_ALLOWED = /not allowed/i;
const RE_NOT_FOUND = /not found/i;
const RE_REPO_REQUIRED = /repo.*required/i;
const RE_MUST_NOT_BE_EMPTY = /must not be empty/i;
const RE_FAILED_TO_SCAN = /failed to scan/i;
const RE_CHAT_COMMAND = /chat/i;

// ── temp dir management ────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const originalEnv = saveEnvVars(["HOME", "CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS"]);

afterEach(async () => {
  restoreEnvVars(originalEnv);
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "iss5299-learnings-ops-")
  );
  tempDirs.push(dir);
  return dir;
}

// ── dispatch helpers ──────────────────────────────────────────────────────────

type DispatchResult = {
  statusCode: number;
  body: unknown;
};

async function dispatch(
  dispatcher: OperationDispatcher,
  method: string,
  pathname: string,
  opts: { query?: Record<string, string>; rawBody?: string } = {}
): Promise<DispatchResult> {
  const bodyStr = opts.rawBody ?? "";
  let responseBody = "";
  const response = {
    statusCode: 0,
    setHeader() {},
    end(b?: string) {
      responseBody = b ?? "";
    },
  } as unknown as ServerResponse;

  await dispatcher.dispatch({
    method,
    pathname,
    params: {},
    query: new URLSearchParams(opts.query ?? {}),
    rawBody: Buffer.alloc(0),
    body: bodyStr,
    request: {} as IncomingMessage,
    response,
  });

  return {
    statusCode: (response as unknown as { statusCode: number }).statusCode,
    body: responseBody ? (JSON.parse(responseBody) as unknown) : null,
  };
}

function makeLearningsDispatcher(
  allowedDirs: string[],
  symphonyDir: string | (() => string)
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  const getSymphonyDir =
    typeof symphonyDir === "function" ? symphonyDir : () => symphonyDir;
  registerLearningsRoutes(dispatcher, () => allowedDirs, getSymphonyDir);
  return dispatcher;
}

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — GET /api/gateway/learnings (uncovered catch branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/gateway/learnings — catch branches", () => {
  test("returns empty patterns when neither toon file exists (ENOENT path)", async () => {
    const homeDir = await makeTempDir();
    process.env.HOME = homeDir;
    const dispatcher = makeLearningsDispatcher([], homeDir);

    const result = await dispatch(dispatcher, "GET", "/api/gateway/learnings");

    assert.equal(result.statusCode, 200);
    assert.deepEqual((result.body as { patterns: unknown[] }).patterns, []);
  });

  test("returns 500 when toon file path is a directory (non-ENOENT error)", async () => {
    const homeDir = await makeTempDir();
    process.env.HOME = homeDir;
    // Create the new-path location as a directory to trigger EISDIR on readFile
    const newPathDir = path.join(
      homeDir,
      ".closedloop-ai",
      "learnings",
      "org-patterns.toon"
    );
    mkdirSync(newPathDir, { recursive: true });
    const dispatcher = makeLearningsDispatcher([], homeDir);

    const result = await dispatch(dispatcher, "GET", "/api/gateway/learnings");

    assert.equal(result.statusCode, 500);
    assert.ok(
      typeof (result.body as { error: string }).error === "string",
      "error field should be a string"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — parseToon branches via GET /api/gateway/learnings
// ─────────────────────────────────────────────────────────────────────────────

describe("parseToon — uncovered branches via GET /api/gateway/learnings", () => {
  test("handles plain-text chunks (no 'patterns[' header, no CSV match, empty-summary fallback)", async () => {
    const homeDir = await makeTempDir();
    process.env.HOME = homeDir;
    // Chunk 1: "---" → replace(/^[-*#\s]+/, "") = "" → summary || "Pattern 1"  (line 750 true)
    // Chunk 2: "A useful insight" → no CSV match → replace gives "A useful insight" (line 746 nullish)
    // Both chunks have no "patterns[" prefix → line 742 false branch
    const toonContent = "---\n\nA useful insight";
    const toonPath = path.join(
      homeDir,
      ".closedloop-ai",
      "learnings",
      "org-patterns.toon"
    );
    mkdirSync(path.dirname(toonPath), { recursive: true });
    writeFileSync(toonPath, toonContent, "utf-8");
    const dispatcher = makeLearningsDispatcher([], homeDir);

    const result = await dispatch(dispatcher, "GET", "/api/gateway/learnings");

    assert.equal(result.statusCode, 200);
    const patterns = (result.body as { patterns: Array<{ summary: string }> })
      .patterns;
    assert.equal(patterns.length, 2);
    assert.equal(patterns[0]?.summary, "Pattern 1"); // empty-summary fallback
    assert.equal(patterns[1]?.summary, "A useful insight"); // plain-text replace
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — POST /api/gateway/symphony/extract-learnings
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/gateway/symphony/extract-learnings — validation branches", () => {
  test("returns 400 for invalid JSON body", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/extract-learnings",
      { rawBody: "{not-json" }
    );

    assert.equal(result.statusCode, 400);
    assert.match((result.body as { error: string }).error, RE_INVALID_JSON);
  });

  test("returns 400 when ticketId is missing", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/extract-learnings",
      { rawBody: JSON.stringify({ repoPath: tmpDir }) }
    );

    assert.equal(result.statusCode, 400);
    assert.match(
      (result.body as { error: string }).error,
      RE_TICKET_ID_REPO_PATH
    );
  });

  test("returns 403 when repoPath is not in allowed directories", async () => {
    const tmpDir = await makeTempDir();
    // Pass empty allowedDirs so every path is denied
    const dispatcher = makeLearningsDispatcher([], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/extract-learnings",
      {
        rawBody: JSON.stringify({
          ticketId: "AI-100",
          repoPath: path.join(tmpDir, "my-repo"),
        }),
      }
    );

    assert.equal(result.statusCode, 403);
    assert.match((result.body as { error: string }).error, RE_NOT_ALLOWED);
  });

  test("returns 404 when worktree directory does not exist", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    // worktreeDir = path.join(path.dirname(repoPath), `${repoName}-AI-100`)
    // = path.join(tmpDir, "my-repo-AI-100") which does not exist
    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/extract-learnings",
      {
        rawBody: JSON.stringify({
          ticketId: "AI-100",
          repoPath: path.join(tmpDir, "my-repo"),
        }),
      }
    );

    assert.equal(result.statusCode, 404);
    assert.match((result.body as { error: string }).error, RE_NOT_FOUND);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — GET /api/gateway/symphony/process-learnings
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/gateway/symphony/process-learnings — validation branches", () => {
  test("returns 400 when ticketId and repo params are missing", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "GET",
      "/api/gateway/symphony/process-learnings"
    );

    assert.equal(result.statusCode, 400);
    assert.match((result.body as { error: string }).error, RE_TICKET_ID_REPO);
  });

  test("returns 200 status=none when processing-status.json is absent", async () => {
    const tmpDir = await makeTempDir();
    // repoPath=tmpDir/repo → worktreeDir=tmpDir/repo-AI-100 → status file absent
    const worktreeDir = path.join(tmpDir, "repo-AI-100");
    mkdirSync(worktreeDir, { recursive: true });
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "GET",
      "/api/gateway/symphony/process-learnings",
      { query: { ticketId: "AI-100", repo: path.join(tmpDir, "repo") } }
    );

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { status: string }).status, "none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — POST /api/gateway/symphony/process-learnings
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/gateway/symphony/process-learnings — validation and flow branches", () => {
  test("returns 400 for invalid JSON body", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/process-learnings",
      { rawBody: "{not-json" }
    );

    assert.equal(result.statusCode, 400);
    assert.match((result.body as { error: string }).error, RE_INVALID_JSON);
  });

  test("returns 400 when ticketId is missing", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/process-learnings",
      { rawBody: JSON.stringify({ repoPath: tmpDir }) }
    );

    assert.equal(result.statusCode, 400);
    assert.match(
      (result.body as { error: string }).error,
      RE_TICKET_ID_REPO_PATH
    );
  });

  test("returns 404 when worktree directory does not exist", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/process-learnings",
      {
        rawBody: JSON.stringify({
          ticketId: "AI-100",
          repoPath: path.join(tmpDir, "my-repo"),
        }),
      }
    );

    assert.equal(result.statusCode, 404);
    assert.match((result.body as { error: string }).error, RE_NOT_FOUND);
  });

  test("returns 200 status=waiting when waitForExtraction is true", async () => {
    const tmpDir = await makeTempDir();
    const worktreeDir = path.join(tmpDir, "my-repo-AI-100");
    mkdirSync(worktreeDir, { recursive: true });
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/process-learnings",
      {
        rawBody: JSON.stringify({
          ticketId: "AI-100",
          repoPath: path.join(tmpDir, "my-repo"),
          waitForExtraction: true,
        }),
      }
    );

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { status: string }).status, "waiting");
  });

  test("returns 200 status=skipped when no pending directory exists", async () => {
    const tmpDir = await makeTempDir();
    const worktreeDir = path.join(tmpDir, "my-repo-AI-100");
    mkdirSync(worktreeDir, { recursive: true });
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/process-learnings",
      {
        rawBody: JSON.stringify({
          ticketId: "AI-100",
          repoPath: path.join(tmpDir, "my-repo"),
          waitForExtraction: false,
        }),
      }
    );

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { status: string }).status, "skipped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — GET /api/gateway/symphony/learnings-status/:ticketId
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/gateway/symphony/learnings-status/:ticketId — validation branches", () => {
  test("returns 400 when repo query param is missing", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "GET",
      "/api/gateway/symphony/learnings-status/AI-100"
    );

    assert.equal(result.statusCode, 400);
    assert.match((result.body as { error: string }).error, RE_REPO_REQUIRED);
  });

  test("returns 200 status=none count=0 when status file is absent", async () => {
    const tmpDir = await makeTempDir();
    const worktreeDir = path.join(tmpDir, "my-repo-AI-100");
    mkdirSync(worktreeDir, { recursive: true });
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "GET",
      "/api/gateway/symphony/learnings-status/AI-100",
      { query: { repo: path.join(tmpDir, "my-repo") } }
    );

    assert.equal(result.statusCode, 200);
    const body = result.body as { status: string; count: number };
    assert.equal(body.status, "none");
    assert.equal(body.count, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — POST /api/gateway/symphony/record-learning-use
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/gateway/symphony/record-learning-use — validation branches", () => {
  test("returns 400 for invalid JSON body", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/record-learning-use",
      { rawBody: "{not-json" }
    );

    assert.equal(result.statusCode, 400);
    assert.match((result.body as { error: string }).error, RE_INVALID_JSON);
  });

  test("returns 400 when learnings array is empty", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/record-learning-use",
      {
        rawBody: JSON.stringify({
          ticketId: "AI-100",
          repoPath: tmpDir,
          learnings: [],
        }),
      }
    );

    assert.equal(result.statusCode, 400);
    assert.match(
      (result.body as { error: string }).error,
      RE_MUST_NOT_BE_EMPTY
    );
  });

  test("returns 403 when repoPath is not in allowed directories", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/record-learning-use",
      {
        rawBody: JSON.stringify({
          ticketId: "AI-100",
          repoPath: path.join(tmpDir, "my-repo"),
          learnings: [{ summary: "something" }],
        }),
      }
    );

    assert.equal(result.statusCode, 403);
    assert.match((result.body as { error: string }).error, RE_NOT_ALLOWED);
  });

  test("returns 404 when worktree directory does not exist", async () => {
    const tmpDir = await makeTempDir();
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/record-learning-use",
      {
        rawBody: JSON.stringify({
          ticketId: "AI-100",
          repoPath: path.join(tmpDir, "my-repo"),
          learnings: [{ summary: "something" }],
        }),
      }
    );

    assert.equal(result.statusCode, 404);
    assert.match((result.body as { error: string }).error, RE_NOT_FOUND);
  });

  test("returns 200 recorded when worktree and learnings are valid", async () => {
    const tmpDir = await makeTempDir();
    const worktreeDir = path.join(tmpDir, "my-repo-AI-100");
    mkdirSync(worktreeDir, { recursive: true });
    const dispatcher = makeLearningsDispatcher([tmpDir], tmpDir);

    const result = await dispatch(
      dispatcher,
      "POST",
      "/api/gateway/symphony/record-learning-use",
      {
        rawBody: JSON.stringify({
          ticketId: "AI-100",
          repoPath: path.join(tmpDir, "my-repo"),
          learnings: [{ summary: "Use explicit types" }],
        }),
      }
    );

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { status: string }).status, "recorded");
    assert.equal((result.body as { count: number }).count, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — GET /api/gateway/symphony/pending-learnings
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/gateway/symphony/pending-learnings — outer catch and listAllWorktrees branches", () => {
  test("returns 500 when getSymphonyDir throws (outer catch branch)", async () => {
    const dispatcher = makeLearningsDispatcher([], () => {
      throw new Error("symphony dir not available");
    });

    const result = await dispatch(
      dispatcher,
      "GET",
      "/api/gateway/symphony/pending-learnings"
    );

    assert.equal(result.statusCode, 500);
    assert.match((result.body as { error: string }).error, RE_FAILED_TO_SCAN);
  });

  test("reaches listAllWorktrees when configured repo path exists", async () => {
    const symphonyDir = await makeTempDir();
    const repoDir = await makeTempDir();
    // Point repos.json to an existing directory so existsSync(expandedRepoPath) = true
    const configDir = path.join(symphonyDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "repos.json"),
      JSON.stringify({
        repos: [{ path: repoDir, addedAt: new Date().toISOString() }],
        settings: {},
      }),
      "utf-8"
    );
    const dispatcher = makeLearningsDispatcher([repoDir], symphonyDir);

    const result = await dispatch(
      dispatcher,
      "GET",
      "/api/gateway/symphony/pending-learnings"
    );

    // repoDir is not a git repo → listAllWorktrees returns [] → no pending learnings
    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { totalCount: number }).totalCount, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// plugin-cache.ts — compareSemverDescending (partial version strings)
// ─────────────────────────────────────────────────────────────────────────────

describe("compareSemverDescending — partial semver strings trigger ?? 0 fallback", () => {
  test("treats missing third part as 0 when comparing two-part versions", () => {
    // "1.2" vs "1.2": partsA[2] = undefined → (undefined ?? 0) - (undefined ?? 0) = 0
    const result = compareSemverDescending("1.2", "1.2");
    assert.equal(result, 0);

    // "1.3" > "1.2" in descending order means compareSemverDescending("1.3","1.2") < 0
    const diffResult = compareSemverDescending("1.3", "1.2");
    assert.ok(diffResult < 0, "1.3 should sort before 1.2 in descending order");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// plugin-cache.ts — parseClaudePluginListJson (malformed entries)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseClaudePluginListJson — malformed and edge-case inputs", () => {
  test("skips null array entries (non-object → normalized=null → empty result)", () => {
    const result = parseClaudePluginListJson(JSON.stringify([null]));
    assert.deepEqual(result, []);
  });

  test("skips object entries with no id or name field", () => {
    const result = parseClaudePluginListJson(
      JSON.stringify([{ version: "1.0.0" }])
    );
    assert.deepEqual(result, []);
  });

  test("normalizes entry without version field (version ternary false branch)", () => {
    const result = parseClaudePluginListJson(
      JSON.stringify([{ id: "test@closedloop-ai" }])
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.id, "test@closedloop-ai");
    assert.equal(result[0]?.version, undefined);
  });

  test("handles { plugins: [...] } object shape (record.plugins branch)", () => {
    const result = parseClaudePluginListJson(
      JSON.stringify({
        plugins: [
          { id: "code@closedloop-ai", version: "2.0.0", enabled: true },
        ],
      })
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.id, "code@closedloop-ai");
    assert.equal(result[0]?.version, "2.0.0");
  });

  test("returns [] when installed field is not an array (entries not array → null)", () => {
    const result = parseClaudePluginListJson(
      JSON.stringify({ installed: "not-an-array" })
    );
    assert.deepEqual(result, []);
  });

  test("returns [] for scalar JSON (non-array non-object top level → null entries)", () => {
    const result = parseClaudePluginListJson(JSON.stringify(42));
    assert.deepEqual(result, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// plugin-cache.ts — getPluginInstallStatus (listJson parse branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("getPluginInstallStatus — listJson parse failure paths", () => {
  test("marks as unverifiable when listJson is invalid JSON and install path exists (catch branch)", async () => {
    const tmpDir = await makeTempDir();
    const installPath = path.join(tmpDir, "code-plugin");
    mkdirSync(installPath, { recursive: true });

    // Registry must have an entry with an existing installPath so that
    // hasExistingUserInstallPath=true, making enabledStateUnverified observable
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          { installPath, scope: "user", version: "1.0.0" },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    writeFileSync(registryPath, JSON.stringify(registry));

    // Invalid JSON → parsePluginListEntries catches → listParseFailed=true
    const status = getPluginInstallStatus("code", registryPath, "{not-json");
    assert.equal(status.enabledStateUnverified, true);
    // hasValidUserScopedEntry = hasExistingUserInstallPath && !disabled && !enabledStateUnverified
    // = true && false && false = false (because enabledStateUnverified=true)
    assert.equal(status.hasValidUserScopedEntry, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// plugin-cache.ts — getInstalledPluginVersions (selectedUserVersion ?? "installed")
// ─────────────────────────────────────────────────────────────────────────────

describe("getInstalledPluginVersions — selectedUserVersion ?? installed fallback", () => {
  test("uses 'installed' fallback when registry entry has no version field", async () => {
    const tmpDir = await makeTempDir();
    const installPath = path.join(tmpDir, "code-plugin");
    mkdirSync(installPath, { recursive: true });

    // Entry has no version: selectedUserVersion = undefined → ?? "installed"
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [{ installPath, scope: "user" as const }],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    writeFileSync(registryPath, JSON.stringify(registry));

    const result = getInstalledPluginVersions(registryPath);
    assert.equal(result["code@closedloop-ai"], "installed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// symphony-utils.ts — readLaunchMetadata (issueId and ticketTitle branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("readLaunchMetadata — issueId and ticketTitle fields", () => {
  test("parses issueId and ticketTitle string fields when present", async () => {
    const tmpDir = await makeTempDir();
    await writeLaunchMetadata(tmpDir, {
      issueId: "ISS-9999",
      ticketTitle: "test ticket title",
      artifactId: undefined,
      loopId: undefined,
      baseBranch: undefined,
      parentTicketId: undefined,
    });

    const meta = await readLaunchMetadata(tmpDir);
    assert.equal(meta?.issueId, "ISS-9999");
    assert.equal(meta?.ticketTitle, "test ticket title");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// symphony-utils.ts — restoreWorktreeState (skip-existing branch)
// ─────────────────────────────────────────────────────────────────────────────

describe("restoreWorktreeState — skips cpSync when destination file already exists", () => {
  test("preserves pre-existing destination file instead of overwriting it", async () => {
    const worktreeDir = await makeTempDir();
    const agentsDir = path.join(worktreeDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "agent.md"), "original-content");

    // saveWorktreeState renames .claude/agents → temp location
    const saved = saveWorktreeState(worktreeDir);

    // Pre-create the destination file with different content
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "agent.md"), "pre-existing-content");

    // restoreWorktreeState should skip cpSync because destChild already exists
    restoreWorktreeState(saved, worktreeDir);

    const content = readFileSync(path.join(agentsDir, "agent.md"), "utf-8");
    assert.equal(
      content,
      "pre-existing-content",
      "pre-existing file should not be overwritten"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// symphony-utils.ts — resolveRef (catch + return null branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveRef — non-git directory", () => {
  test("returns null when neither candidate ref resolves (catch and return-null branches)", {
    timeout: 15_000,
  }, () => {
    // A plain temp directory that is not a git repo: git rev-parse fails fast
    const tmpDir = path.join(os.tmpdir(), `iss5299-resolveref-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    tempDirs.push(tmpDir);

    const result = resolveRef(tmpDir, "non-existent-branch");
    assert.equal(result, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// symphony-utils.ts — releaseLaunchLock (catch branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("releaseLaunchLock — error catch branches", () => {
  test("catches EBADF when fd is invalid (closeSync catch branch)", async () => {
    const lockDir = await makeTempDir();
    // fd = -1 is an invalid file descriptor on all POSIX platforms
    // closeSync(-1) throws EBADF; the catch swallows it without rethrowing
    releaseLaunchLock(lockDir, -1);
    // Both catches fire (closeSync EBADF + unlinkSync ENOENT for missing lock file)
    assert.ok(
      !existsSync(path.join(lockDir, "launch.lock")),
      "lock file should not exist"
    );
  });

  test("catches ENOENT when lock file was already removed (unlinkSync catch branch)", async () => {
    const lockDir = await makeTempDir();
    const lock = acquireLaunchLock(lockDir);
    assert.ok(lock !== null, "should acquire lock");

    if (lock) {
      const lockPath = path.join(lockDir, "launch.lock");
      // Manually remove the lock file before releaseLaunchLock can unlink it
      unlinkSync(lockPath);
      // closeSync succeeds (fd still valid), unlinkSync throws ENOENT → caught
      releaseLaunchLock(lockDir, lock.fd);

      assert.ok(
        !existsSync(lockPath),
        "lock file should not exist after release"
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// symphony-utils.ts — hasBootstrapArtifacts
// ─────────────────────────────────────────────────────────────────────────────

describe("hasBootstrapArtifacts", () => {
  test("returns true when bootstrap-metadata.json exists", async () => {
    const dir = await makeTempDir();
    const metaDir = path.join(dir, ".closedloop-ai");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      path.join(metaDir, "bootstrap-metadata.json"),
      JSON.stringify({ bootstrapped: true })
    );

    assert.equal(hasBootstrapArtifacts(dir), true);
  });

  test("returns true when agents directory has .md files", async () => {
    const dir = await makeTempDir();
    const agentsDir = path.join(dir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "helper.md"), "# helper");

    assert.equal(hasBootstrapArtifacts(dir), true);
  });

  test("returns false when neither artifact is present", async () => {
    const dir = await makeTempDir();
    assert.equal(hasBootstrapArtifacts(dir), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// symphony-utils.ts — resolveBootstrapTimeoutMs
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;

describe("resolveBootstrapTimeoutMs", () => {
  test("returns default when env var is absent", () => {
    Reflect.deleteProperty(process.env, "CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS");
    assert.equal(resolveBootstrapTimeoutMs(), DEFAULT_BOOTSTRAP_TIMEOUT_MS);
  });

  test("returns parsed value when env var is a positive integer", () => {
    process.env.CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS = "30000";
    assert.equal(resolveBootstrapTimeoutMs(), 30_000);
  });

  test("returns default when env var is non-numeric", () => {
    process.env.CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS = "not-a-number";
    assert.equal(resolveBootstrapTimeoutMs(), DEFAULT_BOOTSTRAP_TIMEOUT_MS);
  });

  test("returns default when env var is zero (not > 0 guard)", () => {
    process.env.CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS = "0";
    assert.equal(resolveBootstrapTimeoutMs(), DEFAULT_BOOTSTRAP_TIMEOUT_MS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// command-pack-factory.ts — selectRuntime (command not in pack)
// ─────────────────────────────────────────────────────────────────────────────

describe("ClosedloopWebCommandPackFactory.selectRuntime — command not in pack", () => {
  test("returns ok=false when command is not in the command pack (Chat)", () => {
    const selection = createClosedloopWebCommandPackFactory().selectRuntime(
      LoopCommand.Chat
    );

    assert.equal(selection.ok, false);
    if (!selection.ok) {
      assert.match(
        selection.reason,
        RE_CHAT_COMMAND,
        "reason should mention the command name"
      );
      assert.equal(selection.command, undefined);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// command-pack-factory.ts — outputInstructionForCommand (default switch case)
// ─────────────────────────────────────────────────────────────────────────────

describe("outputInstructionForCommand — default switch case for Bootstrap", () => {
  test("returns requiredOutputDescription for a command not in the explicit switch (Bootstrap)", () => {
    const instruction = outputInstructionForCommand(LoopCommand.Bootstrap);

    // Bootstrap has required: [] in ResultBundle → "No required output artifact."
    assert.equal(instruction, "No required output artifact.");
  });
});
