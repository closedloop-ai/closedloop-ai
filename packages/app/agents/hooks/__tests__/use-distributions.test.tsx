/**
 * ISS-7003: `useCreateDistribution`'s success-path cache invalidation.
 *
 * A distribution decides which machines receive a pack, so the list the admin
 * is looking at is the record of what the org is running. Without the
 * invalidation, a create resolves, the modal closes, and the catalog still
 * renders the pre-create list — the surface reports an org-wide roll-out that
 * has already happened as not having happened. Asserting the mutation
 * succeeded proves none of that, so this asserts the invalidation itself.
 *
 * This is the POSITIVE twin of `use-member-pack-install.test.tsx` (ISS-6700),
 * which pins that hook's deliberate ABSENCE of invalidation with the same spy.
 * Invalidation in this slice is a per-hook decision, so both directions are
 * pinned rather than assumed.
 *
 * The expected key is written out as a literal here rather than imported from
 * `distributionKeys`: a fixture that reads its expectation out of the module
 * under test cannot fail when that module's key changes, which is the exact
 * drift this guards.
 */

import {
  type CreateDistributionRequest,
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import {
  createTestQueryClient,
  createWrapper,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateDistribution, useDistributions } from "../use-distributions";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

/** Independently written — deliberately NOT `distributionKeys.lists()`. */
const DISTRIBUTIONS_LIST_KEY = ["distributions", "list"];

const CREATE_INPUT: CreateDistributionRequest = {
  catalogItemId: "pack-1",
  mode: DistributionMode.AutoInstall,
  targetingType: DistributionTargetingType.All,
  desiredEnabled: true,
};

const CREATED_DISTRIBUTION = { id: "distribution-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockApiClient.post.mockResolvedValue(CREATED_DISTRIBUTION);
  mockApiClient.get.mockResolvedValue([]);
});

describe("useDistributions", () => {
  it("does not fetch when disabled", () => {
    renderHook(() => useDistributions({ enabled: false }), {
      wrapper: createWrapper(),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});

describe("useCreateDistribution (ISS-7003)", () => {
  it("invalidates the distributions list when the create succeeds", async () => {
    const queryClient = createTestQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateDistribution(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate(CREATE_INPUT);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: DISTRIBUTIONS_LIST_KEY,
    });
  });

  /**
   * The spy above proves the call fires with the key this test declares; it
   * cannot prove that key reaches the query the catalog actually renders. A
   * mounted `useDistributions` closes that gap: if the two keys ever stop
   * matching, the create still "invalidates" and the list still shows stale
   * data — exactly the defect, with a green spy.
   */
  it("refetches a mounted distributions list after a create", async () => {
    const queryClient = createTestQueryClient();

    const { result } = renderHook(
      () => ({
        list: useDistributions(),
        create: useCreateDistribution(),
      }),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    result.current.create.mutate(CREATE_INPUT);

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(2));
    expect(mockApiClient.get).toHaveBeenNthCalledWith(2, "/distributions");
  });

  it("does not invalidate when the create fails", async () => {
    mockApiClient.post.mockRejectedValue(new Error("not an admin"));
    const queryClient = createTestQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateDistribution(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate(CREATE_INPUT);

    // Guard against the trivial pass: the spy is also uncalled when the
    // mutation never ran, so prove the POST settled before reading it.
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
