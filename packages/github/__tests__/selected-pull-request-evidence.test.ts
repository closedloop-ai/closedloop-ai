import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  SelectedPullRequestContentReferenceAvailability,
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
  SelectedPullRequestFileCompleteness,
  SelectedPullRequestFilePartialReason,
  SelectedPullRequestFileStatus,
  SelectedPullRequestPatchAvailability,
  SelectedPullRequestPatchOmissionReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import type { SelectedPullRequestOctokit } from "../selected-pull-request-client";
import { getSelectedPullRequestEvidence } from "../selected-pull-request-evidence";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const NEXT_HEAD_SHA = "c".repeat(40);
const MERGE_BASE_SHA = "d".repeat(40);
const OWNER = "Acme";
const REPO = "Widgets";
const PULL_NUMBER = 42;

const mockGet = vi.fn();
const mockListFiles = vi.fn();
const mockCompareCommitsWithBasehead = vi.fn();
const octokit: SelectedPullRequestOctokit = {
  rest: {
    pulls: { get: mockGet, listFiles: mockListFiles },
    repos: { compareCommitsWithBasehead: mockCompareCommitsWithBasehead },
  },
};

describe("getSelectedPullRequestEvidence", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockListFiles.mockReset();
    mockCompareCommitsWithBasehead.mockReset();
    mockCompareCommitsWithBasehead.mockResolvedValue({
      data: { merge_base_commit: { sha: MERGE_BASE_SHA } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns complete immutable evidence and normalizes rename and omitted patch behavior", async () => {
    mockStableMetadata(2);
    mockListFiles.mockResolvedValueOnce({
      data: [
        makeFile({ patch: "@@ -1 +1 @@", status: "modified" }),
        makeFile({
          filename: "src/new-name.ts",
          patch: undefined,
          previous_filename: "src/old-name.ts",
          status: "renamed",
        }),
      ],
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      ` ${OWNER} `,
      `${REPO}.git`,
      PULL_NUMBER
    );

    expect(result.status).toBe(
      SelectedPullRequestEvidenceAvailability.Available
    );
    if (result.status !== SelectedPullRequestEvidenceAvailability.Available) {
      return;
    }
    expect(result.value.identity.repositoryFullName).toBe("acme/widgets");
    expect(result.value.revision).toEqual({
      baseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
    });
    expect(result.value.coverage).toEqual({
      completeness: SelectedPullRequestFileCompleteness.Complete,
      reasons: [],
    });
    expect(result.value.files[1]).toEqual(
      expect.objectContaining({
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        status: SelectedPullRequestFileStatus.Renamed,
        patch: {
          availability: SelectedPullRequestPatchAvailability.Omitted,
          reason: SelectedPullRequestPatchOmissionReason.ProviderOmitted,
        },
        baseContent: {
          availability:
            SelectedPullRequestContentReferenceAvailability.Available,
          path: "src/old-name.ts",
          ref: MERGE_BASE_SHA,
        },
        headContent: {
          availability:
            SelectedPullRequestContentReferenceAvailability.Available,
          path: "src/new-name.ts",
          ref: HEAD_SHA,
        },
      })
    );
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenNthCalledWith(1, {
      owner: "acme",
      repo: "widgets",
      pull_number: PULL_NUMBER,
      request: { signal: expect.any(AbortSignal) },
    });
    expect(mockCompareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      basehead: `${BASE_SHA}...${HEAD_SHA}`,
      request: { signal: expect.any(AbortSignal) },
    });
    expect(mockListFiles).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: PULL_NUMBER,
      page: 1,
      per_page: 100,
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it("preserves filename whitespace in PR evidence and content references", async () => {
    const filename = " src/new-name.ts ";
    const previousFilename = " src/old-name.ts ";
    mockStableMetadata(1);
    mockListFiles.mockResolvedValueOnce({
      data: [
        makeFile({
          filename,
          previous_filename: previousFilename,
          status: "renamed",
        }),
      ],
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        files: [
          {
            path: filename,
            previousPath: previousFilename,
            baseContent: { path: previousFilename },
            headContent: { path: filename },
          },
        ],
      },
    });
  });

  it("preserves an empty provider patch as available evidence", async () => {
    mockStableMetadata(1);
    mockListFiles.mockResolvedValueOnce({ data: [makeFile({ patch: "" })] });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        files: [
          {
            patch: {
              availability: SelectedPullRequestPatchAvailability.Available,
              patch: "",
            },
          },
        ],
      },
    });
  });

  it("paginates until a terminal page and reconciles provider counts", async () => {
    mockStableMetadata(101);
    mockListFiles
      .mockResolvedValueOnce({ data: makeFiles(100, 0) })
      .mockResolvedValueOnce({ data: makeFiles(1, 100) });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: {
          expected: 101,
          normalizedReturned: 101,
          providerReturned: 101,
        },
        pagination: { pagesFetched: 2, reachedProviderMaximum: false },
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Complete,
          reasons: [],
        },
      },
    });
  });

  it("reports exactly 3000 expected files as complete at the provider maximum", async () => {
    mockStableMetadata(3000);
    mockThirtyFullPages();

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { expected: 3000, normalizedReturned: 3000 },
        pagination: { pagesFetched: 30, reachedProviderMaximum: true },
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Complete,
          reasons: [],
        },
      },
    });
  });

  it("reports more than 3000 expected files as capped partial evidence", async () => {
    mockStableMetadata(3001);
    mockThirtyFullPages();

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { expected: 3001, normalizedReturned: 3000 },
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Partial,
          reasons: [
            SelectedPullRequestFilePartialReason.ProviderCapped,
            SelectedPullRequestFilePartialReason.CountMismatch,
          ],
        },
      },
    });
  });

  it("reports unknown expected count at 3000 as capped partial evidence", async () => {
    mockStableMetadata(null);
    mockThirtyFullPages();

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Partial,
          reasons: [SelectedPullRequestFilePartialReason.ProviderCapped],
        },
      },
    });
  });

  it("returns partial evidence when known and normalized counts disagree", async () => {
    mockStableMetadata(2);
    mockListFiles.mockResolvedValueOnce({ data: [makeFile()] });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Partial,
          reasons: [SelectedPullRequestFilePartialReason.CountMismatch],
        },
      },
    });
  });

  it("rejects duplicate provider paths instead of treating repeated pages as complete", async () => {
    const repeatedPage = makeFiles(100, 0);
    mockStableMetadata(200);
    mockListFiles
      .mockResolvedValueOnce({ data: repeatedPage })
      .mockResolvedValueOnce({ data: repeatedPage })
      .mockResolvedValueOnce({ data: [] });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: {
          expected: 200,
          normalizedReturned: 100,
          providerReturned: 200,
        },
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Partial,
          reasons: [
            SelectedPullRequestFilePartialReason.CountMismatch,
            SelectedPullRequestFilePartialReason.MalformedFile,
          ],
        },
      },
    });
  });

  it("omits malformed rows and marks unknown statuses partial", async () => {
    mockStableMetadata(4);
    mockListFiles.mockResolvedValueOnce({
      data: [
        makeFile(),
        makeFile({ additions: -1, filename: "bad.ts" }),
        makeFile({ filename: "future.ts", status: "future_status" }),
        makeFile({ filename: "rename-without-source.ts", status: "renamed" }),
      ],
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { expected: 4, normalizedReturned: 2, providerReturned: 4 },
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Partial,
          reasons: [
            SelectedPullRequestFilePartialReason.CountMismatch,
            SelectedPullRequestFilePartialReason.MalformedFile,
          ],
        },
      },
    });
    if (result.status === SelectedPullRequestEvidenceAvailability.Available) {
      expect(result.value.files[1]?.status).toBe(
        SelectedPullRequestFileStatus.Unknown
      );
    }
  });

  it("rejects malformed input before provider I/O", async () => {
    const result = await getSelectedPullRequestEvidence(
      octokit,
      "bad/owner",
      REPO,
      0
    );

    expect(result).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedRequest,
    });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockListFiles).not.toHaveBeenCalled();
    expect(mockCompareCommitsWithBasehead).not.toHaveBeenCalled();
  });

  it("rejects missing immutable revisions before listing files", async () => {
    mockGet.mockResolvedValueOnce({
      data: makeMetadata({ head: { sha: "" } }),
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason:
        SelectedPullRequestEvidenceUnavailableReason.MissingImmutableRevision,
    });
    expect(mockListFiles).not.toHaveBeenCalled();
    expect(mockCompareCommitsWithBasehead).not.toHaveBeenCalled();
  });

  it("rejects a missing PR merge base before listing files", async () => {
    mockGet.mockResolvedValueOnce({ data: makeMetadata() });
    mockCompareCommitsWithBasehead.mockResolvedValueOnce({
      data: { merge_base_commit: { sha: null } },
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason:
        SelectedPullRequestEvidenceUnavailableReason.MissingImmutableRevision,
    });
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  it("classifies merge-base provider failures before listing files", async () => {
    mockGet.mockResolvedValueOnce({ data: makeMetadata() });
    mockCompareCommitsWithBasehead.mockRejectedValueOnce({ status: 503 });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable,
    });
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  it("rejects malformed metadata without listing files", async () => {
    mockGet.mockResolvedValueOnce({ data: makeMetadata({ html_url: "nope" }) });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedResponse,
    });
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  it("classifies file-page provider failures", async () => {
    mockGet.mockResolvedValueOnce({ data: makeMetadata() });
    mockListFiles.mockRejectedValueOnce({ status: 503 });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable,
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("rejects evidence when immutable metadata changes during pagination", async () => {
    mockGet
      .mockResolvedValueOnce({ data: makeMetadata() })
      .mockResolvedValueOnce({
        data: makeMetadata({ head: { sha: NEXT_HEAD_SHA } }),
      });
    mockListFiles.mockResolvedValueOnce({ data: [makeFile()] });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
    });
  });

  it("bounds the complete multi-request acquisition with one deadline", async () => {
    vi.useFakeTimers();
    mockGet.mockReturnValueOnce(new Promise(() => undefined));

    const resultPromise = getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(resultPromise).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    expect(mockGet).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: PULL_NUMBER,
      request: { signal: expect.objectContaining({ aborted: true }) },
    });
  });

  it("rejects a pre-aborted caller before provider I/O", async () => {
    const controller = new AbortController();
    const cancellation = new DOMException("Request canceled", "AbortError");
    controller.abort(cancellation);

    await expect(
      getSelectedPullRequestEvidence(
        octokit,
        OWNER,
        REPO,
        PULL_NUMBER,
        controller.signal
      )
    ).rejects.toBe(cancellation);

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockCompareCommitsWithBasehead).not.toHaveBeenCalled();
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation through pagination and cleans its deadline", async () => {
    vi.useFakeTimers();
    mockStableMetadata(1);
    let resolvePaginationStarted: (signal: AbortSignal) => void = () => {
      throw new Error("Pagination start resolver was not initialized");
    };
    const paginationStarted = new Promise<AbortSignal>((resolve) => {
      resolvePaginationStarted = resolve;
    });
    mockListFiles.mockImplementationOnce(
      ({ request }: { request: { signal: AbortSignal } }) => {
        resolvePaginationStarted(request.signal);
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true }
          );
        });
      }
    );
    const controller = new AbortController();
    const cancellation = new DOMException("Request canceled", "AbortError");
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener"
    );

    const resultPromise = getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER,
      controller.signal
    );
    const providerSignal = await paginationStarted;
    controller.abort(cancellation);

    await expect(resultPromise).rejects.toBe(cancellation);
    expect(providerSignal.aborted).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockCompareCommitsWithBasehead).toHaveBeenCalledTimes(1);
    expect(mockListFiles).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function)
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans its provider deadline after an ordinary typed result", async () => {
    vi.useFakeTimers();
    mockGet.mockRejectedValueOnce({ status: 401 });

    await expect(
      getSelectedPullRequestEvidence(octokit, OWNER, REPO, PULL_NUMBER)
    ).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason:
        SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized,
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      "unauthorized",
      { status: 401 },
      SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized,
    ],
    [
      "insufficient scope",
      { status: 403 },
      SelectedPullRequestEvidenceUnavailableReason.CredentialInsufficientScope,
    ],
    [
      "missing PR",
      { status: 404 },
      SelectedPullRequestEvidenceUnavailableReason.PullRequestMissingOrInaccessible,
    ],
    [
      "provider unavailable",
      { status: 503 },
      SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable,
    ],
    [
      "provider failure",
      new Error("socket closed"),
      SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
    ],
  ])("classifies %s metadata failure", async (_name, error, reason) => {
    mockGet.mockRejectedValueOnce(error);

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason,
    });
  });

  it("gives rate-limit evidence precedence over a generic 403", async () => {
    mockGet.mockRejectedValueOnce({
      status: 403,
      headers: { "retry-after": "7" },
      message: "secondary rate limit",
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderRateLimited,
      retryAfterSeconds: 7,
    });
  });
});

function mockStableMetadata(changedFiles: number | null) {
  mockGet.mockResolvedValue({
    data: makeMetadata({ changed_files: changedFiles }),
  });
}

function mockThirtyFullPages() {
  mockListFiles.mockImplementation(({ page }: { page: number }) =>
    Promise.resolve({ data: makeFiles(100, (page - 1) * 100) })
  );
}

function makeMetadata(
  overrides: Partial<{
    id: number;
    number: number;
    html_url: string;
    changed_files: number | null;
    base: { sha: string };
    head: { sha: string };
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

function makeFiles(count: number, offset: number) {
  return Array.from({ length: count }, (_, index) =>
    makeFile({ filename: `src/file-${offset + index + 1}.ts` })
  );
}

function makeFile(
  overrides: Partial<{
    filename: string;
    previous_filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
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
