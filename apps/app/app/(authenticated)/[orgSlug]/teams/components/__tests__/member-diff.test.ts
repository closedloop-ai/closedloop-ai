import { TeamRole } from "@repo/api/src/types/teams";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTeamModal } from "../use-team-modal";
import {
  addMemberMutation,
  addRepoMutation,
  createTeamMutation,
  deleteTeamMutation,
  MEMBER_OWNER,
  MEMBER_PLAIN,
  mockNavigate,
  mockUseCurrentUser,
  mockUseOrganizationUsers,
  mockUseTeamMembers,
  mockUseTeamRepositories,
  ORG_USER_B,
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

describe("useTeamModal — member diff", () => {
  beforeEach(() => {
    mockUseTeamMembers.mockReturnValue({
      data: [MEMBER_OWNER, MEMBER_PLAIN],
      isLoading: false,
    });
    mockUseOrganizationUsers.mockReturnValue({
      data: [ORG_USER_B],
      isLoading: false,
    });
  });

  it("stages a removal of a persisted member as hasMemberChanges", () => {
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );

    expect(result.current.hasUnsavedChanges).toBe(false);

    act(() => {
      result.current.stageRemoveMember(MEMBER_PLAIN.id);
    });

    expect(result.current.hasUnsavedChanges).toBe(true);
  });

  it("stages a role change on a persisted member, but not a no-op re-selection", () => {
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );

    act(() => {
      result.current.stageMemberRoleChange(MEMBER_PLAIN.id, TeamRole.Member);
    });
    expect(result.current.hasUnsavedChanges).toBe(false);

    act(() => {
      result.current.stageMemberRoleChange(MEMBER_PLAIN.id, TeamRole.Admin);
    });
    expect(result.current.hasUnsavedChanges).toBe(true);
  });

  it("stages a new member addition as hasMemberChanges", () => {
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );

    act(() => {
      result.current.setSelectedUserId(ORG_USER_B.id);
    });
    act(() => {
      result.current.handleAddMember();
    });

    expect(result.current.hasUnsavedChanges).toBe(true);
  });
});
