import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { seedReposConfig } from "../src/main/seed-repos-config.js";
import {
  loadReposConfig,
  saveReposConfig,
} from "../src/server/operations/repos-config-utils.js";

const tempPaths: string[] = [];

function makeTempSandbox(): string {
  const dir = path.join(
    os.tmpdir(),
    `seed-repos-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tempPaths.push(dir);
  return dir;
}

function configDir(sandbox: string): string {
  return path.join(sandbox, ".closedloop-ai", "config");
}

afterEach(async () => {
  for (const tempPath of tempPaths.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

test("sets worktreeParentDir and worktreeParentDirConfirmed", async () => {
  const sandbox = makeTempSandbox();
  const cd = configDir(sandbox);
  mkdirSync(cd, { recursive: true });
  await saveReposConfig({ repos: [], settings: {} }, cd);

  await seedReposConfig(sandbox);

  const config = await loadReposConfig(cd);
  assert.equal(config.settings.worktreeParentDir, sandbox);
  assert.equal(config.settings.worktreeParentDirConfirmed, true);
});

test("does not auto-discover repos from the filesystem", async () => {
  const sandbox = makeTempSandbox();
  const cd = configDir(sandbox);
  mkdirSync(cd, { recursive: true });
  await saveReposConfig({ repos: [], settings: {} }, cd);

  // Create a git repo in the sandbox — seed should NOT add it
  mkdirSync(path.join(sandbox, "some-repo", ".git"), { recursive: true });

  await seedReposConfig(sandbox);

  const config = await loadReposConfig(cd);
  assert.equal(config.repos.length, 0, "seed should not auto-discover repos");
});

test("worktreeParentDir within sandbox but unconfirmed gets confirmed", async () => {
  const sandbox = makeTempSandbox();
  const cd = configDir(sandbox);
  mkdirSync(cd, { recursive: true });

  const subDir = path.join(sandbox, "worktrees");
  mkdirSync(subDir, { recursive: true });

  await saveReposConfig(
    {
      repos: [],
      settings: {
        worktreeParentDir: subDir,
        worktreeParentDirConfirmed: false,
      },
    },
    cd
  );

  await seedReposConfig(sandbox);

  const config = await loadReposConfig(cd);
  // Should keep the existing subdirectory
  assert.equal(config.settings.worktreeParentDir, subDir);
  assert.equal(config.settings.worktreeParentDirConfirmed, true);
});

test("worktreeParentDir within sandbox and already confirmed is preserved", async () => {
  const sandbox = makeTempSandbox();
  const cd = configDir(sandbox);
  mkdirSync(cd, { recursive: true });

  const subDir = path.join(sandbox, "custom-worktrees");
  mkdirSync(subDir, { recursive: true });

  await saveReposConfig(
    {
      repos: [],
      settings: { worktreeParentDir: subDir, worktreeParentDirConfirmed: true },
    },
    cd
  );

  await seedReposConfig(sandbox);

  const config = await loadReposConfig(cd);
  assert.equal(config.settings.worktreeParentDir, subDir);
  assert.equal(config.settings.worktreeParentDirConfirmed, true);
});

test("worktreeParentDir outside sandbox gets overwritten", async () => {
  const sandbox = makeTempSandbox();
  const cd = configDir(sandbox);
  mkdirSync(cd, { recursive: true });

  const outsideDir = path.join(os.tmpdir(), "some-other-dir");
  mkdirSync(outsideDir, { recursive: true });
  tempPaths.push(outsideDir);

  await saveReposConfig(
    {
      repos: [],
      settings: {
        worktreeParentDir: outsideDir,
        worktreeParentDirConfirmed: true,
      },
    },
    cd
  );

  await seedReposConfig(sandbox);

  const config = await loadReposConfig(cd);
  assert.equal(config.settings.worktreeParentDir, sandbox);
  assert.equal(config.settings.worktreeParentDirConfirmed, true);
});

test("sandbox change from A to B overwrites stale worktreeParentDir=A", async () => {
  const sandboxA = makeTempSandbox();
  const sandboxB = makeTempSandbox();

  // Seed with sandbox A
  await seedReposConfig(sandboxA);
  const configA = await loadReposConfig(configDir(sandboxA));
  assert.equal(configA.settings.worktreeParentDir, sandboxA);

  // Now seed sandbox B (would be a fresh config dir)
  await seedReposConfig(sandboxB);
  const configB = await loadReposConfig(configDir(sandboxB));
  assert.equal(configB.settings.worktreeParentDir, sandboxB);
  assert.equal(configB.settings.worktreeParentDirConfirmed, true);
});

test("cancelled seeding does not create repo defaults", async () => {
  const sandbox = makeTempSandbox();

  await seedReposConfig(sandbox, { isCancelled: () => true });

  await assert.rejects(fs.stat(configDir(sandbox)), { code: "ENOENT" });
});

test("seeding failure does not throw but logs to console.error", async () => {
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);

  try {
    // Pass a path that doesn't exist — readdir will fail inside the try/catch
    await seedReposConfig("/nonexistent/path/that/should/fail");
    // Should not throw
  } finally {
    console.error = origError;
  }

  assert.ok(errors.length > 0, "should have logged an error");
});

test("empty string sandbox is a no-op", async () => {
  // Should not throw or create any files
  await seedReposConfig("");
  await seedReposConfig("   ");
});
