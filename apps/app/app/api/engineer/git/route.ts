import { spawn } from "node:child_process";
import { type NextRequest, NextResponse } from "next/server";
import simpleGit, { type SimpleGit, type StatusResult } from "simple-git";
import { isRepoAllowed } from "@/lib/engineer/repos";

/**
 * API route to perform git operations
 *
 * POST /api/git
 * Body: { action: "branch" | "commit" | "push" | "status", branchName?: string, message?: string }
 *
 * This route uses simple-git to execute git operations server-side.
 * Git operations cannot happen client-side in Next.js as they require Node.js child processes.
 */

export type GitActionRequest = {
  action:
    | "branch"
    | "commit"
    | "push"
    | "pull"
    | "status"
    | "branch-diff"
    | "sync-status";
  branchName?: string;
  message?: string;
  repoPath?: string;
  baseBranch?: string; // For branch-diff: compare against this branch (default: main)
};

export type GitStatusResponse = {
  currentBranch: string;
  hasChanges: boolean;
  files?: {
    modified: string[];
    created: string[];
    deleted: string[];
    staged: string[];
  };
};

export type GitBranchResponse = {
  success: boolean;
  branchName: string;
  message: string;
};

export type GitCommitResponse = {
  success: boolean;
  commit: string;
  message: string;
};

export type GitPushResponse = {
  success: boolean;
  pushed: boolean;
  message: string;
};

export type GitPullResponse = {
  success: boolean;
  message: string;
};

export type GitBranchDiffResponse = {
  baseBranch: string;
  currentBranch: string;
  files: {
    modified: string[];
    created: string[];
    deleted: string[];
  };
  totalChanges: number;
};

export type GitSyncStatusResponse = {
  isUpToDate: boolean;
  behindBy: number;
  aheadBy: number;
  currentBranch: string;
  trackingBranch: string | null;
};

/**
 * Create an error response with consistent formatting
 */
function errorResponse(
  message: string,
  err?: unknown,
  status = 500
): NextResponse {
  const errorMessage = err instanceof Error ? err.message : "Unknown error";
  const fullMessage = err ? `${message}: ${errorMessage}` : message;
  return NextResponse.json({ error: fullMessage }, { status });
}

/**
 * Expand ~ to home directory in paths
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", process.env.HOME || "");
  }
  return path;
}

async function handleBranch(
  git: SimpleGit,
  branchName?: string
): Promise<NextResponse> {
  if (!branchName) {
    return errorResponse(
      "branchName is required for branch action",
      undefined,
      400
    );
  }
  const sanitizedBranch = branchName.replaceAll(/[^a-zA-Z0-9-_/]/g, "-");
  const branches = await git.branch();
  if (branches.all.includes(sanitizedBranch)) {
    await git.checkout(sanitizedBranch);
  } else {
    await git.checkoutLocalBranch(sanitizedBranch);
  }
  return NextResponse.json({
    success: true,
    branchName: sanitizedBranch,
    message: `Switched to branch '${sanitizedBranch}'`,
  } satisfies GitBranchResponse);
}

async function handleCommit(
  git: SimpleGit,
  message?: string
): Promise<NextResponse> {
  if (!message) {
    return errorResponse(
      "message is required for commit action",
      undefined,
      400
    );
  }
  await git.add(".");

  try {
    const result = await git.commit(message);
    return NextResponse.json({
      success: true,
      commit: result.commit,
      message: `Committed changes: ${result.summary.changes} changes, ${result.summary.insertions} insertions, ${result.summary.deletions} deletions`,
    } satisfies GitCommitResponse);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Detect pre-commit hook failures and return a cleaner error
    if (errorMsg.includes("pre-commit") || errorMsg.includes("husky")) {
      throw new Error(
        `${classifyPreCommitError(errorMsg)}. Fix the issues in your editor and try again.`
      );
    }

    throw err;
  }
}

async function handlePush(git: SimpleGit, cwd: string): Promise<NextResponse> {
  const status: StatusResult = await git.status();
  if (!status.current) {
    return errorResponse("No current branch detected", undefined, 400);
  }

  try {
    await git.push("origin", status.current, ["--set-upstream"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const isDiverged =
      msg.includes("rejected") ||
      msg.includes("non-fast-forward") ||
      msg.includes("fetch first");

    if (!isDiverged) {
      throw err;
    }

    await rebaseAndRetryPush(git, cwd, status.current);
  }

  return NextResponse.json({
    success: true,
    pushed: true,
    message: `Pushed branch '${status.current}' to remote`,
  } satisfies GitPushResponse);
}

async function rebaseAndRetryPush(
  git: SimpleGit,
  cwd: string,
  branch: string
): Promise<void> {
  const dirtyStatus = await git.status();
  const hasDirtyFiles =
    dirtyStatus.modified.length > 0 ||
    dirtyStatus.not_added.length > 0 ||
    dirtyStatus.staged.length > 0;

  if (hasDirtyFiles) {
    await git.stash(["push", "-m", "auto-stash before rebase sync"]);
  }

  try {
    await git.pull("origin", branch, ["--rebase"]);
  } catch (error_) {
    await handleRebaseConflicts(git, cwd, hasDirtyFiles, error_);
  }

  if (hasDirtyFiles) {
    await git.stash(["pop"]);
  }

  await git.push("origin", branch, ["--set-upstream"]);
}

async function handleRebaseConflicts(
  git: SimpleGit,
  cwd: string,
  hasDirtyFiles: boolean,
  pullErr: unknown
): Promise<void> {
  const conflicted = await getConflictedFiles(git);

  if (conflicted.length === 0) {
    if (hasDirtyFiles) {
      await git.stash(["pop"]).catch(() => {});
    }
    throw pullErr;
  }

  console.log("[Git Push] Rebase conflicts detected in:", conflicted);
  const resolved = await resolveConflictsWithLLM(git, cwd, conflicted);

  if (resolved) {
    console.log("[Git Push] LLM resolved all conflicts, continuing rebase");
    await git.raw(["rebase", "--continue"]);
    return;
  }

  console.log("[Git Push] LLM could not resolve conflicts, aborting rebase");
  await git.raw(["rebase", "--abort"]);
  if (hasDirtyFiles) {
    await git.stash(["pop"]).catch(() => {});
  }
  throw new Error(
    `Rebase conflicts in ${conflicted.join(", ")} could not be auto-resolved. ` +
      "Please resolve manually and retry."
  );
}

async function handlePull(git: SimpleGit): Promise<NextResponse> {
  const status: StatusResult = await git.status();
  if (!status.current) {
    return errorResponse("No current branch detected", undefined, 400);
  }
  await git.pull("origin", status.current);
  return NextResponse.json({
    success: true,
    message: `Pulled latest changes for '${status.current}'`,
  } satisfies GitPullResponse);
}

async function handleStatus(git: SimpleGit): Promise<NextResponse> {
  const status: StatusResult = await git.status();
  const hasChanges =
    status.modified.length > 0 ||
    status.created.length > 0 ||
    status.deleted.length > 0 ||
    status.staged.length > 0 ||
    status.not_added.length > 0;
  return NextResponse.json({
    currentBranch: status.current || "unknown",
    hasChanges,
    files: {
      modified: status.modified,
      created: [...status.created, ...status.not_added],
      deleted: status.deleted,
      staged: status.staged,
    },
  } satisfies GitStatusResponse);
}

async function resolveBaseBranch(
  git: SimpleGit,
  preferred: string
): Promise<string> {
  const branches = await git.branch();
  const hasPreferred =
    branches.all.includes(preferred) ||
    branches.all.includes(`remotes/origin/${preferred}`);
  if (hasPreferred) {
    return preferred;
  }

  const hasMaster =
    branches.all.includes("master") ||
    branches.all.includes("remotes/origin/master");
  return hasMaster ? "master" : preferred;
}

function classifyDiffFile(file: {
  binary?: boolean;
  insertions?: number;
  deletions?: number;
}): "created" | "deleted" | "modified" {
  if (file.binary) {
    return "modified";
  }
  if ("insertions" in file && "deletions" in file) {
    if ((file.insertions ?? 0) > 0 && file.deletions === 0) {
      return "created";
    }
    if ((file.deletions ?? 0) > 0 && file.insertions === 0) {
      return "deleted";
    }
  }
  return "modified";
}

async function handleBranchDiff(
  git: SimpleGit,
  preferredBase?: string
): Promise<NextResponse> {
  const status: StatusResult = await git.status();
  const currentBranch = status.current || "unknown";
  const baseBranch = await resolveBaseBranch(git, preferredBase || "main");
  const diffSummary = await git.diffSummary([`origin/${baseBranch}...HEAD`]);

  const files: Record<"modified" | "created" | "deleted", string[]> = {
    modified: [],
    created: [],
    deleted: [],
  };

  for (const file of diffSummary.files) {
    const filePath =
      typeof file.file === "string"
        ? file.file
        : (file as { file: string }).file;
    files[classifyDiffFile(file)].push(filePath);
  }

  return NextResponse.json({
    baseBranch,
    currentBranch,
    files,
    totalChanges: diffSummary.files.length,
  } satisfies GitBranchDiffResponse);
}

async function resolveTrackingBranch(git: SimpleGit): Promise<string | null> {
  const branches = await git.branch(["-r"]);
  if (branches.all.includes("origin/main")) {
    return "origin/main";
  }
  if (branches.all.includes("origin/master")) {
    return "origin/master";
  }
  return null;
}

async function handleSyncStatus(git: SimpleGit): Promise<NextResponse> {
  await git.fetch("origin");
  const status: StatusResult = await git.status();
  const currentBranch = status.current || "unknown";
  const trackingBranch = await resolveTrackingBranch(git);

  if (!trackingBranch) {
    return NextResponse.json({
      isUpToDate: true,
      behindBy: 0,
      aheadBy: 0,
      currentBranch,
      trackingBranch: null,
    } satisfies GitSyncStatusResponse);
  }

  const behindResult = await git.raw([
    "rev-list",
    "--count",
    `HEAD..${trackingBranch}`,
  ]);
  const aheadResult = await git.raw([
    "rev-list",
    "--count",
    `${trackingBranch}..HEAD`,
  ]);
  const behindBy = Number.parseInt(behindResult.trim(), 10) || 0;
  const aheadBy = Number.parseInt(aheadResult.trim(), 10) || 0;

  return NextResponse.json({
    isUpToDate: behindBy === 0,
    behindBy,
    aheadBy,
    currentBranch,
    trackingBranch,
  } satisfies GitSyncStatusResponse);
}

const ACTION_HANDLERS: Record<
  GitActionRequest["action"],
  (git: SimpleGit, body: GitActionRequest, cwd: string) => Promise<NextResponse>
> = {
  branch: (git, body) => handleBranch(git, body.branchName),
  commit: (git, body) => handleCommit(git, body.message),
  push: (git, _body, cwd) => handlePush(git, cwd),
  pull: (git) => handlePull(git),
  status: (git) => handleStatus(git),
  "branch-diff": (git, body) => handleBranchDiff(git, body.baseBranch),
  "sync-status": (git) => handleSyncStatus(git),
};

export async function POST(request: NextRequest) {
  try {
    const body: GitActionRequest = await request.json();
    const { action, repoPath } = body;

    const handler = ACTION_HANDLERS[action];
    if (!handler) {
      return errorResponse(
        "Invalid action. Must be one of: branch, commit, push, status, branch-diff, sync-status",
        undefined,
        400
      );
    }

    const cwd = repoPath ? expandPath(repoPath) : process.cwd();

    if (repoPath && !isRepoAllowed(cwd)) {
      return NextResponse.json(
        { error: `Repository not allowed: ${cwd}` },
        { status: 403 }
      );
    }

    const git: SimpleGit = simpleGit(cwd);

    try {
      return await handler(git, body, cwd);
    } catch (err) {
      return errorResponse(`Failed to execute ${action}`, err);
    }
  } catch (err) {
    return errorResponse("Git operation failed", err);
  }
}

/**
 * Get the list of files with unresolved merge/rebase conflicts
 */
async function getConflictedFiles(git: SimpleGit): Promise<string[]> {
  try {
    const result = await git.diff(["--name-only", "--diff-filter=U"]);
    return result
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Invoke Claude CLI to resolve rebase conflict markers in the given files.
 * Returns true if all conflicts were resolved, false otherwise.
 */
function resolveConflictsWithLLM(
  git: SimpleGit,
  cwd: string,
  conflictedFiles: string[]
): Promise<boolean> {
  const fileList = conflictedFiles.join("\n");
  const prompt = `You are resolving git rebase conflicts. The following files have conflict markers:

${fileList}

For each file:
1. Read the file
2. Understand both sides of the conflict (<<<<<<< HEAD vs >>>>>>> incoming)
3. Resolve by keeping the correct combined intent of both changes
4. Write the resolved file (no conflict markers remaining)
5. Run: git add <file>

Do NOT run git rebase --continue. Just resolve the files and stage them.`;

  return new Promise((resolve) => {
    const claude = spawn(
      "claude",
      [
        "--model",
        "sonnet",
        "--allowedTools",
        "Read,Edit,Write,Bash",
        "--max-turns",
        "15",
        "-p",
        prompt,
      ],
      {
        cwd,
        env: {
          ...process.env,
          PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stderr = "";

    claude.stdout.on("data", () => {
      // Collect but don't need the output
    });

    claude.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    claude.on("close", async (code) => {
      console.log(
        "[Git Push] Claude conflict resolver exited with code:",
        code
      );
      if (stderr) {
        console.log("[Git Push] Claude stderr:", stderr.slice(0, 500));
      }

      if (code !== 0) {
        resolve(false);
        return;
      }

      // Verify no conflicts remain
      const remaining = await getConflictedFiles(git);
      resolve(remaining.length === 0);
    });

    claude.on("error", (err) => {
      console.error("[Git Push] Claude spawn error:", err);
      resolve(false);
    });

    // 3-minute timeout
    setTimeout(() => {
      claude.kill();
      console.log("[Git Push] Claude conflict resolver timed out");
      resolve(false);
    }, 180_000);
  });
}

function classifyPreCommitError(errorMsg: string): string {
  if (errorMsg.includes("lint")) {
    return "Lint check failed";
  }
  if (errorMsg.includes("test")) {
    return "Tests failed";
  }
  if (errorMsg.includes("typecheck") || errorMsg.includes("tsc")) {
    return "Type check failed";
  }
  if (errorMsg.includes("format") || errorMsg.includes("prettier")) {
    return "Format check failed";
  }
  return "Pre-commit hook failed";
}
