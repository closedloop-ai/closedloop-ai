import {
  GitHubBackfillRetryErrorCode,
  GitHubBackfillStatus,
} from "@repo/api/src/types/github";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { branchesKeys } from "../../../branches/hooks/use-branches";
import { ApiError } from "../../../shared/api/api-error";
import { usePostConnectBackfill } from "../use-post-connect-backfill";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const POLL_INTERVAL_MS = 5000;
/** ISS-7338's document-scoped claim, injected. Wins by default here. */
const claimStart = () => true;
const POLL_CEILING_MS = 6 * 60 * 1000;

describe("usePostConnectBackfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient.post.mockResolvedValue({
      accepted: true,
      status: GitHubBackfillStatus.Running,
    });
    mockApiClient.get.mockResolvedValue({
      summary: { status: GitHubBackfillStatus.Completed },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start a run until connect has reported success", () => {
    renderHook(() => usePostConnectBackfill({ claimStart, enabled: false }), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    expect(mockApiClient.post).not.toHaveBeenCalled();
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  it("starts the apply run once and does not pin a long client deadline to it", async () => {
    const { rerender } = renderHook(
      () => usePostConnectBackfill({ claimStart, enabled: true }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    await waitFor(() => expect(mockApiClient.post).toHaveBeenCalledTimes(1));
    rerender();
    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalled());

    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    // ISS-7408: the route answers in claim latency now, so the caller must NOT
    // carry the 5-minute `LONG_RUNNING_API_TIMEOUT_MS` the blocking version
    // needed. A third argument here would mean that coupling came back.
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/integrations/github/backfill",
      { mode: "apply" }
    );
  });

  it("refreshes branches while the run is still sweeping, then stops polling", async () => {
    // Installed BEFORE the hook mounts: the poll interval is scheduled when the
    // query is created, so timers faked afterwards would never own it.
    // `shouldAdvanceTime` keeps `waitFor` working against the same clock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApiClient.get.mockResolvedValue({
      summary: { status: GitHubBackfillStatus.Running },
    });
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => usePostConnectBackfill({ claimStart, enabled: true }), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(1));
    // Apply writes repos → branches → PRs → projections incrementally, so rows
    // exist long before the run settles. A refresh that waited for the terminal
    // status would leave the list asserting "nothing here" the whole time.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: branchesKeys.all,
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(mockApiClient.get.mock.calls.length).toBeGreaterThan(1);

    // A terminal status ends the poll; it must not keep hitting the endpoint
    // for the rest of the session.
    mockApiClient.get.mockResolvedValue({
      summary: { status: GitHubBackfillStatus.Completed },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    const settledCallCount = mockApiClient.get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    });

    expect(mockApiClient.get.mock.calls.length).toBe(settledCallCount);
  });

  it("reports a refused start and never polls a run that did not begin", async () => {
    mockApiClient.post.mockRejectedValue(new ApiError("boom", 500));
    const onError = vi.fn();

    renderHook(
      () => usePostConnectBackfill({ claimStart, enabled: true, onError }),
      {
        wrapper: createWrapperWithClient(createTestQueryClient()),
      }
    );

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  // ISS-5013, moved here with the code it describes (ISS-7408). The page suites
  // owned this while the POST lived in their effects; the POST is here now, and
  // the guarantee is unchanged: Apply writes repos → branches → PRs →
  // projections incrementally, so a start that FAILED can still have left rows
  // behind. The hook invalidates branches eagerly BEFORE the POST, so only the
  // SECOND invalidation proves the settle path fired — a bare
  // `toHaveBeenCalledWith` cannot tell `.finally()` from `.then()`.
  it("invalidates branches on the settle path even when the start fails", async () => {
    mockApiClient.post.mockRejectedValue(new ApiError("boom", 500));
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => usePostConnectBackfill({ claimStart, enabled: true }), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await waitFor(() =>
      expect(
        invalidateSpy.mock.calls.filter(
          ([arg]) => arg?.queryKey?.[0] === branchesKeys.all[0]
        )
      ).toHaveLength(2)
    );
  });

  it("follows the run already in flight when the start is refused as deferred", async () => {
    // The route answers this code precisely when an Apply run IS running for
    // the org, or within the cooldown after one — a remount on reload, or
    // navigating to branch detail with `?github=connected` still on the URL.
    // Reporting it as a failure told the user the refresh broke while it ran.
    mockApiClient.post.mockRejectedValue(
      new ApiError("already running", 429, {
        code: GitHubBackfillRetryErrorCode.Deferred,
      })
    );
    const onError = vi.fn();

    renderHook(
      () => usePostConnectBackfill({ claimStart, enabled: true, onError }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalled());
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a 429 that is not the deferred code and never polls", async () => {
    // A platform throttle or an edge rate limiter also answers 429 and leaves
    // NO run behind. Accepting it on the status alone would suppress the error
    // and poll a run that does not exist (#5689 review).
    mockApiClient.post.mockRejectedValue(new ApiError("slow down", 429));
    const onError = vi.fn();

    renderHook(
      () => usePostConnectBackfill({ claimStart, enabled: true, onError }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  it("stops polling when the status read starts failing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApiClient.get.mockResolvedValueOnce({
      summary: { status: GitHubBackfillStatus.Running },
    });
    // TanStack keeps the last SUCCESSFUL data through an error, so a
    // status-only stop condition would keep hitting a broken endpoint every 5s
    // to the ceiling — the infinite-retry case packages/app/AGENTS.md forbids.
    mockApiClient.get.mockRejectedValue(new ApiError("boom", 500));

    renderHook(() => usePostConnectBackfill({ claimStart, enabled: true }), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalled());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    });
    const settledCallCount = mockApiClient.get.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 20);
    });

    expect(mockApiClient.get.mock.calls.length).toBe(settledCallCount);
  });

  it("follows a sibling mount's run instead of firing a second one", async () => {
    // ISS-7338: the claim is document-scoped and test-and-set, so a remount or
    // the list-to-detail hop loses it. Losing it must not mean losing sight of
    // the run — the sweep is writing rows either way, and the poll dedupes to
    // one request because every mount shares the same query key.
    const claimLost = () => false;

    renderHook(
      () => usePostConnectBackfill({ claimStart: claimLost, enabled: true }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalled());
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  it("stops polling at the ceiling even while the server still says running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // A sweep killed mid-run never releases its 20-minute lease, so the status
    // surface keeps answering `running` for work that already stopped.
    mockApiClient.get.mockResolvedValue({
      summary: { status: GitHubBackfillStatus.Running },
    });

    renderHook(() => usePostConnectBackfill({ claimStart, enabled: true }), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalled());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_CEILING_MS + POLL_INTERVAL_MS * 2);
    });
    const ceilingCallCount = mockApiClient.get.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
    });

    expect(mockApiClient.get.mock.calls.length).toBe(ceilingCallCount);
    // Bounded, not merely finite: the 20-minute lease would otherwise drive
    // ~240 reads plus ~240 branch refetches.
    expect(ceilingCallCount).toBeLessThan(
      POLL_CEILING_MS / POLL_INTERVAL_MS + 5
    );
  });
});
