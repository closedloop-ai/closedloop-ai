import { type Mock, vi } from "vitest";
import type { SelectedPullRequestOctokit } from "../selected-pull-request-client";

export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);
export const NEXT_HEAD_SHA = "c".repeat(40);
export const MERGE_BASE_SHA = "d".repeat(40);
export const OWNER = "Acme";
export const REPO = "Widgets";
export const PULL_NUMBER = 42;

export const mockGet: Mock = vi.fn();
export const mockListFiles: Mock = vi.fn();
export const mockCompareCommitsWithBasehead: Mock = vi.fn();
export const octokit: SelectedPullRequestOctokit = {
  rest: {
    pulls: { get: mockGet, listFiles: mockListFiles },
    repos: { compareCommitsWithBasehead: mockCompareCommitsWithBasehead },
  },
};

export function resetEvidenceMocks() {
  mockGet.mockReset();
  mockListFiles.mockReset();
  mockCompareCommitsWithBasehead.mockReset();
  mockCompareCommitsWithBasehead.mockResolvedValue({
    data: { merge_base_commit: { sha: MERGE_BASE_SHA } },
  });
}

export function mockStableMetadata(changedFiles: number | null) {
  mockGet.mockResolvedValue({
    data: makeMetadata({ changed_files: changedFiles }),
  });
}

export function mockThirtyFullPages() {
  mockListFiles.mockImplementation(({ page }: { page: number }) =>
    Promise.resolve({ data: makeFiles(100, (page - 1) * 100) })
  );
}

export function makeMetadata(
  overrides: Partial<{
    id: number;
    number: number;
    html_url: string;
    changed_files: number | null;
    base: { sha: string | null };
    head: { sha: string | null };
  }> = {}
) {
  return {
    id: 123,
    number: PULL_NUMBER,
    html_url: "https://github.com/acme/widgets/pull/42",
    changed_files: 1,
    base: { sha: BASE_SHA },
    head: { sha: HEAD_SHA },
    ...overrides,
  };
}

export function makeFiles(count: number, offset: number) {
  return Array.from({ length: count }, (_, index) =>
    makeFile({ filename: `src/file-${offset + index + 1}.ts` })
  );
}

export function makeFile(
  overrides: Partial<{
    filename: string;
    previous_filename: string;
    status: string;
    additions: number | null;
    deletions: number | null;
    changes: number | null;
    patch: string | undefined;
  }> = {}
) {
  return {
    filename: "src/file.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1 +1 @@",
    ...overrides,
  };
}
