/**
 * ISS-5299 — branch coverage for git-pr-exec.ts and git-pr-create.ts
 * validation arms.
 *
 * PLN-1535 M5 deletion 2 retired the local-`gh` PR data lane, so the
 * git-pr-identity.ts and `/pr/list` / `/pr/files` / `/pr/file-diff` cases this
 * file also carried went with the code they covered. The retired routes' 410
 * contract is asserted in gateway-server.test.ts, over all eight paths at once.
 *
 * Pure-function tests import the symbols directly and assert exact return
 * values; they need no dispatcher or harness. Route tests drive a bare
 * OperationDispatcher using an inline dispatchReq helper.
 *
 * All route tests return before any gh or git binary resolution, so no
 * gh fixture is required. getRepoSlug tests use real temp directories
 * (git binary required, matches existing test conventions in this suite).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitPrCreateRoute } from "../src/server/operations/git-pr-create.js";
import {
  getRepoSlug,
  parsePrNumber,
} from "../src/server/operations/git-pr-exec.js";
import { configureBinaryPathsResolver } from "../src/server/operations/symphony-loop.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  configureBinaryPathsResolver(null);
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), "iss5299-pr-ops-"))
  );
  tempDirs.push(dir);
  return dir;
}

async function dispatchReq(
  dispatcher: OperationDispatcher,
  method: string,
  pathWithQuery: string,
  body?: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const url = new URL(pathWithQuery, "http://localhost");
  const chunks: string[] = [];
  const response = {
    statusCode: 200,
    setHeader: () => undefined,
    end: (chunk?: string | Buffer) => {
      if (chunk) {
        chunks.push(String(chunk));
      }
    },
  } as unknown as ServerResponse;
  await dispatcher.dispatch({
    method,
    pathname: url.pathname,
    params: {},
    query: url.searchParams,
    rawBody: Buffer.from(body ?? ""),
    body: body ?? "",
    request: {} as IncomingMessage,
    response,
  });
  const raw = chunks.join("");
  return {
    statusCode: response.statusCode,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  };
}

function makeCreateDispatcher(allowedDir: string): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitPrCreateRoute(dispatcher, () => [allowedDir]);
  return dispatcher;
}

// ---------------------------------------------------------------------------
// git-pr-exec.ts — parsePrNumber and getRepoSlug
// ---------------------------------------------------------------------------

test("parsePrNumber: URL without /pull/ segment returns null (line 69 true)", () => {
  assert.equal(parsePrNumber("https://github.com/owner/repo/issues/42"), null);
});

test("parsePrNumber: URL with /pull/ segment returns the number (line 69 false)", () => {
  assert.equal(parsePrNumber("https://github.com/owner/repo/pull/99"), 99);
});

// line 74 path 0 (NaN branch) is STRUCTURALLY UNREACHABLE: PR_NUMBER_REGEX
// captures only \d+ so match[1] is always a digit string; parseInt can never
// return NaN.  Documented here rather than silently skipped.

test("getRepoSlug: non-git directory returns empty string (line 61 catch)", async () => {
  const dir = makeTempDir();
  // dir has no git repo → `git remote get-url origin` fails → catch → ""
  assert.equal(await getRepoSlug(dir), "");
});

test("getRepoSlug: git repo with non-GitHub remote returns empty string (line 60 false branch)", async () => {
  const dir = makeTempDir();
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@gitlab.com:foo/bar.git"],
    { cwd: dir, stdio: "ignore" }
  );
  // GITHUB_REMOTE_REGEX does not match gitlab.com → return ""
  assert.equal(await getRepoSlug(dir), "");
});

// ---------------------------------------------------------------------------
// git-pr-create.ts route validation arms
//
// All tests return from resolveCreateRequest before reaching any gh call.
// ---------------------------------------------------------------------------

test("POST /api/gateway/git/pr: invalid JSON body returns 400 (line 93 true)", async () => {
  const dir = makeTempDir();
  const dispatcher = makeCreateDispatcher(dir);
  const res = await dispatchReq(
    dispatcher,
    "POST",
    "/api/gateway/git/pr",
    "not-valid-json"
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid JSON body");
});

test("POST /api/gateway/git/pr: missing repoPath returns 400", async () => {
  const dispatcher = makeCreateDispatcher("");
  const res = await dispatchReq(
    dispatcher,
    "POST",
    "/api/gateway/git/pr",
    JSON.stringify({ title: "My PR" })
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repoPath is required");
});

test("POST /api/gateway/git/pr: missing title returns 400 (line 102 true)", async () => {
  const dir = makeTempDir();
  const dispatcher = makeCreateDispatcher(dir);
  const res = await dispatchReq(
    dispatcher,
    "POST",
    "/api/gateway/git/pr",
    JSON.stringify({ repoPath: dir })
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "title is required");
});

test("POST /api/gateway/git/pr: disallowed directory returns 403 (line 109 true)", async () => {
  const allowedDir = makeTempDir();
  const otherDir = makeTempDir();
  const dispatcher = makeCreateDispatcher(allowedDir);
  const res = await dispatchReq(
    dispatcher,
    "POST",
    "/api/gateway/git/pr",
    JSON.stringify({ repoPath: otherDir, title: "My PR" })
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

test("POST /api/gateway/git/pr: unexpected sandbox errors propagate", async () => {
  const expected = new Error("sandbox policy unavailable");
  const dispatcher = new OperationDispatcher();
  registerGitPrCreateRoute(dispatcher, () => {
    throw expected;
  });

  await assert.rejects(
    dispatchReq(
      dispatcher,
      "POST",
      "/api/gateway/git/pr",
      JSON.stringify({ repoPath: "/tmp/repo", title: "My PR" })
    ),
    (error) => error === expected
  );
});
