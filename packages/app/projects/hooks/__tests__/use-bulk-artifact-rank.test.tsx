/**
 * Tests for the bulk stack-ranking client (ISS-8999): that the hooks call the
 * bulk endpoint with the caller's order, invalidate both the tree and the
 * rank-state caches once a rewrite settles (including after a rejection, where
 * the client's picture is known to be stale), and that the older-server
 * fallback predicate answers only for the status a missing endpoint produces.
 */

import type {
  BulkRankArtifactsResponse,
  ProjectRankStateResponse,
} from "@repo/api/src/types/project-artifact-bulk-rank";
import { BulkRankMutationSource } from "@repo/api/src/types/project-artifact-bulk-rank";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { projectTreeKeys } from "../project-tree-keys";
import {
  isBulkRankUnsupported,
  projectRankKeys,
  useBulkRankArtifacts,
  useProjectRankState,
} from "../use-bulk-artifact-rank";

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const PROJECT_ID = "11111111-1111-7111-8111-111111111111";
const ROOT_A = "22222222-2222-7222-8222-222222222222";
const ROOT_B = "33333333-3333-7333-8333-333333333333";
const EPOCH = "a".repeat(32);

// Cached tree data is seeded with no observer, which the shared harness's
// gcTime of 0 would collect before the mutation reads it.
function createRetainingQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

const REQUEST = {
  orderedArtifactIds: [ROOT_B, ROOT_A],
  expectedRankEpoch: EPOCH,
  source: BulkRankMutationSource.DependencyRank,
  idempotencyKey: "rank-run-1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useProjectRankState", () => {
  it("reads the project's rank state from the bulk rank endpoint", async () => {
    const state: ProjectRankStateResponse = {
      rankEpoch: EPOCH,
      orderedArtifactIds: [ROOT_A, ROOT_B],
    };
    mockApiClient.get.mockResolvedValue(state);
    const queryClient = createRetainingQueryClient();

    const { result } = renderHook(() => useProjectRankState(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/artifacts/rank`
    );
    expect(result.current.data).toEqual(state);
  });
});

describe("useBulkRankArtifacts", () => {
  it("posts the complete order and invalidates the tree and rank caches", async () => {
    const response: BulkRankArtifactsResponse = {
      ranked: true,
      rankEpoch: "b".repeat(32),
      orderedArtifactIds: [ROOT_B, ROOT_A],
      replayed: false,
    };
    mockApiClient.post.mockResolvedValue(response);
    const queryClient = createRetainingQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useBulkRankArtifacts(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync(REQUEST);
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/artifacts/rank`,
      REQUEST
    );
    await waitFor(() => expect(result.current.data).toEqual(response));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: projectTreeKeys.detail(PROJECT_ID),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: projectRankKeys.state(PROJECT_ID),
    });
  });

  it("still invalidates the rank state after a rejected rewrite", async () => {
    mockApiClient.post.mockRejectedValue(
      new ApiError("rank state changed", 409)
    );
    const queryClient = createRetainingQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useBulkRankArtifacts(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync(REQUEST).catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: projectRankKeys.state(PROJECT_ID),
    });
  });
});

describe("isBulkRankUnsupported", () => {
  it("reports the 404 an older server without the endpoint returns", () => {
    expect(isBulkRankUnsupported(new ApiError("Not found", 404))).toBe(true);
  });

  it("does not claim a rejected or failed request means the endpoint is missing", () => {
    expect(isBulkRankUnsupported(new ApiError("conflict", 409))).toBe(false);
    expect(isBulkRankUnsupported(new ApiError("boom", 500))).toBe(false);
    expect(isBulkRankUnsupported(new Error("offline"))).toBe(false);
  });
});
