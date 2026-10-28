import type { Artifact } from "@repo/api/src/types/artifact";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useToggleFavoriteArtifact } from "../use-artifact-favorites";
import {
  useFavoriteArtifactIds,
  usePendingFavoriteArtifactIds,
} from "../use-favorite-artifact-ids";

const mockApiClient = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const FAVORITE = { id: "artifact-a" } as Artifact;

describe("useFavoriteArtifactIds", () => {
  it("reads a settled list as ids", () => {
    const { result } = renderHook(() =>
      useFavoriteArtifactIds({
        data: [FAVORITE],
        isError: false,
        isPending: false,
      })
    );
    expect(result.current.isUnavailable).toBe(false);
    expect([...result.current.favoriteIds]).toEqual([FAVORITE.id]);
  });

  it.each([
    ["pending", { data: undefined, isError: false, isPending: true }],
    ["errored", { data: undefined, isError: true, isPending: false }],
    [
      "malformed",
      {
        data: { id: FAVORITE.id } as unknown as Artifact[],
        isError: false,
        isPending: false,
      },
    ],
  ])("never reads a %s list as no favourites", (_name, read) => {
    const { result } = renderHook(() => useFavoriteArtifactIds(read));
    expect(result.current.isUnavailable).toBe(true);
    expect(result.current.favoriteIds.size).toBe(0);
  });
});

describe("usePendingFavoriteArtifactIds", () => {
  it("names each artifact whose toggle is in flight until it settles", async () => {
    let settle: (value: unknown) => void = () => undefined;
    mockApiClient.post.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );
    const wrapper = createWrapperWithClient(createTestQueryClient());
    const { result } = renderHook(
      () => ({
        pending: usePendingFavoriteArtifactIds(),
        toggle: useToggleFavoriteArtifact(),
      }),
      { wrapper }
    );
    expect(result.current.pending.size).toBe(0);

    act(() => {
      result.current.toggle.mutate({
        artifactId: FAVORITE.id,
        isFavorite: false,
      });
    });
    await waitFor(() =>
      expect(result.current.pending.has(FAVORITE.id)).toBe(true)
    );

    act(() => {
      settle({});
    });
    await waitFor(() => expect(result.current.pending.size).toBe(0));
  });
});
