import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSelectedPullRequestChecksEvidence } from "../selected-pull-request-checks-evidence";
import type { SelectedPullRequestChecksOctokit } from "../selected-pull-request-client";

const mockGet = vi.fn();
const mockGraphql = vi.fn();
const octokit: SelectedPullRequestChecksOctokit = {
  graphql: (query, parameters) => mockGraphql(query, parameters),
  rest: { pulls: { get: mockGet } },
};

describe("selected pull-request checks deadline", () => {
  afterEach(() => {
    mockGet.mockReset();
    mockGraphql.mockReset();
    vi.useRealTimers();
  });

  it.each([
    0,
    -1,
    1.5,
    120_001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid timeout %s before provider I/O", async (timeoutMs) => {
    await expect(acquire({ timeoutMs })).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedRequest,
    });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects a pre-aborted caller before provider I/O and clears its timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    await expect(acquire({ signal: controller.signal })).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockGraphql).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function acquire(
  options: Parameters<typeof getSelectedPullRequestChecksEvidence>[4]
) {
  return getSelectedPullRequestChecksEvidence(
    octokit,
    "Acme",
    "Widgets",
    42,
    options
  );
}
