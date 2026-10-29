import { TeamRole } from "@repo/api/src/types/teams";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTeamModal } from "../use-team-modal";
import {
  addMemberMutation,
  addRepoMutation,
  createTeamMutation,
  deleteTeamMutation,
  fullUser,
  MEMBER_OWNER,
  MEMBER_PLAIN,
  mockNavigate,
  mockUseCurrentUser,
  mockUseOrganizationUsers,
  mockUseTeamMembers,
  mockUseTeamRepositories,
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

describe("useTeamModal — edit mode hydration & permissions", () => {
  it("hydrates memberDrafts from the server member list once loaded", () => {
    mockUseTeamMembers.mockReturnValue({
      data: [MEMBER_OWNER, MEMBER_PLAIN],
      isLoading: false,
    });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ team: TEAM, onClose }));

    expect(result.current.memberDrafts).toEqual([
      expect.objectContaining({
        draftId: MEMBER_OWNER.id,
        teamMemberId: MEMBER_OWNER.id,
        userId: MEMBER_OWNER.userId,
        role: TeamRole.Owner,
      }),
      expect.objectContaining({
        draftId: MEMBER_PLAIN.id,
        teamMemberId: MEMBER_PLAIN.id,
        userId: MEMBER_PLAIN.userId,
        role: TeamRole.Member,
      }),
    ]);
  });

  it("does not hydrate memberDrafts while the members query is loading", () => {
    mockUseTeamMembers.mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: true,
    });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ team: TEAM, onClose }));

    expect(result.current.memberDrafts).toBeNull();
  });

  // ISS-9805. Three settled states the hook must keep apart, asserted in one
  // case so none of them can pass by collapsing into another. The middle one is
  // why the guard reads `isLoadingError` and not `isError`: a REFETCH failure
  // still carries the last successful list, and refusing to hydrate there would
  // take away membership editing the user could previously do — so this case
  // fails if the guard is widened back to `isError`.
  it("separates a failed-with-nothing read from a refetch failure and an empty team", () => {
    mockUseTeamMembers.mockReturnValue({
      data: undefined,
      isError: true,
      isLoading: false,
      isLoadingError: true,
    });
    const { result: failed } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    expect(failed.current.memberDrafts).toBeNull();
    expect(failed.current.isEditMembersUnavailable).toBe(true);

    mockUseTeamMembers.mockReturnValue({
      data: [MEMBER_OWNER, MEMBER_PLAIN],
      isError: true,
      isLoading: false,
      isLoadingError: false,
    });
    const { result: stale } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    expect(stale.current.memberDrafts).toHaveLength(2);
    expect(stale.current.isEditMembersUnavailable).toBe(false);

    mockUseTeamMembers.mockReturnValue({
      data: [],
      isError: false,
      isLoading: false,
      isLoadingError: false,
    });
    const { result: empty } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    expect(empty.current.memberDrafts).toEqual([]);
    expect(empty.current.isEditMembersUnavailable).toBe(false);
  });

  it("treats an Owner or Admin as a team admin, and a Member (or non-member) as not", () => {
    mockUseTeamMembers.mockReturnValue({
      data: [MEMBER_OWNER, MEMBER_PLAIN],
      isLoading: false,
    });

    mockUseCurrentUser.mockReturnValue({
      data: fullUser("user-owner", "Ada", "Owner"),
      isPending: false,
    });
    const { result: ownerResult } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    expect(ownerResult.current.isCurrentUserTeamAdmin).toBe(true);
    expect(ownerResult.current.canManageMembers).toBe(true);

    mockUseCurrentUser.mockReturnValue({
      data: fullUser("user-plain", "Plain", "Person"),
      isPending: false,
    });
    const { result: plainResult } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    expect(plainResult.current.isCurrentUserTeamAdmin).toBe(false);
    expect(plainResult.current.canManageMembers).toBe(false);

    mockUseCurrentUser.mockReturnValue({
      data: fullUser("user-outsider", "No", "Body"),
      isPending: false,
    });
    const { result: outsiderResult } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    expect(outsiderResult.current.isCurrentUserTeamAdmin).toBe(false);
  });

  it("only exposes the Repositories tab in edit mode", () => {
    const { result: createResult } = renderHook(() =>
      useTeamModal({ onClose: vi.fn() })
    );
    expect(createResult.current.showRepositoriesTab).toBe(false);
    expect(createResult.current.canManageMembers).toBe(true);

    const { result: editResult } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );
    expect(editResult.current.showRepositoriesTab).toBe(true);
  });
});
