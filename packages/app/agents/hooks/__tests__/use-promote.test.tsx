import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { PromoteRequest } from "@repo/api/src/types/distribution";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogKeys } from "../use-catalog";
import { distributionKeys } from "../use-distributions";
import { analyticsKeys, usePromoteAgentComponent } from "../use-promote";

const mockApiClient = {
  post: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePromoteAgentComponent (ISS-6638)", () => {
  it("invalidates the catalog, distribution, and ranking lists on success", async () => {
    mockApiClient.post.mockResolvedValue({
      catalogItemId: "catalog-item-1",
      distributionId: "distribution-1",
    });
    const queryClient = createTestQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => usePromoteAgentComponent(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    await result.current.mutateAsync(PROMOTE_INPUT);

    // Asserting the key VALUES, not the call count: three calls with two
    // duplicated keys would satisfy a count assertion while leaving one of the
    // three screens showing pre-promote data.
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledTimes(3));
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: catalogKeys.lists(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: distributionKeys.lists(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: analyticsKeys.ranking(),
    });
  });

  it("invalidates nothing when the promote is rejected", async () => {
    mockApiClient.post.mockRejectedValue(new Error("Promote rejected"));
    const queryClient = createTestQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => usePromoteAgentComponent(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    await expect(result.current.mutateAsync(PROMOTE_INPUT)).rejects.toThrow(
      "Promote rejected"
    );

    // A failed promote created nothing; dropping the caches would refetch three
    // lists for no reason and hide the fact that the write never landed.
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

const PROMOTE_INPUT: PromoteRequest = {
  agentComponentId: "uuid-component-1",
  name: "My Orchestrator Agent",
  targetKind: AgentComponentKind.Subagent,
};
