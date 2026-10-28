import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWrapper } from "../../../shared/test-utils";
import { useBranchSelectedPullRequestChecks } from "../use-branch-selected-pull-request-checks";
import { BRANCH_DETAIL_REFETCH_INTERVAL_MS } from "../use-branches";

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet }),
}));

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const QUERY = {
  repositoryFullName: "octo/repo",
  pullRequestNumber: 42,
  headSha: "b".repeat(40),
};

describe("useBranchSelectedPullRequestChecks (ISS-12278)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.apiGet.mockResolvedValue({ status: "unavailable" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-reads checks on the detail poll cadence while the head stays the same", async () => {
    renderHook(() => useBranchSelectedPullRequestChecks(BRANCH_ID, QUERY), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(BRANCH_DETAIL_REFETCH_INTERVAL_MS);

    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(2));
  });
});
