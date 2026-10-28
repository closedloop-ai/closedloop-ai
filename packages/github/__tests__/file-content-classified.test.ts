import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { SelectedPullRequestContentClassification } from "@repo/api/src/types/selected-pull-request-evidence";
import { log } from "@repo/observability/log";
import { getClassifiedBoundedFileContentAtRef } from "../file-content";
import {
  fileEntryResponse,
  mockGitGetBlob,
  mockReposGetContent,
  octokit,
} from "./file-content-fixtures";

// GitHub wraps base64 content at fixed line lengths, so the decoder must treat
// the wrapping whitespace as absent rather than as data.
const WRAPPED_TEXT = "wrapped base64 text";

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

  it.each(["", "plain text", "snowman ☃", "literal � character"])(
    "classifies valid UTF-8 text without changing its content: %j",
    async (content) => {
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
    }
  );

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
    "AAAAA===",
    "aGVsbG8gd29ybGQ==",
    "AAAAA",
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
  ])(
    "rejects underestimated $encoding content before returning bytes",
    async ({ encoding, content }) => {
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
    }
  );

  it.each(["utf8", "utf-8"])(
    "classifies direct %s content with the same rules",
    async (encoding) => {
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
    }
  );

  it.each(["utf8", "utf-8"])(
    "classifies direct %s NUL-bearing content as binary",
    async (encoding) => {
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
    }
  );

  it.each(["utf8", "utf-8"])(
    "classifies malformed direct %s text as unknown",
    async (encoding) => {
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
    }
  );

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

  it.each([
    {
      source: "a directory listing",
      response: { data: [] },
      expected: { status: "not_file" },
    },
    {
      source: "an oversized entry",
      response: fileEntryResponse({
        encoding: "base64",
        content: "",
        size: 4096,
      }),
      expected: { status: "too_large" },
    },
  ])(
    "returns the unclassified result for $source",
    async ({ response, expected }) => {
      mockReposGetContent.mockResolvedValue(response);

      await expect(
        getClassifiedBoundedFileContentAtRef(
          octokit,
          "acme",
          "repo",
          "src",
          "sha",
          1024
        )
      ).resolves.toEqual(expected);
    }
  );

  it("throws the caller's abort reason instead of classifying", async () => {
    const controller = new AbortController();
    const cancellation = new DOMException("Request canceled", "AbortError");
    mockReposGetContent.mockImplementationOnce(
      ({ request }: { request: { signal: AbortSignal } }) => {
        controller.abort(cancellation);
        return Promise.resolve({
          ...fileEntryResponse({
            encoding: "base64",
            content: Buffer.from("text", "utf8").toString("base64"),
            size: 4,
          }),
          request,
        });
      }
    );

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "src/index.ts",
        "head-sha",
        1024,
        controller.signal
      )
    ).rejects.toBe(cancellation);
  });

  it("rethrows a non-Error rejection and records Unknown error", async () => {
    const rejection = { status: 502 };
    mockReposGetContent.mockRejectedValueOnce(rejection);

    await expect(
      getClassifiedBoundedFileContentAtRef(
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

  it("reports a null encoding when GitHub omits the encoding field", async () => {
    mockReposGetContent.mockResolvedValue(
      fileEntryResponse({ content: "raw", size: 3 })
    );

    await expect(
      getClassifiedBoundedFileContentAtRef(
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

  it("classifies line-wrapped base64 as text without the wrapping bytes", async () => {
    const encoded = Buffer.from(WRAPPED_TEXT, "utf8").toString("base64");
    mockReposGetContent.mockResolvedValue(
      fileEntryResponse({
        encoding: "base64",
        content: `${encoded.slice(0, 8)}\n${encoded.slice(8)}\n`,
        size: Buffer.byteLength(WRAPPED_TEXT, "utf8"),
      })
    );

    await expect(
      getClassifiedBoundedFileContentAtRef(
        octokit,
        "acme",
        "repo",
        "wrapped.txt",
        "sha",
        1024
      )
    ).resolves.toEqual({
      status: "found",
      classification: SelectedPullRequestContentClassification.Text,
      content: WRAPPED_TEXT,
    });
    expect(log.error).not.toHaveBeenCalled();
  });
});
