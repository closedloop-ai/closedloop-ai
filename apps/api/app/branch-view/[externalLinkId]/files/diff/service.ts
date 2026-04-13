import "server-only";

import type { BranchViewFileDiff } from "@repo/api/src/types/branch-view";
import {
  getFileContentAtRef,
  getSinglePullRequest,
  listPullRequestFiles,
} from "@repo/github";
import type { PrContext } from "@/lib/resolve-pr-context";

// Common binary extensions
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".wav",
]);

function isBinaryPath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export type GetFileDiffResult =
  | { data: BranchViewFileDiff; error: null }
  | { data: null; error: string };

export function isRequestedDiffInPullRequest(
  files: Array<{
    filename: string;
    previous_filename?: string;
  }>,
  path: string,
  previousPath: string | null
): boolean {
  return files.some(
    (file) =>
      file.filename === path &&
      (file.previous_filename ?? null) === previousPath
  );
}

/**
 * Fetch old (base) and new (head) content for a single file diff.
 * Uses immutable SHAs from the live GitHub PR (not mutable branch names).
 */
export async function getFileDiff(
  ctx: PrContext,
  path: string,
  previousPath: string | null
): Promise<GetFileDiffResult> {
  const { installationId, owner, repo, pullNumber } = ctx;

  // Resolve immutable SHAs from GitHub
  const [livePr, fileList] = await Promise.all([
    getSinglePullRequest(installationId, owner, repo, pullNumber),
    listPullRequestFiles(installationId, owner, repo, pullNumber),
  ]);

  if (!livePr) {
    return { data: null, error: "Pull request not found on GitHub" };
  }

  if (!fileList) {
    return { data: null, error: "Failed to load pull request files" };
  }

  if (!isRequestedDiffInPullRequest(fileList, path, previousPath)) {
    return { data: null, error: "File is not part of this pull request" };
  }

  const baseSha = livePr.baseSha;
  const headSha = livePr.headSha;

  // Check for binary files
  if (isBinaryPath(path)) {
    return {
      data: {
        path,
        oldContent: "",
        newContent: "",
        isNew: false,
        isDeleted: false,
        isBinary: true,
      },
      error: null,
    };
  }

  // Fetch old and new content in parallel
  // For renames, fetch old from previousPath
  const basePath = previousPath ?? path;
  const [oldContent, newContent] = await Promise.all([
    getFileContentAtRef(installationId, owner, repo, basePath, baseSha),
    getFileContentAtRef(installationId, owner, repo, path, headSha),
  ]);

  return {
    data: {
      path,
      oldContent: oldContent ?? "",
      newContent: newContent ?? "",
      isNew: oldContent === null,
      isDeleted: newContent === null,
      isBinary: false,
    },
    error: null,
  };
}
