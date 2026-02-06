import type { ArtifactRatingSummary } from "@repo/api/src/types/rating";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  ratingKeys,
  useArtifactRating,
  useSubmitRating,
} from "../use-artifact-rating";
import { createWrapper } from "./test-utils";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// Mock sonner toast
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Import the mocked toast to use in assertions
import { toast } from "@repo/design-system/components/ui/sonner";

describe("useArtifactRating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("fetches rating summary for artifact", async () => {
    const mockSummary: ArtifactRatingSummary = {
      average: 4.5,
      count: 2,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 5,
        comment: "Great plan!",
        artifactVersion: 1,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    };

    mockApiClient.get.mockResolvedValueOnce(mockSummary);

    const { result } = renderHook(() => useArtifactRating("artifact-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/artifacts/artifact-1/rating"
    );
    expect(result.current.data).toEqual(mockSummary);
  });

  test("returns summary with no user rating", async () => {
    const mockSummary: ArtifactRatingSummary = {
      average: 3.0,
      count: 1,
      userRating: null,
    };

    mockApiClient.get.mockResolvedValueOnce(mockSummary);

    const { result } = renderHook(() => useArtifactRating("artifact-2"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.userRating).toBeNull();
    expect(result.current.data?.average).toBe(3.0);
    expect(result.current.data?.count).toBe(1);
  });

  test("returns summary with zero ratings", async () => {
    const mockSummary: ArtifactRatingSummary = {
      average: 0,
      count: 0,
      userRating: null,
    };

    mockApiClient.get.mockResolvedValueOnce(mockSummary);

    const { result } = renderHook(() => useArtifactRating("artifact-3"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.count).toBe(0);
    expect(result.current.data?.average).toBe(0);
  });

  test("does not fetch when artifactId is empty", () => {
    renderHook(() => useArtifactRating(""), {
      wrapper: createWrapper(),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("uses correct query key", () => {
    const expectedKey = ratingKeys.detail("artifact-1");
    expect(expectedKey).toEqual(["ratings", "detail", "artifact-1"]);
  });

  test("handles API error", async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useArtifactRating("artifact-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("Network error");
  });
});

describe("useSubmitRating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("submits new rating successfully", async () => {
    const mockSummary: ArtifactRatingSummary = {
      average: 4.0,
      count: 1,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 4,
        comment: undefined,
        artifactVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    mockApiClient.put.mockResolvedValueOnce(mockSummary);

    const { result } = renderHook(() => useSubmitRating(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      artifactId: "artifact-1",
      score: 4,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith(
      "/artifacts/artifact-1/rating",
      {
        score: 4,
        comment: undefined,
      }
    );
    expect(toast.success).toHaveBeenCalledWith("Rating submitted");
  });

  test("updates existing rating successfully", async () => {
    const mockPreviousRating: ArtifactRatingSummary = {
      average: 3.0,
      count: 1,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 3,
        comment: "Old comment",
        artifactVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    const mockUpdatedSummary: ArtifactRatingSummary = {
      average: 5.0,
      count: 1,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 5,
        comment: "Updated comment",
        artifactVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    mockApiClient.get.mockResolvedValueOnce(mockPreviousRating);
    mockApiClient.put.mockResolvedValueOnce(mockUpdatedSummary);

    const wrapper = createWrapper();

    // First, fetch the existing rating
    const { result: ratingResult } = renderHook(
      () => useArtifactRating("artifact-1"),
      { wrapper }
    );

    await waitFor(() => expect(ratingResult.current.isSuccess).toBe(true));

    // Then submit an update
    const { result: mutationResult } = renderHook(() => useSubmitRating(), {
      wrapper,
    });

    mutationResult.current.mutate({
      artifactId: "artifact-1",
      score: 5,
      comment: "Updated comment",
    });

    await waitFor(() => expect(mutationResult.current.isSuccess).toBe(true));

    expect(toast.success).toHaveBeenCalledWith("Rating updated");
  });

  test("submits rating with comment", async () => {
    const mockSummary: ArtifactRatingSummary = {
      average: 4.0,
      count: 1,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 4,
        comment: "Great work!",
        artifactVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    mockApiClient.put.mockResolvedValueOnce(mockSummary);

    const { result } = renderHook(() => useSubmitRating(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      artifactId: "artifact-1",
      score: 4,
      comment: "Great work!",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith(
      "/artifacts/artifact-1/rating",
      {
        score: 4,
        comment: "Great work!",
      }
    );
  });

  test("handles API error and shows toast", async () => {
    mockApiClient.put.mockRejectedValueOnce(new Error("Failed to save"));

    const { result } = renderHook(() => useSubmitRating(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      artifactId: "artifact-1",
      score: 4,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(toast.error).toHaveBeenCalledWith(
      "Failed to submit rating. Please try again."
    );
  });

  test("performs optimistic update on user rating only", async () => {
    const mockPreviousRating: ArtifactRatingSummary = {
      average: 3.0,
      count: 2,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 3,
        comment: "Old comment",
        artifactVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    const mockUpdatedSummary: ArtifactRatingSummary = {
      average: 3.5,
      count: 2,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 4,
        comment: "New comment",
        artifactVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    mockApiClient.get.mockResolvedValueOnce(mockPreviousRating);
    mockApiClient.put.mockResolvedValueOnce(mockUpdatedSummary);
    mockApiClient.get.mockResolvedValueOnce(mockUpdatedSummary); // For refetch after invalidation

    const wrapper = createWrapper();

    // First, fetch the existing rating
    const { result: ratingResult } = renderHook(
      () => useArtifactRating("artifact-1"),
      { wrapper }
    );

    await waitFor(() => expect(ratingResult.current.isSuccess).toBe(true));

    // Verify initial state
    expect(ratingResult.current.data?.userRating?.score).toBe(3);
    expect(ratingResult.current.data?.average).toBe(3.0);

    // Submit an update
    const { result: mutationResult } = renderHook(() => useSubmitRating(), {
      wrapper,
    });

    mutationResult.current.mutate({
      artifactId: "artifact-1",
      score: 4,
      comment: "New comment",
    });

    await waitFor(() => expect(mutationResult.current.isSuccess).toBe(true));

    // After invalidation and refetch, should have server values
    await waitFor(() => {
      expect(ratingResult.current.data?.userRating?.score).toBe(4);
      expect(ratingResult.current.data?.average).toBe(3.5);
    });
  });

  test("rolls back optimistic update on error", async () => {
    const mockPreviousRating: ArtifactRatingSummary = {
      average: 3.0,
      count: 1,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 3,
        comment: "Original",
        artifactVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    mockApiClient.get.mockResolvedValueOnce(mockPreviousRating);
    mockApiClient.put.mockRejectedValueOnce(new Error("Network error"));

    const wrapper = createWrapper();

    // First, fetch the existing rating
    const { result: ratingResult } = renderHook(
      () => useArtifactRating("artifact-1"),
      { wrapper }
    );

    await waitFor(() => expect(ratingResult.current.isSuccess).toBe(true));

    // Submit an update that will fail
    const { result: mutationResult } = renderHook(() => useSubmitRating(), {
      wrapper,
    });

    mutationResult.current.mutate({
      artifactId: "artifact-1",
      score: 5,
    });

    await waitFor(() => expect(mutationResult.current.isError).toBe(true));

    // Should roll back to original value
    expect(ratingResult.current.data?.userRating?.score).toBe(3);
    expect(toast.error).toHaveBeenCalled();
  });

  test("does not attempt to update when userRating is null", async () => {
    const mockPreviousRating: ArtifactRatingSummary = {
      average: 0,
      count: 0,
      userRating: null,
    };

    const mockNewRating: ArtifactRatingSummary = {
      average: 4.0,
      count: 1,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 4,
        comment: undefined,
        artifactVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    mockApiClient.get.mockResolvedValueOnce(mockPreviousRating);
    mockApiClient.put.mockResolvedValueOnce(mockNewRating);

    const wrapper = createWrapper();

    // First, fetch (no existing rating)
    const { result: ratingResult } = renderHook(
      () => useArtifactRating("artifact-1"),
      { wrapper }
    );

    await waitFor(() => expect(ratingResult.current.isSuccess).toBe(true));
    expect(ratingResult.current.data?.userRating).toBeNull();

    // Submit first rating
    const { result: mutationResult } = renderHook(() => useSubmitRating(), {
      wrapper,
    });

    mutationResult.current.mutate({
      artifactId: "artifact-1",
      score: 4,
    });

    await waitFor(() => expect(mutationResult.current.isSuccess).toBe(true));

    expect(toast.success).toHaveBeenCalledWith("Rating submitted");
  });
});
