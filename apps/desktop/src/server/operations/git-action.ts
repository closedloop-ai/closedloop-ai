import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import type {
  OperationDispatcher,
  OperationRequestContext,
} from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { parseBody } from "./parse-body.js";
import { json, jsonError } from "./response-utils.js";
import { expandHome } from "./symphony-utils.js";

type GitAction =
  | "branch"
  | "commit"
  | "push"
  | "pull"
  | "status"
  | "branch-diff"
  | "sync-status";

const MAX_STDERR_EXCERPT_CHARS = 1200;

export function registerGitActionRoutes(
  dispatcher: OperationDispatcher,
  processManager: ProcessManager,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register("POST", "/api/gateway/git", async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }

    const action = body.action as GitAction | undefined;
    const repoPath = typeof body.repoPath === "string" ? body.repoPath : null;
    const branchName =
      typeof body.branchName === "string" ? body.branchName : undefined;
    const message = typeof body.message === "string" ? body.message : undefined;
    const baseBranch =
      typeof body.baseBranch === "string" ? body.baseBranch : "main";

    if (!repoPath) {
      json(context, 400, { error: "repoPath is required" });
      return;
    }

    const expandedRepoPath = expandHome(repoPath);
    try {
      assertPathAllowed(expandedRepoPath, getAllowedDirectories());
    } catch (error) {
      if (error instanceof DirectoryNotAllowedError) {
        jsonError(context, 403, {
          error: "directory not allowed",
          code: LoopErrorCode.RepoNotAllowed,
          details: { category: "repo_not_allowed" },
        });
        return;
      }
      throw error;
    }

    try {
      await fs.access(expandedRepoPath, fsConstants.F_OK);
      switch (action) {
        case "status":
          await handleStatus(context, processManager, expandedRepoPath);
          return;
        case "branch":
          await handleBranch(
            context,
            processManager,
            expandedRepoPath,
            branchName
          );
          return;
        case "commit":
          await handleCommit(
            context,
            processManager,
            expandedRepoPath,
            message
          );
          return;
        case "push":
          await handlePush(context, processManager, expandedRepoPath);
          return;
        case "pull":
          await handlePull(context, processManager, expandedRepoPath);
          return;
        case "branch-diff":
          await handleBranchDiff(
            context,
            processManager,
            expandedRepoPath,
            baseBranch
          );
          return;
        case "sync-status":
          await handleSyncStatus(context, processManager, expandedRepoPath);
          return;
        default:
          json(context, 400, { error: "Invalid action" });
          return;
      }
    } catch (error) {
      if (
        isNodeError(error) &&
        error.code === "ENOENT" &&
        error.path === expandedRepoPath
      ) {
        jsonError(context, 404, {
          error: "repository not found",
          code: LoopErrorCode.RepoNotFound,
          details: { category: "repo_not_found" },
        });
        return;
      }
      if (error instanceof GitActionError) {
        const classified = classifyGitActionError(error);
        jsonError(context, 500, classified);
        return;
      }
      const messageText =
        error instanceof Error ? error.message : "Unknown error";
      jsonError(context, 500, { error: messageText });
    }
  });
}

async function handleStatus(
  context: OperationRequestContext,
  processManager: ProcessManager,
  repoPath: string
): Promise<void> {
  const currentBranch = await gitRead(
    processManager,
    repoPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "status"
  );
  const statusOutput = await gitRead(
    processManager,
    repoPath,
    ["status", "--porcelain"],
    "status"
  );
  const lines = statusOutput.split("\n").filter(Boolean);

  const modified: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  const staged: string[] = [];

  for (const line of lines) {
    const statusCode = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (!file) {
      continue;
    }
    if (statusCode.includes("M")) {
      modified.push(file);
    }
    if (statusCode.includes("A") || statusCode === "??") {
      created.push(file);
    }
    if (statusCode.includes("D")) {
      deleted.push(file);
    }
    if (statusCode[0] && statusCode[0] !== "?" && statusCode[0] !== " ") {
      staged.push(file);
    }
  }

  json(context, 200, {
    currentBranch: currentBranch || "unknown",
    hasChanges: lines.length > 0,
    files: { modified, created, deleted, staged },
  });
}

async function handleBranch(
  context: OperationRequestContext,
  processManager: ProcessManager,
  repoPath: string,
  branchName?: string
): Promise<void> {
  if (!branchName) {
    json(context, 400, { error: "branchName is required for branch action" });
    return;
  }

  const sanitizedBranch = branchName.replaceAll(/[^a-zA-Z0-9-_/]/g, "-");
  const branchesOutput = await gitRead(
    processManager,
    repoPath,
    ["branch", "--list", sanitizedBranch],
    "branch"
  );

  if (branchesOutput.trim()) {
    await gitRun(
      processManager,
      repoPath,
      ["checkout", sanitizedBranch],
      "branch"
    );
  } else {
    await gitRun(
      processManager,
      repoPath,
      ["checkout", "-b", sanitizedBranch],
      "branch"
    );
  }

  json(context, 200, {
    success: true,
    branchName: sanitizedBranch,
    message: `Switched to branch '${sanitizedBranch}'`,
  });
}

async function handleCommit(
  context: OperationRequestContext,
  processManager: ProcessManager,
  repoPath: string,
  message?: string
): Promise<void> {
  if (!message) {
    json(context, 400, { error: "message is required for commit action" });
    return;
  }

  await gitRun(processManager, repoPath, ["add", "."], "commit");
  const commitOutput = await gitRead(
    processManager,
    repoPath,
    ["commit", "-m", message],
    "commit"
  );
  const commitHashMatch = /\[.+\s([0-9a-f]{7,40})\]/.exec(commitOutput);
  const commitHash = commitHashMatch?.[1] ?? "unknown";

  json(context, 200, {
    success: true,
    commit: commitHash,
    message: "Committed changes",
  });
}

async function handlePush(
  context: OperationRequestContext,
  processManager: ProcessManager,
  repoPath: string
): Promise<void> {
  const branch = await gitRead(
    processManager,
    repoPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "push"
  );
  await gitRun(
    processManager,
    repoPath,
    ["push", "origin", branch, "--set-upstream"],
    "push"
  );
  json(context, 200, {
    success: true,
    pushed: true,
    message: `Pushed branch '${branch}' to remote`,
  });
}

async function handlePull(
  context: OperationRequestContext,
  processManager: ProcessManager,
  repoPath: string
): Promise<void> {
  const branch = await gitRead(
    processManager,
    repoPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "pull"
  );
  await gitRun(processManager, repoPath, ["pull", "origin", branch], "pull");
  json(context, 200, {
    success: true,
    message: `Pulled latest changes for '${branch}'`,
  });
}

async function handleBranchDiff(
  context: OperationRequestContext,
  processManager: ProcessManager,
  repoPath: string,
  baseBranch: string
): Promise<void> {
  const currentBranch = await gitRead(
    processManager,
    repoPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "branch-diff"
  );
  const diffOutput = await gitRead(
    processManager,
    repoPath,
    ["diff", "--name-status", `origin/${baseBranch}...HEAD`],
    "branch-diff"
  );

  const files: { modified: string[]; created: string[]; deleted: string[] } = {
    modified: [],
    created: [],
    deleted: [],
  };
  for (const line of diffOutput.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [statusCode, file] = line.split(/\s+/, 2);
    if (!file) {
      continue;
    }
    if (statusCode.startsWith("A")) {
      files.created.push(file);
    } else if (statusCode.startsWith("D")) {
      files.deleted.push(file);
    } else {
      files.modified.push(file);
    }
  }

  json(context, 200, {
    baseBranch,
    currentBranch,
    files,
    totalChanges:
      files.modified.length + files.created.length + files.deleted.length,
  });
}

async function handleSyncStatus(
  context: OperationRequestContext,
  processManager: ProcessManager,
  repoPath: string
): Promise<void> {
  await gitRun(processManager, repoPath, ["fetch", "origin"], "sync-status");
  const currentBranch = await gitRead(
    processManager,
    repoPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "sync-status"
  );
  const trackingBranch = await resolveTrackingBranch(processManager, repoPath);

  if (!trackingBranch) {
    json(context, 200, {
      isUpToDate: true,
      behindBy: 0,
      aheadBy: 0,
      currentBranch,
      trackingBranch: null,
    });
    return;
  }

  const counts = await gitRead(
    processManager,
    repoPath,
    [
      "rev-list",
      "--left-right",
      "--count",
      `${currentBranch}...${trackingBranch}`,
    ],
    "sync-status"
  );
  const [aheadRaw, behindRaw] = counts.split(/\s+/, 2);
  const aheadBy = Number.parseInt(aheadRaw ?? "0", 10) || 0;
  const behindBy = Number.parseInt(behindRaw ?? "0", 10) || 0;

  json(context, 200, {
    isUpToDate: aheadBy === 0 && behindBy === 0,
    behindBy,
    aheadBy,
    currentBranch,
    trackingBranch,
  });
}

async function resolveTrackingBranch(
  processManager: ProcessManager,
  repoPath: string
): Promise<string | null> {
  const branches = await gitRead(
    processManager,
    repoPath,
    ["branch", "-r"],
    "sync-status"
  );
  if (branches.includes("origin/main")) {
    return "origin/main";
  }
  if (branches.includes("origin/master")) {
    return "origin/master";
  }
  return null;
}

async function gitRead(
  processManager: ProcessManager,
  repoPath: string,
  args: string[],
  action: GitAction
): Promise<string> {
  const result = await processManager.exec("git", args, repoPath);
  if (result.exitCode !== 0) {
    throw GitActionError.fromResult(action, args, result);
  }
  return result.stdout.trim();
}

async function gitRun(
  processManager: ProcessManager,
  repoPath: string,
  args: string[],
  action: GitAction
): Promise<void> {
  const result = await processManager.exec("git", args, repoPath);
  if (result.exitCode !== 0) {
    throw GitActionError.fromResult(action, args, result);
  }
}

class GitActionError extends Error {
  readonly action: GitAction;
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly errorCode?: string;
  readonly errorPath?: string;
  readonly errorSyscall?: string;
  readonly stderrExcerpt: string;

  private constructor(args: {
    action: GitAction;
    args: string[];
    stdout: string;
    stderr: string;
    exitCode: number;
    errorCode?: string;
    errorPath?: string;
    errorSyscall?: string;
  }) {
    super(args.stderr || `git ${args.args.join(" ")} failed`);
    this.name = "GitActionError";
    this.action = args.action;
    this.args = args.args;
    this.stdout = args.stdout;
    this.stderr = args.stderr;
    this.exitCode = args.exitCode;
    this.errorCode = args.errorCode;
    this.errorPath = args.errorPath;
    this.errorSyscall = args.errorSyscall;
    this.stderrExcerpt = truncate(
      args.stderr || args.stdout || this.message,
      MAX_STDERR_EXCERPT_CHARS
    );
  }

  static fromResult(
    action: GitAction,
    args: string[],
    result: Awaited<ReturnType<ProcessManager["exec"]>>
  ): GitActionError {
    return new GitActionError({
      action,
      args,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      errorCode: result.errorCode,
      errorPath: result.errorPath,
      errorSyscall: result.errorSyscall,
    });
  }
}

function classifyGitActionError(error: GitActionError) {
  if (isSpawnFailure(error)) {
    return {
      error: error.message,
      code: LoopErrorCode.SpawnFailed,
      details: {
        action: error.action,
        category: "spawn_failed",
        stderrExcerpt: error.stderrExcerpt,
      },
    };
  }

  if (isCommitHookFailure(error)) {
    const output = getGitActionOutput(error);
    return {
      error: "Pre-commit hook failed",
      code: LoopErrorCode.ProcessFailed,
      details: {
        action: "commit",
        category: "pre_commit_hook",
        hookType: classifyHookType(output),
        stderrExcerpt: error.stderrExcerpt,
      },
    };
  }

  if (error.action === "push" && isPushAuthFailure(error.stderr)) {
    return {
      error: "Git push authentication failed",
      code: LoopErrorCode.ProcessFailed,
      details: {
        action: "push",
        category: "git_push_auth",
        stderrExcerpt: error.stderrExcerpt,
      },
    };
  }

  return {
    error: error.message,
    code: LoopErrorCode.ProcessFailed,
    details: {
      action: error.action,
      category: "git_command_failed",
      exitCode: error.exitCode,
      stderrExcerpt: error.stderrExcerpt,
    },
  };
}

function isCommitHookFailure(error: GitActionError): boolean {
  if (error.action !== "commit" || error.args[0] !== "commit") {
    return false;
  }
  const output = getGitActionOutput(error);
  const normalizedOutput = output.toLowerCase();
  return (
    normalizedOutput.includes("pre-commit") ||
    normalizedOutput.includes("husky") ||
    normalizedOutput.includes("hook") ||
    classifyHookType(output) !== "unknown"
  );
}

function getGitActionOutput(error: GitActionError): string {
  return (
    [error.stderr, error.stdout].filter(Boolean).join("\n") ||
    error.stderrExcerpt
  );
}

function classifyHookType(
  output: string
): "lint" | "test" | "typecheck" | "format" | "unknown" {
  const normalizedOutput = output.toLowerCase();
  if (
    normalizedOutput.includes("eslint") ||
    normalizedOutput.includes("lint")
  ) {
    return "lint";
  }
  if (
    normalizedOutput.includes("typecheck") ||
    normalizedOutput.includes("tsc") ||
    normalizedOutput.includes("type error")
  ) {
    return "typecheck";
  }
  if (
    normalizedOutput.includes("prettier") ||
    normalizedOutput.includes("format")
  ) {
    return "format";
  }
  if (
    normalizedOutput.includes("vitest") ||
    normalizedOutput.includes("jest") ||
    normalizedOutput.includes("test failed")
  ) {
    return "test";
  }
  return "unknown";
}

function isPushAuthFailure(stderr: string): boolean {
  const output = stderr.toLowerCase();
  return (
    output.includes("authentication failed") ||
    output.includes("permission denied") ||
    output.includes("could not read username") ||
    output.includes("repository not found") ||
    output.includes("access denied") ||
    output.includes("403") ||
    output.includes("401")
  );
}

function isSpawnFailure(error: GitActionError): boolean {
  return (
    error.errorCode === "ENOENT" ||
    error.errorCode === "EACCES" ||
    error.errorSyscall?.startsWith("spawn") === true
  );
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}...[truncated]`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
