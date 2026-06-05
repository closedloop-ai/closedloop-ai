import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";

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

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Expand ~ to home directory
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", process.env.HOME || "");
  }
  return path;
}

/**
 * API route to get the diff for a specific file
 *
 * POST /api/engineer/git/diff
 * Body: { filePath: string, repoPath: string, baseBranch?: string }
 *
 * When baseBranch is provided, compares HEAD against origin/{baseBranch}
 * Otherwise, compares working tree against HEAD
 *
 * Returns: { oldContent: string, newContent: string, isNew: boolean, isDeleted: boolean, filePath: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { filePath, repoPath, baseBranch } = await request.json();

    if (!(filePath && repoPath)) {
      return NextResponse.json(
        { error: "filePath and repoPath are required" },
        { status: 400 }
      );
    }

    const expandedRepoPath = expandPath(repoPath);

    if (!existsSync(expandedRepoPath)) {
      return NextResponse.json(
        { error: "Repository path does not exist" },
        { status: 404 }
      );
    }

    // Branch mode: compare HEAD against base branch
    if (baseBranch) {
      return handleBranchDiff(expandedRepoPath, filePath, baseBranch);
    }

    // Working mode: compare working tree against HEAD
    return handleWorkingDiff(expandedRepoPath, filePath);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to get diff: ${errorMessage}` },
      { status: 500 }
    );
  }
}

/**
 * Handle diff for branch mode (committed changes vs base branch)
 */
function handleBranchDiff(
  repoPath: string,
  filePath: string,
  baseBranch: string
) {
  let oldContent = "";
  let newContent = "";
  let isNew = false;
  let isDeleted = false;
  const image = isImageFile(filePath);
  const mimeType = image
    ? MIME_TYPES[extname(filePath).toLowerCase()]
    : undefined;

  if (image) {
    // Read image content as base64
    try {
      const buf = execSync(`git show origin/${baseBranch}:"${filePath}"`, {
        cwd: repoPath,
      });
      oldContent = buf.toString("base64");
    } catch {
      isNew = true;
      oldContent = "";
    }

    try {
      const buf = execSync(`git show HEAD:"${filePath}"`, {
        cwd: repoPath,
      });
      newContent = buf.toString("base64");
    } catch {
      isDeleted = true;
      newContent = "";
    }
  } else {
    // Get content from base branch
    try {
      oldContent = execSync(`git show origin/${baseBranch}:"${filePath}"`, {
        cwd: repoPath,
        encoding: "utf-8",
      });
    } catch {
      // File doesn't exist in base branch - it's new
      isNew = true;
      oldContent = "";
    }

    // Get content from HEAD (current branch)
    try {
      newContent = execSync(`git show HEAD:"${filePath}"`, {
        cwd: repoPath,
        encoding: "utf-8",
      });
    } catch {
      // File doesn't exist in HEAD - it was deleted
      isDeleted = true;
      newContent = "";
    }
  }

  return NextResponse.json({
    filePath,
    oldContent,
    newContent,
    isNew,
    isDeleted,
    ...(image ? { isImage: true, mimeType } : {}),
  });
}

function readContentFromHead(
  repoPath: string,
  filePath: string,
  asBase64: boolean
): string {
  try {
    if (asBase64) {
      const buf = execSync(`git show HEAD:"${filePath}"`, { cwd: repoPath });
      return buf.toString("base64");
    }
    return execSync(`git show HEAD:"${filePath}"`, {
      cwd: repoPath,
      encoding: "utf-8",
    });
  } catch {
    return "";
  }
}

async function readWorkingFile(
  fullPath: string,
  asBase64: boolean
): Promise<string> {
  try {
    if (asBase64) {
      const buf = await readFile(fullPath);
      return buf.toString("base64");
    }
    return await readFile(fullPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Handle diff for working mode (uncommitted changes vs HEAD)
 */
async function handleWorkingDiff(repoPath: string, filePath: string) {
  let status: string;
  try {
    const gitStatus = execSync(`git status --porcelain "${filePath}"`, {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();

    if (!gitStatus) {
      return NextResponse.json(
        { error: "File has no changes" },
        { status: 400 }
      );
    }

    status = gitStatus.slice(0, 2).trim();
  } catch {
    return NextResponse.json(
      { error: "Failed to get file status" },
      { status: 500 }
    );
  }

  const isNew = status === "??" || status === "A";
  const isDeleted = status === "D";
  const fullFilePath = join(repoPath, filePath);
  const image = isImageFile(filePath);
  const mimeType = image
    ? MIME_TYPES[extname(filePath).toLowerCase()]
    : undefined;

  const oldContent = isNew
    ? ""
    : readContentFromHead(repoPath, filePath, image);
  const newContent = isDeleted
    ? ""
    : await readWorkingFile(fullFilePath, image);

  return NextResponse.json({
    filePath,
    oldContent,
    newContent,
    isNew,
    isDeleted,
    ...(image ? { isImage: true, mimeType } : {}),
  });
}
