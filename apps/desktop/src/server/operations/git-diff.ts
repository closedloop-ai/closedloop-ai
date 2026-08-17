import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { GIT_GATEWAY_EXEC_TIMEOUT_MS } from "./git-gateway-constants.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import { getResolvedGitPath } from "./symphony-loop.js";
import { expandHome } from "./symphony-utils.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".bmp",
]);

const TRAILING_NEWLINE_REGEX = /\n$/;

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};

export function registerGitDiffRoutes(
  dispatcher: OperationDispatcher,
  processManager: ProcessManager,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register("POST", "/api/gateway/git/diff", async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }

    const filePath = typeof body.filePath === "string" ? body.filePath : null;
    const repoPath = typeof body.repoPath === "string" ? body.repoPath : null;
    const baseBranch =
      typeof body.baseBranch === "string" ? body.baseBranch : undefined;

    if (!(filePath && repoPath)) {
      json(context, 400, { error: "filePath and repoPath are required" });
      return;
    }

    const expandedRepoPath = expandHome(repoPath);
    try {
      assertPathAllowed(expandedRepoPath, getAllowedDirectories());
    } catch (error) {
      if (error instanceof DirectoryNotAllowedError) {
        json(context, 403, { error: "directory not allowed" });
        return;
      }
      throw error;
    }

    if (!existsSync(expandedRepoPath)) {
      json(context, 404, { error: "Repository path does not exist" });
      return;
    }

    const fullFilePath = path.join(expandedRepoPath, filePath);
    if (existsSync(fullFilePath)) {
      try {
        assertPathAllowed(fullFilePath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }
      // The allow-list check above compares the joined path against the sandbox
      // roots, but `fs.readFile` follows symlinks: a symlink inside this repo
      // pointing at a file in a sibling repo under the same sandbox would pass
      // the check and be read anyway. Require the canonical target to stay
      // inside the canonical repo root so a symlink cannot escape it.
      const containedInRepo = await isCanonicalPathInsideRoot(
        fullFilePath,
        expandedRepoPath
      );
      if (!containedInRepo) {
        json(context, 403, { error: "directory not allowed" });
        return;
      }
    }

    try {
      if (baseBranch) {
        const branchDiff = await handleBranchDiff(
          processManager,
          expandedRepoPath,
          filePath,
          baseBranch
        );
        json(context, 200, branchDiff);
        return;
      }

      const workingDiff = await handleWorkingDiff(
        processManager,
        expandedRepoPath,
        filePath
      );
      if ("error" in workingDiff) {
        json(context, 400, workingDiff);
        return;
      }
      json(context, 200, workingDiff);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: `Failed to get diff: ${message}` });
    }
  });
}

async function handleBranchDiff(
  processManager: ProcessManager,
  repoPath: string,
  filePath: string,
  baseBranch: string
): Promise<Record<string, unknown>> {
  const image = isImageFile(filePath);
  const mimeType = image
    ? MIME_TYPES[path.extname(filePath).toLowerCase()]
    : undefined;

  const oldResult = await runGit(processManager, repoPath, [
    "show",
    `origin/${baseBranch}:${filePath}`,
  ]);
  const newResult = await runGit(processManager, repoPath, [
    "show",
    `HEAD:${filePath}`,
  ]);

  // Only a confirmed "path is not present in this revision" failure means the
  // file is new/deleted. A bad base ref, spawn failure, or other operational
  // error must surface as an error, not be silently reported as isNew/isDeleted
  // with empty content.
  assertGitShowFailureIsMissingPath(oldResult, `origin/${baseBranch}`);
  assertGitShowFailureIsMissingPath(newResult, "HEAD");

  const oldContent = oldResult.exitCode === 0 ? oldResult.stdout : "";
  const newContent = newResult.exitCode === 0 ? newResult.stdout : "";

  return {
    filePath,
    oldContent,
    newContent,
    isNew: oldResult.exitCode !== 0,
    isDeleted: newResult.exitCode !== 0,
    ...(image ? { isImage: true, mimeType } : {}),
  };
}

const MISSING_PATH_SIGNATURES = [
  "does not exist in",
  "exists on disk, but not in",
  "path does not exist",
  "no such path",
];

/**
 * `git show <ref>:<path>` exits non-zero both when the path is legitimately
 * absent from the revision (a new/deleted file) and when the operation itself
 * failed (bad/unknown base ref, spawn failure, corrupt repo). Only the former
 * may be classified as new/deleted; anything else is thrown so the route
 * returns an error instead of a misleading 200.
 */
function assertGitShowFailureIsMissingPath(
  result: { stderr: string; exitCode: number },
  revision: string
): void {
  if (result.exitCode === 0) {
    return;
  }
  const stderr = result.stderr.toLowerCase();
  const isMissingPath = MISSING_PATH_SIGNATURES.some((signature) =>
    stderr.includes(signature)
  );
  if (!isMissingPath) {
    throw new Error(
      `git show failed for ${revision}: ${result.stderr.trim() || "unknown error"}`
    );
  }
}

async function handleWorkingDiff(
  processManager: ProcessManager,
  repoPath: string,
  filePath: string
): Promise<Record<string, unknown>> {
  const status = await runGit(processManager, repoPath, [
    "status",
    "--porcelain",
    "--",
    filePath,
  ]);
  if (status.exitCode !== 0) {
    throw new Error(status.stderr || "Failed to get file status");
  }

  // Do not trim the whole line first: the leading index column is
  // column-significant. `status --porcelain -- <file>` emits `XY <path>`.
  const rawLine = status.stdout.replace(TRAILING_NEWLINE_REGEX, "");
  if (!rawLine.trim()) {
    return { error: "File has no changes" };
  }

  // Parse the two status columns separately rather than collapsing them, so
  // `AM` (added then modified) and `MD` (modified then deleted in the worktree)
  // classify correctly. The two-char code is exactly `rawLine[0..2)`; a
  // single-column untracked marker `??` is handled below.
  const twoChar = rawLine.length >= 2 ? rawLine.slice(0, 2) : rawLine;
  const indexStatus = twoChar[0] ?? "";
  const worktreeStatus = twoChar[1] ?? "";
  const isNew =
    twoChar === "??" || indexStatus === "A" || worktreeStatus === "A";
  const isDeleted = indexStatus === "D" || worktreeStatus === "D";
  const image = isImageFile(filePath);
  const mimeType = image
    ? MIME_TYPES[path.extname(filePath).toLowerCase()]
    : undefined;

  const oldResult = isNew
    ? { stdout: "", exitCode: 0 }
    : await runGit(processManager, repoPath, ["show", `HEAD:${filePath}`]);

  let newContent = "";
  if (!isDeleted) {
    const fullFilePath = path.join(repoPath, filePath);
    try {
      newContent = await fs.readFile(fullFilePath, "utf-8");
    } catch {
      newContent = "";
    }
  }

  return {
    filePath,
    oldContent: oldResult.exitCode === 0 ? oldResult.stdout : "",
    newContent,
    isNew,
    isDeleted,
    ...(image ? { isImage: true, mimeType } : {}),
  };
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Whether the canonical (symlink-resolved) form of `targetPath` is inside the
 * canonical form of `rootPath`. Used to reject a symlinked file that resolves
 * outside the repository root even though its lexical path sits under an allowed
 * sandbox directory.
 */
async function isCanonicalPathInsideRoot(
  targetPath: string,
  rootPath: string
): Promise<boolean> {
  const canonicalRoot = await canonicalizePath(rootPath);
  const canonicalTarget = await canonicalizePath(targetPath);
  if (canonicalTarget === canonicalRoot) {
    return true;
  }
  const relative = path.relative(canonicalRoot, canonicalTarget);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

async function canonicalizePath(rawPath: string): Promise<string> {
  try {
    return await fs.realpath(rawPath);
  } catch {
    return path.resolve(rawPath);
  }
}

async function runGit(
  processManager: ProcessManager,
  repoPath: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await processManager.exec(getResolvedGitPath(), args, repoPath, {
    timeoutMs: GIT_GATEWAY_EXEC_TIMEOUT_MS,
  });
}
