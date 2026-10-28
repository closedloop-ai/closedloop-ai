import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { getSelectedPullRequestEvidence } from "../selected-pull-request-evidence";
import {
  makeFile,
  makeFiles,
  makeMetadata,
  mockCompareCommitsWithBasehead,
  mockGet,
  mockListFiles,
  mockStableMetadata,
  NEXT_HEAD_SHA,
  OWNER,
  octokit,
  PULL_NUMBER,
  REPO,
  resetEvidenceMocks,
} from "./selected-pull-request-evidence-fixtures";

describe("getSelectedPullRequestEvidence failure, cancellation, and deadlines", () => {
  beforeEach(() => {
    resetEvidenceMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  /**
   * The two placements `normalizeRepoFullName` would otherwise absorb: a
   * leading or trailing slash folds away and the read would answer about a
   * repository the caller never named. Every other slash over-segments the
   * folded name and is refused downstream regardless, so these are the cases
   * that depend on the entry guard — and a guard that rejected only after
   * issuing the request would already have leaked the call.
   */
  it("rejects a slash-carrying repository component before provider I/O", async () => {
    const leading = await getSelectedPullRequestEvidence(
      octokit,
      `/${OWNER}`,
      REPO,
      PULL_NUMBER
    );
    const trailing = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      `${REPO}/`,
      PULL_NUMBER
    );

    const malformed = {
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedRequest,
    };
    expect(leading).toEqual(malformed);
    expect(trailing).toEqual(malformed);
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

  it("returns the final metadata read's provider failure after files are read", async () => {
    mockGet
      .mockResolvedValueOnce({ data: makeMetadata() })
      .mockRejectedValueOnce({ status: 503 });
    mockListFiles.mockResolvedValueOnce({ data: [makeFile()] });

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
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockListFiles).toHaveBeenCalledTimes(1);
  });

  it("reports a final revision that lost its head sha as missing, not stale", async () => {
    mockGet
      .mockResolvedValueOnce({ data: makeMetadata() })
      .mockResolvedValueOnce({ data: makeMetadata({ head: { sha: "" } }) });
    mockListFiles.mockResolvedValueOnce({ data: [makeFile()] });

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
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("rejects an owner that resolves to more than one repository segment", async () => {
    const result = await getSelectedPullRequestEvidence(
      octokit,
      `${OWNER}/extra`,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedRequest,
    });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("treats null provider shas as a missing immutable revision", async () => {
    mockGet.mockResolvedValueOnce({
      data: makeMetadata({ base: { sha: null }, head: { sha: null } }),
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
    expect(mockCompareCommitsWithBasehead).not.toHaveBeenCalled();
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation raised by the in-flight metadata read", async () => {
    vi.useFakeTimers();
    let resolveMetadataStarted: (signal: AbortSignal) => void = () => {
      throw new Error("Metadata start resolver was not initialized");
    };
    const metadataStarted = new Promise<AbortSignal>((resolve) => {
      resolveMetadataStarted = resolve;
    });
    mockGet.mockImplementationOnce(
      ({ request }: { request: { signal: AbortSignal } }) => {
        resolveMetadataStarted(request.signal);
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

    const resultPromise = getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER,
      controller.signal
    );
    const providerSignal = await metadataStarted;
    controller.abort(cancellation);

    await expect(resultPromise).rejects.toBe(cancellation);
    expect(providerSignal.aborted).toBe(true);
    expect(mockCompareCommitsWithBasehead).not.toHaveBeenCalled();
    expect(mockListFiles).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a non-array file page as a malformed response", async () => {
    mockGet.mockResolvedValueOnce({ data: makeMetadata() });
    mockListFiles.mockResolvedValueOnce({ data: { files: [makeFile()] } });

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
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("rejects a file page longer than the requested page size", async () => {
    mockStableMetadata(101);
    mockListFiles.mockResolvedValueOnce({ data: makeFiles(101, 0) });

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
    expect(mockListFiles).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
