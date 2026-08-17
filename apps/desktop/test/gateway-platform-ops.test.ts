/**
 * ISS-5299 Wave 2 — Branch coverage for gateway operation modules not reached by
 * deploy-ops.test.ts or learnings-and-utils-ops.test.ts (both near their
 * 1 000-line ceiling).
 *
 * Targeted uncovered branches (this file):
 *   loop-http.ts        — persistRevivalToken ternary, postLoopEvent catch ternaries,
 *                         uploadArtifacts catch, getCloudLoopStatus paths,
 *                         postLoopHeartbeat auth-ladder rungs
 *   mcp-detection.ts    — normalizeMcpServerUrl variants, parseClaudeMcpList/Get/Codex
 *                         invalid-URL and no-name-prefix paths
 *   metadata-routes.ts  — status 403 / state.json branches, work-directory branches
 *   learnings.ts        — learnings-status 403 / file-read, record-learning-use filter,
 *                         process-all-learnings GET/POST, parseToon patterns[ prefix
 *
 * Deploy branches are covered in gateway-platform-ops-2.test.ts.
 *
 * SKIPPED (unreachable or environment-dependent):
 *   — "throw error" re-throw paths when assertRepoAllowed throws non-DirectoryNotAllowedError
 *   — triggerSuccessRateComputation deep branches (require installed claude plugins)
 *   — checkPendingClaudeMd / checkBranchStatus branches (require real git repos)
 *   — getFreshLatest/getCacheEntry expiry (require timing or binary execution)
 *   — health-poll catch (background async, no public entry point)
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerLearningsRoutes } from "../src/server/operations/learnings.js";
import {
  getCloudLoopStatus,
  persistRevivalToken,
  postLoopEvent,
  postLoopHeartbeat,
  uploadArtifacts,
} from "../src/server/operations/loop-http.js";
import {
  normalizeMcpServerUrl,
  parseClaudeMcpGet,
  parseClaudeMcpList,
  parseCodexMcpList,
  resetMcpDetectionCache,
} from "../src/server/operations/mcp-detection.js";
import { registerMetadataRoutes } from "../src/server/operations/metadata-routes.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";

// ── module-level regex constants (Biome useTopLevelRegex) ─────────────────────
const RE_NOT_ALLOWED = /not allowed/i;
const RE_MISSING_TOKEN = /missing_token/;

// ── shared temp dir factory + env restore ─────────────────────────────────────
const { makeTempDir } = createGitOpTempDirs("iss5299-gw-plat-");

const originalFetch = globalThis.fetch;
const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetMcpDetectionCache();
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

function makeLearningsDispatcher(
  allowedDirs: string[],
  symphonyDir: string
): OperationDispatcher {
  const d = new OperationDispatcher();
  registerLearningsRoutes(
    d,
    () => allowedDirs,
    () => symphonyDir
  );
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// loop-http.ts — persistRevivalToken (expiresAt ternary branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("persistRevivalToken — expiresAt ternary", () => {
  test("returns false when loopTokenStore is undefined", () => {
    const result = persistRevivalToken(undefined, "loop-1", {
      success: true,
      status: 200,
      revived: true,
      token: "tok",
    });
    assert.equal(result, false);
  });

  test("calls setLoopToken with expiresAt=undefined when result.expiresAt is absent", () => {
    const calls: Array<{ loopId: string; meta: unknown }> = [];
    const store = {
      setLoopToken(id: string, meta: unknown) {
        calls.push({ loopId: id, meta });
      },
    };
    const r = persistRevivalToken(store, "loop-1", {
      success: true,
      status: 200,
      revived: true,
      token: "new-tok",
    });
    assert.equal(r, true);
    assert.equal(calls.length, 1);
    assert.equal(
      (calls[0]?.meta as { expiresAt: unknown }).expiresAt,
      undefined,
      "expiresAt should be undefined when absent from revival"
    );
  });

  test("calls setLoopToken with expiresAt=getTime() when result.expiresAt is a Date", () => {
    const calls: Array<{ loopId: string; meta: unknown }> = [];
    const store = {
      setLoopToken(id: string, meta: unknown) {
        calls.push({ loopId: id, meta });
      },
    };
    const expiresAt = new Date("2030-01-01T00:00:00Z");
    const r = persistRevivalToken(store, "loop-1", {
      success: true,
      status: 200,
      revived: true,
      token: "new-tok",
      expiresAt,
    });
    assert.equal(r, true);
    assert.equal(
      (calls[0]?.meta as { expiresAt: unknown }).expiresAt,
      expiresAt.getTime(),
      "expiresAt should be the numeric ms value from Date.getTime()"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loop-http.ts — postLoopEvent (catch ternary + signal branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("postLoopEvent — catch branches", () => {
  test("returns auth error when getToken returns null", async () => {
    const result = await postLoopEvent(
      "http://api.test",
      "loop-1",
      () => null,
      { type: "test_event" }
    );
    assert.equal(result.success, false);
    assert.ok(!result.success && result.kind === "auth");
  });

  test("returns network error with String(err) when fetch rejects with non-Error value", async () => {
    globalThis.fetch = (): Promise<Response> => Promise.reject(42);
    const result = await postLoopEvent(
      "http://api.test",
      "loop-1",
      () => "valid-token",
      { type: "test_event" }
    );
    assert.equal(result.success, false);
    assert.ok(!result.success && result.kind === "network");
    assert.equal(result.error, "42", "String(42) should be the error message");
  });

  test("returns timeout when fetch rejects and signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = (): Promise<Response> =>
      Promise.reject(new Error("AbortError"));
    const result = await postLoopEvent(
      "http://api.test",
      "loop-1",
      () => "valid-token",
      { type: "test_event" },
      controller.signal
    );
    assert.equal(result.success, false);
    assert.ok(!result.success && result.kind === "timeout");
  });

  test("returns http error kind on non-OK response", async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: () => Promise.resolve("down"),
      } as unknown as Response);
    const result = await postLoopEvent(
      "http://api.test",
      "loop-1",
      () => "valid-token",
      { type: "test_event" }
    );
    assert.equal(result.success, false);
    assert.ok(
      !result.success && result.kind === "http" && result.status === 503
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loop-http.ts — uploadArtifacts (non-Error catch branch)
// ─────────────────────────────────────────────────────────────────────────────

describe("uploadArtifacts — catch branches", () => {
  test("returns auth error when getToken returns null", async () => {
    const result = await uploadArtifacts(
      "http://api.test",
      "loop-1",
      () => null,
      { files: [] }
    );
    assert.equal(result.success, false);
    assert.ok(!result.success && result.kind === "auth");
  });

  test("returns network error with String(err) when fetch rejects with non-Error", async () => {
    globalThis.fetch = (): Promise<Response> => Promise.reject("upload-fail");
    const result = await uploadArtifacts(
      "http://api.test",
      "loop-1",
      () => "valid-token",
      { files: [] }
    );
    assert.equal(result.success, false);
    assert.ok(!result.success && result.kind === "network");
    assert.equal(result.error, "upload-fail");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loop-http.ts — getCloudLoopStatus (401, non-OK, TIMED_OUT, fetch throws)
// ─────────────────────────────────────────────────────────────────────────────

describe("getCloudLoopStatus — response paths", () => {
  test("returns unauthorized on HTTP 401", async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as unknown as Response);
    const status = await getCloudLoopStatus(
      "http://api.test",
      "loop-1",
      () => "tok"
    );
    assert.equal(status.kind, "unauthorized");
  });

  test("returns error kind on non-OK non-401 response", async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Error",
      } as unknown as Response);
    const status = await getCloudLoopStatus(
      "http://api.test",
      "loop-1",
      () => "tok"
    );
    assert.equal(status.kind, "error");
    assert.ok(status.kind === "error" && status.status === 500);
  });

  test("returns timed_out when status field is TIMED_OUT", async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: "TIMED_OUT" }),
      } as unknown as Response);
    const status = await getCloudLoopStatus(
      "http://api.test",
      "loop-1",
      () => "tok"
    );
    assert.equal(status.kind, "timed_out");
  });

  test("returns active when status field is non-TIMED_OUT string", async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: "RUNNING" }),
      } as unknown as Response);
    const status = await getCloudLoopStatus(
      "http://api.test",
      "loop-1",
      () => "tok"
    );
    assert.equal(status.kind, "active");
  });

  test("returns active when response has no status field (null path)", async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ otherField: "value" }),
      } as unknown as Response);
    const status = await getCloudLoopStatus(
      "http://api.test",
      "loop-1",
      () => "tok"
    );
    assert.equal(status.kind, "active");
  });

  test("returns error with String(err) message when fetch rejects with non-Error", async () => {
    globalThis.fetch = (): Promise<Response> => Promise.reject("network-down");
    const status = await getCloudLoopStatus(
      "http://api.test",
      "loop-1",
      () => "tok"
    );
    assert.equal(status.kind, "error");
    assert.ok(status.kind === "error" && status.message === "network-down");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loop-http.ts — postLoopHeartbeat (auth-ladder rungs 3+4, catch non-Error)
// ─────────────────────────────────────────────────────────────────────────────

describe("postLoopHeartbeat — auth-ladder and catch branches", () => {
  test("returns missing_token when both getTokenMeta and getToken are undefined (ladder rung 4)", async () => {
    const result = await postLoopHeartbeat("http://api.test", "loop-1", {});
    assert.equal(result.success, false);
    assert.ok(!result.success && result.kind === "auth");
    assert.match(result.error, RE_MISSING_TOKEN);
  });

  test("uses managed key when JWT is stale and provenance is DESKTOP_MANAGED (ladder rung 3)", {
    timeout: 10_000,
  }, async () => {
    let capturedAuth = "";
    globalThis.fetch = (
      _input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      capturedAuth = String(
        (init?.headers as Record<string, string>)?.Authorization ?? ""
      );
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as unknown as Response);
    };
    const staleMs = Date.now() - 60_000; // 1 minute ago
    const result = await postLoopHeartbeat("http://api.test", "loop-1", {
      getTokenMeta: () => ({ token: "stale-jwt", expiresAt: staleMs }),
      getApiKey: () => "sk_live_managed",
      getApiKeyProvenance: () => "DESKTOP_MANAGED",
    });
    assert.equal(result.success, true);
    assert.ok(
      capturedAuth.startsWith("Bearer sk_live_managed"),
      "managed key should be used as Authorization header in rung 3"
    );
  });

  test("returns network error with String(err) when fetch rejects with non-Error (catch rung 1)", {
    timeout: 10_000,
  }, async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.reject("heartbeat-down");
    const futureMs = Date.now() + 3_600_000;
    const result = await postLoopHeartbeat("http://api.test", "loop-1", {
      getTokenMeta: () => ({ token: "valid-jwt", expiresAt: futureMs }),
    });
    assert.equal(result.success, false);
    assert.ok(!result.success && result.kind === "network");
    assert.equal(result.error, "heartbeat-down");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mcp-detection.ts — normalizeMcpServerUrl (path/catch branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeMcpServerUrl", () => {
  test("returns null for an invalid URL (catch branch)", () => {
    assert.equal(normalizeMcpServerUrl("not-a-url"), null);
  });

  test("returns '/' pathname when URL has no path component (empty normalizedPath branch)", () => {
    const result = normalizeMcpServerUrl("http://localhost:3010");
    assert.ok(result, "should return a URL string");
    assert.ok(result.includes("localhost:3010"), "should preserve host");
    const parsed = new URL(result);
    assert.equal(parsed.pathname, "/");
  });

  test("strips trailing slash from URL with a path", () => {
    const result = normalizeMcpServerUrl("http://localhost:3010/api/mcp/");
    assert.ok(result !== null);
    const parsed = new URL(result);
    assert.equal(
      parsed.pathname,
      "/api/mcp",
      "trailing slash should be removed"
    );
  });

  test("strips URL hash", () => {
    const result = normalizeMcpServerUrl("http://localhost:3010/api#section");
    assert.ok(result !== null);
    assert.ok(!result.includes("#"), "hash should be stripped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mcp-detection.ts — parseClaudeMcpList (invalid URL + no-name paths)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseClaudeMcpList", () => {
  test("returns null when expectedMcpUrl is not a valid URL", () => {
    const result = parseClaudeMcpList(
      "closedloop: http://localhost:3010 - Connected",
      "not-a-url"
    );
    assert.equal(result, null);
  });

  test("returns null when URL matches but nothing precedes it (no name prefix)", () => {
    const stdout = "http://localhost:3010 - Connected";
    const result = parseClaudeMcpList(stdout, "http://localhost:3010");
    assert.equal(
      result,
      null,
      "should return null when no name can be extracted before the URL"
    );
  });

  test("returns null for lines without ` - ` separator", () => {
    const stdout = "closedloop http://localhost:3010 Connected";
    const result = parseClaudeMcpList(stdout, "http://localhost:3010");
    assert.equal(result, null);
  });

  test("returns parsed entry when URL and name are present", () => {
    const stdout = "closedloop: http://localhost:3010 - Connected";
    const result = parseClaudeMcpList(stdout, "http://localhost:3010");
    assert.ok(result !== null);
    assert.equal(result.available, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mcp-detection.ts — parseClaudeMcpGet (invalid URL + no-match paths)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseClaudeMcpGet", () => {
  test("returns null when expectedMcpUrl is not a valid URL", () => {
    const result = parseClaudeMcpGet(
      "closedloop:\nStatus: Connected\nURL: http://localhost:3010",
      "not-a-url"
    );
    assert.equal(result, null);
  });

  test("returns null when neither name nor URL are found in stdout", () => {
    const result = parseClaudeMcpGet("", "http://localhost:3010");
    assert.equal(result, null);
  });

  test("returns null when URL in stdout does not match expectedMcpUrl", () => {
    const stdout = "closedloop:\nStatus: Connected\nURL: http://localhost:9999";
    const result = parseClaudeMcpGet(stdout, "http://localhost:3010");
    assert.equal(result, null);
  });

  test("returns parsed entry when name, URL, and status are present", () => {
    const stdout = "closedloop:\nStatus: Connected\nURL: http://localhost:3010";
    const result = parseClaudeMcpGet(stdout, "http://localhost:3010");
    assert.ok(result !== null);
    assert.equal(result.name, "closedloop");
    assert.equal(result.available, true);
  });

  test("returns entry with available=false when status is not Connected", () => {
    const stdout = "mymcp:\nStatus: Disconnected\nURL: http://localhost:3010";
    const result = parseClaudeMcpGet(stdout, "http://localhost:3010");
    assert.ok(result !== null);
    assert.equal(result.available, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mcp-detection.ts — parseCodexMcpList (invalid URL + Name-header skip)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseCodexMcpList", () => {
  test("returns null when expectedMcpUrl is not a valid URL", () => {
    const result = parseCodexMcpList(
      "closedloop enabled http://localhost:3010",
      "not-a-url"
    );
    assert.equal(result, null);
  });

  test("skips 'Name ...' header lines and returns null when no data line found", () => {
    const stdout = "Name        URL              Status\n";
    const result = parseCodexMcpList(stdout, "http://localhost:3010");
    assert.equal(result, null, "header-only output should yield null");
  });

  test("parses a valid codex mcp list row", () => {
    const stdout =
      "Name        URL              Status\n" +
      "closedloop  http://localhost:3010  enabled\n";
    const result = parseCodexMcpList(stdout, "http://localhost:3010");
    assert.ok(result !== null);
    assert.equal(result.name, "closedloop");
    assert.equal(result.available, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// metadata-routes.ts — GET /api/gateway/symphony/status (403 + state.json)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/gateway/symphony/status", () => {
  test("returns 400 when workDir query param is missing", async () => {
    const tmpDir = makeTempDir();
    const d = makeMetadataDispatcher([tmpDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
    });
    assert.equal(res.statusCode, 400);
  });

  test("returns 403 when workDir is outside allowed directories", async () => {
    const tmpDir = makeTempDir();
    const d = makeMetadataDispatcher([], tmpDir); // empty allowedDirs
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
      query: { workDir: tmpDir },
    });
    assert.equal(res.statusCode, 403);
    assert.match(String(res.body.error), RE_NOT_ALLOWED);
  });

  test("returns isRunning=false when state.json is absent", async () => {
    const tmpDir = makeTempDir();
    const d = makeMetadataDispatcher([tmpDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
      query: { workDir: tmpDir },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isRunning, false);
  });

  test("returns isRunning=true when state.json has a running status", async () => {
    const tmpDir = makeTempDir();
    const workDir = path.join(tmpDir, "work");
    mkdirSync(path.join(workDir, ".closedloop-ai", "work"), {
      recursive: true,
    });
    const stateDir = path.join(workDir, ".closedloop-ai", "work");
    writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ status: "RUNNING", phase: "execute", iteration: 3 }),
      "utf-8"
    );
    const d = makeMetadataDispatcher([workDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
      query: { workDir },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isRunning, true);
    assert.equal(res.body.phase, "execute");
  });

  test("returns isRunning=false when state.json has COMPLETED status", async () => {
    const tmpDir = makeTempDir();
    const workDir = path.join(tmpDir, "work");
    const stateDir = path.join(workDir, ".closedloop-ai", "work");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ status: "COMPLETED" }),
      "utf-8"
    );
    const d = makeMetadataDispatcher([workDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
      query: { workDir },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isRunning, false);
  });

  test("returns 500 when state.json exists but contains invalid JSON", async () => {
    const tmpDir = makeTempDir();
    const workDir = path.join(tmpDir, "work");
    const stateDir = path.join(workDir, ".closedloop-ai", "work");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "state.json"), "{not-json", "utf-8");
    const d = makeMetadataDispatcher([workDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/symphony/status",
      query: { workDir },
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.isRunning, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// metadata-routes.ts — GET /api/gateway/work-directory/:ticketId
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/gateway/work-directory/:ticketId", () => {
  test("returns exists=false when no sessions.json and no repos config", async () => {
    const tmpDir = makeTempDir();
    const d = makeMetadataDispatcher([tmpDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/work-directory/AI-100",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.exists, false);
  });

  test("uses SYMPHONY_WORKTREE_PARENT_DIR env var to resolve worktree parent (lines 251/256)", async () => {
    const tmpDir = makeTempDir();
    const repoDir = path.join(tmpDir, "myrepo");
    mkdirSync(repoDir, { recursive: true });
    setEnv("SYMPHONY_WORKTREE_PARENT_DIR", tmpDir);
    const worktreeDir = path.join(tmpDir, "myrepo-AI-100");
    mkdirSync(worktreeDir, { recursive: true });
    const configDir = path.join(tmpDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "repos.json"),
      JSON.stringify({
        repos: [{ path: repoDir, addedAt: new Date().toISOString() }],
        settings: {},
      }),
      "utf-8"
    );
    const d = makeMetadataDispatcher([tmpDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/work-directory/AI-100",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.exists, true);
    assert.equal(String(res.body.source), "worktree");
  });

  test("returns exists=false when worktree path does not exist (line 219 true branch)", async () => {
    const tmpDir = makeTempDir();
    const repoDir = path.join(tmpDir, "myrepo");
    mkdirSync(repoDir, { recursive: true });
    const configDir = path.join(tmpDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "repos.json"),
      JSON.stringify({
        repos: [{ path: repoDir, addedAt: new Date().toISOString() }],
        settings: {},
      }),
      "utf-8"
    );
    // Do NOT create the worktree dir — existsSync returns false → continue
    const d = makeMetadataDispatcher([tmpDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/work-directory/AI-100",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.exists, false);
  });

  test("returns exists=false when worktree is not in allowed directories (line 222 true branch)", async () => {
    const tmpDir = makeTempDir();
    const repoDir = path.join(tmpDir, "myrepo");
    mkdirSync(repoDir, { recursive: true });
    // worktree is a sibling of myrepo — not allowed when allowedDirs=[repoDir]
    const worktreeDir = path.join(tmpDir, "myrepo-AI-100");
    mkdirSync(worktreeDir, { recursive: true });
    const configDir = path.join(repoDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "repos.json"),
      JSON.stringify({
        repos: [{ path: repoDir, addedAt: new Date().toISOString() }],
        settings: {},
      }),
      "utf-8"
    );
    const d = makeMetadataDispatcher([repoDir], repoDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/work-directory/AI-100",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.exists, false);
  });

  test("returns session source when sessions.json has matching entry with valid worktreePath", async () => {
    const tmpDir = makeTempDir();
    const worktreePath = path.join(tmpDir, "my-worktree");
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(
      path.join(tmpDir, "sessions.json"),
      JSON.stringify({
        sessions: [{ ticketId: "AI-200", repoPath: tmpDir, worktreePath }],
      }),
      "utf-8"
    );
    const d = makeMetadataDispatcher([tmpDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/work-directory/AI-200",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.exists, true);
    assert.equal(String(res.body.source), "session");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — GET /api/gateway/symphony/learnings-status/:ticketId
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/gateway/symphony/learnings-status/:ticketId — 403 and file-read", () => {
  test("returns 403 when repo is outside allowed directories (line 358)", async () => {
    const tmpDir = makeTempDir();
    const d = makeLearningsDispatcher([], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/symphony/learnings-status/AI-100",
      query: { repo: path.join(tmpDir, "my-repo") },
    });
    assert.equal(res.statusCode, 403);
    assert.match(String(res.body.error), RE_NOT_ALLOWED);
  });

  test("reads and returns status file content when it exists (line 380)", async () => {
    const tmpDir = makeTempDir();
    const worktreeDir = path.join(tmpDir, "my-repo-AI-100");
    const statusDir = path.join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      ".learnings"
    );
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(
      path.join(statusDir, "chat-extraction-status.json"),
      JSON.stringify({ status: "completed", count: 3 }),
      "utf-8"
    );
    const d = makeLearningsDispatcher([tmpDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/symphony/learnings-status/AI-100",
      query: { repo: path.join(tmpDir, "my-repo") },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "completed");
    assert.equal(res.body.count, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — POST /api/gateway/symphony/record-learning-use (filter branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/gateway/symphony/record-learning-use — learnings filter branches", () => {
  test("filters out null and non-object entries in learnings array (lines 403/407)", async () => {
    const tmpDir = makeTempDir();
    const worktreeDir = path.join(tmpDir, "my-repo-AI-100");
    mkdirSync(worktreeDir, { recursive: true });
    const d = makeLearningsDispatcher([tmpDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "POST",
      pathname: "/api/gateway/symphony/record-learning-use",
      body: JSON.stringify({
        ticketId: "AI-100",
        repoPath: path.join(tmpDir, "my-repo"),
        learnings: [
          null, // filtered: null is not an object
          42, // filtered: typeof 42 !== "object"
          { notSummary: "x" }, // filtered: no string .summary
          { summary: "valid learning" }, // kept
        ],
      }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "recorded");
    assert.equal(
      res.body.count,
      1,
      "only the entry with a string summary should pass"
    );
  });

  test("returns 400 when body.learnings is not an array (line 410 false branch → empty [])", async () => {
    const tmpDir = makeTempDir();
    const d = makeLearningsDispatcher([tmpDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "POST",
      pathname: "/api/gateway/symphony/record-learning-use",
      body: JSON.stringify({
        ticketId: "AI-100",
        repoPath: path.join(tmpDir, "my-repo"),
        learnings: "not-an-array",
      }),
    });
    assert.equal(res.statusCode, 400);
    assert.ok(
      String(res.body.error).toLowerCase().includes("empty"),
      "should complain about empty learnings"
    );
  });
});
