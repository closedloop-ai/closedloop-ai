import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerLearningsRoutes } from "../src/server/operations/learnings.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  process.env.HOME = originalHome;
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "learnings-route-test-"));
  tempDirs.push(dir);
  return dir;
}

function buildToon(summary: string): string {
  return [
    "patterns[1]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context}:",
    `  pat-1,pattern,"${summary}",high,1,1.0,[KEEP],repo|all,chat`,
    "",
  ].join("\n");
}

async function dispatchGetLearnings(homeDir: string): Promise<{
  statusCode: number;
  body: { patterns: Array<{ summary: string }> };
}> {
  process.env.HOME = homeDir;

  const dispatcher = new OperationDispatcher();
  registerLearningsRoutes(
    dispatcher,
    () => [],
    () => path.join(homeDir, ".closedloop-ai")
  );

  let responseBody = "";
  const response = {
    statusCode: 0,
    setHeader() {},
    end(body?: string) {
      responseBody = body ?? "";
    },
  } as unknown as ServerResponse;

  const handled = await dispatcher.dispatch({
    method: "GET",
    pathname: "/api/gateway/learnings",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.alloc(0),
    body: "",
    request: {} as IncomingMessage,
    response,
  });

  assert.equal(handled, true);

  return {
    statusCode: (response as unknown as { statusCode: number }).statusCode,
    body: JSON.parse(responseBody) as { patterns: Array<{ summary: string }> },
  };
}

async function dispatchGetPendingLearnings(symphonyDir: string): Promise<{
  statusCode: number;
  body: { totalCount: number; worktreeCount: number };
}> {
  const dispatcher = new OperationDispatcher();
  registerLearningsRoutes(
    dispatcher,
    () => [],
    () => symphonyDir
  );

  let responseBody = "";
  const response = {
    statusCode: 0,
    setHeader() {},
    end(body?: string) {
      responseBody = body ?? "";
    },
  } as unknown as ServerResponse;

  const handled = await dispatcher.dispatch({
    method: "GET",
    pathname: "/api/gateway/symphony/pending-learnings",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.alloc(0),
    body: "",
    request: {} as IncomingMessage,
    response,
  });

  assert.equal(handled, true);

  return {
    statusCode: (response as unknown as { statusCode: number }).statusCode,
    body: JSON.parse(responseBody) as {
      totalCount: number;
      worktreeCount: number;
    },
  };
}

describe("registerLearningsRoutes GET /api/gateway/learnings", () => {
  test("prefers ~/.closedloop-ai/learnings/org-patterns.toon", async () => {
    const homeDir = await makeTempDir();
    await fs.mkdir(path.join(homeDir, ".closedloop-ai", "learnings"), {
      recursive: true,
    });
    await fs.mkdir(path.join(homeDir, ".claude", ".learnings"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(homeDir, ".closedloop-ai", "learnings", "org-patterns.toon"),
      buildToon("new-path"),
      "utf-8"
    );
    await fs.writeFile(
      path.join(homeDir, ".claude", ".learnings", "org-patterns.toon"),
      buildToon("legacy-path"),
      "utf-8"
    );

    const response = await dispatchGetLearnings(homeDir);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.patterns[0]?.summary, "new-path");
  });

  test("falls back to ~/.claude/.learnings/org-patterns.toon when needed", async () => {
    const homeDir = await makeTempDir();
    await fs.mkdir(path.join(homeDir, ".claude", ".learnings"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(homeDir, ".claude", ".learnings", "org-patterns.toon"),
      buildToon("legacy-path"),
      "utf-8"
    );

    const response = await dispatchGetLearnings(homeDir);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.patterns[0]?.summary, "legacy-path");
  });
});

describe("registerLearningsRoutes GET /api/gateway/symphony/pending-learnings", () => {
  test("reads repos.json from the config subdirectory of the symphony dir", async () => {
    // loadReposConfig's graceful fallback: when repos.json is absent it
    // creates the directory and writes an empty one. Use that side effect
    // to verify the handler passed the correct path — it must target
    // `<symphonyDir>/config/repos.json`, NOT the bare `<symphonyDir>/repos.json`
    // that the previous buggy version passed.
    const symphonyDir = await makeTempDir();

    const response = await dispatchGetPendingLearnings(symphonyDir);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.totalCount, 0);
    assert.equal(response.body.worktreeCount, 0);

    const configRepos = path.join(symphonyDir, "config", "repos.json");
    const bareRepos = path.join(symphonyDir, "repos.json");
    assert.equal(
      existsSync(configRepos),
      true,
      "handler should have triggered loadReposConfig to create <symphonyDir>/config/repos.json"
    );
    assert.equal(
      existsSync(bareRepos),
      false,
      "handler must NOT create <symphonyDir>/repos.json — that was the pre-fix bug"
    );
  });

  test("returns empty totals when configured repos have no pending learnings", async () => {
    const symphonyDir = await makeTempDir();
    // Seed a repos.json pointing at a non-existent path so the handler
    // iterates the config, skips the missing repo, and returns zeros.
    // Without the fix, this would also return zeros (handler reads the
    // wrong file, sees an empty list) — but the side-effect assertion in
    // the test above is what proves the path is correct.
    const configDir = path.join(symphonyDir, "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "repos.json"),
      JSON.stringify({
        repos: [
          { path: "/nonexistent/repo", addedAt: new Date().toISOString() },
        ],
        settings: {},
      }),
      "utf-8"
    );

    const response = await dispatchGetPendingLearnings(symphonyDir);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.totalCount, 0);
    assert.equal(response.body.worktreeCount, 0);
  });
});
