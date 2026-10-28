import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamModalTab, useTeamModal } from "../use-team-modal";
import {
  addMemberMutation,
  addRepoMutation,
  createTeamMutation,
  deleteTeamMutation,
  fakeSubmitEvent,
  GITHUB_REPO_B,
  MEMBER_OWNER,
  MEMBER_PLAIN,
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

describe("useTeamModal — edit save flow", () => {
  beforeEach(() => {
    mockUseTeamMembers.mockReturnValue({
      data: [MEMBER_OWNER, MEMBER_PLAIN],
      isLoading: false,
    });
    mockUseTeamRepositories.mockReturnValue({
      data: [REPO_A],
      isLoading: false,
    });
  });

  it("updates the team name first, then applies member and repo changes in order, and closes", async () => {
    const callOrder: string[] = [];
    removeMemberMutation.mutateAsync.mockImplementation(() => {
      callOrder.push("memberRemove");
    });
    addRepoMutation.mutateAsync.mockImplementation(() => {
      callOrder.push("repoAdd");
    });

    const onClose = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose, onSuccess })
    );

    act(() => {
      result.current.setActiveTab(TeamModalTab.Repositories);
    });
    act(() => {
      result.current.setName("Engineering Platform");
    });
    act(() => {
      result.current.stageRemoveMember(MEMBER_PLAIN.id);
    });
    act(() => {
      result.current.stageAddRepo(GITHUB_REPO_B);
    });

    act(() => {
      result.current.handleSubmit(fakeSubmitEvent());
    });

    expect(updateTeamMutation.mutate).toHaveBeenCalledWith(
      { id: TEAM.id, input: { name: "Engineering Platform" } },
      expect.any(Object)
    );
    const [, options] = updateTeamMutation.mutate.mock.calls[0];

    act(() => {
      options.onSuccess();
    });

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    expect(removeMemberMutation.mutateAsync).toHaveBeenCalledWith({
      teamId: TEAM.id,
      userId: MEMBER_PLAIN.userId,
    });
    expect(addRepoMutation.mutateAsync).toHaveBeenCalledWith({
      teamId: TEAM.id,
      input: {
        installationRepositoryId: GITHUB_REPO_B.id,
        isDefaultSelected: false,
        isPrimary: false,
      },
    });
    // Member changes are applied before repo changes.
    expect(callOrder).toEqual(["memberRemove", "repoAdd"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("skips the name mutation and saves directly when the name is unchanged", async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose, onSuccess })
    );

    act(() => {
      result.current.stageRemoveMember(MEMBER_PLAIN.id);
    });

    act(() => {
      result.current.handleSubmit(fakeSubmitEvent());
    });

    expect(updateTeamMutation.mutate).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(removeMemberMutation.mutateAsync).toHaveBeenCalledWith({
      teamId: TEAM.id,
      userId: MEMBER_PLAIN.userId,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces the mutation's Error message inline and keeps the modal open", async () => {
    removeMemberMutation.mutateAsync.mockRejectedValueOnce(
      new Error("network blip")
    );
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose, onSuccess })
    );

    act(() => {
      result.current.stageRemoveMember(MEMBER_PLAIN.id);
    });
    act(() => {
      result.current.handleSubmit(fakeSubmitEvent());
    });

    await waitFor(() => {
      expect(result.current.error).toBe("network blip");
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.isSubmitting).toBe(false);
  });

  it("falls back to a generic message when a non-Error is thrown", async () => {
    removeMemberMutation.mutateAsync.mockRejectedValueOnce("boom");
    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );

    act(() => {
      result.current.stageRemoveMember(MEMBER_PLAIN.id);
    });
    act(() => {
      result.current.handleSubmit(fakeSubmitEvent());
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Failed to save team changes.");
    });
  });

  it("reports isSubmitting while the save is in flight, and clears it after", async () => {
    let resolveRemove: () => void = () => undefined;
    removeMemberMutation.mutateAsync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRemove = resolve;
        })
    );

    const { result } = renderHook(() =>
      useTeamModal({ team: TEAM, onClose: vi.fn() })
    );

    act(() => {
      result.current.stageRemoveMember(MEMBER_PLAIN.id);
    });
    act(() => {
      result.current.handleSubmit(fakeSubmitEvent());
    });

    expect(result.current.isSubmitting).toBe(true);

    await act(async () => {
      resolveRemove();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.isSubmitting).toBe(false);
    });
  });
});
