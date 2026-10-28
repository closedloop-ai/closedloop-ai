import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import type { Octokit } from "@octokit/rest";
import {
  compareBranchFileChangesWithProviderResult,
  GITHUB_COMPARE_FILE_LIMIT,
  GitHubProviderResultStatus,
} from "../index";

// getBoundedFileContentAtRef / getMergeBaseSha tests moved to
// file-content.test.ts with the PLN-1525 step-3 extraction. The compare path
// is credential-agnostic since step 4: callers inject the Octokit, so the
// tests do too — no App env, no auth mocking.
//
// ISS-6127 replaced this suite's previous case, which drove 600 files through
// six mocked pages and asserted an internal 500-file cap. GitHub cannot produce
// that response — "the list of changed files is only shown on the first page of
// results, and it includes up to 300 changed files for the entire comparison" —
// so the old test pinned a scenario that does not exist, against a guard that
// could never fire. These cases pin the real contract instead.
const mockCompareCommitsWithBasehead = vi.fn();
const mockPaginate = vi.fn();

const octokit = {
  paginate: mockPaginate,
  rest: {
    repos: {
      compareCommitsWithBasehead: mockCompareCommitsWithBasehead,
    },
  },
} as unknown as Octokit;

function comparePage(fileCount: number) {
  return {
    data: {
      files: Array.from({ length: fileCount }, (_, index) => ({
        filename: `src/file-${index + 1}.ts`,
        previous_filename: undefined,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: `@@ file ${index + 1}`,
      })),
    },
  };
}

async function compare() {
  return await compareBranchFileChangesWithProviderResult(
    octokit,
    "acme",
    "repo",
    "main",
    "head-sha"
  );
}

describe("compareBranchFileChangesWithProviderResult", () => {
  beforeEach(() => {
    mockCompareCommitsWithBasehead.mockReset();
    mockPaginate.mockReset();
  });

  it("reports a full 300-file response as capped, because the provider cannot say otherwise", async () => {
    // The case the old internal 500 threshold made undetectable, and the one
    // this ticket exists for. GitHub returns no total and no truncation flag, so
    // "exactly 300 changed" and "more than 300, truncated" are the same bytes.
    // Reading that as complete is what silently understated every large branch.
    mockCompareCommitsWithBasehead.mockResolvedValue(
      comparePage(GITHUB_COMPARE_FILE_LIMIT)
    );

    const result = await compare();

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status !== GitHubProviderResultStatus.Success) {
      return;
    }
    expect(result.value.capped).toBe(true);
    expect(result.value.files).toHaveLength(GITHUB_COMPARE_FILE_LIMIT);
  });

  it("reports a short response as complete, so the conservative rule does not swallow ordinary branches", async () => {
    mockCompareCommitsWithBasehead.mockResolvedValue(
      comparePage(GITHUB_COMPARE_FILE_LIMIT - 1)
    );

    const result = await compare();

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status !== GitHubProviderResultStatus.Success) {
      return;
    }
    expect(result.value.capped).toBe(false);
    expect(result.value.files).toHaveLength(GITHUB_COMPARE_FILE_LIMIT - 1);
  });

  it("issues ONE request and never pages for files that cannot be there", async () => {
    // Changed files exist only on the first response, so a paginated walk spends
    // a round trip per page on an empty `files` array. Asserting `paginate` is
    // untouched is what keeps the walk from creeping back in.
    mockCompareCommitsWithBasehead.mockResolvedValue(comparePage(2));

    await compare();

    expect(mockCompareCommitsWithBasehead).toHaveBeenCalledTimes(1);
    expect(mockCompareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      basehead: "main...head-sha",
      per_page: 100,
    });
    expect(mockPaginate).not.toHaveBeenCalled();
  });

  // `main...head-sha` is a three-dot compare, so these files describe
  // mergeBase..head — and `main` is a moving ref. A caller persisting the range
  // the totals belong to needs the commit, not the ref it asked for (ISS-10009).
  it("surfaces the merge base the diff was actually computed from", async () => {
    mockCompareCommitsWithBasehead.mockResolvedValue({
      data: {
        ...comparePage(2).data,
        merge_base_commit: { sha: "abc1230000000000000000000000000000000000" },
      },
    });

    const result = await compare();

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status !== GitHubProviderResultStatus.Success) {
      return;
    }
    expect(result.value.mergeBaseSha).toBe(
      "abc1230000000000000000000000000000000000"
    );
  });

  it("omits the merge base when the provider withheld it", async () => {
    mockCompareCommitsWithBasehead.mockResolvedValue(comparePage(1));

    const result = await compare();

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status !== GitHubProviderResultStatus.Success) {
      return;
    }
    expect(result.value.mergeBaseSha).toBeUndefined();
  });

  it("carries rename and patch metadata through unchanged", async () => {
    mockCompareCommitsWithBasehead.mockResolvedValue({
      data: {
        files: [
          {
            filename: "src/renamed.ts",
            previous_filename: "src/original.ts",
            status: "renamed",
            additions: 3,
            deletions: 4,
            changes: 7,
            patch: "@@ renamed",
          },
        ],
      },
    });

    const result = await compare();

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status !== GitHubProviderResultStatus.Success) {
      return;
    }
    expect(result.value.files[0]).toEqual({
      filename: "src/renamed.ts",
      previousFilename: "src/original.ts",
      status: "renamed",
      additions: 3,
      deletions: 4,
      changes: 7,
      patch: "@@ renamed",
    });
  });

  it("treats a comparison with no files as complete and empty, never capped", async () => {
    mockCompareCommitsWithBasehead.mockResolvedValue({ data: {} });

    const result = await compare();

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status !== GitHubProviderResultStatus.Success) {
      return;
    }
    expect(result.value.files).toEqual([]);
    expect(result.value.capped).toBe(false);
  });
});
