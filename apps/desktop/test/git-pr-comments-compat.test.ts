import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  RETIRED_GITHUB_DATA_ROUTE_ERROR,
  RETIRED_GITHUB_DATA_ROUTE_MESSAGE,
  registerGitPrRoutes,
} from "../src/server/operations/git-pr.js";
import { configureBinaryPathsResolver } from "../src/server/operations/symphony-loop.js";

const LEGACY_BRANCH_ID_PATTERN = /^acme%2Fwidgets::/;
const tempDirs: string[] = [];

afterEach(async () => {
  configureBinaryPathsResolver(null);
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("registerGitPrRoutes GET /api/gateway/git/pr/comments", () => {
  test("preserves the legacy local repo plus pr query contract", async () => {
    const repoDir = await makeGitHubRepoFixture();
    const ghBin = await makeGhFixture();
    const dispatcher = makeDispatcher(repoDir, ghBin);

    const response = await dispatchJson(
      dispatcher,
      `/api/gateway/git/pr/comments?repo=${encodeURIComponent(repoDir)}&pr=42`
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.prNumber, 42);
    assert.equal(
      response.body.prUrl,
      "https://github.com/acme/widgets/pull/42"
    );
    assert.match(response.body.branchId, LEGACY_BRANCH_ID_PATTERN);
  });

  test("returns 410 when legacy local gh-backed data routes are retired", async () => {
    const repoDir = await makeGitHubRepoFixture();
    const dispatcher = makeDispatcher(repoDir, "/missing/gh", false);

    const response = await dispatchJson(
      dispatcher,
      `/api/gateway/git/pr/comments?repo=${encodeURIComponent(repoDir)}&pr=42`
    );

    assert.equal(response.statusCode, 410);
    assert.deepEqual(response.body, {
      error: RETIRED_GITHUB_DATA_ROUTE_ERROR,
      message: RETIRED_GITHUB_DATA_ROUTE_MESSAGE,
    });
  });

  test("keeps the GitHub user route available when data routes are retired", async () => {
    const repoDir = await makeGitHubRepoFixture();
    const ghBin = await makeGhFixture();
    const dispatcher = makeDispatcher(repoDir, ghBin, false);

    const response = await dispatchJson(dispatcher, "/api/gateway/git/user");

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.login, "octocat");
  });
});

async function makeGitHubRepoFixture(): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "git-pr-comments-"));
  tempDirs.push(repoDir);
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature/comments"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:acme/widgets.git"],
    { cwd: repoDir, stdio: "ignore" }
  );
  return repoDir;
}

async function makeGhFixture(): Promise<string> {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "git-pr-comments-bin-"));
  tempDirs.push(binDir);
  const ghBin = path.join(binDir, "gh");
  await writeFile(
    ghBin,
    `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo octocat
  exit 0
fi
cat <<'JSON'
{"repository":{"pullRequest":{"number":42,"url":"https://github.com/acme/widgets/pull/42","comments":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}},"reviews":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}},"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}
JSON
`,
    { mode: 0o755 }
  );
  return ghBin;
}

function makeDispatcher(
  repoDir: string,
  ghBin: string,
  enableGithubDataRoutes = true
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitPrRoutes(
    dispatcher,
    () => [repoDir],
    () => null,
    { enableGithubDataRoutes }
  );
  configureBinaryPathsResolver(() => ({ gh: ghBin }));
  return dispatcher;
}

async function dispatchJson(
  dispatcher: OperationDispatcher,
  pathWithQuery: string
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
  const handled = await dispatcher.dispatch({
    method: "GET",
    pathname: url.pathname,
    params: {},
    query: url.searchParams,
    rawBody: Buffer.alloc(0),
    body: "",
    request: {} as IncomingMessage,
    response,
  });

  if (!handled) {
    throw new Error("Expected PR comments route to be handled");
  }
  return {
    statusCode: response.statusCode,
    body: JSON.parse(chunks.join("")) as Record<string, unknown>,
  };
}
