import { existsSync } from "node:fs";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { json } from "./response-utils.js";
import { expandHome } from "./symphony-utils.js";

type WorktreeInfo = {
  path: string;
  branch: string;
  ticketId: string | null;
};

type BranchInfo = {
  name: string;
  isRemote: boolean;
  lastCommitDate?: string;
};

const TICKET_PATH_REGEX = /[A-Z]+-\d+$/;
const TICKET_BRANCH_REGEX = /([A-Z]+-\d+)/;

export function registerGitBranchesRoutes(
  dispatcher: OperationDispatcher,
  processManager: ProcessManager,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register("GET", "/api/gateway/git/branches", async (context) => {
    const repoPath = context.query.get("repo");
    if (!repoPath) {
      json(context, 400, { error: "repo parameter is required" });
      return;
    }

    const expandedPath = expandHome(repoPath);
    try {
      assertPathAllowed(expandedPath, getAllowedDirectories());
    } catch (error) {
      if (error instanceof DirectoryNotAllowedError) {
        json(context, 403, { error: "directory not allowed" });
        return;
      }
      throw error;
    }

    if (!existsSync(expandedPath)) {
      json(context, 404, { error: `Repository not found: ${expandedPath}` });
      return;
    }

    try {
      const defaultBranch = await getDefaultBranch(
        processManager,
        expandedPath
      );
      const worktrees = await parseWorktrees(processManager, expandedPath);
      const branches = await getAllBranches(
        processManager,
        expandedPath,
        defaultBranch
      );

      json(context, 200, {
        defaultBranch,
        worktrees,
        branches,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: message });
    }
  });
}

async function getDefaultBranch(
  processManager: ProcessManager,
  repoPath: string
): Promise<string> {
  const symbolic = await runGit(processManager, repoPath, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
  ]);
  if (symbolic.exitCode === 0 && symbolic.stdout.trim()) {
    return symbolic.stdout.trim().replace("refs/remotes/origin/", "");
  }

  const current = await runGit(processManager, repoPath, [
    "branch",
    "--show-current",
  ]);
  return current.stdout.trim() || "main";
}

async function parseWorktrees(
  processManager: ProcessManager,
  repoPath: string
): Promise<WorktreeInfo[]> {
  const output = await runGit(processManager, repoPath, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (output.exitCode !== 0) {
    return [];
  }

  const worktrees: WorktreeInfo[] = [];
  const blocks = output.stdout.split("\n\n").filter((block) => block.trim());
  for (const block of blocks) {
    const lines = block.split("\n");
    let worktreePath = "";
    let branch = "";
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice(9);
      } else if (line.startsWith("branch ")) {
        branch = line.slice(7).replace("refs/heads/", "");
      }
    }

    if (!worktreePath || worktreePath === repoPath) {
      continue;
    }

    worktrees.push({
      path: worktreePath,
      branch,
      ticketId:
        extractTicketId(path.basename(worktreePath)) ??
        extractTicketId(branch) ??
        null,
    });
  }

  return worktrees;
}

async function getAllBranches(
  processManager: ProcessManager,
  repoPath: string,
  defaultBranch: string
): Promise<BranchInfo[]> {
  const output = await runGit(processManager, repoPath, [
    "branch",
    "-a",
    "--format=%(refname:short)|%(committerdate:iso-strict)",
  ]);
  if (output.exitCode !== 0) {
    return [];
  }

  const branches: BranchInfo[] = [];
  const seen = new Set<string>();

  for (const line of output.stdout
    .split("\n")
    .filter((entry) => entry.trim())) {
    const [refname, dateStr] = line.split("|");
    if (!refname || refname.includes("HEAD")) {
      continue;
    }

    const isRemote = refname.startsWith("origin/");
    const name = isRemote ? refname.slice(7) : refname;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    branches.push({
      name,
      isRemote,
      lastCommitDate: dateStr || undefined,
    });
  }

  branches.sort((a, b) => {
    if (a.name === defaultBranch) {
      return -1;
    }
    if (b.name === defaultBranch) {
      return 1;
    }
    const dateA = a.lastCommitDate ? new Date(a.lastCommitDate).getTime() : 0;
    const dateB = b.lastCommitDate ? new Date(b.lastCommitDate).getTime() : 0;
    return dateB - dateA;
  });

  return branches;
}

function extractTicketId(input: string): string | null {
  const pathMatch = TICKET_PATH_REGEX.exec(input);
  if (pathMatch) {
    return pathMatch[0];
  }
  const branchMatch = TICKET_BRANCH_REGEX.exec(input);
  if (branchMatch) {
    return branchMatch[1];
  }
  return null;
}

async function runGit(
  processManager: ProcessManager,
  repoPath: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await processManager.exec("git", args, repoPath);
}
