"use client";

import { TeamRole } from "@repo/api/src/types/teams";
import type { User } from "@repo/api/src/types/user";
// Reuse the shipped Retry labels and focus-preserving unavailable treatment.
import { ONBOARDING_STATUS_UNAVAILABLE_COPY } from "@repo/app/onboarding/components/onboarding-status-unavailable";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Label } from "@repo/design-system/components/ui/label";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { AlertCircleIcon, LoaderIcon, PlusIcon } from "lucide-react";
import { MemberRow } from "./member-row";
import type { TeamModalState } from "./use-team-modal";

type MembersTabContentProps = {
  state: TeamModalState;
};

export function MembersTabContent({ state }: MembersTabContentProps) {
  const {
    availableUsers,
    canManageMembers,
    currentUser,
    handleAddMember,
    isCreateOwnerPending,
    isCreateOwnerRetrying,
    isCreateOwnerUnavailable,
    isEditMembersUnavailable,
    isEditMode,
    loadingUsers,
    usersUnavailable,
    usersError,
    orgUsersPending,
    memberDrafts,
    retryCreateOwner,
    selectedRole,
    selectedUserId,
    setSelectedRole,
    setSelectedUserId,
    stageMemberRoleChange,
    stageRemoveMember,
  } = state;

  const drafts = memberDrafts ?? [];
  const isHydrating = memberDrafts === null;
  const showEmpty = !isHydrating && drafts.length === 0;
  const useCenteredLayout = isHydrating || showEmpty;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Label>Team Members</Label>

      <div className="flex gap-2">
        <Select
          disabled={usersUnavailable || orgUsersPending || !canManageMembers}
          onValueChange={setSelectedUserId}
          value={selectedUserId}
        >
          <SelectTrigger aria-label="Team Members" className="flex-1">
            <SelectValue placeholder="Select a user to add..." />
          </SelectTrigger>
          <SelectContent>
            <UserSelectContent loading={loadingUsers} users={availableUsers} />
          </SelectContent>
        </Select>

        <Select
          disabled={!canManageMembers}
          onValueChange={(value) => setSelectedRole(value as TeamRole)}
          value={selectedRole}
        >
          <SelectTrigger aria-label="Role" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TeamRole.Member}>Member</SelectItem>
            <SelectItem value={TeamRole.Admin}>Admin</SelectItem>
          </SelectContent>
        </Select>

        <Button
          aria-label="Add member"
          disabled={
            !(selectedUserId && canManageMembers) || memberDrafts === null
          }
          onClick={handleAddMember}
          size="icon"
          type="button"
          variant="outline"
        >
          <PlusIcon className="h-4 w-4" />
        </Button>
      </div>

      {usersUnavailable ? (
        <Alert variant="error">
          <AlertCircleIcon />
          <AlertDescription>
            {usersError instanceof Error
              ? usersError.message
              : "Reload the page and try again."}
          </AlertDescription>
        </Alert>
      ) : null}

      <div
        className={`min-h-0 flex-1 overflow-y-auto ${
          useCenteredLayout ? "flex items-center justify-center" : "space-y-2"
        }`}
      >
        {isHydrating ? (
          <MemberListPlaceholder
            isCreateOwnerPending={isCreateOwnerPending}
            isCreateOwnerRetrying={isCreateOwnerRetrying}
            isCreateOwnerUnavailable={isCreateOwnerUnavailable}
            isEditMembersUnavailable={isEditMembersUnavailable}
            isEditMode={isEditMode}
            onRetryCreateOwner={retryCreateOwner}
          />
        ) : null}

        {showEmpty ? (
          <p className="text-center text-muted-foreground text-sm">
            No members yet. Add members above.
          </p>
        ) : null}

        {!isHydrating && drafts.length > 0
          ? drafts.map((draft) => (
              <MemberRow
                canManage={canManageMembers}
                draft={draft}
                isCurrentUser={draft.userId === currentUser?.id}
                key={draft.draftId}
                onRemove={stageRemoveMember}
                onRoleChange={stageMemberRoleChange}
              />
            ))
          : null}
      </div>
    </div>
  );
}

type MemberListPlaceholderProps = {
  isCreateOwnerPending: boolean;
  isCreateOwnerRetrying: boolean;
  isCreateOwnerUnavailable: boolean;
  isEditMembersUnavailable: boolean;
  isEditMode: boolean;
  onRetryCreateOwner: () => void;
};

// What stands in for the member list before it hydrates. Each mode keeps its
// failed read apart from its in-flight one rather than letting both render as
// the same waiting state: in edit mode `isEditMembersUnavailable` is the
// settled-on-failure members read, and in create mode the two branches are
// mutually exclusive by construction (`isCreateOwnerPending` is the in-flight
// `/me`, `isCreateOwnerUnavailable` is the settled-with-no-user one, including
// while the user's Retry re-reads it). The trailing spinner covers the single
// create-mode render between `/me` resolving and the seeding effect committing
// the Owner draft.
function MemberListPlaceholder({
  isCreateOwnerPending,
  isCreateOwnerRetrying,
  isCreateOwnerUnavailable,
  isEditMembersUnavailable,
  isEditMode,
  onRetryCreateOwner,
}: MemberListPlaceholderProps) {
  if (isEditMode) {
    if (isEditMembersUnavailable) {
      return (
        <Alert variant="error">
          <AlertCircleIcon />
          <AlertTitle>We couldn't load this team's members</AlertTitle>
          <AlertDescription>
            We can't show who is on the team or save membership changes until it
            loads. Reload the page and try again.
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
    );
  }
  if (isCreateOwnerUnavailable) {
    return (
      <Alert variant="error">
        <AlertCircleIcon />
        <AlertTitle>We couldn't load your account</AlertTitle>
        <AlertDescription>
          We need it to add you as the team owner, so you can't create a team
          right now.
          {/* ISS-11068: the approved Retry/Retrying… pair and its
           * focus-keeping `aria-disabled` shape, reused from the onboarding
           * status card rather than new copy (operator ruling 2026-09-19). */}
          <Button
            aria-disabled={isCreateOwnerRetrying}
            className="mt-3 aria-disabled:opacity-50"
            onClick={isCreateOwnerRetrying ? undefined : onRetryCreateOwner}
            size="sm"
            type="button"
          >
            {isCreateOwnerRetrying ? (
              <LoaderIcon className="animate-spin" />
            ) : null}
            {isCreateOwnerRetrying
              ? ONBOARDING_STATUS_UNAVAILABLE_COPY.retryingLabel
              : ONBOARDING_STATUS_UNAVAILABLE_COPY.retryLabel}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (isCreateOwnerPending) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <LoaderIcon className="h-4 w-4 animate-spin" />
        <span>Loading your owner membership...</span>
      </div>
    );
  }
  return <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />;
}

type UserSelectContentProps = {
  loading: boolean;
  users: User[];
};

function UserSelectContent({ loading, users }: UserSelectContentProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center p-2">
        <LoaderIcon className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (users.length === 0) {
    return (
      <div className="p-2 text-center text-muted-foreground text-sm">
        No users available
      </div>
    );
  }
  return (
    <>
      {users.map((user) => (
        <SelectItem key={user.id} value={user.id}>
          <div className="flex items-center gap-2">
            <PersonAvatar
              avatarUrl={user.avatarUrl}
              className="h-5 w-5"
              fallbackClassName="text-xs"
              initials={getUserInitials(user.firstName, user.lastName)}
              name={getUserDisplayName(user)}
            />
            <span>{getUserDisplayName(user)}</span>
          </div>
        </SelectItem>
      ))}
    </>
  );
}
