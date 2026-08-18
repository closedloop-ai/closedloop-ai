import "server-only";

import type { BranchViewFileDiff } from "@repo/api/src/types/branch-view";
import { withDb } from "@repo/database";
import {
  type BoundedFileContentAtRefResult,
  getBoundedFileContentAtRef,
  getMergeBaseSha,
} from "@repo/github/file-content";
import type { Octokit } from "@repo/github/user-token-auth";
import type { GitHubAccessError } from "@/lib/github/github-access";
import { runBranchViewRead } from "@/lib/github/github-branch-view-read-client";
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
  | { data: BranchViewFileDiff; error: null; accessDenial?: undefined }
  | {
      data: null;
      error: string;
      /**
       * Present when GitHub refused the read. Carries the whole denial, not
       * just its reason: `retryAfterSeconds` rides on rate-limit denials and
       * the route turns it into a `Retry-After`, and the reason decides
       * whether the failure is an authorization one at all (see the route).
       */
      accessDenial?: GitHubAccessError;
    };

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
 *
 * GitHub reads run as the requesting user through the PLN-1525 resolver, with
 * no installation-credential fallback: a user who cannot reach the repository
 * on GitHub gets an `accessDenial` for the route to surface, not someone
 * else's view of the file. See `@/lib/github/github-branch-view-read-client`.
 */
export async function getFileDiff(
  ctx: PrContext,
  userId: string,
  path: string,
  previousPath: string | null
): Promise<GetFileDiffResult> {
  const { owner, repo } = ctx;
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

  const readDiffContents = async (octokit: Octokit) => {
    // Match GitHub's PR diff, which compares against the fork point rather
    // than the base branch's current tip.
    const mergeBaseSha = await getMergeBaseSha(
      octokit,
      owner,
      repo,
      baseBranch,
      headRef
    );
    const baseRef = mergeBaseSha ?? baseBranch;
    return await Promise.all([
      getBoundedFileContentAtRef(
        octokit,
        owner,
        repo,
        basePath,
        baseRef,
        MAX_FILE_CONTENT_BYTES
      ),
      getBoundedFileContentAtRef(
        octokit,
        owner,
        repo,
        path,
        headRef,
        MAX_FILE_CONTENT_BYTES
      ),
    ]);
  };

  // Client resolved once per request and threaded into every read above
  // (PLN-1525 pool-protection rule 1). The cached file is a changed file of
  // this branch, so BOTH sides missing is implausible and flagged as a likely
  // cloaked 404 — GitHub's answer when the user lost access to the repo.
  const contents = await runBranchViewRead(
    {
      organizationId: ctx.externalLink.organizationId,
      userId,
      target: { owner, repo },
    },
    readDiffContents,
    ([oldSide, newSide]) =>
      oldSide.status === "missing" && newSide.status === "missing"
  );
  if (!contents.ok) {
    return {
      data: null,
      error: "File diff unavailable",
      accessDenial: contents.error,
    };
  }
  const [oldContent, newContent] = contents.value;

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
