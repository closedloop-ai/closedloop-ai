import { ArtifactBulkAction } from "@repo/api/src/types/artifact-bulk-action";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProjectIndexBulkActions } from "./project-index-bulk-actions";

const mocks = vi.hoisted(() => ({
  favorite: vi.fn(),
  unfavorite: vi.fn(),
  updateOwner: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => true,
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useFavoriteProject: () => ({ mutateAsync: mocks.favorite }),
  useFavoriteProjects: () => ({
    data: [{ id: "11111111-1111-4111-8111-111111111111" }],
  }),
  useUnfavoriteProject: () => ({ mutateAsync: mocks.unfavorite }),
  useUpdateProjectAssignee: () => ({ mutateAsync: mocks.updateOwner }),
  useUpdateProjectStatus: () => ({ mutateAsync: mocks.updateStatus }),
}));

const PROJECT_A = project("11111111-1111-4111-8111-111111111111", "Apollo");
const PROJECT_B = project("22222222-2222-4222-8222-222222222222", "Borealis");

describe("Projects index bulk actions", () => {
  it("offers every action supported by Project rows and no artifact-only action", () => {
    const { result } = renderHook(() =>
      useProjectIndexBulkActions({
        projects: [PROJECT_A, PROJECT_B],
        selectedIds: new Set([PROJECT_A.id, PROJECT_B.id]),
      })
    );

    expect(result.current.enabled).toBe(true);
    expect(result.current.actions.map((action) => action.id)).toEqual([
      ArtifactBulkAction.ChangeFavorite,
      ArtifactBulkAction.ChangeStatus,
      ArtifactBulkAction.ChangeOwner,
    ]);
  });

  it("sets one favorite state for a mixed Project selection", async () => {
    const { result } = renderHook(() =>
      useProjectIndexBulkActions({
        projects: [PROJECT_A, PROJECT_B],
        selectedIds: new Set([PROJECT_A.id, PROJECT_B.id]),
      })
    );
    const favorite = result.current.actions.find(
      (action) => action.id === ArtifactBulkAction.ChangeFavorite
    );
    if (favorite?.kind !== "command") {
      throw new Error("Expected the Project favorite action");
    }

    favorite.onSelect([PROJECT_A.id, PROJECT_B.id], {
      clear: vi.fn(),
      retain: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(mocks.favorite).toHaveBeenCalledWith(PROJECT_B.id)
    );
    expect(mocks.favorite).toHaveBeenCalledTimes(1);
    expect(mocks.unfavorite).not.toHaveBeenCalled();
  });
});

function project(id: string, name: string): ProjectWithDetails {
  const now = new Date("2026-10-21T00:00:00Z");
  return {
    assigneeId: null,
    codebaseSummary: null,
    completionPercentage: 0,
    createdAt: now,
    createdById: "33333333-3333-4333-8333-333333333333",
    description: null,
    id,
    lastIndexedAt: null,
    name,
    organizationId: "44444444-4444-4444-8444-444444444444",
    priority: null,
    settings: {},
    slug: null,
    sortOrder: null,
    status: ProjectStatus.InProgress,
    targetDate: null,
    teams: [],
    updatedAt: now,
  };
}
