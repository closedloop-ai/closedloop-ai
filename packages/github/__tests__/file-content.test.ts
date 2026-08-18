import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import type { Octokit } from "@octokit/rest";
import { SelectedPullRequestContentClassification } from "@repo/api/src/types/selected-pull-request-evidence";
import { log } from "@repo/observability/log";
import {
  getBoundedFileContentAtRef,
  getClassifiedBoundedFileContentAtRef,
  getMergeBaseSha,
} from "../file-content";

// The module is credential-agnostic: callers inject the Octokit, so the tests
// do too — no App env, no auth mocking.
const mockCompareCommitsWithBasehead = vi.fn();
const mockReposGetContent = vi.fn();
const mockGitGetBlob = vi.fn();

const octokit = {
  rest: {
    repos: { compareCommitsWithBasehead: mockCompareCommitsWithBasehead },
  },
  repos: { getContent: mockReposGetContent },
  git: { getBlob: mockGitGetBlob },
} as unknown as Octokit;

describe("getMergeBaseSha", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the merge-base SHA for base...head", async () => {
    mockCompareCommitsWithBasehead.mockResolvedValue({
      data: { merge_base_commit: { sha: "fork-point-sha" } },
    });

    const sha = await getMergeBaseSha(octokit, "acme", "repo", "main", "head");

    expect(sha).toBe("fork-point-sha");
    expect(mockCompareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      basehead: "main...head",
    });
  });

  it("returns null when the comparison fails instead of throwing", async () => {
    mockCompareCommitsWithBasehead.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const sha = await getMergeBaseSha(octokit, "acme", "repo", "main", "gone");

    expect(sha).toBeNull();
  });
});

describe("getBoundedFileContentAtRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns decoded base64 content for an in-bounds file", async () => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from("hello world", "utf-8").toString("base64"),
        sha: "blob-sha-1",
        size: 11,
      },
    });

    const result = await getBoundedFileContentAtRef(
      octokit,
      "acme",
      "repo",
      "src/index.ts",
      "head-sha",
      1024
    );

    expect(result).toEqual({ status: "found", content: "hello world" });
  });

  it("returns too_large before falling back to blob content for oversized files", async () => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "none",
        content: "",
        sha: "blob-sha-1",
        size: 1024 * 1024 + 1,
      },
    });

    const result = await getBoundedFileContentAtRef(
      octokit,
      "acme",
      "repo",
      "pnpm-lock.yaml",
      "head-sha",
      1024 * 1024
    );

    expect(result).toEqual({ status: "too_large" });
    expect(mockGitGetBlob).not.toHaveBeenCalled();
  });

  it("falls back to the blob API when content is deferred and bounds it too", async () => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "none",
        content: "",
        sha: "blob-sha-2",
        size: 20,
      },
    });
    mockGitGetBlob.mockResolvedValue({
      data: {
        content: Buffer.from("blob content", "utf-8").toString("base64"),
        encoding: "base64",
        size: 12,
      },
    });

    const result = await getBoundedFileContentAtRef(
      octokit,
      "acme",
      "repo",
      "src/big.ts",
      "head-sha",
      1024
    );

    expect(result).toEqual({ status: "found", content: "blob content" });
    expect(mockGitGetBlob).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      file_sha: "blob-sha-2",
    });
  });

  it("passes the caller signal through content and blob fallback requests", async () => {
    const controller = new AbortController();
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "none",
        content: "",
        sha: "blob-sha-3",
        size: 20,
      },
    });
    mockGitGetBlob.mockResolvedValue({
      data: {
        content: Buffer.from("blob content", "utf-8").toString("base64"),
        encoding: "base64",
        size: 12,
      },
    });

    await getBoundedFileContentAtRef(
      octokit,
      "acme",
      "repo",
      "src/big.ts",
      "head-sha",
      1024,
      controller.signal
    );

    expect(mockReposGetContent).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      path: "src/big.ts",
      ref: "head-sha",
      request: { signal: controller.signal },
    });
    expect(mockGitGetBlob).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      file_sha: "blob-sha-3",
      request: { signal: controller.signal },
    });
  });

  it("does not schedule blob fallback after caller cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new DOMException("Request canceled", "AbortError");
    mockReposGetContent.mockImplementationOnce(
      ({ request }: { request: { signal: AbortSignal } }) => {
        controller.abort(cancellation);
        return Promise.resolve({
          data: {
            type: "file",
            encoding: "none",
            content: "",
            sha: "blob-sha-4",
            size: 20,
          },
          request,
        });
      }
    );

    await expect(
      getBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "src/big.ts",
        "head-sha",
        1024,
        controller.signal
      )
    ).rejects.toBe(cancellation);

    expect(mockGitGetBlob).not.toHaveBeenCalled();
  });

  it("returns missing on a 404 and rethrows other errors", async () => {
    mockReposGetContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    await expect(
      getBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "src/deleted.ts",
        "head-sha",
        1024
      )
    ).resolves.toEqual({ status: "missing" });

    mockReposGetContent.mockRejectedValueOnce(
      Object.assign(new Error("Server error"), { status: 502 })
    );
    await expect(
      getBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "src/index.ts",
        "head-sha",
        1024
      )
    ).rejects.toThrow("Server error");
  });

  it("returns not_file for directories and unsupported_encoding for unknown encodings", async () => {
    mockReposGetContent.mockResolvedValueOnce({ data: [] });
    await expect(
      getBoundedFileContentAtRef(octokit, "acme", "repo", "src", "sha", 1024)
    ).resolves.toEqual({ status: "not_file" });

    mockReposGetContent.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "utf-16",
        content: "xx",
        sha: "s",
        size: 2,
      },
    });
    await expect(
      getBoundedFileContentAtRef(octokit, "acme", "repo", "a.ts", "sha", 1024)
    ).resolves.toEqual({ status: "unsupported_encoding" });
  });
});

describe("getClassifiedBoundedFileContentAtRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns missing on a 404 and rethrows other errors", async () => {
    mockReposGetContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "src/deleted.ts",
        "head-sha",
        1024
      )
    ).resolves.toEqual({ status: "missing" });

    mockReposGetContent.mockRejectedValueOnce(
      Object.assign(new Error("Server error"), { status: 502 })
    );
    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "src/index.ts",
        "head-sha",
        1024
      )
    ).rejects.toThrow("Server error");
  });

  it("returns unsupported_encoding for an unknown encoding", async () => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "utf-16",
        content: "xx",
        sha: "unsupported-sha",
        size: 2,
      },
    });

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "unsupported.txt",
        "sha",
        1024
      )
    ).resolves.toEqual({ status: "unsupported_encoding" });
  });

  it.each([
    "",
    "plain text",
    "snowman ☃",
    "literal � character",
  ])("classifies valid UTF-8 text without changing its content: %j", async (content) => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(content, "utf8").toString("base64"),
        sha: "text-sha",
        size: Buffer.byteLength(content, "utf8"),
      },
    });

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "text.txt",
        "sha",
        1024
      )
    ).resolves.toEqual({
      status: "found",
      classification: SelectedPullRequestContentClassification.Text,
      content,
    });
  });

  it("classifies NUL-bearing bytes as binary without decoding content", async () => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from([0x61, 0x00, 0x62]).toString("base64"),
        sha: "binary-sha",
        size: 3,
      },
    });

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "asset.bin",
        "sha",
        1024
      )
    ).resolves.toEqual({
      status: "found",
      classification: SelectedPullRequestContentClassification.Binary,
    });
  });

  it("classifies invalid non-NUL UTF-8 as unknown without replacement text", async () => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from([0xc3, 0x28]).toString("base64"),
        sha: "unknown-sha",
        size: 2,
      },
    });

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "ambiguous.dat",
        "sha",
        1024
      )
    ).resolves.toEqual({
      status: "found",
      classification: SelectedPullRequestContentClassification.Unknown,
    });
  });

  it.each([
    "c2VjcmV0$",
    "aGVsbG8=garbage",
  ])("classifies malformed base64 as unknown: %s", async (content) => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "base64",
        content,
        sha: "malformed-base64-sha",
        size: 8,
      },
    });

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "malformed.dat",
        "sha",
        1024
      )
    ).resolves.toEqual({
      status: "found",
      classification: SelectedPullRequestContentClassification.Unknown,
    });
    expect(log.error).toHaveBeenCalledWith("github_content_malformed_base64", {
      owner: "acme",
      repo: "repo",
      path: "malformed.dat",
      ref: "sha",
      encoding: "base64",
    });
  });

  it.each([
    {
      encoding: "base64",
      content: Buffer.from("content beyond cap").toString("base64"),
    },
    { encoding: "utf8", content: "content beyond cap" },
  ])("rejects underestimated $encoding content before returning bytes", async ({
    encoding,
    content,
  }) => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding,
        content,
        sha: "underestimated-sha",
        size: 1,
      },
    });

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "underestimated.dat",
        "sha",
        4
      )
    ).resolves.toEqual({ status: "too_large" });
  });

  it.each([
    "utf8",
    "utf-8",
  ])("classifies direct %s content with the same rules", async (encoding) => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding,
        content: "direct text",
        sha: "direct-sha",
        size: 11,
      },
    });

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "direct.txt",
        "sha",
        1024
      )
    ).resolves.toMatchObject({
      status: "found",
      classification: SelectedPullRequestContentClassification.Text,
      content: "direct text",
    });
  });

  it.each([
    "utf8",
    "utf-8",
  ])("classifies direct %s NUL-bearing content as binary", async (encoding) => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding,
        content: "direct\0content",
        sha: "direct-binary-sha",
        size: 14,
      },
    });

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "direct.dat",
        "sha",
        1024
      )
    ).resolves.toEqual({
      status: "found",
      classification: SelectedPullRequestContentClassification.Binary,
    });
  });

  it.each([
    "utf8",
    "utf-8",
  ])("classifies malformed direct %s text as unknown", async (encoding) => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding,
        content: "malformed \ud800 text",
        sha: "direct-unknown-sha",
        size: 18,
      },
    });

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "direct.txt",
        "sha",
        1024
      )
    ).resolves.toEqual({
      status: "found",
      classification: SelectedPullRequestContentClassification.Unknown,
    });
  });

  it("uses the same classifier for the Blob fallback", async () => {
    mockReposGetContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "none",
        content: "",
        sha: "blob-sha",
        size: 3,
      },
    });
    mockGitGetBlob.mockResolvedValue({
      data: {
        content: Buffer.from([0x61, 0x00, 0x62]).toString("base64"),
        encoding: "base64",
        size: 3,
      },
    });

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "asset.bin",
        "sha",
        1024
      )
    ).resolves.toEqual({
      status: "found",
      classification: SelectedPullRequestContentClassification.Binary,
    });
  });
});
