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
  GitHubProviderResultStatus,
} from "../index";

// getBoundedFileContentAtRef / getMergeBaseSha tests moved to
// file-content.test.ts with the PLN-1525 step-3 extraction. The compare path
// is credential-agnostic since step 4: callers inject the Octokit, so the
// tests do too — no App env, no auth mocking.
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

describe("compareBranchFileChangesWithProviderResult", () => {
  beforeEach(() => {
    mockCompareCommitsWithBasehead.mockReset();
    mockPaginate.mockReset();
  });

  it("paginates compare files up to the 500-file cache boundary", async () => {
    mockPaginate.mockImplementation(
      (
        _endpoint: unknown,
        _params: unknown,
        mapFn: (
          response: {
            data: {
              files: Array<{
                filename: string;
                previous_filename: undefined;
                status: string;
                additions: number;
                deletions: number;
                changes: number;
                patch: string;
              }>;
            };
          },
          done: () => void
        ) => unknown
      ) => {
        for (let page = 0; page < 6; page += 1) {
          const pageFiles = Array.from({ length: 100 }, (_, index) => {
            const fileNumber = page * 100 + index + 1;
            return {
              filename: `src/file-${fileNumber}.ts`,
              previous_filename: undefined,
              status: "modified",
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: `@@ file ${fileNumber}`,
            };
          });
          mapFn({ data: { files: pageFiles } }, vi.fn());
        }
        return [];
      }
    );

    const result = await compareBranchFileChangesWithProviderResult(
      octokit,
      "acme",
      "repo",
      "main",
      "head-sha"
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    const files =
      result.status === GitHubProviderResultStatus.Success ? result.value : [];
    expect(files).toHaveLength(500);
    expect(files[100]?.filename).toBe("src/file-101.ts");
    expect(files[499]?.filename).toBe("src/file-500.ts");
    expect(files.some((file) => file.filename === "src/file-501.ts")).toBe(
      false
    );
    expect(mockPaginate).toHaveBeenCalledWith(
      mockCompareCommitsWithBasehead,
      {
        owner: "acme",
        repo: "repo",
        basehead: "main...head-sha",
        per_page: 100,
      },
      expect.any(Function)
    );
  });
});
