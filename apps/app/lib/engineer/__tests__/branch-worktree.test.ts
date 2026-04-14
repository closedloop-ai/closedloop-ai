import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockExpandHome = vi.fn((path: string) => path);
const mockGetConfiguredReposList = vi.fn();
const mockGetWorktreeParentDir = vi.fn();
vi.mock("@/lib/engineer/repos", () => ({
  expandHome: (path: string) => mockExpandHome(path),
  getConfiguredReposList: () => mockGetConfiguredReposList(),
  getWorktreeParentDir: () => mockGetWorktreeParentDir(),
}));

const mockFindExistingWorktreeForBranch = vi.fn();
const mockResolveWorktreeForPR = vi.fn();
vi.mock("@/lib/engineer/worktree", () => ({
  findExistingWorktreeForBranch: (...args: unknown[]) =>
    mockFindExistingWorktreeForBranch(...args),
  resolveWorktreeForPR: (...args: unknown[]) =>
    mockResolveWorktreeForPR(...args),
}));

import {
  parseGitHubRemoteFullName,
  resolveBranchWorktree,
} from "../branch-worktree";

function initRepo(repoPath: string, remoteUrl: string): void {
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, "README.md"), "# repo\n");

  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@example.com"', {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync('git config user.name "Test User"', {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync("git add .", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: repoPath, stdio: "pipe" });
  execSync(`git remote add origin "${remoteUrl}"`, {
    cwd: repoPath,
    stdio: "pipe",
  });
}

describe("branch-worktree", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "branch-worktree-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("parses GitHub SSH and HTTPS remotes", () => {
    expect(
      parseGitHubRemoteFullName(
        "git@github.com:closedloop/closedloop-electron.git"
      )
    ).toBe("closedloop/closedloop-electron");
    expect(
      parseGitHubRemoteFullName(
        "https://github.com/closedloop/closedloop-electron"
      )
    ).toBe("closedloop/closedloop-electron");
  });

  test("returns an existing checkout for the matching configured repo", () => {
    const otherRepoPath = join(testDir, "other-repo");
    const targetRepoPath = join(testDir, "closedloop-electron");
    initRepo(otherRepoPath, "git@github.com:closedloop/other-repo.git");
    initRepo(
      targetRepoPath,
      "git@github.com:closedloop/closedloop-electron.git"
    );

    mockGetConfiguredReposList.mockReturnValue([
      { path: otherRepoPath, name: "other-repo" },
      { path: targetRepoPath, name: "closedloop-electron" },
    ]);
    mockFindExistingWorktreeForBranch.mockReturnValue(
      "/tmp/closedloop-electron-pr-42"
    );

    expect(
      resolveBranchWorktree("closedloop/closedloop-electron", "feat/pr-42", 42)
    ).toEqual({
      path: "/tmp/closedloop-electron-pr-42",
      repoPath: targetRepoPath,
    });
    expect(mockResolveWorktreeForPR).not.toHaveBeenCalled();
  });

  test("creates a PR worktree when the repo matches but no checkout exists", () => {
    const targetRepoPath = join(testDir, "closedloop-electron");
    initRepo(
      targetRepoPath,
      "git@github.com:closedloop/closedloop-electron.git"
    );

    mockGetConfiguredReposList.mockReturnValue([
      { path: targetRepoPath, name: "closedloop-electron" },
    ]);
    mockFindExistingWorktreeForBranch.mockReturnValue(null);
    mockGetWorktreeParentDir.mockReturnValue("/tmp/worktrees");
    mockResolveWorktreeForPR.mockReturnValue(
      "/tmp/worktrees/closedloop-electron-pr-42"
    );

    expect(
      resolveBranchWorktree("closedloop/closedloop-electron", "feat/pr-42", 42)
    ).toEqual({
      path: "/tmp/worktrees/closedloop-electron-pr-42",
      repoPath: targetRepoPath,
    });
    expect(mockResolveWorktreeForPR).toHaveBeenCalledWith(
      targetRepoPath,
      "feat/pr-42",
      42,
      "/tmp/worktrees"
    );
  });

  test("returns null when no configured repo matches the GitHub repo", () => {
    const otherRepoPath = join(testDir, "other-repo");
    initRepo(otherRepoPath, "git@github.com:closedloop/other-repo.git");

    mockGetConfiguredReposList.mockReturnValue([
      { path: otherRepoPath, name: "other-repo" },
    ]);

    expect(
      resolveBranchWorktree("closedloop/closedloop-electron", "feat/pr-42", 42)
    ).toBeNull();
  });
});
