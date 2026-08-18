import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { mockGetClassifiedBoundedFileContentAtRef } = vi.hoisted(() => ({
  mockGetClassifiedBoundedFileContentAtRef: vi.fn(),
}));
vi.mock("../file-content", () => ({
  getClassifiedBoundedFileContentAtRef:
    mockGetClassifiedBoundedFileContentAtRef,
}));

import type { Octokit } from "@octokit/rest";
import {
  SelectedPullRequestContentAvailability,
  SelectedPullRequestContentClassification,
  SelectedPullRequestContentNotApplicableReason,
  SelectedPullRequestContentReferenceAvailability,
  SelectedPullRequestContentUnavailableReason,
  type SelectedPullRequestEvidence,
  type SelectedPullRequestFile,
  SelectedPullRequestFileCompleteness,
  SelectedPullRequestFileContentEvidenceAvailability,
  SelectedPullRequestFileStatus,
  SelectedPullRequestPatchAvailability,
  SelectedPullRequestPatchOmissionReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { getSelectedPullRequestFileContentEvidence } from "../selected-pull-request-content-evidence";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const octokit = {} as Octokit;

describe("getSelectedPullRequestFileContentEvidence", () => {
  beforeEach(() => {
    mockGetClassifiedBoundedFileContentAtRef.mockReset();
  });

  it("reads renamed content from the selected PR's immutable paths and SHAs", async () => {
    const file = makeFile({
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: SelectedPullRequestFileStatus.Renamed,
      baseContent: contentReference("src/old.ts", BASE_SHA),
      headContent: contentReference("src/new.ts", HEAD_SHA),
    });
    mockGetClassifiedBoundedFileContentAtRef
      .mockResolvedValueOnce({
        status: "found",
        classification: SelectedPullRequestContentClassification.Text,
        content: "before",
      })
      .mockResolvedValueOnce({
        status: "found",
        classification: SelectedPullRequestContentClassification.Text,
        content: "after",
      });

    const result = await getSelectedPullRequestFileContentEvidence(
      octokit,
      makeEvidence(file),
      file.path,
      1024
    );

    expect(result).toEqual({
      status: SelectedPullRequestFileContentEvidenceAvailability.Available,
      value: {
        file,
        base: {
          availability: SelectedPullRequestContentAvailability.Available,
          classification: SelectedPullRequestContentClassification.Text,
          content: "before",
        },
        head: {
          availability: SelectedPullRequestContentAvailability.Available,
          classification: SelectedPullRequestContentClassification.Text,
          content: "after",
        },
      },
    });
    expect(mockGetClassifiedBoundedFileContentAtRef).toHaveBeenNthCalledWith(
      1,
      octokit,
      "acme",
      "widgets",
      "src/old.ts",
      BASE_SHA,
      1024
    );
    expect(mockGetClassifiedBoundedFileContentAtRef).toHaveBeenNthCalledWith(
      2,
      octokit,
      "acme",
      "widgets",
      "src/new.ts",
      HEAD_SHA,
      1024
    );
  });

  it("preserves requested provider path whitespace during membership lookup", async () => {
    const path = " src/file.ts ";
    const file = makeFile({
      path,
      baseContent: contentReference(path, BASE_SHA),
      headContent: contentReference(path, HEAD_SHA),
    });
    mockGetClassifiedBoundedFileContentAtRef.mockResolvedValue({
      status: "found",
      classification: SelectedPullRequestContentClassification.Text,
      content: "contents",
    });

    const result = await getSelectedPullRequestFileContentEvidence(
      octokit,
      makeEvidence(file),
      path,
      1024
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestFileContentEvidenceAvailability.Available,
      value: { file: { path } },
    });
    expect(mockGetClassifiedBoundedFileContentAtRef).toHaveBeenCalledWith(
      octokit,
      "acme",
      "widgets",
      path,
      expect.any(String),
      1024
    );
  });

  it("does not read the inapplicable base side of an added file", async () => {
    const file = makeFile({
      status: SelectedPullRequestFileStatus.Added,
      baseContent: {
        availability:
          SelectedPullRequestContentReferenceAvailability.NotApplicable,
        reason: SelectedPullRequestContentNotApplicableReason.AddedFile,
      },
    });
    mockGetClassifiedBoundedFileContentAtRef.mockResolvedValueOnce({
      status: "found",
      classification: SelectedPullRequestContentClassification.Text,
      content: "after",
    });

    const result = await getSelectedPullRequestFileContentEvidence(
      octokit,
      makeEvidence(file),
      file.path,
      1024
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestFileContentEvidenceAvailability.Available,
      value: {
        base: {
          availability: SelectedPullRequestContentAvailability.NotApplicable,
          reason: SelectedPullRequestContentNotApplicableReason.AddedFile,
        },
        head: {
          availability: SelectedPullRequestContentAvailability.Available,
        },
      },
    });
    expect(mockGetClassifiedBoundedFileContentAtRef).toHaveBeenCalledTimes(1);
  });

  it("does not read the inapplicable head side of a removed file", async () => {
    const file = makeFile({
      status: SelectedPullRequestFileStatus.Removed,
      headContent: {
        availability:
          SelectedPullRequestContentReferenceAvailability.NotApplicable,
        reason: SelectedPullRequestContentNotApplicableReason.RemovedFile,
      },
    });
    mockGetClassifiedBoundedFileContentAtRef.mockResolvedValueOnce({
      status: "found",
      classification: SelectedPullRequestContentClassification.Text,
      content: "before",
    });

    const result = await getSelectedPullRequestFileContentEvidence(
      octokit,
      makeEvidence(file),
      file.path,
      1024
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestFileContentEvidenceAvailability.Available,
      value: {
        base: {
          availability: SelectedPullRequestContentAvailability.Available,
        },
        head: {
          availability: SelectedPullRequestContentAvailability.NotApplicable,
          reason: SelectedPullRequestContentNotApplicableReason.RemovedFile,
        },
      },
    });
    expect(mockGetClassifiedBoundedFileContentAtRef).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", SelectedPullRequestContentUnavailableReason.MissingContent],
    ["not_file", SelectedPullRequestContentUnavailableReason.NotAFile],
    ["too_large", SelectedPullRequestContentUnavailableReason.ContentTooLarge],
    [
      "unsupported_encoding",
      SelectedPullRequestContentUnavailableReason.UnsupportedEncoding,
    ],
  ])("maps %s content results explicitly", async (status, reason) => {
    const file = makeFile();
    mockGetClassifiedBoundedFileContentAtRef.mockResolvedValue({ status });

    const result = await getSelectedPullRequestFileContentEvidence(
      octokit,
      makeEvidence(file),
      file.path,
      1024
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestFileContentEvidenceAvailability.Available,
      value: {
        base: {
          availability: SelectedPullRequestContentAvailability.Unavailable,
          reason,
        },
        head: {
          availability: SelectedPullRequestContentAvailability.Unavailable,
          reason,
        },
      },
    });
  });

  it.each([
    {
      classification: SelectedPullRequestContentClassification.Binary,
      reason: SelectedPullRequestContentUnavailableReason.BinaryContent,
    },
    {
      classification: SelectedPullRequestContentClassification.Unknown,
      reason:
        SelectedPullRequestContentUnavailableReason.ContentClassificationUnknown,
    },
  ])("propagates $classification classification without decoded content", async ({
    classification,
    reason,
  }) => {
    const file = makeFile();
    mockGetClassifiedBoundedFileContentAtRef.mockResolvedValue({
      status: "found",
      classification,
    });

    const result = await getSelectedPullRequestFileContentEvidence(
      octokit,
      makeEvidence(file),
      file.path,
      1024
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestFileContentEvidenceAvailability.Available,
      value: {
        base: {
          availability: SelectedPullRequestContentAvailability.Unavailable,
          classification,
          reason,
        },
        head: {
          availability: SelectedPullRequestContentAvailability.Unavailable,
          classification,
          reason,
        },
      },
    });
    if (
      result.status !==
      SelectedPullRequestFileContentEvidenceAvailability.Available
    ) {
      throw new Error("Expected content-side evidence");
    }
    expect(result.value.base).not.toHaveProperty("content");
    expect(result.value.head).not.toHaveProperty("content");
  });

  it.each([
    {
      name: "unauthorized credentials",
      error: { status: 401 },
      reason:
        SelectedPullRequestContentUnavailableReason.CredentialUnauthorized,
    },
    {
      name: "insufficient credential scope",
      error: { response: { status: 403 } },
      reason:
        SelectedPullRequestContentUnavailableReason.CredentialInsufficientScope,
    },
    {
      name: "provider rate limit",
      error: { status: 429, headers: { "retry-after": "17" } },
      reason: SelectedPullRequestContentUnavailableReason.ProviderRateLimited,
      retryAfterSeconds: 17,
    },
    {
      name: "provider unavailable",
      error: { status: 503 },
      reason: SelectedPullRequestContentUnavailableReason.ProviderUnavailable,
    },
    {
      name: "unclassified provider failure",
      error: new Error("socket closed"),
      reason: SelectedPullRequestContentUnavailableReason.ProviderFailure,
    },
  ])("classifies $name for both requested content sides", async ({
    error,
    reason,
    retryAfterSeconds,
  }) => {
    const file = makeFile();
    mockGetClassifiedBoundedFileContentAtRef.mockRejectedValue(error);

    const result = await getSelectedPullRequestFileContentEvidence(
      octokit,
      makeEvidence(file),
      file.path,
      1024
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestFileContentEvidenceAvailability.Available,
      value: {
        base: {
          availability: SelectedPullRequestContentAvailability.Unavailable,
          reason,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        },
        head: {
          availability: SelectedPullRequestContentAvailability.Unavailable,
          reason,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        },
      },
    });
    expect(mockGetClassifiedBoundedFileContentAtRef).toHaveBeenCalledTimes(2);
  });

  it("passes one caller signal to both content sides and rejects cancellation", async () => {
    const file = makeFile();
    const controller = new AbortController();
    const cancellation = new DOMException("Request canceled", "AbortError");
    const observedSignals: AbortSignal[] = [];
    mockGetClassifiedBoundedFileContentAtRef.mockImplementation(
      (
        _octokit: Octokit,
        _owner: string,
        _repo: string,
        _path: string,
        _ref: string,
        _maxBytes: number,
        signal: AbortSignal
      ) => {
        observedSignals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
    );

    const resultPromise = getSelectedPullRequestFileContentEvidence(
      octokit,
      makeEvidence(file),
      file.path,
      1024,
      controller.signal
    );
    controller.abort(cancellation);

    await expect(resultPromise).rejects.toBe(cancellation);
    expect(observedSignals).toEqual([controller.signal, controller.signal]);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("rejects a pre-aborted caller before content I/O", async () => {
    const file = makeFile();
    const controller = new AbortController();
    const cancellation = new DOMException("Request canceled", "AbortError");
    controller.abort(cancellation);

    await expect(
      getSelectedPullRequestFileContentEvidence(
        octokit,
        makeEvidence(file),
        file.path,
        1024,
        controller.signal
      )
    ).rejects.toBe(cancellation);

    expect(mockGetClassifiedBoundedFileContentAtRef).not.toHaveBeenCalled();
  });

  it("rejects non-member paths and malformed limits before content I/O", async () => {
    const evidence = makeEvidence(makeFile());

    await expect(
      getSelectedPullRequestFileContentEvidence(
        octokit,
        evidence,
        "outside.ts",
        1024
      )
    ).resolves.toEqual({
      status: SelectedPullRequestFileContentEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestContentUnavailableReason.FileNotInPullRequest,
    });
    await expect(
      getSelectedPullRequestFileContentEvidence(
        octokit,
        evidence,
        "src/file.ts",
        0
      )
    ).resolves.toEqual({
      status: SelectedPullRequestFileContentEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestContentUnavailableReason.MalformedRequest,
    });
    expect(mockGetClassifiedBoundedFileContentAtRef).not.toHaveBeenCalled();
  });

  it("does not claim a path is absent when file membership is partial", async () => {
    const evidence = makeEvidence(makeFile());
    evidence.coverage = {
      completeness: SelectedPullRequestFileCompleteness.Partial,
      reasons: [],
    };

    await expect(
      getSelectedPullRequestFileContentEvidence(
        octokit,
        evidence,
        "possibly-omitted.ts",
        1024
      )
    ).resolves.toEqual({
      status: SelectedPullRequestFileContentEvidenceAvailability.Unavailable,
      reason:
        SelectedPullRequestContentUnavailableReason.FileMembershipIncomplete,
    });
    expect(mockGetClassifiedBoundedFileContentAtRef).not.toHaveBeenCalled();
  });
});

function makeEvidence(
  file: SelectedPullRequestFile
): SelectedPullRequestEvidence {
  return {
    identity: {
      githubId: "123",
      repositoryFullName: "acme/widgets",
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
    },
    revision: { baseSha: BASE_SHA, headSha: HEAD_SHA },
    files: [file],
    counts: { expected: 1, providerReturned: 1, normalizedReturned: 1 },
    pagination: {
      pageSize: 100,
      pagesFetched: 1,
      providerMaximum: 3000,
      reachedProviderMaximum: false,
    },
    coverage: {
      completeness: SelectedPullRequestFileCompleteness.Complete,
      reasons: [],
    },
  };
}

function makeFile(
  overrides: Partial<SelectedPullRequestFile> = {}
): SelectedPullRequestFile {
  return {
    path: "src/file.ts",
    providerStatus: "modified",
    status: SelectedPullRequestFileStatus.Modified,
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: {
      availability: SelectedPullRequestPatchAvailability.Omitted,
      reason: SelectedPullRequestPatchOmissionReason.ProviderOmitted,
    },
    baseContent: contentReference("src/file.ts", BASE_SHA),
    headContent: contentReference("src/file.ts", HEAD_SHA),
    ...overrides,
  };
}

function contentReference(path: string, ref: string) {
  return {
    availability: SelectedPullRequestContentReferenceAvailability.Available,
    path,
    ref,
  } as const;
}
