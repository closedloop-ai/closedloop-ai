"use client";

import { BranchViewFileDiffErrorCode } from "@repo/api/src/types/branch-view";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { z } from "zod";
import { ApiError } from "../../shared/api/api-error";

const branchViewFileDiffAccessDenialSchema = z.enum(GitHubAccessDenialReason);

/**
 * Extract the GitHub access-denial reason from a Branch View file-diff error.
 *
 * The file-diff route answers 403 + `github_access_denied` when the requesting
 * user's own GitHub credential cannot reach the repository (PLN-1525 removed
 * the installation-credential fallback that used to mask this). Returns null
 * for every other failure, including a plain 403 without the code, so an
 * unrelated authorization error still renders as a generic diff error.
 */
export function parseBranchViewFileDiffAccessDenial(
  error: unknown
): GitHubAccessDenialReason | null {
  if (
    !(
      error instanceof ApiError &&
      error.code === BranchViewFileDiffErrorCode.GithubAccessDenied
    )
  ) {
    return null;
  }
  const parsed = branchViewFileDiffAccessDenialSchema.safeParse(
    error.details?.accessDenial
  );
  return parsed.success ? parsed.data : null;
}
