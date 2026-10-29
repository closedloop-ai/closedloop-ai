import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  addRepo,
  loadReposConfig,
  normalizePath,
  removeRepo,
  saveReposConfig,
  updateSettings,
} from "../src/server/operations/repos-config-utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repos-cfg-"));
  tempDirs.push(dir);
  return dir;
}

test("normalizePath: home-relative paths use tilde prefix", () => {
  const home = os.homedir();
  const result = normalizePath(path.join(home, "Projects", "my-repo"));
  assert.equal(result, "~/Projects/my-repo");
});

test("normalizePath: non-home paths resolve to absolute", () => {
  const result = normalizePath("/tmp/test-repo");
  assert.equal(result, "/tmp/test-repo");
});

test("normalizePath: tilde input expands and re-normalizes", () => {
  const result = normalizePath("~/some-dir");
  assert.equal(result, "~/some-dir");
});

test("loadReposConfig: creates empty config when file does not exist", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const config = await loadReposConfig(configDir);
  assert.deepEqual(config.repos, []);
  assert.deepEqual(config.settings, {});
  const exists = await fs
    .stat(path.join(configDir, "repos.json"))
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, true);
});

test("loadReposConfig: reads existing config", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "repos.json"),
    JSON.stringify({
      repos: [{ path: "/tmp/repo", addedAt: "2026-01-01T00:00:00Z" }],
      settings: { worktreeParentDir: "/tmp/trees" },
    })
  );
  const config = await loadReposConfig(configDir);
  assert.equal(config.repos.length, 1);
  assert.equal(config.repos[0].path, "/tmp/repo");
  assert.equal(config.settings.worktreeParentDir, "/tmp/trees");
});

test("loadReposConfig: handles corrupt JSON by creating empty config", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "repos.json"), "not json{{{");
  const config = await loadReposConfig(configDir);
  assert.deepEqual(config.repos, []);
  assert.deepEqual(config.settings, {});
});

test("loadReposConfig: handles missing repos array gracefully", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "repos.json"),
    JSON.stringify({ settings: { worktreeParentDir: "/tmp" } })
  );
  const config = await loadReposConfig(configDir);
  assert.deepEqual(config.repos, []);
  assert.equal(config.settings.worktreeParentDir, "/tmp");
});

test("loadReposConfig: handles missing settings gracefully", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "repos.json"),
    JSON.stringify({ repos: [] })
  );
  const config = await loadReposConfig(configDir);
  assert.deepEqual(config.settings, {});
});

test("saveReposConfig: writes JSON with indentation", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  await saveReposConfig({ repos: [], settings: {} }, configDir);
  const content = await fs.readFile(
    path.join(configDir, "repos.json"),
    "utf-8"
  );
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed, { repos: [], settings: {} });
  assert.ok(content.includes("\n"));
});

test("addRepo: rejects non-existent path", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const result = await addRepo(
    path.join(dir, "nonexistent"),
    undefined,
    configDir
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "Path does not exist");
});

test("addRepo: rejects file path (not directory)", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const filePath = path.join(dir, "a-file.txt");
  await fs.writeFile(filePath, "content");
  const result = await addRepo(filePath, undefined, configDir);
  assert.equal(result.success, false);
  assert.equal(result.error, "Path must be a directory");
});

test("addRepo: rejects duplicate repository", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const repoDir = path.join(dir, "repo");
  await fs.mkdir(repoDir);
  const first = await addRepo(repoDir, "test", configDir);
  assert.equal(first.success, true);
  const second = await addRepo(repoDir, "test again", configDir);
  assert.equal(second.success, false);
  assert.equal(second.error, "Repository already configured");
});

test("addRepo: succeeds for valid directory", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const repoDir = path.join(dir, "repo");
  await fs.mkdir(repoDir);
  const result = await addRepo(repoDir, "my repo", configDir);
  assert.equal(result.success, true);
  assert.notEqual(result.repo, undefined);
  assert.ok(result.repo?.addedAt);
});

test("addRepo: detects framework from package.json", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const repoDir = path.join(dir, "repo");
  await fs.mkdir(repoDir);
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      dependencies: { next: "^14.0.0" },
      scripts: { dev: "next dev" },
    })
  );
  const result = await addRepo(repoDir, undefined, configDir);
  assert.equal(result.success, true);
  assert.equal(result.repo?.deployment?.framework, "next");
  assert.equal(result.repo?.deployment?.startCommand, "pnpm dev");
});

test("addRepo: detects vite framework", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const repoDir = path.join(dir, "repo");
  await fs.mkdir(repoDir);
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ devDependencies: { vite: "^5.0.0" } })
  );
  const result = await addRepo(repoDir, undefined, configDir);
  assert.equal(result.success, true);
  assert.equal(result.repo?.deployment?.framework, "vite");
});

test("addRepo: detects start command when no dev script", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const repoDir = path.join(dir, "repo");
  await fs.mkdir(repoDir);
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ scripts: { start: "node server.js" } })
  );
  const result = await addRepo(repoDir, undefined, configDir);
  assert.equal(result.success, true);
  assert.equal(result.repo?.deployment?.startCommand, "pnpm start");
});

test("addRepo: no deployment when no package.json", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const repoDir = path.join(dir, "repo");
  await fs.mkdir(repoDir);
  const result = await addRepo(repoDir, undefined, configDir);
  assert.equal(result.success, true);
  assert.equal(result.repo?.deployment, undefined);
});

test("removeRepo: removes existing repo", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const repoDir = path.join(dir, "repo");
  await fs.mkdir(repoDir);
  await addRepo(repoDir, undefined, configDir);
  const result = await removeRepo(repoDir, configDir);
  assert.equal(result.success, true);
  const config = await loadReposConfig(configDir);
  assert.equal(config.repos.length, 0);
});

test("removeRepo: returns error for non-configured repo", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  const result = await removeRepo("/tmp/nonexistent", configDir);
  assert.equal(result.success, false);
  assert.equal(result.error, "Repository not found");
});

test("updateSettings: merges new settings", async () => {
  const dir = await makeTempDir();
  const configDir = path.join(dir, "config");
  await loadReposConfig(configDir);
  await updateSettings({ worktreeParentDir: "/tmp/trees" }, configDir);
  const config = await loadReposConfig(configDir);
  assert.equal(config.settings.worktreeParentDir, "/tmp/trees");
});
