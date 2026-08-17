/**
 * ISS-5299 — branch coverage for five uncovered-branch target modules under
 * apps/desktop/src/server/operations/: repos-config-utils (pure utility),
 * repos-config (route handlers), filesystem-search, filesystem-directories,
 * and metadata-routes.
 *
 * Exists as its own file because gateway-server.test.ts is on the shrink-only
 * noExcessiveLinesPerFile grandfather list in biome.jsonc and must not grow.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerFilesystemDirectoriesRoutes } from "../src/server/operations/filesystem-directories.js";
import { registerFilesystemSearchRoutes } from "../src/server/operations/filesystem-search.js";
import { registerMetadataRoutes } from "../src/server/operations/metadata-routes.js";
import { registerReposConfigRoutes } from "../src/server/operations/repos-config.js";
import {
  addRepo,
  loadReposConfig,
  removeRepo,
  saveReposConfig,
} from "../src/server/operations/repos-config-utils.js";
import { SymphonyDirNotConfiguredError } from "../src/server/operations/symphony-utils.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

const ENV_KEYS = ["SYMPHONY_WORKTREE_PARENT_DIR"] as const;
let savedEnv: Record<string, string | undefined> = {};
const { makeTempDir } = createGitOpTempDirs("iss5299-cfg-");

afterEach(() => {
  restoreEnvVars(savedEnv);
  savedEnv = {};
});

// ─── repos-config-utils: loadReposConfig ─────────────────────────────────────

test("loadReposConfig returns empty config when repos.json does not exist", async () => {
  const configDir = makeTempDir();
  const cfg = await loadReposConfig(configDir);
  assert.deepEqual(cfg.repos, []);
  assert.deepEqual(cfg.settings, {});
});

test("loadReposConfig returns empty config when repos.json contains corrupt JSON", async () => {
  const configDir = makeTempDir();
  await fs.writeFile(
    path.join(configDir, "repos.json"),
    "{ bad json !!",
    "utf-8"
  );
  const cfg = await loadReposConfig(configDir);
  assert.deepEqual(cfg.repos, []);
  assert.deepEqual(cfg.settings, {});
});

test("loadReposConfig coerces non-array repos to [] and null settings to {}", async () => {
  const configDir = makeTempDir();
  await fs.writeFile(
    path.join(configDir, "repos.json"),
    JSON.stringify({ repos: "not-an-array", settings: null }),
    "utf-8"
  );
  const cfg = await loadReposConfig(configDir);
  assert.deepEqual(cfg.repos, []);
  assert.deepEqual(cfg.settings, {});
});

// ─── repos-config-utils: addRepo failure and detection paths ─────────────────

test("addRepo returns error when path does not exist", async () => {
  const configDir = makeTempDir();
  const result = await addRepo(
    "/iss5299-nonexistent-path",
    undefined,
    configDir
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "Path does not exist");
});

test("addRepo returns error when path is a file not a directory", async () => {
  const configDir = makeTempDir();
  const tmp = makeTempDir();
  const filePath = path.join(tmp, "file.txt");
  await fs.writeFile(filePath, "content");
  const result = await addRepo(filePath, undefined, configDir);
  assert.equal(result.success, false);
  assert.equal(result.error, "Path must be a directory");
});

test("addRepo returns error when repository is already configured", async () => {
  const configDir = makeTempDir();
  const repoDir = makeTempDir();
  const first = await addRepo(repoDir, "first", configDir);
  assert.equal(first.success, true);
  const second = await addRepo(repoDir, "again", configDir);
  assert.equal(second.success, false);
  assert.equal(second.error, "Repository already configured");
});

test("addRepo records no deployment when repo has no package.json", async () => {
  const configDir = makeTempDir();
  const repoDir = makeTempDir();
  const result = await addRepo(repoDir, undefined, configDir);
  assert.equal(result.success, true);
  assert.equal(result.repo?.deployment, undefined);
});

test("addRepo detects vite framework with dev script and packageManager", async () => {
  const configDir = makeTempDir();
  const repoDir = makeTempDir();
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      devDependencies: { vite: "^4.0.0" },
      scripts: { dev: "vite" },
      packageManager: "pnpm@8.0.0",
    }),
    "utf-8"
  );
  const result = await addRepo(repoDir, undefined, configDir);
  assert.equal(result.success, true);
  assert.equal(result.repo?.deployment?.framework, "vite");
  assert.equal(result.repo?.deployment?.startCommand, "pnpm dev");
  assert.equal(result.repo?.deployment?.packageManager, "pnpm@8.0.0");
});

test("addRepo detects react framework with start script when no dev script", async () => {
  const configDir = makeTempDir();
  const repoDir = makeTempDir();
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      dependencies: { react: "^18.0.0" },
      scripts: { start: "react-scripts start" },
    }),
    "utf-8"
  );
  const result = await addRepo(repoDir, undefined, configDir);
  assert.equal(result.success, true);
  assert.equal(result.repo?.deployment?.framework, "react");
  assert.equal(result.repo?.deployment?.startCommand, "pnpm start");
});

test("addRepo detects express framework", async () => {
  const configDir = makeTempDir();
  const repoDir = makeTempDir();
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    "utf-8"
  );
  const result = await addRepo(repoDir, undefined, configDir);
  assert.equal(result.success, true);
  assert.equal(result.repo?.deployment?.framework, "express");
});

test("addRepo returns no deployment when package.json is corrupt JSON", async () => {
  const configDir = makeTempDir();
  const repoDir = makeTempDir();
  await fs.writeFile(path.join(repoDir, "package.json"), "{ bad json", "utf-8");
  const result = await addRepo(repoDir, undefined, configDir);
  assert.equal(result.success, true);
  assert.equal(result.repo?.deployment, undefined);
});

// ─── repos-config-utils: removeRepo ──────────────────────────────────────────

test("removeRepo returns error when repository is not in config", async () => {
  const configDir = makeTempDir();
  const result = await removeRepo("/iss5299-no-such/repo", configDir);
  assert.equal(result.success, false);
  assert.equal(result.error, "Repository not found");
});

// ─── repos-config routes ─────────────────────────────────────────────────────

function makeReposDispatcher(
  getSymphonyDir: () => string
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerReposConfigRoutes(dispatcher, getSymphonyDir);
  return dispatcher;
}

test("GET /repos returns repos array for configured symphony dir", async () => {
  const symphonyDir = makeTempDir();
  const dispatcher = makeReposDispatcher(() => symphonyDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/repos",
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.repos));
});

test("GET /repos propagates SymphonyDirNotConfiguredError as 503", async () => {
  const dispatcher = makeReposDispatcher(() => {
    throw new SymphonyDirNotConfiguredError();
  });
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/repos",
  });
  assert.equal(res.statusCode, 503);
  assert.equal(typeof res.body.error, "string");
});

test("POST /repos with invalid JSON body returns 400", async () => {
  const dispatcher = makeReposDispatcher(() => makeTempDir());
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/repos",
    body: "{ bad json",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid JSON body");
});

test("POST /repos with missing path field returns 400", async () => {
  const dispatcher = makeReposDispatcher(() => makeTempDir());
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/repos",
    body: JSON.stringify({ description: "no path field" }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "path is required and must be a string");
});

test("POST /repos with valid path adds repo and returns it", async () => {
  const symphonyDir = makeTempDir();
  const repoDir = makeTempDir();
  const dispatcher = makeReposDispatcher(() => symphonyDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/repos",
    body: JSON.stringify({ path: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const repo = res.body.repo as { path: string };
  assert.equal(typeof repo.path, "string");
});

test("POST /repos with duplicate path returns 400 with addRepo error message", async () => {
  const symphonyDir = makeTempDir();
  const repoDir = makeTempDir();
  const configDir = path.join(symphonyDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await saveReposConfig(
    { repos: [{ path: repoDir, addedAt: "2025-01-01" }], settings: {} },
    configDir
  );
  const dispatcher = makeReposDispatcher(() => symphonyDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/repos",
    body: JSON.stringify({ path: repoDir }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Repository already configured");
});

test("DELETE /repos without path query parameter returns 400", async () => {
  const dispatcher = makeReposDispatcher(() => makeTempDir());
  const res = await dispatchOperation({
    dispatcher,
    method: "DELETE",
    pathname: "/api/gateway/repos",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "path query parameter is required");
});

test("DELETE /repos removes an existing repo and clears it from config", async () => {
  const symphonyDir = makeTempDir();
  const repoDir = makeTempDir();
  const configDir = path.join(symphonyDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await saveReposConfig(
    { repos: [{ path: repoDir, addedAt: "2025-01-01" }], settings: {} },
    configDir
  );
  const dispatcher = makeReposDispatcher(() => symphonyDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "DELETE",
    pathname: "/api/gateway/repos",
    query: { path: repoDir },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const cfg = await loadReposConfig(configDir);
  assert.equal(cfg.repos.length, 0);
});

test("DELETE /repos with unknown path returns 400 with removeRepo error message", async () => {
  const dispatcher = makeReposDispatcher(() => makeTempDir());
  const res = await dispatchOperation({
    dispatcher,
    method: "DELETE",
    pathname: "/api/gateway/repos",
    query: { path: "/iss5299-no-such/repo" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Repository not found");
});

test("PATCH /repos with invalid JSON body returns 400", async () => {
  const dispatcher = makeReposDispatcher(() => makeTempDir());
  const res = await dispatchOperation({
    dispatcher,
    method: "PATCH",
    pathname: "/api/gateway/repos",
    body: "bad json",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid JSON body");
});

test("PATCH /repos with no recognized settings fields returns 400", async () => {
  const dispatcher = makeReposDispatcher(() => makeTempDir());
  const res = await dispatchOperation({
    dispatcher,
    method: "PATCH",
    pathname: "/api/gateway/repos",
    body: JSON.stringify({ unknownField: "ignored" }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "No settings to update");
});

test("PATCH /repos updates worktreeParentDir and persists settings to config", async () => {
  const symphonyDir = makeTempDir();
  const dispatcher = makeReposDispatcher(() => symphonyDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "PATCH",
    pathname: "/api/gateway/repos",
    body: JSON.stringify({
      worktreeParentDir: "/some/path",
      worktreeParentDirConfirmed: true,
    }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const cfg = await loadReposConfig(path.join(symphonyDir, "config"));
  assert.equal(cfg.settings.worktreeParentDir, "/some/path");
  assert.equal(cfg.settings.worktreeParentDirConfirmed, true);
});

test("PATCH /repos propagates SymphonyDirNotConfiguredError as 503", async () => {
  const dispatcher = makeReposDispatcher(() => {
    throw new SymphonyDirNotConfiguredError();
  });
  const res = await dispatchOperation({
    dispatcher,
    method: "PATCH",
    pathname: "/api/gateway/repos",
    body: JSON.stringify({ worktreeParentDir: "/x" }),
  });
  assert.equal(res.statusCode, 503);
});

// ─── filesystem-search routes ─────────────────────────────────────────────────

function makeSearchDispatcher(allowedDirs: string[]): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerFilesystemSearchRoutes(dispatcher, () => allowedDirs);
  return dispatcher;
}

test("GET /files/search without repo param returns 400", async () => {
  const tmpDir = makeTempDir();
  const dispatcher = makeSearchDispatcher([tmpDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/files/search",
    query: { ticket: "ISS-1" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repo query parameter is required");
});

test("GET /files/search without ticket or base param returns 400", async () => {
  const tmpDir = makeTempDir();
  const dispatcher = makeSearchDispatcher([tmpDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/files/search",
    query: { repo: tmpDir },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "ticket query parameter is required");
});

test("GET /files/search with repo path outside allowed dirs returns 403", async () => {
  const allowedDir = makeTempDir();
  const outsideDir = makeTempDir();
  const dispatcher = makeSearchDispatcher([allowedDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/files/search",
    query: { repo: outsideDir, base: "true" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

test("GET /files/search with worktree parent dir outside allowed dirs returns 403", async () => {
  savedEnv = saveEnvVars(ENV_KEYS);
  const allowedDir = makeTempDir();
  const outsideParent = makeTempDir();
  const repoDir = path.join(allowedDir, "myrepo");
  await fs.mkdir(repoDir, { recursive: true });
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = outsideParent;
  const dispatcher = makeSearchDispatcher([allowedDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/files/search",
    query: { repo: repoDir, ticket: "ISS-99" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

test("GET /files/search with base=true and missing repo dir returns 200 with Repository not found", async () => {
  const tmpDir = makeTempDir();
  const missingDir = path.join(tmpDir, "no-such-dir");
  const dispatcher = makeSearchDispatcher([tmpDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/files/search",
    query: { repo: missingDir, base: "true" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.files, []);
  assert.equal(res.body.error, "Repository not found");
});

test("GET /files/search with ticket and missing worktree returns 200 with Worktree not found", async () => {
  savedEnv = saveEnvVars(ENV_KEYS);
  Reflect.deleteProperty(process.env, "SYMPHONY_WORKTREE_PARENT_DIR");
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "myrepo");
  await fs.mkdir(repoDir, { recursive: true });
  const dispatcher = makeSearchDispatcher([tmpDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/files/search",
    query: { repo: repoDir, ticket: "ISS-404" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.files, []);
  assert.equal(res.body.error, "Worktree not found");
});

test("GET /files/search sorts: exact match first, starts-with second, then shorter, then localeCompare", async () => {
  savedEnv = saveEnvVars(ENV_KEYS);
  Reflect.deleteProperty(process.env, "SYMPHONY_WORKTREE_PARENT_DIR");
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  await fs.mkdir(repoDir, { recursive: true });
  // query="a": "a.ts" is exact, "apple.ts" starts-with, "pear.ts"/"banana.ts"/"canary.ts" are neither
  for (const name of [
    "canary.ts",
    "banana.ts",
    "pear.ts",
    "apple.ts",
    "a.ts",
  ]) {
    await fs.writeFile(path.join(repoDir, name), "");
  }
  const dispatcher = makeSearchDispatcher([tmpDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/files/search",
    query: { repo: repoDir, base: "true", query: "a" },
  });
  assert.equal(res.statusCode, 200);
  const files = res.body.files as string[];
  assert.ok(files.length >= 3);
  assert.equal(files[0], "a.ts"); // exact match always first
  assert.equal(files[1], "apple.ts"); // starts-with second
  assert.equal(files[2], "pear.ts"); // shorter (7 chars) before banana/canary (9 chars)
});

test("GET /files/search with more than 10 results sets truncated=true and returns exactly 10", async () => {
  savedEnv = saveEnvVars(ENV_KEYS);
  Reflect.deleteProperty(process.env, "SYMPHONY_WORKTREE_PARENT_DIR");
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "bigRepo");
  await fs.mkdir(repoDir, { recursive: true });
  for (let i = 0; i < 15; i++) {
    await fs.writeFile(path.join(repoDir, `file${i}.ts`), "");
  }
  const dispatcher = makeSearchDispatcher([tmpDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/files/search",
    query: { repo: repoDir, base: "true" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal((res.body.files as string[]).length, 10);
  assert.equal(res.body.truncated, true);
});

// ─── filesystem-directories routes ───────────────────────────────────────────
// NOTE: TCC-protected folder filtering and home-dir handling are already covered
// by filesystem-directories-tcc.test.ts. These tests cover the remaining branches.

function makeDirectoriesDispatcher(allowedDirs: string[]): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerFilesystemDirectoriesRoutes(dispatcher, () => allowedDirs);
  return dispatcher;
}

test("GET /directories with no path param defaults to ~ and returns 200 with array", async () => {
  const homeDir = os.homedir();
  const dispatcher = makeDirectoriesDispatcher([homeDir]);
  // No query.path provided — exercises the `|| "~"` default branch (line 25)
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/directories",
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.directories));
});

test("GET /directories with path outside allowed dirs returns 403", async () => {
  const allowedDir = makeTempDir();
  const outsideDir = makeTempDir();
  const dispatcher = makeDirectoriesDispatcher([allowedDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/directories",
    query: { path: outsideDir },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

test("GET /directories with non-existent path returns 200 with empty directories list", async () => {
  const allowedDir = makeTempDir();
  const missingPath = path.join(allowedDir, "does-not-exist");
  const dispatcher = makeDirectoriesDispatcher([allowedDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/directories",
    query: { path: missingPath },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.directories, []);
});

test("GET /directories skips hidden entries and sorts git repos before plain dirs", async () => {
  const allowedDir = makeTempDir();
  await fs.mkdir(path.join(allowedDir, ".hidden"), { recursive: true });
  await fs.mkdir(path.join(allowedDir, "aardvark", ".git"), {
    recursive: true,
  });
  await fs.mkdir(path.join(allowedDir, "zebra"), { recursive: true });
  const dispatcher = makeDirectoriesDispatcher([allowedDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/directories",
    query: { path: allowedDir },
  });
  assert.equal(res.statusCode, 200);
  const dirs = res.body.directories as Array<{
    name: string;
    isGitRepo: boolean;
  }>;
  const names = dirs.map((d) => d.name);
  assert.ok(!names.includes(".hidden"), "hidden dir must not appear");
  const aIdx = names.indexOf("aardvark");
  const zIdx = names.indexOf("zebra");
  assert.ok(aIdx !== -1, "git repo dir present");
  assert.ok(aIdx < zIdx, "git repo sorted before plain dir");
  assert.equal(dirs.find((d) => d.name === "aardvark")?.isGitRepo, true);
  assert.equal(dirs.find((d) => d.name === "zebra")?.isGitRepo, false);
});

test("GET /directories sorts two plain dirs alphabetically by name", async () => {
  const allowedDir = makeTempDir();
  await fs.mkdir(path.join(allowedDir, "bravo"), { recursive: true });
  await fs.mkdir(path.join(allowedDir, "alpha"), { recursive: true });
  const dispatcher = makeDirectoriesDispatcher([allowedDir]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/directories",
    query: { path: allowedDir },
  });
  assert.equal(res.statusCode, 200);
  const names = (res.body.directories as Array<{ name: string }>).map(
    (d) => d.name
  );
  assert.ok(
    names.indexOf("alpha") < names.indexOf("bravo"),
    "alpha sorted before bravo"
  );
});

// ─── metadata-routes: symphony/status ────────────────────────────────────────

function makeMetaDispatcher(
  allowedDirs: string[],
  getSymphonyDir: () => string
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerMetadataRoutes(dispatcher, () => allowedDirs, getSymphonyDir);
  return dispatcher;
}

test("GET /symphony/status without workDir param returns 400", async () => {
  const tmpDir = makeTempDir();
  const dispatcher = makeMetaDispatcher([tmpDir], () => tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "workDir parameter is required");
});

test("GET /symphony/status with workDir outside allowed dirs returns 403", async () => {
  const allowedDir = makeTempDir();
  const outsideDir = makeTempDir();
  const dispatcher = makeMetaDispatcher([allowedDir], () => allowedDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status",
    query: { workDir: outsideDir },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

test("GET /symphony/status with no state.json returns 200 with isRunning=false and reason", async () => {
  const tmpDir = makeTempDir();
  const workDir = path.join(tmpDir, "ws");
  await fs.mkdir(workDir, { recursive: true });
  const dispatcher = makeMetaDispatcher([tmpDir], () => tmpDir);
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

test("GET /symphony/status with COMPLETED status returns 200 with isRunning=false", async () => {
  const tmpDir = makeTempDir();
  const workDir = path.join(tmpDir, "ws");
  const stateDir = path.join(workDir, ".closedloop-ai", "work");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "state.json"),
    JSON.stringify({ status: "COMPLETED", phase: "done", iteration: 3 }),
    "utf-8"
  );
  const dispatcher = makeMetaDispatcher([tmpDir], () => tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status",
    query: { workDir },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.isRunning, false);
  assert.equal(res.body.phase, "done");
  assert.equal(res.body.iteration, 3);
});

test("GET /symphony/status with corrupt state.json returns 500 with isRunning=false", async () => {
  const tmpDir = makeTempDir();
  const workDir = path.join(tmpDir, "ws");
  const stateDir = path.join(workDir, ".closedloop-ai", "work");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "state.json"), "{ bad json", "utf-8");
  const dispatcher = makeMetaDispatcher([tmpDir], () => tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/symphony/status",
    query: { workDir },
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.isRunning, false);
  assert.equal(typeof res.body.error, "string");
});

// ─── metadata-routes: work-directory ─────────────────────────────────────────
// Line 161 (!ticketId || typeof ticketId !== "string") is UNREACHABLE via
// normal dispatch: the route pattern "[^/]+" requires at least one character,
// so the dispatcher only routes when ticketId is a non-empty string.

test("GET /work-directory/:ticketId with no sessions and no repos returns exists=false", async () => {
  const tmpDir = makeTempDir();
  const dispatcher = makeMetaDispatcher([tmpDir], () => tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/work-directory/ISS-0001",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, false);
  assert.equal(res.body.path, null);
});

test("GET /work-directory/:ticketId finds worktree via sessions.json match", async () => {
  const tmpDir = makeTempDir();
  const worktreePath = path.join(tmpDir, "my-worktree");
  await fs.mkdir(worktreePath, { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "sessions.json"),
    JSON.stringify({
      sessions: [
        {
          ticketId: "ISS-9000",
          repoPath: path.join(tmpDir, "repo"),
          worktreePath,
        },
      ],
    }),
    "utf-8"
  );
  const dispatcher = makeMetaDispatcher([tmpDir], () => tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/work-directory/ISS-9000",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, true);
  assert.equal(res.body.source, "session");
  assert.equal(res.body.path, worktreePath);
});

test("GET /work-directory/:ticketId finds worktree via repos config loop", async () => {
  savedEnv = saveEnvVars(ENV_KEYS);
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "myrepo");
  await fs.mkdir(repoDir, { recursive: true });
  const worktreePath = path.join(tmpDir, "myrepo-ISS-9001");
  await fs.mkdir(worktreePath, { recursive: true });
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = tmpDir;
  const configDir = path.join(tmpDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await saveReposConfig(
    { repos: [{ path: repoDir, addedAt: "2025-01-01" }], settings: {} },
    configDir
  );
  const dispatcher = makeMetaDispatcher([tmpDir], () => tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/work-directory/ISS-9001",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, true);
  assert.equal(res.body.source, "worktree");
});
