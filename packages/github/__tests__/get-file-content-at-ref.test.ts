import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockReposGetContent = vi.fn();
const mockGitGetBlob = vi.fn();

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => async (_opts: unknown) => ({
    token: "test-token",
  })),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
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

import { getFileContentAtRef } from "../index";

describe("getFileContentAtRef", () => {
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
  });

  it("decodes inline base64 content from the contents API", async () => {
    mockReposGetContent.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from("hello world", "utf-8").toString("base64"),
      },
    });

    const result = await getFileContentAtRef(
      "12345",
      "acme",
      "repo",
      "README.md",
      "head-sha"
    );

    expect(result).toBe("hello world");
    expect(mockGitGetBlob).not.toHaveBeenCalled();
  });

  it("falls back to the blob API when GitHub omits inline content", async () => {
    mockReposGetContent.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "none",
        content: "",
        sha: "blob-sha-1",
      },
    });
    mockGitGetBlob.mockResolvedValueOnce({
      data: {
        content: Buffer.from("large file body", "utf-8").toString("base64"),
        encoding: "base64",
      },
    });

    const result = await getFileContentAtRef(
      "12345",
      "acme",
      "repo",
      "pnpm-lock.yaml",
      "head-sha"
    );

    expect(result).toBe("large file body");
    expect(mockGitGetBlob).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      file_sha: "blob-sha-1",
    });
  });
});
