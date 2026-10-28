import { TeamRole } from "@repo/api/src/types/teams";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTeamModal } from "../use-team-modal";
import {
  addMemberMutation,
  addRepoMutation,
  CURRENT_USER,
  createTeamMutation,
  deleteTeamMutation,
  fakeSubmitEvent,
  mockNavigate,
  mockUseCurrentUser,
  mockUseOrganizationUsers,
  mockUseTeamMembers,
  mockUseTeamRepositories,
  ORG_USER_B,
  removeMemberMutation,
  removeRepoMutation,
  resetTeamModalMocks,
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

describe("useTeamModal — create mode", () => {
  it("seeds the current user as Owner once /me resolves, and clears isCreateOwnerPending", () => {
    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: 0,
      isPending: true,
    });
    const onClose = vi.fn();
    const { result, rerender } = renderHook(() => useTeamModal({ onClose }));

    expect(result.current.memberDrafts).toBeNull();
    expect(result.current.isCreateOwnerPending).toBe(true);
    expect(result.current.isCreateOwnerUnavailable).toBe(false);

    mockUseCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isPending: false,
    });
    rerender();

    expect(result.current.memberDrafts).toEqual([
      expect.objectContaining({
        draftId: "seed:user-owner",
        teamMemberId: null,
        userId: "user-owner",
        role: TeamRole.Owner,
      }),
    ]);
    expect(result.current.isCreateOwnerPending).toBe(false);
  });

  // ISS-9794. `/me` settling with no user is a finished read, not a slow one: the shared
  // query client fails a response-backed error without retrying, and nothing
  // re-runs the read until the user asks (ISS-11068). The two owner flags must
  // therefore disagree here — a pending flag that stayed true is what let the
  // members panel claim to be loading forever.
  it("reports the owner unavailable, not pending, once /me settles with no user", () => {
    mockUseCurrentUser.mockReturnValue({ data: undefined, isPending: false });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));

    act(() => {
      result.current.setName("New Team");
    });

    expect(result.current.isCreateOwnerPending).toBe(false);
    expect(result.current.isCreateOwnerUnavailable).toBe(true);
    expect(result.current.memberDrafts).toBeNull();
    expect(result.current.disableSubmit).toBe(true);
  });

  // ISS-11068. Retry re-reads `/me`, and TanStack puts a query with no data
  // back to `pending` while it does, keeping `errorUpdatedAt` — the harness
  // models that. The retry stays
  // in the failed state (so the panel keeps its Retry button) and only a
  // resolved user makes the dialog submittable.
  it("re-reads /me on retry and becomes submittable once the owner resolves", () => {
    const refetch = vi.fn();
    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: false,
      refetch,
    });
    const onClose = vi.fn();
    const { result, rerender } = renderHook(() => useTeamModal({ onClose }));

    act(() => {
      result.current.setName("New Team");
    });
    act(() => {
      result.current.retryCreateOwner();
    });
    expect(refetch).toHaveBeenCalledTimes(1);

    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: true,
      refetch,
    });
    rerender();

    expect(result.current.isCreateOwnerRetrying).toBe(true);
    expect(result.current.isCreateOwnerUnavailable).toBe(true);
    expect(result.current.isCreateOwnerPending).toBe(false);
    expect(result.current.disableSubmit).toBe(true);

    mockUseCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isPending: false,
      refetch,
    });
    rerender();

    expect(result.current.isCreateOwnerRetrying).toBe(false);
    expect(result.current.isCreateOwnerUnavailable).toBe(false);
    expect(result.current.memberDrafts).toEqual([
      expect.objectContaining({ userId: "user-owner", role: TeamRole.Owner }),
    ]);
    expect(result.current.disableSubmit).toBe(false);
  });

  it("stays in the failed state with submit disabled when the retry fails again", () => {
    const refetch = vi.fn();
    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: false,
      refetch,
    });
    const onClose = vi.fn();
    const { result, rerender } = renderHook(() => useTeamModal({ onClose }));

    act(() => {
      result.current.setName("New Team");
    });
    act(() => {
      result.current.retryCreateOwner();
    });
    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: true,
      refetch,
    });
    rerender();
    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: false,
      refetch,
    });
    rerender();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result.current.isCreateOwnerRetrying).toBe(false);
    expect(result.current.isCreateOwnerUnavailable).toBe(true);
    expect(result.current.isCreateOwnerPending).toBe(false);
    expect(result.current.memberDrafts).toBeNull();
    expect(result.current.disableSubmit).toBe(true);
  });

  // Review on #7850: a focus or reconnect refetch re-reads a failed `/me`
  // without anyone pressing Retry. It must stay in the failed state too, so
  // the panel does not swap to the loading copy under a focused Retry.
  it("keeps the failed state through a re-read nobody asked for", () => {
    const refetch = vi.fn();
    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: true,
      refetch,
    });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));

    expect(refetch).not.toHaveBeenCalled();
    expect(result.current.isCreateOwnerRetrying).toBe(true);
    expect(result.current.isCreateOwnerUnavailable).toBe(true);
    expect(result.current.isCreateOwnerPending).toBe(false);
  });

  it("keeps submit disabled while the owner is pending, even with a name typed", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));

    act(() => {
      result.current.setName("New Team");
    });

    expect(result.current.disableSubmit).toBe(true);
  });

  it("disables submit when the name is blank", () => {
    mockUseCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isPending: false,
    });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));

    expect(result.current.name).toBe("");
    expect(result.current.disableSubmit).toBe(true);
  });

  it("ignores handleAddMember when no user is selected", () => {
    mockUseCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isPending: false,
    });
    mockUseOrganizationUsers.mockReturnValue({
      data: [CURRENT_USER, ORG_USER_B],
      isLoading: false,
    });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));

    const before = result.current.memberDrafts;
    act(() => {
      result.current.handleAddMember();
    });

    expect(result.current.memberDrafts).toBe(before);
  });

  it("ignores handleAddMember before member drafts have hydrated", () => {
    // currentUser still unresolved => memberDrafts is null.
    mockUseOrganizationUsers.mockReturnValue({
      data: [ORG_USER_B],
      isLoading: false,
    });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));

    act(() => {
      result.current.setSelectedUserId(ORG_USER_B.id);
    });
    act(() => {
      result.current.handleAddMember();
    });

    expect(result.current.memberDrafts).toBeNull();
  });

  it("stages a new member, resets the picker, and removes them from availableUsers", () => {
    mockUseCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isPending: false,
    });
    mockUseOrganizationUsers.mockReturnValue({
      data: [CURRENT_USER, ORG_USER_B],
      isLoading: false,
    });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));

    // Only the current user is seeded, so Bob is still available.
    expect(result.current.availableUsers.map((u) => u.id)).toEqual([
      ORG_USER_B.id,
    ]);

    act(() => {
      result.current.setSelectedUserId(ORG_USER_B.id);
      result.current.setSelectedRole(TeamRole.Admin);
    });
    act(() => {
      result.current.handleAddMember();
    });

    expect(result.current.memberDrafts).toEqual([
      expect.objectContaining({ userId: CURRENT_USER.id }),
      expect.objectContaining({
        draftId: `new:${ORG_USER_B.id}`,
        teamMemberId: null,
        userId: ORG_USER_B.id,
        role: TeamRole.Admin,
      }),
    ]);
    // Picker resets after staging.
    expect(result.current.selectedUserId).toBe("");
    expect(result.current.selectedRole).toBe(TeamRole.Member);
    // Bob is now staged, so he drops out of availableUsers.
    expect(result.current.availableUsers).toEqual([]);
  });

  it("removes a staged (unsaved) member via stageRemoveMember", () => {
    mockUseCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isPending: false,
    });
    mockUseOrganizationUsers.mockReturnValue({
      data: [CURRENT_USER, ORG_USER_B],
      isLoading: false,
    });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));

    act(() => {
      result.current.setSelectedUserId(ORG_USER_B.id);
    });
    act(() => {
      result.current.handleAddMember();
    });
    act(() => {
      result.current.stageRemoveMember(`new:${ORG_USER_B.id}`);
    });

    expect(result.current.memberDrafts).toEqual([
      expect.objectContaining({ userId: CURRENT_USER.id }),
    ]);
    expect(result.current.availableUsers.map((u) => u.id)).toEqual([
      ORG_USER_B.id,
    ]);
  });

  it("is a no-op when the name is blank on submit", () => {
    mockUseCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isPending: false,
    });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));

    const event = fakeSubmitEvent();
    act(() => {
      result.current.handleSubmit(event);
    });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(createTeamMutation.mutate).not.toHaveBeenCalled();
  });

  it("creates the team, adds staged non-owner members, navigates, and closes", async () => {
    mockUseCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isPending: false,
    });
    mockUseOrganizationUsers.mockReturnValue({
      data: [CURRENT_USER, ORG_USER_B],
      isLoading: false,
    });
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose, onSuccess }));

    act(() => {
      result.current.setName("Platform");
    });
    act(() => {
      result.current.setSelectedUserId(ORG_USER_B.id);
    });
    act(() => {
      result.current.handleAddMember();
    });

    act(() => {
      result.current.handleSubmit(fakeSubmitEvent());
    });

    expect(createTeamMutation.mutate).toHaveBeenCalledWith(
      { name: "Platform" },
      expect.any(Object)
    );
    const [, options] = createTeamMutation.mutate.mock.calls[0];
    const newTeam = { id: "team-new", name: "Platform" };

    await act(async () => {
      await options.onSuccess(newTeam);
    });

    // The server already auto-adds the caller as Owner; only Bob's addition fires.
    expect(addMemberMutation.mutateAsync).toHaveBeenCalledTimes(1);
    expect(addMemberMutation.mutateAsync).toHaveBeenCalledWith({
      teamId: newTeam.id,
      userId: ORG_USER_B.id,
      role: TeamRole.Member,
    });
    expect(mockNavigate).toHaveBeenCalledWith(
      `/acme/teams/${newTeam.id}/projects`
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed create draft and retries additions on the same team", async () => {
    mockUseCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isPending: false,
    });
    mockUseOrganizationUsers.mockReturnValue({
      data: [CURRENT_USER, ORG_USER_B],
      isLoading: false,
    });
    const onClose = vi.fn();
    const { result } = renderHook(() => useTeamModal({ onClose }));
    act(() => {
      result.current.setName("Platform");
      result.current.setSelectedUserId(ORG_USER_B.id);
    });
    act(() => result.current.handleAddMember());
    addMemberMutation.mutateAsync.mockRejectedValueOnce(
      new Error("Membership save failed")
    );
    act(() => result.current.handleSubmit(fakeSubmitEvent()));
    const [, options] = createTeamMutation.mutate.mock.calls[0];
    await act(async () =>
      options.onSuccess({ id: "team-created", name: "Platform" })
    );
    expect(result.current.error).toBe("Membership save failed");
    expect(result.current.memberDrafts).toHaveLength(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    await act(async () => result.current.handleSubmit(fakeSubmitEvent()));
    expect(createTeamMutation.mutate).toHaveBeenCalledTimes(1);
    expect(addMemberMutation.mutateAsync).toHaveBeenCalledTimes(2);
    expect(mockNavigate).toHaveBeenCalledWith(
      "/acme/teams/team-created/projects"
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not navigate from a save that completes after the dialog unmounts", async () => {
    mockUseCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isPending: false,
    });
    mockUseOrganizationUsers.mockReturnValue({
      data: [CURRENT_USER, ORG_USER_B],
      isLoading: false,
    });
    let completeMember: (() => void) | undefined;
    const pendingMember = new Promise<void>((resolve) => {
      completeMember = resolve;
    });
    addMemberMutation.mutateAsync.mockImplementationOnce(() => pendingMember);
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTeamModal({ onClose, onSuccess })
    );
    act(() => {
      result.current.setName("Platform");
      result.current.setSelectedUserId(ORG_USER_B.id);
    });
    act(() => result.current.handleAddMember());
    act(() => result.current.handleSubmit(fakeSubmitEvent()));
    const [, options] = createTeamMutation.mutate.mock.calls[0];
    act(() => options.onSuccess({ id: "team-old-org", name: "Platform" }));
    await waitFor(() =>
      expect(addMemberMutation.mutateAsync).toHaveBeenCalledTimes(1)
    );
    unmount();
    await act(async () => {
      completeMember?.();
      await pendingMember;
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

const FAILED_AT = 1_700_000_000_000;
