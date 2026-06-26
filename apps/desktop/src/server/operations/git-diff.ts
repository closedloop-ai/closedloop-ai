import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
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

  const line = status.stdout.trim();
  if (!line) {
    return { error: "File has no changes" };
  }

  const statusCode = line.slice(0, 2).trim();
  const isNew = statusCode === "??" || statusCode === "A";
  const isDeleted = statusCode === "D";
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

async function runGit(
  processManager: ProcessManager,
  repoPath: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await processManager.exec("git", args, repoPath);
}
