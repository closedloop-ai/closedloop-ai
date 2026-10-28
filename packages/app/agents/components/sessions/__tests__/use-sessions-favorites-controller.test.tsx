import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "../../../../shared/test-utils";
import { useSessionsFavoritesController } from "../use-sessions-favorites-controller";

/**
 * ISS-12691: the Sessions row star, shared by the web and Desktop hosts
 * (marisolashgrove review cid 4327728360). `enabled` is the host's claim that its
 * row ids are cloud artifact ids.
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  useFavoriteArtifacts: vi.fn(),
}));

vi.mock("../../../../documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: (options: unknown) =>
    mocks.useFavoriteArtifacts(options),
  useToggleFavoriteArtifact: () => ({
    mutate: mocks.mutate,
    mutateAsync: mocks.mutateAsync,
  }),
}));

function renderController(enabled: boolean) {
  return renderHook(() => useSessionsFavoritesController(enabled), {
    wrapper: createWrapperWithClient(createTestQueryClient()),
  });
}

describe("useSessionsFavoritesController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFavoriteArtifacts.mockReturnValue({
      data: [{ id: "session-1" }],
      isError: false,
      isPending: false,
    });
    mocks.mutateAsync.mockResolvedValue(undefined);
  });

  it("supplies a controller when enabled and omits it when not", () => {
    // Omitting it is how a host says it has no favourites concept at all —
    // Desktop's local mode, whose session ids are not artifact ids.
    expect(renderController(true).result.current).not.toBeUndefined();
    expect(renderController(false).result.current).toBeUndefined();
  });

  it("fires no favorites query when disabled", () => {
    renderController(false);

    expect(mocks.useFavoriteArtifacts).toHaveBeenCalledWith({
      enabled: false,
    });
  });

  it("reads the batched favorites list into favoriteIds", () => {
    const { result } = renderController(true);

    expect(result.current?.favoriteIds.has("session-1")).toBe(true);
    expect(result.current?.isUnavailable).toBe(false);
  });

  it("reports isUnavailable while the read is pending or errored", () => {
    mocks.useFavoriteArtifacts.mockReturnValue({
      data: undefined,
      isError: true,
      isPending: false,
    });

    expect(renderController(true).result.current?.isUnavailable).toBe(true);
  });

  it("reports a malformed response as unavailable, not as no favorites", () => {
    // whitlockk review cid 4327674216: a body that is not an array resolves, so
    // neither `isError` nor `isPending` reports it. An empty set with
    // `isUnavailable: false` renders every existing favourite unstarred and
    // sends the ADD path on a click against that false state.
    mocks.useFavoriteArtifacts.mockReturnValue({
      data: { unexpected: "shape" },
      isError: false,
      isPending: false,
    });

    const { result } = renderController(true);

    expect(result.current?.isUnavailable).toBe(true);
    expect(result.current?.favoriteIds.size).toBe(0);
  });

  it("toggles the CURRENT state's negation, not the desired state forwarded blindly", () => {
    const { result } = renderController(true);

    result.current?.onChange({ id: "session-1" } as never, true);

    expect(mocks.mutate).toHaveBeenCalledWith({
      artifactId: "session-1",
      isFavorite: false,
    });
  });

  it("splits a partially-failing bulk change into the rows that landed and the rows that did not", async () => {
    mocks.mutateAsync.mockImplementation(
      ({ artifactId }: { artifactId: string }) =>
        artifactId === "session-2"
          ? Promise.reject(new Error("rejected row"))
          : Promise.resolve(undefined)
    );
    const { result } = renderController(true);

    const outcome = await result.current?.onBulkChange?.(
      [{ id: "session-1" }, { id: "session-2" }, { id: "session-3" }] as never,
      true
    );

    expect(outcome).toEqual({
      failedIds: ["session-2"],
      succeededIds: ["session-1", "session-3"],
    });
  });

  it("forwards the negated favorited flag for every row of a bulk change", async () => {
    const { result } = renderController(true);

    await result.current?.onBulkChange?.(
      [{ id: "session-1" }, { id: "session-2" }] as never,
      true
    );

    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      artifactId: "session-1",
      isFavorite: false,
    });
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      artifactId: "session-2",
      isFavorite: false,
    });
  });
});
