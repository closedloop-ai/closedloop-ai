import {
  createWrapper,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { distributionKeys } from "../../../agents/hooks/use-distributions";
import { usePackDistributionWithdrawal } from "../use-pack-distribution-withdrawal";

/**
 * ISS-5123 — the admin "stop distributing" flow.
 *
 * The hook is where the safety properties of a destructive, org-wide action
 * live, so each is pinned against the real mutation path (a mocked API client,
 * not a mocked hook): the affordance is closed by default, a click alone never
 * withdraws, the confirmation is bound to a specific distribution id, and a
 * failed request leaves the confirmation intact for a retry rather than
 * reporting a withdrawal that did not happen.
 */

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: mockToast,
}));

const DISTRIBUTION_ID = "dist-7";

beforeEach(() => {
  vi.clearAllMocks();
  mockApiClient.delete.mockResolvedValue({ id: DISTRIBUTION_ID });
});

const OTHER_DISTRIBUTION_ID = "dist-9";

/**
 * A harness whose QueryClient the test keeps a handle on, so the cache can be
 * seeded and then inspected after the mutation settles.
 *
 * Deliberately NOT `createTestQueryClient()`: that helper sets `gcTime: 0`, so
 * the `invalidateQueries` at the end of the mutation immediately garbage-
 * collects the observer-less list entry and every post-mutation cache read
 * returns undefined. That would make this test measure the harness's GC rather
 * than the production cache behaviour it exists to pin.
 */
function createCacheHarness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  return { queryClient, wrapper: createWrapperWithClient(queryClient) };
}

function renderWithdrawal(options: { isAdmin: boolean; flagEnabled: boolean }) {
  return renderHook(() => usePackDistributionWithdrawal(options), {
    wrapper: createWrapper(),
  });
}

describe("usePackDistributionWithdrawal (ISS-5123)", () => {
  it.each([
    { isAdmin: true, flagEnabled: false, label: "flag off" },
    { isAdmin: false, flagEnabled: true, label: "not an admin" },
    { isAdmin: false, flagEnabled: false, label: "neither" },
  ])("offers no affordance when $label", ({ isAdmin, flagEnabled }) => {
    const { result } = renderWithdrawal({ isAdmin, flagEnabled });

    // Undefined, so the surface has no callback to hand a button — the control
    // cannot be rendered at all rather than being rendered and then rejected.
    expect(result.current.requestWithdraw).toBeUndefined();
  });

  it("opens a confirmation without withdrawing anything", () => {
    const { result } = renderWithdrawal({ isAdmin: true, flagEnabled: true });

    act(() => {
      result.current.requestWithdraw?.([DISTRIBUTION_ID]);
    });

    expect(result.current.pendingDistributionIds).toEqual([DISTRIBUTION_ID]);
    // The whole point of the confirmation: the click alone must not have hit
    // the org.
    expect(mockApiClient.delete).not.toHaveBeenCalled();
  });

  it("withdraws the confirmed distribution and clears the confirmation", async () => {
    const { result } = renderWithdrawal({ isAdmin: true, flagEnabled: true });

    act(() => {
      result.current.requestWithdraw?.([DISTRIBUTION_ID]);
    });
    await act(async () => {
      await result.current.confirmWithdraw();
    });

    expect(mockApiClient.delete).toHaveBeenCalledWith(
      `/distributions/${DISTRIBUTION_ID}`
    );
    await waitFor(() =>
      expect(result.current.pendingDistributionIds).toBeNull()
    );
  });

  /**
   * The confirmation promises the pack "will no longer be offered to anyone in
   * your organization". A pack can hold several live distributions at once, so
   * withdrawing only one would make that sentence false while reporting success.
   */
  it("withdraws every confirmed distribution, not just the first", async () => {
    const { result } = renderWithdrawal({ isAdmin: true, flagEnabled: true });

    act(() => {
      result.current.requestWithdraw?.([DISTRIBUTION_ID, "dist-second"]);
    });
    await act(async () => {
      await result.current.confirmWithdraw();
    });

    expect(mockApiClient.delete).toHaveBeenCalledWith(
      `/distributions/${DISTRIBUTION_ID}`
    );
    expect(mockApiClient.delete).toHaveBeenCalledWith(
      "/distributions/dist-second"
    );
    expect(mockApiClient.delete).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(result.current.pendingDistributionIds).toBeNull()
    );
  });

  it("opens no confirmation when there is nothing live to withdraw", () => {
    const { result } = renderWithdrawal({ isAdmin: true, flagEnabled: true });

    act(() => {
      result.current.requestWithdraw?.([]);
    });

    // An empty request must not open a dialog that would promise an org-wide
    // change and then issue no request at all.
    expect(result.current.pendingDistributionIds).toBeNull();
    expect(mockApiClient.delete).not.toHaveBeenCalled();
  });

  it("confirming with nothing pending is a no-op", async () => {
    const { result } = renderWithdrawal({ isAdmin: true, flagEnabled: true });

    await act(async () => {
      await result.current.confirmWithdraw();
    });

    expect(mockApiClient.delete).not.toHaveBeenCalled();
  });

  it("keeps the confirmation open when the request fails", async () => {
    mockApiClient.delete.mockRejectedValue(new Error("network down"));
    const { result } = renderWithdrawal({ isAdmin: true, flagEnabled: true });

    act(() => {
      result.current.requestWithdraw?.([DISTRIBUTION_ID]);
    });
    await act(async () => {
      await expect(result.current.confirmWithdraw()).rejects.toThrow(
        "network down"
      );
    });

    // Rejecting is what lets the dialog stay open; clearing the pending id here
    // would dismiss the confirmation as though the pack had been withdrawn.
    expect(result.current.pendingDistributionIds).toEqual([DISTRIBUTION_ID]);
  });

  it("dismissing the confirmation withdraws nothing", () => {
    const { result } = renderWithdrawal({ isAdmin: true, flagEnabled: true });

    act(() => {
      result.current.requestWithdraw?.([DISTRIBUTION_ID]);
    });
    act(() => {
      result.current.setConfirmOpen(false);
    });

    expect(result.current.pendingDistributionIds).toBeNull();
    expect(mockApiClient.delete).not.toHaveBeenCalled();
  });
});

describe("usePackDistributionWithdrawal cache handling (ISS-5123)", () => {
  it("drops the withdrawn distribution from the cached list and evicts its detail", async () => {
    const { queryClient, wrapper } = createCacheHarness();
    queryClient.setQueryData(distributionKeys.list(), [
      { id: DISTRIBUTION_ID },
      { id: OTHER_DISTRIBUTION_ID },
    ]);
    queryClient.setQueryData(distributionKeys.detail(DISTRIBUTION_ID), {
      id: DISTRIBUTION_ID,
    });

    const { result } = renderHook(
      () =>
        usePackDistributionWithdrawal({
          isAdmin: true,
          flagEnabled: true,
          packName: "Code",
        }),
      { wrapper }
    );

    act(() => {
      result.current.requestWithdraw?.([DISTRIBUTION_ID]);
    });
    await act(async () => {
      await result.current.confirmWithdraw();
    });

    // The surface prefers the DETAIL read over the list row, and the detail read
    // still returns a withdrawn record by id. Leaving it cached (or re-fetching
    // it) re-renders the dead distribution as a live roll-out.
    expect(
      queryClient.getQueryData(distributionKeys.detail(DISTRIBUTION_ID))
    ).toBeUndefined();
    // The list flips immediately rather than after a round trip, and only the
    // withdrawn entry goes.
    expect(queryClient.getQueryData(distributionKeys.list())).toEqual([
      { id: OTHER_DISTRIBUTION_ID },
    ]);
  });

  it("confirms the org-wide action succeeded by naming the pack", async () => {
    const { wrapper } = createCacheHarness();
    const { result } = renderHook(
      () =>
        usePackDistributionWithdrawal({
          isAdmin: true,
          flagEnabled: true,
          packName: "Code",
        }),
      { wrapper }
    );

    act(() => {
      result.current.requestWithdraw?.([DISTRIBUTION_ID]);
    });
    await act(async () => {
      await result.current.confirmWithdraw();
    });

    // The roll-out block simply disappears on success, so without this the admin
    // gets no confirmation that an org-wide action landed.
    expect(mockToast.success).toHaveBeenCalledWith(
      'Stopped distributing "Code"'
    );
  });

  it("does not claim success when the request failed", async () => {
    mockApiClient.delete.mockRejectedValue(new Error("network down"));
    const { wrapper } = createCacheHarness();
    const { result } = renderHook(
      () =>
        usePackDistributionWithdrawal({
          isAdmin: true,
          flagEnabled: true,
          packName: "Code",
        }),
      { wrapper }
    );

    act(() => {
      result.current.requestWithdraw?.([DISTRIBUTION_ID]);
    });
    await act(async () => {
      await expect(result.current.confirmWithdraw()).rejects.toThrow(
        "network down"
      );
    });

    expect(mockToast.success).not.toHaveBeenCalled();
  });
});
