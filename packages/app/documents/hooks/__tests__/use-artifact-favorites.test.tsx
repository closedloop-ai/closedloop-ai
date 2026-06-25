import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  artifactFavoriteKeys,
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

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

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
  });
});
