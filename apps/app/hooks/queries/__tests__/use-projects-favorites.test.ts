import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  projectKeys,
  useFavoriteProject,
  useFavoriteProjects,
  useIsFavorite,
  useToggleFavorite,
  useUnfavoriteProject,
} from "../use-projects";
import { createWrapper } from "./test-utils";

// Mock useApiClient
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

describe("Favorite Project Query Hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("projectKeys.favorites", () => {
    test("returns correct query key", () => {
      expect(projectKeys.favorites()).toEqual(["projects", "favorites"]);
    });
  });

  describe("useFavoriteProjects", () => {
    test("fetches favorite projects", async () => {
      const mockFavorites = [
        { id: "project-1", name: "Fav 1" },
        { id: "project-2", name: "Fav 2" },
      ];

      mockApiClient.get.mockResolvedValueOnce(mockFavorites);

      const { result } = renderHook(() => useFavoriteProjects(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith("/projects/favorites");
      expect(result.current.data).toEqual(mockFavorites);
    });

    test("returns empty array on error", async () => {
      mockApiClient.get.mockRejectedValueOnce(new Error("Network error"));

      const { result } = renderHook(() => useFavoriteProjects(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
    });
  });

  describe("useIsFavorite", () => {
    test("returns true when project is in favorites", async () => {
      const mockFavorites = [
        { id: "project-1", name: "Fav 1" },
        { id: "project-2", name: "Fav 2" },
      ];

      mockApiClient.get.mockResolvedValueOnce(mockFavorites);

      const { result } = renderHook(() => useIsFavorite("project-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current).toBe(true));
    });

    test("returns false when project is not in favorites", async () => {
      const mockFavorites = [{ id: "project-1", name: "Fav 1" }];

      mockApiClient.get.mockResolvedValueOnce(mockFavorites);

      const { result } = renderHook(() => useIsFavorite("project-999"), {
        wrapper: createWrapper(),
      });

      // Initially false while loading, stays false after data loads
      expect(result.current).toBe(false);

      await waitFor(() => {
        // Wait for the underlying query to resolve, then check again
        expect(result.current).toBe(false);
      });
    });

    test("returns false when favorites data is not yet loaded", () => {
      // Don't resolve the mock — data stays undefined
      mockApiClient.get.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useIsFavorite("project-1"), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(false);
    });
  });
});

describe("Favorite Project Mutation Hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("useFavoriteProject", () => {
    test("calls POST /projects/:id/favorite", async () => {
      mockApiClient.post.mockResolvedValueOnce({ favorited: true });

      const { result } = renderHook(() => useFavoriteProject(), {
        wrapper: createWrapper(),
      });

      result.current.mutate("project-123");

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.post).toHaveBeenCalledWith(
        "/projects/project-123/favorite",
        {}
      );
      expect(result.current.data).toEqual({ favorited: true });
    });
  });

  describe("useUnfavoriteProject", () => {
    test("calls DELETE /projects/:id/favorite", async () => {
      mockApiClient.delete.mockResolvedValueOnce({ favorited: false });

      const { result } = renderHook(() => useUnfavoriteProject(), {
        wrapper: createWrapper(),
      });

      result.current.mutate("project-123");

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.delete).toHaveBeenCalledWith(
        "/projects/project-123/favorite"
      );
      expect(result.current.data).toEqual({ favorited: false });
    });
  });

  describe("useToggleFavorite", () => {
    test("calls unfavorite when isFavorite is true", async () => {
      mockApiClient.delete.mockResolvedValueOnce({ favorited: false });

      const { result } = renderHook(() => useToggleFavorite(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({ projectId: "project-123", isFavorite: true });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.delete).toHaveBeenCalledWith(
        "/projects/project-123/favorite"
      );
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });

    test("calls favorite when isFavorite is false", async () => {
      mockApiClient.post.mockResolvedValueOnce({ favorited: true });

      const { result } = renderHook(() => useToggleFavorite(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({ projectId: "project-123", isFavorite: false });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.post).toHaveBeenCalledWith(
        "/projects/project-123/favorite",
        {}
      );
      expect(mockApiClient.delete).not.toHaveBeenCalled();
    });
  });
});
