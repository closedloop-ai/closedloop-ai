// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchRow } from "../../lib/branch-row";
import { useBranchFavoritesController } from "../use-branch-favorites-controller";

const favoriteMocks = vi.hoisted(() => ({
  pending: new Set<string>(),
  read: vi.fn(),
  write: vi.fn(),
}));

vi.mock("../../../documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: favoriteMocks.read,
  useToggleFavoriteArtifact: () => ({ mutate: favoriteMocks.write }),
}));

vi.mock(
  "../../../documents/hooks/use-favorite-artifact-ids",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../documents/hooks/use-favorite-artifact-ids")
    >()),
    usePendingFavoriteArtifactIds: () => favoriteMocks.pending,
  })
);

const ROW = {
  id: "repo::branch",
  artifactId: "branch-artifact-id",
  branchName: "feature/shared-star",
} as BranchRow;

beforeEach(() => {
  favoriteMocks.pending = new Set();
  favoriteMocks.read.mockReset();
  favoriteMocks.write.mockReset();
  favoriteMocks.read.mockReturnValue({
    data: [{ id: ROW.artifactId }],
    isError: false,
    isPending: false,
  });
});

describe("useBranchFavoritesController", () => {
  it("stars and unstars through the existing store by artifact id", () => {
    const { result } = renderHook(() => useBranchFavoritesController());
    const controller = result.current;
    expect(controller?.favoriteIds.has(ROW.artifactId!)).toBe(true);
    expect(controller?.getArtifactId(ROW)).toBe(ROW.artifactId);

    controller?.onChange(ROW, true);
    controller?.onChange(ROW, false);

    expect(favoriteMocks.write).toHaveBeenNthCalledWith(1, {
      artifactId: ROW.artifactId,
      isFavorite: false,
    });
    expect(favoriteMocks.write).toHaveBeenNthCalledWith(2, {
      artifactId: ROW.artifactId,
      isFavorite: true,
    });
  });

  it("does not mutate a legacy row without artifact identity", () => {
    const { result } = renderHook(() => useBranchFavoritesController());
    const row = { ...ROW, artifactId: undefined };
    expect(result.current?.getArtifactId(row)).toBeUndefined();
    result.current?.onChange(row, false);
    expect(favoriteMocks.write).not.toHaveBeenCalled();
  });

  it("keeps an unread favorite list unavailable", () => {
    favoriteMocks.read.mockReturnValue({
      data: undefined,
      isError: false,
      isPending: true,
    });
    const { result } = renderHook(() => useBranchFavoritesController());
    expect(result.current?.isUnavailable).toBe(true);
  });

  it("names the rows whose toggle is in flight", () => {
    favoriteMocks.pending = new Set([ROW.artifactId ?? ""]);
    const { result } = renderHook(() => useBranchFavoritesController());
    expect(result.current.pendingIds?.has(ROW.artifactId ?? "")).toBe(true);
  });
});
