import {
  createTestQueryClient,
  createWrapper,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { assignedArtifactTreeKeys } from "../../../projects/hooks/use-assigned-artifact-tree";
import { artifactFavoriteKeys } from "../artifact-favorite-keys";
import { documentKeys } from "../document-keys";
import {
  useFavoriteArtifacts,
  useIsFavoriteArtifact,
  useToggleFavoriteArtifact,
} from "../use-artifact-favorites";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

describe("Artifact Favorite Query Hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("artifactFavoriteKeys", () => {
    test("returns correct query key", () => {
      expect(artifactFavoriteKeys.list()).toEqual([
        "artifact-favorites",
        "list",
      ]);
    });
  });

  describe("useFavoriteArtifacts", () => {
    test("fetches favorite artifacts", async () => {
      const mockFavorites = [
        { id: "artifact-1", name: "Fav 1" },
        { id: "artifact-2", name: "Fav 2" },
      ];

      mockApiClient.get.mockResolvedValueOnce(mockFavorites);

      const { result } = renderHook(() => useFavoriteArtifacts(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith("/artifacts/favorites");
      expect(result.current.data).toEqual(mockFavorites);
    });

    test("returns error state on failure", async () => {
      mockApiClient.get.mockRejectedValueOnce(new Error("Network error"));

      const { result } = renderHook(() => useFavoriteArtifacts(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
    });
  });

  describe("useIsFavoriteArtifact", () => {
    test("returns true when artifact is in favorites", async () => {
      const mockFavorites = [
        { id: "artifact-1", name: "Fav 1" },
        { id: "artifact-2", name: "Fav 2" },
      ];

      mockApiClient.get.mockResolvedValueOnce(mockFavorites);

      const { result } = renderHook(() => useIsFavoriteArtifact("artifact-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current).toBe(true));
    });

    test("returns false when artifact is not in favorites", async () => {
      const mockFavorites = [{ id: "artifact-1", name: "Fav 1" }];

      mockApiClient.get.mockResolvedValueOnce(mockFavorites);

      const { result } = renderHook(
        () => useIsFavoriteArtifact("artifact-999"),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(mockApiClient.get).toHaveBeenCalledWith("/artifacts/favorites");
      });

      expect(result.current).toBe(false);
    });

    test("returns false when favorites data is not yet loaded", () => {
      mockApiClient.get.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useIsFavoriteArtifact("artifact-1"), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(false);
    });
  });
});

describe("Artifact Favorite Mutation Hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("useToggleFavoriteArtifact", () => {
    test("calls DELETE when isFavorite is true (unfavoriting)", async () => {
      mockApiClient.delete.mockResolvedValueOnce({ favorited: false });

      const { result } = renderHook(() => useToggleFavoriteArtifact(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        artifactId: "artifact-123",
        isFavorite: true,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.delete).toHaveBeenCalledWith(
        "/artifacts/artifact-123/favorite"
      );
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });

    test("calls POST when isFavorite is false (favoriting)", async () => {
      mockApiClient.post.mockResolvedValueOnce({ favorited: true });

      const { result } = renderHook(() => useToggleFavoriteArtifact(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        artifactId: "artifact-123",
        isFavorite: false,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.post).toHaveBeenCalledWith(
        "/artifacts/artifact-123/favorite",
        {}
      );
      expect(mockApiClient.delete).not.toHaveBeenCalled();
    });

    // ISS-12600: a favorites-scoped Documents card keeps its query key when the
    // favorite set changes, so the toggle must refetch the card reads.
    test("refetches the Documents summary and cost reads", async () => {
      mockApiClient.post.mockResolvedValueOnce({ favorited: true });
      const queryClient = createTestQueryClient();
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      const { result } = renderHook(() => useToggleFavoriteArtifact(), {
        wrapper: createWrapperWithClient(queryClient),
      });

      result.current.mutate({ artifactId: "artifact-123", isFavorite: false });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: documentKeys.summaries(),
      });
    });

    // ISS-10472: Favorites is a SERVER facet on the My Tasks All tab, so the
    // tree read that drew the page and counted its total is a view the star
    // moves. Asserted on the seeded page entry rather than on the invalidate
    // call, so it is the prefix reaching the cache that goes red — not merely
    // that a key was named.
    test("refetches the assigned tree the All tab pages from", async () => {
      mockApiClient.delete.mockResolvedValueOnce({ favorited: false });
      const queryClient = createTestQueryClient();
      const pageKey = assignedArtifactTreeKeys.page("user-1", {
        limit: 50,
        offset: 0,
        search: "",
        facets: { favoritesOnly: true },
      });
      // `createTestQueryClient` sets `gcTime: 0`, which collects an
      // observer-less entry the moment it is written — the seeded page would be
      // gone before the mutation ran, and the assertion below would read
      // `undefined` rather than the invalidation it is checking.
      queryClient.setQueryDefaults(pageKey, {
        gcTime: Number.POSITIVE_INFINITY,
      });
      queryClient.setQueryData(pageKey, { nodes: [], externalParents: [] });
      const { result } = renderHook(() => useToggleFavoriteArtifact(), {
        wrapper: createWrapperWithClient(queryClient),
      });

      result.current.mutate({ artifactId: "artifact-123", isFavorite: true });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(queryClient.getQueryState(pageKey)?.isInvalidated).toBe(true);
    });
  });
});
