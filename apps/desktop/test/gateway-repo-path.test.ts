import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitRepoPathRoutes } from "../src/server/operations/git-repo-path.js";
import { SymphonyDirNotConfiguredError } from "../src/server/operations/symphony-utils.js";
import { runGitFixture } from "./helpers/git-fixture.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";

/**
 * ISS-7346: `git-repo-path.ts`, a small gateway module reached only from
 * `router.ts`. (The `health-check-worktree-dir.ts` cases this file also held
 * were removed with that check, ISS-12435.)
 */

const REPO_PATH_ROUTE = "/api/gateway/git/repo-path";
const GET = "GET";

const { makeTempDir } = createGitOpTempDirs("gateway-repo-path-");

async function writeReposConfig(
  symphonyDir: string,
  config: Record<string, unknown>
): Promise<string> {
  const configDir = path.join(symphonyDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "repos.json"),
    JSON.stringify(config),
    "utf-8"
  );
  return configDir;
}

/** A real git repo whose `origin` URL reads as `git@github.com:<fullName>.git`. */
async function makeRepoWithOrigin(
  root: string,
  name: string,
  fullName: string
): Promise<string> {
  const repoPath = path.join(root, name);
  await fs.mkdir(repoPath, { recursive: true });
  await runGitFixture(["init", "-b", "main"], repoPath);
  await runGitFixture(
    ["remote", "add", "origin", `git@github.com:${fullName}.git`],
    repoPath
  );
  return repoPath;
}

function dispatchRepoPath(
  getSymphonyDir: () => string,
  query: Record<string, string>
): Promise<Awaited<ReturnType<typeof dispatchOperation>>> {
  const dispatcher = new OperationDispatcher();
  registerGitRepoPathRoutes(dispatcher, getSymphonyDir);
  return dispatchOperation({
    dispatcher,
    method: GET,
    pathname: REPO_PATH_ROUTE,
    query,
  });
}

describe(`registerGitRepoPathRoutes ${GET} ${REPO_PATH_ROUTE}`, () => {
  test("rejects a request with no repoFullName", async () => {
    const symphonyDir = makeTempDir();

    const response = await dispatchRepoPath(() => symphonyDir, {});

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "repoFullName is required");
  });

  test("resolves the configured repo whose origin matches", async () => {
    const root = makeTempDir();
    const symphonyDir = path.join(root, ".closedloop-ai");
    const repoPath = await makeRepoWithOrigin(root, "widget", "acme/widget");
    await writeReposConfig(symphonyDir, {
      repos: [{ path: repoPath, addedAt: "2026-08-20T00:00:00.000Z" }],
      settings: {},
    });

    const response = await dispatchRepoPath(() => symphonyDir, {
      repoFullName: "acme/widget",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.path, repoPath);
  });

  test("reports a null path when no configured repo matches the name", async () => {
    const root = makeTempDir();
    const symphonyDir = path.join(root, ".closedloop-ai");
    const repoPath = await makeRepoWithOrigin(root, "widget", "acme/widget");
    await writeReposConfig(symphonyDir, {
      repos: [{ path: repoPath, addedAt: "2026-08-20T00:00:00.000Z" }],
      settings: {},
    });

    const response = await dispatchRepoPath(() => symphonyDir, {
      repoFullName: "acme/other",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.path, null);
  });

  test("reports a null path when no repos are configured at all", async () => {
    const symphonyDir = makeTempDir();

    const response = await dispatchRepoPath(() => symphonyDir, {
      repoFullName: "acme/widget",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.path, null);
  });

  test("skips a configured directory that is not a git repo", async () => {
    const root = makeTempDir();
    const symphonyDir = path.join(root, ".closedloop-ai");
    const plainDir = path.join(root, "not-a-repo");
    await fs.mkdir(plainDir, { recursive: true });
    const repoPath = await makeRepoWithOrigin(root, "widget", "acme/widget");
    await writeReposConfig(symphonyDir, {
      repos: [
        { path: plainDir, addedAt: "2026-08-20T00:00:00.000Z" },
        { path: repoPath, addedAt: "2026-08-20T00:00:00.000Z" },
      ],
      settings: {},
    });

    const response = await dispatchRepoPath(() => symphonyDir, {
      repoFullName: "acme/widget",
    });

    // The non-repo entry resolves to a null fullName and is stepped over
    // rather than aborting the scan.
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.path, repoPath);
  });

  test("returns the FIRST configured repo whose origin matches", async () => {
    const root = makeTempDir();
    const symphonyDir = path.join(root, ".closedloop-ai");
    const first = await makeRepoWithOrigin(root, "first", "acme/widget");
    const second = await makeRepoWithOrigin(root, "second", "acme/widget");
    await writeReposConfig(symphonyDir, {
      repos: [
        { path: first, addedAt: "2026-08-20T00:00:00.000Z" },
        { path: second, addedAt: "2026-08-20T00:00:00.000Z" },
      ],
      settings: {},
    });

    const response = await dispatchRepoPath(() => symphonyDir, {
      repoFullName: "acme/widget",
    });

    assert.equal(response.body.path, first);
    assert.notEqual(response.body.path, second);
  });

  test("rethrows SymphonyDirNotConfiguredError so the dispatcher answers 503", async () => {
    // The handler rethrows this one deliberately rather than folding it into
    // its own 500, which is what lets the dispatcher turn it into the
    // onboarding-specific 503 instead of a generic failure.
    const dispatcher = new OperationDispatcher();
    registerGitRepoPathRoutes(dispatcher, () => {
      throw new SymphonyDirNotConfiguredError();
    });

    const response = await dispatchOperation({
      dispatcher,
      method: GET,
      pathname: REPO_PATH_ROUTE,
      query: { repoFullName: "acme/widget" },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(
      response.body.error,
      "Server not configured — complete onboarding"
    );
  });

  test("answers 500 with the failure message for any other error", async () => {
    const dispatcher = new OperationDispatcher();
    registerGitRepoPathRoutes(dispatcher, () => {
      throw new Error("symphony dir exploded");
    });

    const response = await dispatchOperation({
      dispatcher,
      method: GET,
      pathname: REPO_PATH_ROUTE,
      query: { repoFullName: "acme/widget" },
    });

    assert.equal(response.statusCode, 500);
    assert.equal(
      response.body.error,
      "Failed to resolve repo path: symphony dir exploded"
    );
  });

  test("names a non-Error throw as an unknown error", async () => {
    const dispatcher = new OperationDispatcher();
    registerGitRepoPathRoutes(dispatcher, () => {
      // biome-ignore lint/style/useThrowOnlyError: driving the non-Error branch
      throw "not an error object";
    });

    const response = await dispatchOperation({
      dispatcher,
      method: GET,
      pathname: REPO_PATH_ROUTE,
      query: { repoFullName: "acme/widget" },
    });

    assert.equal(response.statusCode, 500);
    assert.equal(
      response.body.error,
      "Failed to resolve repo path: Unknown error"
    );
  });
});
