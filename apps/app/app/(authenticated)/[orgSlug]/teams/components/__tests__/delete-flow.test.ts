import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTeamModal } from "../use-team-modal";
import {
  addMemberMutation,
  addRepoMutation,
  createTeamMutation,
  deleteTeamMutation,
  MEMBER_OWNER,
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

describe("useTeamModal — delete flow", () => {
  it("deletes the team, closes the confirmation and modal, and calls onSuccess", () => {
    mockUseTeamMembers.mockReturnValue({
      data: [MEMBER_OWNER],
      isLoading: false,
    });
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose, onSuccess })
    );

    act(() => {
      result.current.setShowDeleteDialog(true);
    });

    act(() => {
      result.current.handleDeleteTeam();
    });

    expect(deleteTeamMutation.mutate).toHaveBeenCalledWith(
      TEAM.id,
      expect.any(Object)
    );
    const [, options] = deleteTeamMutation.mutate.mock.calls[0];

    act(() => {
      options.onSuccess();
    });

    expect(result.current.showDeleteDialog).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("is a no-op with no team to delete", async () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));

    const outcome = await result.current.handleDeleteTeam();

    expect(outcome).toBe(false);
    expect(deleteTeamMutation.mutate).not.toHaveBeenCalled();
  });
});
