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
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
} from "@/hooks/queries/use-teams";
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@/hooks/queries/use-users";
import { useMultiRepoConfigEnabled } from "@/hooks/use-multi-repo-config-enabled";

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

type UseTeamModalArgs = {
  team?: TeamWithCounts;
  onSuccess?: () => void;
  onClose: () => void;
};

export type TeamModalState = ReturnType<typeof useTeamModal>;

// `useTeamModal` is intended to live in a child component that's mounted only
// while the dialog is open (see TeamModalContent in team-modal.tsx). The
// outer TeamModal owns the open/close state and remounts this hook on each
// open, so we don't need imperative reset effects or `open` gates on queries.
export function useTeamModal({ team, onSuccess, onClose }: UseTeamModalArgs) {
  const router = useRouter();
  const isEditMode = !!team;

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

  const { data: currentUser, isPending: isCurrentUserPending } =
    useCurrentUser();
  const { data: orgUsers = [], isLoading: loadingUsers } =
    useOrganizationUsers();
  const { data: members = [], isLoading: loadingMembers } = useTeamMembers(
    team?.id ?? "",
    { enabled: isEditMode && !!team?.id }
  );

  const multiRepoEnabled = useMultiRepoConfigEnabled();
  const showRepositoriesTab = multiRepoEnabled && isEditMode;
  const repoQueryEnabled =
    isEditMode &&
    !!team?.id &&
    multiRepoEnabled &&
    activeTab === TeamModalTab.Repositories;

  const { data: configuredRepos = [], isLoading: loadingConfiguredRepos } =
    useTeamRepositories(team?.id ?? "", { enabled: repoQueryEnabled });

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
      if (!loadingMembers) {
        setMemberDrafts(mapMembersToDrafts(members));
      }
      return;
    }
    if (!currentUser) {
      return;
    }
    setMemberDrafts([seedCurrentUserDraft(currentUser)]);
  }, [currentUser, isEditMode, loadingMembers, members, memberDrafts]);

  // Hydrate repo drafts from server data once configured loads. Gated on
  // repoQueryEnabled because the query is only enabled when the user
  // actually visits the Repositories tab; without this guard the effect
  // would seed drafts with the disabled query's default `[]`, and a save
  // would diff against that empty baseline and silently delete every
  // configured repo. Only runs when drafts are unhydrated so user edits
  // aren't stomped by stale fetches.
  useEffect(() => {
    if (!repoQueryEnabled) {
      return;
    }
    if (loadingConfiguredRepos) {
      return;
    }
    if (repoDrafts !== null) {
      return;
    }
    setRepoDrafts(mapConfiguredToDrafts(configuredRepos));
  }, [configuredRepos, loadingConfiguredRepos, repoDrafts, repoQueryEnabled]);

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
      await removeMemberMutation.mutateAsync({
        teamId,
        userId: orig.userId,
      });
    }
    for (const draft of memberDiff.toAdd) {
      await addMemberMutation.mutateAsync({
        teamId,
        userId: draft.userId,
        role: draft.role,
      });
    }
    for (const draft of memberDiff.toUpdate) {
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
      await removeRepoMutation.mutateAsync({
        teamId,
        teamRepositoryId: orig.id,
      });
    }
    for (const draft of repoDiff.toAdd) {
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
    handleClose();
    onSuccess?.();
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
        }
      );
    } else {
      finishEditSave(teamId);
    }
  };

  const handleCreateSubmit = () => {
    createTeamMutation.mutate(
      { name: name.trim() },
      {
        onSuccess: (newTeam) => {
          // Server auto-adds the caller as Owner during team creation, so we
          // skip the seeded current-user draft when applying additions.
          const additions = (memberDrafts ?? []).filter(
            (d) => d.userId !== currentUser?.id
          );
          // Fire member additions independently so a failed add does not
          // leave the modal open (the team is already created — re-enabling
          // Submit would let the user create a duplicate). Each mutation's
          // success invalidates the members cache; failures surface through
          // the global mutations.onError toast.
          for (const draft of additions) {
            addMemberMutation.mutate({
              teamId: newTeam.id,
              userId: draft.userId,
              role: draft.role,
            });
          }
          router.push(`/teams/${newTeam.id}/projects`);
          handleClose();
          onSuccess?.();
        },
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
  const isCreateOwnerPending = !(isEditMode || currentUser);

  const hasUnsavedChanges = isEditMode
    ? hasNameChange || hasMemberChanges || hasRepoChanges
    : !!name.trim();
  const disableSubmit =
    isSubmitting || !name.trim() || isCreateOwnerPending || !hasUnsavedChanges;

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
    isCurrentUserPending,
    loadingMembers,
    loadingUsers,

    // members
    memberDrafts,
    availableUsers,
    isCurrentUserTeamAdmin,
    canManageMembers,
    isCreateOwnerPending,
    isSubmitting,
    isDeleting,
    disableSubmit,
    hasUnsavedChanges,
    handleAddMember,
    stageRemoveMember,
    stageMemberRoleChange,

    // repositories
    configuredRepos,
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
