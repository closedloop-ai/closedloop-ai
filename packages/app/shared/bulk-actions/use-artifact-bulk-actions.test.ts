import {
  ArtifactBulkAction,
  ArtifactBulkKind,
} from "@repo/api/src/types/artifact-bulk-action";
import { batchItemApplied } from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@repo/app/shared/api/use-api-client-optional", () => ({
  useApiClientOptional: () => ({ post: mocks.post }),
}));

import { useArtifactBulkActions } from "./use-artifact-bulk-actions";

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";

describe("useArtifactBulkActions", () => {
  it("wires the shared favorite executor to the API client", async () => {
    mocks.post.mockResolvedValue({
      results: [batchItemApplied(BRANCH_ID)],
      transactionId: "favorite-transaction",
    });
    const { result } = renderHook(() =>
      useArtifactBulkActions({
        rows: [{ id: BRANCH_ID, kind: ArtifactBulkKind.Branch }],
      })
    );
    const favorite = result.current.find(
      (entry) => entry.id === ArtifactBulkAction.ChangeFavorite
    );
    expect(favorite).toBeDefined();
    await expect(favorite?.execute(true)).resolves.toEqual({
      results: [batchItemApplied(BRANCH_ID)],
      transactionIds: ["favorite-transaction"],
    });
    expect(mocks.post).toHaveBeenCalledWith(
      BatchMutationRoute.ArtifactsFavorites,
      { artifactIds: [BRANCH_ID], favorite: true }
    );
  });
});
