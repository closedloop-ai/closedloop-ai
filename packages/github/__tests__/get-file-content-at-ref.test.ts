import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockReposGetContent = vi.fn();
const mockGitGetBlob = vi.fn();
const mockCompareCommitsWithBasehead = vi.fn();
const mockPaginate = vi.fn();

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => async (_opts: unknown) => ({
    token: "test-token",
  })),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    paginate = mockPaginate;
    rest = {
      repos: {
        compareCommitsWithBasehead: mockCompareCommitsWithBasehead,
      },
    };
    repos = {
      getContent: mockReposGetContent,
    };

    git = {
      getBlob: mockGitGetBlob,
    };
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { compareBranchFileChanges, getBoundedFileContentAtRef } from "../index";

describe("getBoundedFileContentAtRef", () => {
  beforeAll(() => {
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-key";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "test-secret";
    process.env.GITHUB_APP_CLIENT_ID = "test-client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/dispatch";
    process.env.WEBAPP_ENV = "stage";
  });

  beforeEach(() => {
    mockReposGetContent.mockReset();
    mockGitGetBlob.mockReset();
    mockCompareCommitsWithBasehead.mockReset();
    mockPaginate.mockReset();
  });

  it("returns too_large before falling back to blob content for oversized files", async () => {
    mockReposGetContent.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "none",
        content: "",
        sha: "blob-sha-1",
        size: 1024 * 1024 + 1,
      },
    });

    const result = await getBoundedFileContentAtRef(
      "12345",
      "acme",
      "repo",
      "pnpm-lock.yaml",
      "head-sha",
      1024 * 1024
    );

    expect(result).toEqual({ status: "too_large" });
    expect(mockGitGetBlob).not.toHaveBeenCalled();
  });
});

describe("compareBranchFileChanges", () => {
  beforeEach(() => {
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

    const result = await compareBranchFileChanges(
      "12345",
      "acme",
      "repo",
      "main",
      "head-sha"
    );

    expect(result).toHaveLength(500);
    expect(result?.[100]?.filename).toBe("src/file-101.ts");
    expect(result?.[499]?.filename).toBe("src/file-500.ts");
    expect(result?.some((file) => file.filename === "src/file-501.ts")).toBe(
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
