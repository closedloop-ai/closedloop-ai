import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { hermeticGitEnv } from "../scripts/hermetic-git-env.mjs";
import { seedRepositories } from "../scripts/vibe-profile/seed-repositories";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { resolveRepoForCwd } from "../src/main/enrichment/repo-identity.js";

test("captures Acme Git identities and linked worktrees idempotently", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-repositories-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
  });
  try {
    const now = new Date("2026-10-13T10:00:00.000Z");
    const hookDir = path.join(dir, "global-hooks");
    const marker = path.join(dir, "hook-fired");
    await mkdir(hookDir);
    await writeFile(
      path.join(hookDir, "post-checkout"),
      `#!/bin/sh\nprintf fired > '${marker}'\n`,
      { mode: 0o755 }
    );
    const globalConfig = path.join(dir, "global-gitconfig");
    await writeFile(
      globalConfig,
      `[core]\n hooksPath = ${JSON.stringify(hookDir)}\n`
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    await seedRepositories(db, dir, now);
    await seedRepositories(db, dir, now);
    expect((await import("node:fs")).existsSync(marker)).toBe(false);
    expect(await db.prisma.client.repo.count()).toBe(2);
    expect(await db.prisma.client.repoWorktree.count()).toBe(2);
    for (const name of ["acme-web", "agent-toolkit"]) {
      const repo = await resolveRepoForCwd(
        db.prisma,
        path.join(dir, "worktrees", name)
      );
      expect(repo?.repo_full_name).toBe(`acme-co/${name}`);
      expect(repo?.default_branch).toBe("main");
      const worktree = await db.prisma.client.repoWorktree.findUniqueOrThrow({
        where: { worktreePath: path.join(dir, "worktrees", name) },
      });
      expect(worktree.branchName).toBe("feature/workspace");
    }
  } finally {
    vi.unstubAllEnvs();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("repairs interrupted setup and an existing unborn worktree without bypassing local hooks", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "vibe-repositories-repair-")
  );
  const root = path.join(dir, "repositories", "acme-web");
  const marker = path.join(dir, "local-hook-fired");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "--initial-branch=main"]);
  await writeFile(
    path.join(root, ".git", "hooks", "pre-commit"),
    `#!/bin/sh\nprintf fired > '${marker}'\n`,
    { mode: 0o755 }
  );
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
  });
  try {
    const now = new Date("2026-10-13T10:00:00.000Z");
    expect(await seedRepositories(db, dir, now)).toEqual({
      repositories: 2,
      worktrees: 2,
    });
    expect((await import("node:fs")).existsSync(marker)).toBe(true);
    await git(root, ["update-ref", "-d", "refs/heads/feature/workspace"]);
    await git(root, ["remote", "remove", "origin"]);
    expect(await seedRepositories(db, dir, now)).toEqual({
      repositories: 2,
      worktrees: 2,
    });
    const worktree = await db.prisma.client.repoWorktree.findUniqueOrThrow({
      where: { worktreePath: path.join(dir, "worktrees", "acme-web") },
    });
    expect(worktree.branchName).toBe("feature/workspace");
    const repo = await resolveRepoForCwd(db.prisma, worktree.worktreePath);
    expect(repo?.repo_full_name).toBe("acme-co/acme-web");
    expect(repo?.remote_url).toBe("https://github.com/acme-co/acme-web.git");
    expect(repo?.default_branch).toBe("main");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a fixture repository or worktree moved off its expected branch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-repositories-off-"));
  const root = path.join(dir, "repositories", "acme-web");
  const worktree = path.join(dir, "worktrees", "acme-web");
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
  });
  try {
    const now = new Date("2026-10-13T10:00:00.000Z");
    await seedRepositories(db, dir, now);

    await git(root, ["checkout", "-b", "elsewhere"]);
    await expect(seedRepositories(db, dir, now)).rejects.toThrow(
      "seeded repository acme-web must have its main branch checked out"
    );

    await git(root, ["checkout", "main"]);
    await git(worktree, ["checkout", "-b", "feature/other"]);
    await expect(seedRepositories(db, dir, now)).rejects.toThrow(
      "seeded worktree acme-web does not belong to its expected repository and branch"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const execFileAsync = promisify(execFile);

function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, env: hermeticGitEnv() });
}
