import "server-only";

import type { Octokit } from "@octokit/rest";
import { toGitHubProviderFailure } from "./provider-error-classification";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
} from "./provider-result";

export type GitHubChangedFile = {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

/**
 * ISS-6127: GitHub's own ceiling on a compare, not ours.
 *
 * "The list of changed files is only shown on the first page of results, and it
 * includes up to 300 changed files for the entire comparison."
 * https://docs.github.com/en/rest/commits/commits#compare-two-commits
 *
 * Two consequences the previous implementation got wrong in both directions. It
 * capped at an internal 500, which the provider can never reach — so the guard
 * was unreachable and no truncation was ever detected. And it paginated looking
 * for files that, by the sentence above, cannot appear after the first response.
 */
export const GITHUB_COMPARE_FILE_LIMIT = 300;

/**
 * A compare read plus whether the provider may have withheld files from it.
 *
 * `capped` is deliberately conservative: at exactly
 * {@link GITHUB_COMPARE_FILE_LIMIT} files the response is indistinguishable
 * from a comparison that genuinely changed that many, because GitHub reports no
 * total and no truncation flag. Treating that as complete is the defect
 * ISS-6127 exists to close, so the tie resolves to `capped`.
 */
export type GitHubComparedFiles = {
  files: GitHubChangedFile[];
  capped: boolean;
  /**
   * The immutable commit the returned diff was actually computed from.
   *
   * `base...head` is a THREE-dot compare, so `files` describes
   * `mergeBase..head`, not `base..head` — and `base` may have been a moving ref
   * that has since advanced. A caller persisting the range these totals belong
   * to must store this, never the ref it asked for (ISS-10009). Absent when the
   * provider withheld the field.
   */
  mergeBaseSha?: string;
};

type CompareCommitFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

/**
 * Compare two refs and return file-change metadata plus an explicit
 * completeness signal. Raw file contents are intentionally not fetched here;
 * callers decide how to truncate or omit patch snippets before persisting
 * metadata.
 *
 * ISS-6127: ONE request, never a paginated walk. Changed files live only on the
 * first response, so paging the comparison spends round trips on `files` arrays
 * that are empty by contract — and on a large branch that is every page after
 * the first.
 */
export async function compareBranchFileChangesWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<GitHubProviderResult<GitHubComparedFiles>> {
  try {
    const response = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
      per_page: 100,
    });
    const responseData = response.data as {
      files?: CompareCommitFile[];
      merge_base_commit?: { sha?: string };
    };
    const files: GitHubChangedFile[] = [];
    for (const file of responseData.files ?? []) {
      const changedFile: GitHubChangedFile = {
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      };
      if (file.previous_filename) {
        changedFile.previousFilename = file.previous_filename;
      }
      if (file.patch) {
        changedFile.patch = file.patch;
      }
      files.push(changedFile);
    }

    const mergeBaseSha = responseData.merge_base_commit?.sha;
    return {
      status: GitHubProviderResultStatus.Success,
      value: {
        files,
        capped: files.length >= GITHUB_COMPARE_FILE_LIMIT,
        ...(mergeBaseSha ? { mergeBaseSha } : {}),
      },
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
}
