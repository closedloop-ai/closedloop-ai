import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { projectTreeKeys } from "../hooks/project-tree-keys";
import { projectArtifactBoardPageKeys } from "../hooks/use-project-artifact-board-page";
import { invalidateArtifactPlacementViews } from "./artifact-placement-invalidation";

const SOURCE_PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const DESTINATION_PROJECT_ID = "00000000-0000-4000-8000-000000000002";

describe("invalidateArtifactPlacementViews", () => {
  it("refreshes the tree and every board page of each affected project", () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    invalidateArtifactPlacementViews(queryClient, {
      affectedProjectIds: [SOURCE_PROJECT_ID, DESTINATION_PROJECT_ID],
    });

    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    for (const projectId of [SOURCE_PROJECT_ID, DESTINATION_PROJECT_ID]) {
      expect(keys).toContainEqual(projectTreeKeys.detail(projectId));
      expect(keys).toContainEqual(
        projectArtifactBoardPageKeys.project(projectId)
      );
    }
  });
});
