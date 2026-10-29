import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { log } from "@repo/observability/log";
import { getBoundedFileContentAtRef, getMergeBaseSha } from "../file-content";
import {
  fileEntryResponse,
  mockCompareCommitsWithBasehead,
  mockGitGetBlob,
  mockReposGetContent,
  octokit,
} from "./file-content-fixtures";

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

  it("returns null when the comparison carries no merge-base commit", async () => {
    mockCompareCommitsWithBasehead.mockResolvedValue({ data: {} });

    const sha = await getMergeBaseSha(
      octokit,
      "acme",
      "repo",
      "main",
      "unrelated"
    );

    expect(sha).toBeNull();
  });

  it("records Unknown error when the rejection is not an Error", async () => {
    mockCompareCommitsWithBasehead.mockRejectedValue({ status: 500 });

    const sha = await getMergeBaseSha(octokit, "acme", "repo", "main", "head");

    expect(sha).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "[github/branch-files] Failed to resolve merge base",
      {
        owner: "acme",
        repo: "repo",
        base: "main",
        head: "head",
        error: "Unknown error",
      }
    );
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

  it("returns too_large when the blob exceeds a cap the entry size satisfied", async () => {
    mockReposGetContent.mockResolvedValue(
      fileEntryResponse({
        encoding: "none",
        content: "",
        sha: "blob-sha-5",
        size: 8,
      })
    );
    mockGitGetBlob.mockResolvedValue({
      data: {
        content: Buffer.from("x".repeat(64), "utf8").toString("base64"),
        encoding: "base64",
        size: 64,
      },
    });

    await expect(
      getBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "src/big.ts",
        "head-sha",
        16
      )
    ).resolves.toEqual({ status: "too_large" });
  });

  it.each([
    {
      shape: "no content field",
      response: fileEntryResponse({ encoding: "utf-8", size: 5 }),
    },
    {
      shape: "a non-string content field",
      response: fileEntryResponse({
        encoding: "utf-8",
        content: null,
        size: 5,
      }),
    },
  ])("returns not_file when a file entry has $shape", async ({ response }) => {
    mockReposGetContent.mockResolvedValue(response);

    await expect(
      getBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "src/odd.ts",
        "sha",
        1024
      )
    ).resolves.toEqual({ status: "not_file" });
  });

  it("returns too_large when base64 decodes past the cap an understated size hid", async () => {
    mockReposGetContent.mockResolvedValue(
      fileEntryResponse({
        encoding: "base64",
        content: Buffer.from("content beyond the cap", "utf8").toString(
          "base64"
        ),
        size: 1,
      })
    );

    await expect(
      getBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "understated.txt",
        "sha",
        4
      )
    ).resolves.toEqual({ status: "too_large" });
  });

  it.each(["utf8", "utf-8"])(
    "returns direct %s content without base64 decoding it",
    async (encoding) => {
      mockReposGetContent.mockResolvedValue(
        fileEntryResponse({ encoding, content: "direct text", size: 11 })
      );

      await expect(
        getBoundedFileContentAtRef(
          octokit,
          "acme",
          "repo",
          "direct.txt",
          "sha",
          1024
        )
      ).resolves.toEqual({ status: "found", content: "direct text" });
    }
  );

  it("returns too_large for direct utf-8 content past the cap", async () => {
    mockReposGetContent.mockResolvedValue(
      fileEntryResponse({
        encoding: "utf-8",
        content: "direct text beyond the cap",
        size: 1,
      })
    );

    await expect(
      getBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "direct.txt",
        "sha",
        4
      )
    ).resolves.toEqual({ status: "too_large" });
  });

  it("reports a null encoding when GitHub omits the encoding field", async () => {
    mockReposGetContent.mockResolvedValue(
      fileEntryResponse({ content: "raw", size: 3 })
    );

    await expect(
      getBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "no-encoding.txt",
        "sha",
        1024
      )
    ).resolves.toEqual({ status: "unsupported_encoding" });
    expect(log.warn).toHaveBeenCalledWith(
      "[github/content] Unsupported file encoding",
      { encoding: null }
    );
  });

  it("rethrows a non-Error rejection and records Unknown error", async () => {
    const rejection = { status: 502 };
    mockReposGetContent.mockRejectedValueOnce(rejection);

    await expect(
      getBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "src/index.ts",
        "head-sha",
        1024
      )
    ).rejects.toBe(rejection);
    expect(log.warn).toHaveBeenCalledWith(
      "[github/content] Failed to fetch bounded file content at ref",
      {
        owner: "acme",
        repo: "repo",
        path: "src/index.ts",
        ref: "head-sha",
        error: "Unknown error",
      }
    );
  });
});
