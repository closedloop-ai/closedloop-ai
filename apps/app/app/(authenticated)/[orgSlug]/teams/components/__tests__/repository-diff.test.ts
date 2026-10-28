import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamModalTab, useTeamModal } from "../use-team-modal";
import {
  addMemberMutation,
  addRepoMutation,
  createTeamMutation,
  deleteTeamMutation,
  GITHUB_REPO_B,
  MEMBER_OWNER,
  mockNavigate,
  mockUseCurrentUser,
  mockUseOrganizationUsers,
  mockUseTeamMembers,
  mockUseTeamRepositories,
  REPO_A,
  removeMemberMutation,
  removeRepoMutation,
  resetTeamModalMocks,
  TEAM,
  updateRepoMutation,
  updateRoleMutation,
  updateTeamMutation,
} from "./support/use-team-modal-mocks";

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => mockUseCurrentUser(),
  useOrganizationUsers: () => mockUseOrganizationUsers(),
}));

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useCreateTeam: () => createTeamMutation,
  useUpdateTeam: () => updateTeamMutation,
  useDeleteTeam: () => deleteTeamMutation,
  useAddTeamMember: () => addMemberMutation,
  useRemoveTeamMember: () => removeMemberMutation,
  useUpdateTeamMemberRole: () => updateRoleMutation,
  useTeamMembers: (teamId: string, options: { enabled: boolean }) =>
    mockUseTeamMembers(teamId, options),
  useTeamRepositories: (teamId: string, options: { enabled: boolean }) =>
    mockUseTeamRepositories(teamId, options),
  useAddTeamRepository: () => addRepoMutation,
  useUpdateTeamRepository: () => updateRepoMutation,
  useRemoveTeamRepository: () => removeRepoMutation,
}));

beforeEach(() => {
  resetTeamModalMocks();
});

describe("useTeamModal — repository staging", () => {
  beforeEach(() => {
    mockUseTeamMembers.mockReturnValue({
      data: [MEMBER_OWNER],
      isLoading: false,
    });
    mockUseTeamRepositories.mockReturnValue({
      data: [REPO_A],
      isLoading: false,
    });
  });

  it("keeps repoDrafts null until the Repositories tab is opened", () => {
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );

    expect(result.current.repoDrafts).toBeNull();

    act(() => {
      result.current.stageAddRepo(GITHUB_REPO_B);
    });
    // The guard against staging before hydration keeps this a no-op.
    expect(result.current.repoDrafts).toBeNull();

    act(() => {
      result.current.setActiveTab(TeamModalTab.Repositories);
    });

    expect(result.current.repoDrafts).toEqual([
      expect.objectContaining({
        draftId: REPO_A.id,
        teamRepositoryId: REPO_A.id,
        isDefaultSelected: true,
        isPrimary: true,
      }),
    ]);
  });

  it("clears isPrimary when a default-selected repo is un-defaulted", () => {
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    act(() => {
      result.current.setActiveTab(TeamModalTab.Repositories);
    });

    act(() => {
      result.current.stageToggleDefault(REPO_A.id, false);
    });

    expect(result.current.repoDrafts).toEqual([
      expect.objectContaining({ isDefaultSelected: false, isPrimary: false }),
    ]);
  });

  it("moving primary to a new repo clears the previous primary's flag only", () => {
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    act(() => {
      result.current.setActiveTab(TeamModalTab.Repositories);
    });
    act(() => {
      result.current.stageAddRepo(GITHUB_REPO_B);
    });

    const newDraftId = `new:${GITHUB_REPO_B.id}`;
    act(() => {
      result.current.stageSetPrimary(newDraftId);
    });

    const drafts = result.current.repoDrafts ?? [];
    const previousPrimary = drafts.find((d) => d.draftId === REPO_A.id);
    const newPrimary = drafts.find((d) => d.draftId === newDraftId);

    expect(previousPrimary).toMatchObject({ isPrimary: false });
    // Un-primarying does not also clear isDefaultSelected.
    expect(previousPrimary).toMatchObject({ isDefaultSelected: true });
    expect(newPrimary).toMatchObject({
      isPrimary: true,
      isDefaultSelected: true,
    });
  });

  it("stageRemoveRepo drops the matching staged repository", () => {
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    act(() => {
      result.current.setActiveTab(TeamModalTab.Repositories);
    });

    act(() => {
      result.current.stageRemoveRepo(REPO_A.id);
    });

    expect(result.current.repoDrafts).toEqual([]);
    expect(result.current.hasUnsavedChanges).toBe(true);
  });
});

// ISS-9895, the repositories twin of ISS-9805. The read's outcomes are asserted
// together so none can pass by collapsing into another. The stale case is why
// the guard reads `isLoadingError` and not `isError`: a refetch failure still
// carries the last successful list.
describe("useTeamModal — repositories read outcomes", () => {
  function openRepositoriesTab() {
    const rendered = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    act(() => {
      rendered.result.current.setActiveTab(TeamModalTab.Repositories);
    });
    return rendered;
  }

  it("separates a failed-with-nothing read from a refetch failure, an empty team, and a read in flight or paused", () => {
    mockUseTeamRepositories.mockReturnValue(FAILED_REPOSITORIES_READ);
    const { result: failed } = openRepositoriesTab();
    expect(failed.current.repoDrafts).toBeNull();
    expect(failed.current.configuredReposUnavailable).toBe(true);

    mockUseTeamRepositories.mockReturnValue({
      data: [REPO_A],
      isError: true,
      isLoading: false,
      isLoadingError: false,
    });
    const { result: stale } = openRepositoriesTab();
    expect(stale.current.repoDrafts).toHaveLength(1);
    expect(stale.current.configuredReposUnavailable).toBe(false);

    mockUseTeamRepositories.mockReturnValue({
      data: [],
      isError: false,
      isLoading: false,
      isLoadingError: false,
    });
    const { result: empty } = openRepositoriesTab();
    expect(empty.current.repoDrafts).toEqual([]);
    expect(empty.current.configuredReposUnavailable).toBe(false);

    mockUseTeamRepositories.mockReturnValue({
      data: undefined,
      isError: false,
      isLoading: true,
      isLoadingError: false,
      isPending: true,
    });
    const { result: loading } = openRepositoriesTab();
    expect(loading.current.repoDrafts).toBeNull();
    expect(loading.current.configuredReposUnavailable).toBe(false);

    mockUseTeamRepositories.mockReturnValue({
      data: undefined,
      isError: false,
      isLoading: false,
      isLoadingError: false,
      isPaused: true,
      isPending: true,
    });
    const { result: paused } = openRepositoriesTab();
    expect(paused.current.repoDrafts).toBeNull();
    expect(paused.current.loadingConfiguredRepos).toBe(true);
  });

  it("hydrates from a successful read after a failed one instead of staging every repo for removal", () => {
    mockUseTeamRepositories.mockReturnValue(FAILED_REPOSITORIES_READ);
    const { result, rerender } = openRepositoriesTab();

    mockUseTeamRepositories.mockReturnValue({
      data: [REPO_A],
      isError: false,
      isLoading: false,
      isLoadingError: false,
    });
    rerender();

    expect(result.current.repoDrafts).toEqual([
      expect.objectContaining({ teamRepositoryId: REPO_A.id }),
    ]);
    expect(result.current.hasUnsavedChanges).toBe(false);
  });
});

const FAILED_REPOSITORIES_READ = {
  data: undefined,
  isError: true,
  isLoading: false,
  isLoadingError: true,
  isPending: false,
};
