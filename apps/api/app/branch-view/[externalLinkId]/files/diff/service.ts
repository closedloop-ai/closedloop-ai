import "server-only";

import type { BranchViewFileDiff } from "@repo/api/src/types/branch-view";
import { withDb } from "@repo/database";
import {
  type BoundedFileContentAtRefResult,
  getBoundedFileContentAtRef,
  getMergeBaseSha,
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
const MAX_FILE_CONTENT_BYTES = 1024 * 1024;

function isBinaryPath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export type GetFileDiffResult =
  | { data: BranchViewFileDiff; error: null }
  | { data: null; error: string };

export async function findCachedBranchFileChange(
  ctx: PrContext,
  path: string,
  previousPath: string | null
): Promise<{
  path: string;
  previousPath: string | null;
  isBinary: boolean;
} | null> {
  if (!ctx.branch) {
    return null;
  }
  const branchArtifactId = ctx.branch.artifactId;

  return await withDb((db) =>
    db.branchFileChange.findFirst({
      where: {
        branchArtifactId,
        path,
        previousPath,
      },
      select: {
        path: true,
        previousPath: true,
        isBinary: true,
      },
    })
  );
}

/**
 * Fetch old (base) and new (head) content for a single file diff.
 * The "old" side is read at the merge-base of the base branch and head, which
 * is the fork point GitHub uses for PR "Files changed" diffs. Reading it at the
 * base branch tip instead would surface unrelated changes whenever the base has
 * advanced past the fork. Falls back to the base branch ref if the merge-base
 * cannot be resolved.
 */
export async function getFileDiff(
  ctx: PrContext,
  path: string,
  previousPath: string | null
): Promise<GetFileDiffResult> {
  const { installationId, owner, repo } = ctx;
  const cachedFile = await findCachedBranchFileChange(ctx, path, previousPath);
  if (!cachedFile) {
    return { data: null, error: "File is not part of this branch" };
  }

  const basePath = previousPath ?? path;
  if (cachedFile.isBinary || isBinaryPath(path) || isBinaryPath(basePath)) {
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

  const baseBranch =
    ctx.branch?.baseBranch ?? ctx.gitHubPullRequest?.baseBranch ?? null;
  const headRef = ctx.branch?.headSha ?? ctx.gitHubPullRequest?.headSha ?? null;
  if (!(baseBranch && headRef)) {
    return { data: null, error: "File diff refs unavailable" };
  }

  // Match GitHub's PR diff, which compares against the fork point rather than
  // the base branch's current tip.
  const mergeBaseSha = await getMergeBaseSha(
    installationId,
    owner,
    repo,
    baseBranch,
    headRef
  );
  const baseRef = mergeBaseSha ?? baseBranch;

  const [oldContent, newContent] = await Promise.all([
    getBoundedFileContentAtRef(
      installationId,
      owner,
      repo,
      basePath,
      baseRef,
      MAX_FILE_CONTENT_BYTES
    ),
    getBoundedFileContentAtRef(
      installationId,
      owner,
      repo,
      path,
      headRef,
      MAX_FILE_CONTENT_BYTES
    ),
  ]);

  if (oldContent.status === "too_large" || newContent.status === "too_large") {
    return { data: null, error: "File content exceeds 1 MiB limit" };
  }
  if (
    oldContent.status === "unsupported_encoding" ||
    newContent.status === "unsupported_encoding"
  ) {
    return { data: null, error: "File content is not text" };
  }

  return {
    data: {
      path,
      oldContent: contentOrEmpty(oldContent),
      newContent: contentOrEmpty(newContent),
      isNew: oldContent.status !== "found",
      isDeleted: newContent.status !== "found",
      isBinary: false,
    },
    error: null,
  };
}

function contentOrEmpty(result: BoundedFileContentAtRefResult): string {
  return result.status === "found" ? result.content : "";
}
