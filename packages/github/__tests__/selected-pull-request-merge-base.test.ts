import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import type { SelectedPullRequestOctokit } from "../selected-pull-request-client";
import { readSelectedPullRequestMergeBase } from "../selected-pull-request-merge-base";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

describe("readSelectedPullRequestMergeBase", () => {
  it("rejects a pre-aborted caller before provider I/O", async () => {
    const compareCommitsWithBasehead = vi.fn();
    const octokit = makeOctokit(compareCommitsWithBasehead);
    const controller = new AbortController();
    const cancellation = new DOMException("Request canceled", "AbortError");
    controller.abort(cancellation);

    await expect(
      readSelectedPullRequestMergeBase(
        octokit,
        "acme",
        "widgets",
        BASE_SHA,
        HEAD_SHA,
        controller.signal
      )
    ).rejects.toBe(cancellation);

    expect(compareCommitsWithBasehead).not.toHaveBeenCalled();
  });

  it("propagates mid-request caller cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new DOMException("Request canceled", "AbortError");
    const compareCommitsWithBasehead = vi.fn(
      ({ request }: { request: { signal: AbortSignal } }) =>
        new Promise<{ data: unknown }>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true }
          );
        })
    );
    const octokit = makeOctokit(compareCommitsWithBasehead);

    const resultPromise = readSelectedPullRequestMergeBase(
      octokit,
      "acme",
      "widgets",
      BASE_SHA,
      HEAD_SHA,
      controller.signal
    );
    controller.abort(cancellation);

    await expect(resultPromise).rejects.toBe(cancellation);
    expect(compareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      basehead: `${BASE_SHA}...${HEAD_SHA}`,
      request: { signal: controller.signal },
    });
  });

  it("preserves ordinary provider failure classification", async () => {
    const compareCommitsWithBasehead = vi
      .fn()
      .mockRejectedValue({ status: 503 });
    const octokit = makeOctokit(compareCommitsWithBasehead);

    await expect(
      readSelectedPullRequestMergeBase(
        octokit,
        "acme",
        "widgets",
        BASE_SHA,
        HEAD_SHA,
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable,
    });
  });

  it("returns an available merge base without changing the comparison", async () => {
    const compareCommitsWithBasehead = vi.fn().mockResolvedValue({
      data: { merge_base_commit: { sha: MERGE_BASE_SHA } },
    });
    const octokit = makeOctokit(compareCommitsWithBasehead);

    await expect(
      readSelectedPullRequestMergeBase(
        octokit,
        "acme",
        "widgets",
        BASE_SHA,
        HEAD_SHA,
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: MERGE_BASE_SHA,
    });
  });
});

function makeOctokit(
  compareCommitsWithBasehead: SelectedPullRequestOctokit["rest"]["repos"]["compareCommitsWithBasehead"]
): SelectedPullRequestOctokit {
  return {
    rest: {
      pulls: { get: vi.fn(), listFiles: vi.fn() },
      repos: { compareCommitsWithBasehead },
    },
  };
}
