import type {
  ArtifactRatingResponse,
  ArtifactRatingSummary,
} from "@repo/api/src/types/rating";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  ratingKeys,
  useArtifactRating,
  useSubmitRating,
} from "../use-artifact-rating";
import { createWrapper } from "./test-utils";

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function buildUserRating(
  overrides: Partial<ArtifactRatingResponse> = {}
): ArtifactRatingResponse {
  return {
    id: "rating-1",
    userId: "user-1",
    score: 4,
    comment: undefined,
    artifactVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildRatingSummary(
  overrides: Partial<Omit<ArtifactRatingSummary, "userRating">> & {
    userRating?: Partial<ArtifactRatingResponse> | null;
  } = {}
): ArtifactRatingSummary {
  const { userRating, ...rest } = overrides;
  return {
    average: 4.0,
    count: 1,
    userRating: userRating === null ? null : buildUserRating(userRating ?? {}),
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderRatingQuery(artifactId: string) {
  const wrapper = createWrapper();
  const hook = renderHook(() => useArtifactRating(artifactId), { wrapper });
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  return { ...hook, wrapper };
}

// ---------------------------------------------------------------------------
// Tests — useArtifactRating (query)
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useArtifactRating", () => {
  test("fetches rating summary for artifact", async () => {
    const mockSummary = buildRatingSummary({
      average: 4.5,
      count: 2,
      userRating: { score: 5, comment: "Great plan!" },
    });

    mockApiClient.get.mockResolvedValueOnce(mockSummary);

    const { result } = await renderRatingQuery("artifact-1");

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/artifacts/artifact-1/rating"
    );
    expect(result.current.data).toEqual(mockSummary);
  });

  test.each([
    {
      id: "no user rating",
      summary: buildRatingSummary({ average: 3.0, count: 1, userRating: null }),
      assertions: (data: ArtifactRatingSummary) => {
        expect(data.userRating).toBeNull();
        expect(data.average).toBe(3.0);
        expect(data.count).toBe(1);
      },
    },
    {
      id: "zero ratings",
      summary: buildRatingSummary({ average: 0, count: 0, userRating: null }),
      assertions: (data: ArtifactRatingSummary) => {
        expect(data.count).toBe(0);
        expect(data.average).toBe(0);
      },
    },
  ])("returns summary with $id", async ({ summary, assertions }) => {
    mockApiClient.get.mockResolvedValueOnce(summary);

    const { result } = await renderRatingQuery("artifact-1");

    assertions(result.current.data!);
  });

  test("does not fetch when artifactId is empty", () => {
    renderHook(() => useArtifactRating(""), {
      wrapper: createWrapper(),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("uses correct query key", () => {
    expect(ratingKeys.detail("artifact-1")).toEqual([
      "ratings",
      "detail",
      "artifact-1",
    ]);
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

// ---------------------------------------------------------------------------
// Tests — useSubmitRating (mutation)
// ---------------------------------------------------------------------------

describe("useSubmitRating", () => {
  test.each([
    { id: "without comment", score: 4, comment: undefined },
    { id: "with comment", score: 4, comment: "Great work!" },
  ])("submits rating $id", async ({ score, comment }) => {
    mockApiClient.put.mockResolvedValueOnce(
      buildRatingSummary({ userRating: { score, comment } })
    );

    const { result } = renderHook(() => useSubmitRating(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ artifactId: "artifact-1", score, comment });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith(
      "/artifacts/artifact-1/rating",
      { score, comment }
    );
  });

  test("updates existing rating successfully", async () => {
    mockApiClient.get.mockResolvedValueOnce(
      buildRatingSummary({
        average: 3.0,
        userRating: { score: 3, comment: "Old comment" },
      })
    );
    mockApiClient.put.mockResolvedValueOnce(
      buildRatingSummary({
        average: 5.0,
        userRating: { score: 5, comment: "Updated comment" },
      })
    );

    const wrapper = createWrapper();

    const { result: ratingResult } = renderHook(
      () => useArtifactRating("artifact-1"),
      { wrapper }
    );
    await waitFor(() => expect(ratingResult.current.isSuccess).toBe(true));

    const { result: mutationResult } = renderHook(() => useSubmitRating(), {
      wrapper,
    });

    mutationResult.current.mutate({
      artifactId: "artifact-1",
      score: 5,
      comment: "Updated comment",
    });

    await waitFor(() => expect(mutationResult.current.isSuccess).toBe(true));
  });

  test("handles API error", async () => {
    mockApiClient.put.mockRejectedValueOnce(new Error("Failed to save"));

    const { result } = renderHook(() => useSubmitRating(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ artifactId: "artifact-1", score: 4 });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("Failed to save");
  });

  test("invalidates rating query on success", async () => {
    const updatedRating = buildRatingSummary({
      average: 3.5,
      count: 2,
      userRating: { score: 4, comment: "New comment" },
    });

    mockApiClient.get.mockResolvedValueOnce(
      buildRatingSummary({
        average: 3.0,
        count: 2,
        userRating: { score: 3, comment: "Old comment" },
      })
    );
    mockApiClient.put.mockResolvedValueOnce(updatedRating);
    mockApiClient.get.mockResolvedValueOnce(updatedRating); // Refetch after invalidation

    const wrapper = createWrapper();

    const { result: ratingResult } = renderHook(
      () => useArtifactRating("artifact-1"),
      { wrapper }
    );
    await waitFor(() => expect(ratingResult.current.isSuccess).toBe(true));

    expect(ratingResult.current.data?.userRating?.score).toBe(3);
    expect(ratingResult.current.data?.average).toBe(3.0);

    const { result: mutationResult } = renderHook(() => useSubmitRating(), {
      wrapper,
    });

    mutationResult.current.mutate({
      artifactId: "artifact-1",
      score: 4,
      comment: "New comment",
    });

    await waitFor(() => expect(mutationResult.current.isSuccess).toBe(true));

    await waitFor(() => {
      expect(ratingResult.current.data?.userRating?.score).toBe(4);
      expect(ratingResult.current.data?.average).toBe(3.5);
    });
  });

  test("handles first rating when userRating is null", async () => {
    const newRating = buildRatingSummary({ count: 1 });

    mockApiClient.get.mockResolvedValueOnce(
      buildRatingSummary({ average: 0, count: 0, userRating: null })
    );
    mockApiClient.put.mockResolvedValueOnce(newRating);

    const wrapper = createWrapper();

    const { result: ratingResult } = renderHook(
      () => useArtifactRating("artifact-1"),
      { wrapper }
    );
    await waitFor(() => expect(ratingResult.current.isSuccess).toBe(true));

    expect(ratingResult.current.data?.userRating).toBeNull();

    const { result: mutationResult } = renderHook(() => useSubmitRating(), {
      wrapper,
    });

    mutationResult.current.mutate({ artifactId: "artifact-1", score: 4 });

    await waitFor(() => expect(mutationResult.current.isSuccess).toBe(true));
  });
});
