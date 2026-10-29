"use client";

import type { GitHubRepository } from "@repo/api/src/types/github";
import {
  type TeamMember,
  type TeamRepository,
  type TeamRepositoryRepoSummary,
  TeamRole,
  type TeamWithCounts,
} from "@repo/api/src/types/teams";
import type { BasicUser, User } from "@repo/api/src/types/user";
import {
  useAddTeamMember,
  useAddTeamRepository,
  useCreateTeam,
  useDeleteTeam,
  useRemoveTeamMember,
  useRemoveTeamRepository,
  useTeamMembers,
  useTeamRepositories,
  useUpdateTeam,
  useUpdateTeamMemberRole,
  useUpdateTeamRepository,
} from "@repo/app/teams/hooks/use-teams";
// The users slice owns canonical local identities and the organization roster.
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@repo/app/users/hooks/use-users";
import { useEffect, useMemo, useRef, useState } from "react";

export const TeamModalTab = {
  Members: "members",
  Repositories: "repositories",
} as const;
export type TeamModalTab = (typeof TeamModalTab)[keyof typeof TeamModalTab];

export type TeamMemberDraft = {
  // Stable client-side id. Persisted: matches teamMemberId. Newly staged
  // additions: `new:${userId}`. Create-mode current-user seed: `seed:${userId}`.
  draftId: string;
  teamMemberId: string | null;
  userId: string;
  role: TeamRole;
  user: BasicUser;
};

// Drafts populate `repository` from two sources: persisted TeamRepository
// rows (which carry installationId) and newly staged additions whose source
// is a GitHubRepository (which does not). Rather than fabricate a fake
// installationId for staged drafts, the draft only retains the fields both
// sources can produce — the UI never reads installationId off a draft.
export type TeamRepositoryDraftRepo = Omit<
  TeamRepositoryRepoSummary,
  "installationId"
>;

export type TeamRepositoryDraft = {
  // Stable client-side id. For persisted drafts this matches teamRepositoryId.
  // For newly staged additions this is `new:${installationRepositoryId}`.
  draftId: string;
  teamRepositoryId: string | null;
  installationRepositoryId: string;
  isDefaultSelected: boolean;
  isPrimary: boolean;
  repository: TeamRepositoryDraftRepo;
};

export type UseTeamModalArgs = {
  onCreated?: (team: TeamWithCounts) => void;
  team?: TeamWithCounts;
  onSuccess?: () => void;
  onClose: () => void;
};

export type TeamModalState = ReturnType<typeof useTeamModal>;

// `useTeamModal` is intended to live in a child component that's mounted only
// while the dialog is open (see TeamModalContent in team-modal.tsx). The
// outer TeamModal owns the open/close state and remounts this hook on each
// open, so we don't need imperative reset effects or `open` gates on queries.
export function useTeamModal({
  team,
  onSuccess,
  onClose,
  onCreated,
}: UseTeamModalArgs) {
  const isEditMode = !!team;
  const [createdTeam, setCreatedTeam] = useState<TeamWithCounts | null>(null);
  const appliedCreateMembers = useRef(new Map<string, TeamRole>());
  const dialogIsCurrent = useRef(true);
  // Saves are event-driven. Closing or switching the keyed dialog invalidates
  // their remaining fan-out and host callbacks without undoing committed writes.
  useEffect(() => {
    dialogIsCurrent.current = true;
    return () => {
      dialogIsCurrent.current = false;
    };
  }, []);

  const [name, setName] = useState(team?.name || "");
  const [error, setError] = useState<string | null>(null);

  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedRole, setSelectedRole] = useState<TeamRole>(TeamRole.Member);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const [activeTab, setActiveTab] = useState<TeamModalTab>(
    TeamModalTab.Members
  );

  // null = not yet hydrated. Drafts hydrate from server data and survive tab
  // switches; the next dialog open remounts the hook and starts over.
  const [memberDrafts, setMemberDrafts] = useState<TeamMemberDraft[] | null>(
    null
  );
  const [repoDrafts, setRepoDrafts] = useState<TeamRepositoryDraft[] | null>(
    null
  );
  const [isApplyingChanges, setIsApplyingChanges] = useState(false);

  const {
    data: currentUser,
    errorUpdatedAt: currentUserErrorUpdatedAt,
    isPending: isCurrentUserPending,
    refetch: refetchCurrentUser,
  } = useCurrentUser();
  const {
    data: orgUsers = [],
    isPending: orgUsersPending,
    isLoading: loadingUsers,
    isLoadingError: usersUnavailable = false,
    error: usersError,
  } = useOrganizationUsers();
  // `isLoadingError`, not `isError`: React Query keeps the last successful
  // `data` when a REFETCH fails, and a stale list is still a list the user can
  // read and edit. Only the errored-with-nothing case (`isLoadingError` is
  // exactly `isError` with `data === undefined`) has nothing to show.
  const {
    data: members = [],
    isPending: loadingMembers,
    isLoadingError: membersUnavailable = false,
  } = useTeamMembers(team?.id ?? "", { enabled: isEditMode && !!team?.id });

  const showRepositoriesTab = isEditMode;
  const repoQueryEnabled =
    isEditMode && !!team?.id && activeTab === TeamModalTab.Repositories;

  // `isLoadingError` for the same reason as the members read above, and
  // `isPending` rather than `isLoading` because a fetch paused offline is
  // pending without fetching: together they are exactly "no data" (ISS-9895).
  const {
    data: configuredRepos = [],
    isPending: loadingConfiguredRepos,
    isLoadingError: configuredReposUnavailable = false,
  } = useTeamRepositories(team?.id ?? "", { enabled: repoQueryEnabled });

  const createTeamMutation = useCreateTeam();
  const updateTeamMutation = useUpdateTeam();
  const deleteTeamMutation = useDeleteTeam();
  const addMemberMutation = useAddTeamMember();
  const removeMemberMutation = useRemoveTeamMember();
  const updateRoleMutation = useUpdateTeamMemberRole();
  const addRepoMutation = useAddTeamRepository();
  const updateRepoMutation = useUpdateTeamRepository();
  const removeRepoMutation = useRemoveTeamRepository();

  // Hydrate member drafts when the source data is ready. Edit mode pulls from
  // the server members list; create mode seeds the current user as Owner so
  // they appear in the members panel and can't be removed.
  useEffect(() => {
    if (memberDrafts !== null) {
      return;
    }
    if (isEditMode) {
      // A read that failed with nothing settles with `isPending` false and
      // `members` at its `[]` default, so hydrating from it would publish the
      // failure as a real empty team (ISS-9805) and give staged edits a phantom
      // baseline. Leaving drafts unhydrated is what routes the failure to the
      // panel's error state, exactly as an absent `/me` does in create mode.
      // Pending includes a cold offline read whose fetch is paused, so it must
      // not hydrate an empty draft before the first member response arrives.
      if (!(loadingMembers || membersUnavailable)) {
        setMemberDrafts(mapMembersToDrafts(members));
      }
      return;
    }
    if (!currentUser) {
      return;
    }
    setMemberDrafts([seedCurrentUserDraft(currentUser)]);
  }, [
    currentUser,
    isEditMode,
    loadingMembers,
    members,
    memberDrafts,
    membersUnavailable,
  ]);

  // Hydrate repo drafts from server data once configured loads. Gated on
  // repoQueryEnabled because the query is only enabled when the user
  // actually visits the Repositories tab; without this guard the effect
  // would seed drafts with the disabled query's default `[]`, and a save
  // would diff against that empty baseline and silently delete every
  // configured repo. A read that failed with nothing is the same `[]` default
  // and is skipped for the same reason (ISS-9895). Only runs when drafts are
  // unhydrated so user edits aren't stomped by stale fetches.
  useEffect(() => {
    if (!repoQueryEnabled) {
      return;
    }
    if (loadingConfiguredRepos || configuredReposUnavailable) {
      return;
    }
    if (repoDrafts !== null) {
      return;
    }
    setRepoDrafts(mapConfiguredToDrafts(configuredRepos));
  }, [
    configuredRepos,
    configuredReposUnavailable,
    loadingConfiguredRepos,
    repoDrafts,
    repoQueryEnabled,
  ]);

  const availableUsers = useMemo<User[]>(() => {
    const stagedUserIds = new Set((memberDrafts ?? []).map((d) => d.userId));
    return orgUsers.filter((u) => !stagedUserIds.has(u.id));
  }, [memberDrafts, orgUsers]);

  const isCurrentUserTeamAdmin = useMemo(() => {
    if (!(isEditMode && currentUser)) {
      return false;
    }
    const member = members.find((m) => m.userId === currentUser.id);
    return member?.role === TeamRole.Owner || member?.role === TeamRole.Admin;
  }, [currentUser, isEditMode, members]);

  const canManageMembers = !isEditMode || isCurrentUserTeamAdmin;

  const memberDiff = useMemo(() => {
    if (!isEditMode) {
      return null;
    }
    if (memberDrafts === null) {
      return null;
    }
    return diffMemberDrafts(memberDrafts, members);
  }, [isEditMode, memberDrafts, members]);

  const repoDiff = useMemo(() => {
    if (repoDrafts === null) {
      return null;
    }
    return diffRepoDrafts(repoDrafts, configuredRepos);
  }, [configuredRepos, repoDrafts]);

  const hasNameChange =
    name.trim() !== (team?.name ?? "").trim() && name.trim().length > 0;
  const hasMemberChanges =
    isEditMode && memberDiff !== null && hasAnyDiff(memberDiff);
  const hasRepoChanges =
    isEditMode && repoDiff !== null && hasAnyDiff(repoDiff);

  // Member draft actions are local-only. They persist on save and are
  // discarded on cancel/close (drafts reset by the open transition effect).
  const handleAddMember = () => {
    if (!selectedUserId) {
      return;
    }
    // Refuse to stage before drafts hydrate — otherwise the new entry becomes
    // the entire baseline and diffMemberDrafts would treat every existing
    // server member as a removal on save.
    if (memberDrafts === null) {
      return;
    }
    const user = orgUsers.find((u) => u.id === selectedUserId);
    if (!user) {
      return;
    }
    setMemberDrafts((prev) => {
      const next: TeamMemberDraft = {
        draftId: `new:${user.id}`,
        teamMemberId: null,
        userId: user.id,
        role: selectedRole,
        user: userToBasicUser(user),
      };
      return prev ? [...prev, next] : [next];
    });
    setSelectedUserId("");
    setSelectedRole(TeamRole.Member);
  };

  const stageRemoveMember = (draftId: string) => {
    setMemberDrafts((prev) =>
      prev ? prev.filter((d) => d.draftId !== draftId) : prev
    );
  };

  const stageMemberRoleChange = (draftId: string, role: TeamRole) => {
    setMemberDrafts((prev) =>
      prev
        ? prev.map((d) => (d.draftId === draftId ? { ...d, role } : d))
        : prev
    );
  };

  // Repository drafts: same staging model as members.
  const stageAddRepo = (repo: GitHubRepository) => {
    // Refuse to stage before drafts hydrate — otherwise the new entry becomes
    // the entire baseline and diffRepoDrafts would treat every existing
    // configured repo as a removal on save.
    if (repoDrafts === null) {
      return;
    }
    setRepoDrafts((prev) => {
      const next: TeamRepositoryDraft = {
        draftId: `new:${repo.id}`,
        teamRepositoryId: null,
        installationRepositoryId: repo.id,
        isDefaultSelected: false,
        isPrimary: false,
        repository: githubRepoToSummary(repo),
      };
      return prev ? [...prev, next] : [next];
    });
  };

  const stageRemoveRepo = (draftId: string) => {
    setRepoDrafts((prev) =>
      prev ? prev.filter((d) => d.draftId !== draftId) : prev
    );
  };

  const stageToggleDefault = (draftId: string, value: boolean) => {
    setRepoDrafts((prev) => {
      if (!prev) {
        return prev;
      }
      return prev.map((d) => {
        if (d.draftId !== draftId) {
          return d;
        }
        return {
          ...d,
          isDefaultSelected: value,
          // Un-defaulting a primary clears primary too (mirrors server cascade).
          isPrimary: value ? d.isPrimary : false,
        };
      });
    });
  };

  const stageSetPrimary = (draftId: string) => {
    setRepoDrafts((prev) => {
      if (!prev) {
        return prev;
      }
      return prev.map((d) => {
        if (d.draftId === draftId) {
          return { ...d, isPrimary: true, isDefaultSelected: true };
        }
        return d.isPrimary ? { ...d, isPrimary: false } : d;
      });
    });
  };

  const handleClose = onClose;

  // Intentional exception to the apps/app `mutate`-only convention. Save is
  // a fan-out of remove/add/update operations that must complete before the
  // modal closes (the dialog's `isSubmitting` flag is driven by the wrapping
  // promise). `mutate` is fire-and-forget and can't be awaited, so we use
  // `mutateAsync` here to drive the modal's UI lifecycle. The first
  // rejection aborts the loop; finishEditSave catches and surfaces it.
  const applyMemberChanges = async (teamId: string) => {
    if (memberDiff === null) {
      return;
    }
    for (const orig of memberDiff.toRemove) {
      if (!dialogIsCurrent.current) {
        return;
      }
      await removeMemberMutation.mutateAsync({
        teamId,
        userId: orig.userId,
      });
    }
    for (const draft of memberDiff.toAdd) {
      if (!dialogIsCurrent.current) {
        return;
      }
      await addMemberMutation.mutateAsync({
        teamId,
        userId: draft.userId,
        role: draft.role,
      });
    }
    for (const draft of memberDiff.toUpdate) {
      if (!dialogIsCurrent.current) {
        return;
      }
      await updateRoleMutation.mutateAsync({
        teamId,
        userId: draft.userId,
        role: draft.role,
      });
    }
  };

  // Intentional exception to the apps/app `mutate`-only convention. Beyond
  // needing awaitable completion for the modal lifecycle (see
  // applyMemberChanges), repo changes also require ordered execution:
  // removals run first so primary-uniqueness cascades have room when a new
  // primary is added in the same save.
  const applyRepoChanges = async (teamId: string) => {
    if (repoDiff === null) {
      return;
    }
    for (const orig of repoDiff.toRemove) {
      if (!dialogIsCurrent.current) {
        return;
      }
      await removeRepoMutation.mutateAsync({
        teamId,
        teamRepositoryId: orig.id,
      });
    }
    for (const draft of repoDiff.toAdd) {
      if (!dialogIsCurrent.current) {
        return;
      }
      await addRepoMutation.mutateAsync({
        teamId,
        input: {
          installationRepositoryId: draft.installationRepositoryId,
          isDefaultSelected: draft.isDefaultSelected,
          isPrimary: draft.isPrimary,
        },
      });
    }
    for (const draft of repoDiff.toUpdate) {
      if (!dialogIsCurrent.current) {
        return;
      }
      if (!draft.teamRepositoryId) {
        continue;
      }
      await updateRepoMutation.mutateAsync({
        teamId,
        teamRepositoryId: draft.teamRepositoryId,
        input: {
          isDefaultSelected: draft.isDefaultSelected,
          isPrimary: draft.isPrimary,
        },
      });
    }
  };

  // Owns the success/failure flow for an edit save. mutateAsync inside the
  // apply functions rejects on failure; we catch here, surface the message
  // inline so the user sees it without dismissing the modal, and skip the
  // close/onSuccess so they can retry. The global mutations.onError toast
  // also fires, but the inline error keeps the cause visible while the
  // user is still focused on the dialog.
  const finishEditSave = async (teamId: string) => {
    if (!dialogIsCurrent.current) {
      return;
    }
    setIsApplyingChanges(true);
    try {
      await applyMemberChanges(teamId);
      await applyRepoChanges(teamId);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save team changes."
      );
      return;
    } finally {
      setIsApplyingChanges(false);
    }
    if (dialogIsCurrent.current) {
      handleClose();
      onSuccess?.();
    }
  };

  const handleSubmit = (e: React.SubmitEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      return;
    }
    setError(null);
    if (isEditMode && team) {
      handleEditSubmit(team.id);
    } else {
      handleCreateSubmit();
    }
  };

  const handleEditSubmit = (teamId: string) => {
    if (hasNameChange) {
      updateTeamMutation.mutate(
        { id: teamId, input: { name: name.trim() } },
        {
          onSuccess: () => {
            finishEditSave(teamId);
          },
          onError: (err) =>
            setError(
              err instanceof Error
                ? err.message
                : "Failed to save team changes."
            ),
        }
      );
    } else {
      finishEditSave(teamId);
    }
  };

  const removeCreatedMembers = async (
    teamId: string,
    additions: TeamMemberDraft[]
  ) => {
    const desired = new Set(additions.map((draft) => draft.userId));
    for (const userId of appliedCreateMembers.current.keys()) {
      if (!dialogIsCurrent.current) {
        return;
      }
      if (!desired.has(userId)) {
        await removeMemberMutation.mutateAsync({ teamId, userId });
        appliedCreateMembers.current.delete(userId);
      }
    }
  };

  // Resume the same team's draft after partial failure, retaining successful
  // writes so a retry cannot create a duplicate team or membership.
  const applyCreatedMembers = async (
    teamId: string,
    additions: TeamMemberDraft[]
  ) => {
    for (const draft of additions) {
      if (!dialogIsCurrent.current) {
        return;
      }
      const appliedRole = appliedCreateMembers.current.get(draft.userId);
      if (appliedRole === draft.role) {
        continue;
      }
      const input = { teamId, userId: draft.userId, role: draft.role };
      if (appliedRole) {
        await updateRoleMutation.mutateAsync(input);
      } else {
        await addMemberMutation.mutateAsync(input);
      }
      appliedCreateMembers.current.set(draft.userId, draft.role);
    }
  };

  const finishCreateSave = async (newTeam: TeamWithCounts) => {
    if (!dialogIsCurrent.current) {
      return;
    }
    setIsApplyingChanges(true);
    try {
      const additions = (memberDrafts ?? []).filter(
        (draft) => draft.userId !== currentUser?.id
      );
      await removeCreatedMembers(newTeam.id, additions);
      await applyCreatedMembers(newTeam.id, additions);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save team changes."
      );
      return;
    } finally {
      setIsApplyingChanges(false);
    }
    if (dialogIsCurrent.current) {
      onCreated?.(newTeam);
      handleClose();
      onSuccess?.();
    }
  };

  const handleCreateSubmit = () => {
    if (createdTeam) {
      if (createdTeam.name === name.trim()) {
        finishCreateSave(createdTeam);
      } else {
        updateTeamMutation.mutate(
          { id: createdTeam.id, input: { name: name.trim() } },
          {
            onSuccess: () => {
              const renamed = { ...createdTeam, name: name.trim() };
              setCreatedTeam(renamed);
              finishCreateSave(renamed);
            },
            onError: (err) =>
              setError(
                err instanceof Error
                  ? err.message
                  : "Failed to save team changes."
              ),
          }
        );
      }
      return;
    }
    createTeamMutation.mutate(
      { name: name.trim() },
      {
        onSuccess: (newTeam) => {
          if (!dialogIsCurrent.current) {
            return;
          }
          setCreatedTeam(newTeam);
          finishCreateSave(newTeam);
        },
        onError: (err) =>
          setError(
            err instanceof Error ? err.message : "Failed to save team changes."
          ),
      }
    );
  };

  // Returns false so DeleteConfirmationDialog never closes itself preemptively.
  // The mutation's onSuccess closes both the confirmation dialog and the
  // team modal; on error the global mutations.onError handler toasts and the
  // confirmation dialog stays open so the user can retry.
  const handleDeleteTeam = (): Promise<boolean> => {
    if (!team) {
      return Promise.resolve(false);
    }
    deleteTeamMutation.mutate(team.id, {
      onSuccess: () => {
        if (!dialogIsCurrent.current) {
          return;
        }
        setShowDeleteDialog(false);
        handleClose();
        onSuccess?.();
      },
    });
    return Promise.resolve(false);
  };

  const isSubmitting =
    createTeamMutation.isPending ||
    updateTeamMutation.isPending ||
    isApplyingChanges;
  const isDeleting = deleteTeamMutation.isPending;
  // Create mode needs the caller's identity to seed the Owner row, and the
  // three states it can be in are deliberately kept apart (ISS-9794): still
  // fetching, resolved, or settled with no user at all. The shared client
  // fails a response-backed error fast, so that last state is a finished read,
  // and rendering it as "loading" tells the user the app is still trying when
  // it has stopped. The user's Retry re-reads it (ISS-11068).
  //
  // A query with no data goes back to `pending` while it re-reads, whoever
  // started it: the Retry, or a focus/reconnect refetch. `errorUpdatedAt`
  // survives that reset, so a pending read after a failure stays in the failed
  // state rather than falling back to the loading copy, and the panel does not
  // swap out from under a focused Retry (review on #7850).
  const isCreateOwnerRetrying =
    !isEditMode && isCurrentUserPending && currentUserErrorUpdatedAt > 0;
  const isCreateOwnerPending =
    !isEditMode && isCurrentUserPending && !isCreateOwnerRetrying;
  const isCreateOwnerUnavailable =
    isCreateOwnerRetrying ||
    !(isEditMode || isCurrentUserPending || currentUser);
  const retryCreateOwner = () => {
    refetchCurrentUser();
  };
  // The edit-mode twin of the above (ISS-9805). The members read settled on a
  // failure with nothing to show, so the panel knows nothing about this team's
  // membership — which is not the same fact as a team that has no members.
  const isEditMembersUnavailable = isEditMode && membersUnavailable;

  const hasUnsavedChanges = isEditMode
    ? hasNameChange || hasMemberChanges || hasRepoChanges
    : !!name.trim();
  // An unresolved owner blocks submit whether the read is still in flight or
  // has settled with nothing — both are named so neither can be dropped by a
  // later edit that only remembers the loading case.
  const disableSubmit =
    isSubmitting ||
    !name.trim() ||
    isCreateOwnerPending ||
    isCreateOwnerUnavailable ||
    !hasUnsavedChanges;

  return {
    // close
    handleClose,

    // mode
    isEditMode,
    team,

    // form fields
    name,
    setName,
    error,

    // member-add controls
    selectedUserId,
    setSelectedUserId,
    selectedRole,
    setSelectedRole,

    // tabs
    activeTab,
    setActiveTab,
    showRepositoriesTab,

    // delete dialog
    showDeleteDialog,
    setShowDeleteDialog,

    // queries
    currentUser,
    loadingMembers,
    loadingUsers,

    // members
    memberDrafts,
    availableUsers,
    isCurrentUserTeamAdmin,
    canManageMembers,
    isCreateOwnerPending,
    isCreateOwnerRetrying,
    isCreateOwnerUnavailable,
    isEditMembersUnavailable,
    retryCreateOwner,
    usersUnavailable,
    usersError,
    orgUsersPending,
    isSubmitting,
    isDeleting,
    disableSubmit,
    hasUnsavedChanges,
    handleAddMember,
    stageRemoveMember,
    stageMemberRoleChange,

    // repositories
    configuredRepos,
    configuredReposUnavailable,
    loadingConfiguredRepos,
    repoDrafts,
    stageAddRepo,
    stageRemoveRepo,
    stageToggleDefault,
    stageSetPrimary,

    // submit / delete
    handleSubmit,
    handleDeleteTeam,
  };
}

type MemberDiff = {
  toRemove: TeamMember[];
  toAdd: TeamMemberDraft[];
  toUpdate: TeamMemberDraft[];
};

type RepoDiff = {
  toRemove: TeamRepository[];
  toAdd: TeamRepositoryDraft[];
  toUpdate: TeamRepositoryDraft[];
};

function mapMembersToDrafts(members: TeamMember[]): TeamMemberDraft[] {
  return members.map((m) => ({
    draftId: m.id,
    teamMemberId: m.id,
    userId: m.userId,
    role: m.role,
    user: m.user,
  }));
}

function seedCurrentUserDraft(user: User): TeamMemberDraft {
  return {
    draftId: `seed:${user.id}`,
    teamMemberId: null,
    userId: user.id,
    role: TeamRole.Owner,
    user: userToBasicUser(user),
  };
}

function userToBasicUser(user: User): BasicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
  };
}

function diffMemberDrafts(
  drafts: TeamMemberDraft[],
  original: TeamMember[]
): MemberDiff {
  const persistedDraftIds = new Set(
    drafts.filter((d) => d.teamMemberId !== null).map((d) => d.teamMemberId)
  );
  const originalById = new Map(original.map((m) => [m.id, m]));

  const toRemove = original.filter((m) => !persistedDraftIds.has(m.id));
  const toAdd = drafts.filter((d) => d.teamMemberId === null);
  const toUpdate = drafts.filter((d) => {
    if (!d.teamMemberId) {
      return false;
    }
    const orig = originalById.get(d.teamMemberId);
    return !!orig && orig.role !== d.role;
  });

  return { toRemove, toAdd, toUpdate };
}

function mapConfiguredToDrafts(
  configured: TeamRepository[]
): TeamRepositoryDraft[] {
  return configured.map((c) => ({
    draftId: c.id,
    teamRepositoryId: c.id,
    installationRepositoryId: c.installationRepositoryId,
    isDefaultSelected: c.isDefaultSelected,
    isPrimary: c.isPrimary,
    repository: c.repository,
  }));
}

function diffRepoDrafts(
  drafts: TeamRepositoryDraft[],
  configured: TeamRepository[]
): RepoDiff {
  const persistedDraftIds = new Set(
    drafts
      .filter((d) => d.teamRepositoryId !== null)
      .map((d) => d.teamRepositoryId)
  );
  const configuredById = new Map(configured.map((c) => [c.id, c]));

  const toRemove = configured.filter((c) => !persistedDraftIds.has(c.id));
  const toAdd = drafts.filter((d) => d.teamRepositoryId === null);
  const toUpdate = drafts.filter((d) => {
    if (!d.teamRepositoryId) {
      return false;
    }
    const orig = configuredById.get(d.teamRepositoryId);
    if (!orig) {
      return false;
    }
    return (
      orig.isDefaultSelected !== d.isDefaultSelected ||
      orig.isPrimary !== d.isPrimary
    );
  });

  return { toRemove, toAdd, toUpdate };
}

function hasAnyDiff(diff: {
  toRemove: unknown[];
  toAdd: unknown[];
  toUpdate: unknown[];
}): boolean {
  return (
    diff.toRemove.length > 0 ||
    diff.toAdd.length > 0 ||
    diff.toUpdate.length > 0
  );
}

function githubRepoToSummary(repo: GitHubRepository): TeamRepositoryDraftRepo {
  return {
    id: repo.id,
    githubRepoId: repo.githubRepoId,
    fullName: repo.fullName,
    name: repo.name,
    owner: repo.owner,
    private: repo.private,
  };
}
