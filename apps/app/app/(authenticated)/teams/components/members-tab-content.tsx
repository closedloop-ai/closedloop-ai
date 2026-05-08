"use client";

import { TeamRole } from "@repo/api/src/types/teams";
import type { User } from "@repo/api/src/types/user";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { LoaderIcon, PlusIcon } from "lucide-react";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";
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
    isCurrentUserPending,
    isEditMode,
    loadingUsers,
    memberDrafts,
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
        <Select onValueChange={setSelectedUserId} value={selectedUserId}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select a user to add..." />
          </SelectTrigger>
          <SelectContent>
            <UserSelectContent loading={loadingUsers} users={availableUsers} />
          </SelectContent>
        </Select>

        <Select
          onValueChange={(value) => setSelectedRole(value as TeamRole)}
          value={selectedRole}
        >
          <SelectTrigger className="w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TeamRole.Member}>Member</SelectItem>
            <SelectItem value={TeamRole.Admin}>Admin</SelectItem>
            <SelectItem value={TeamRole.Owner}>Owner</SelectItem>
          </SelectContent>
        </Select>

        <Button
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

      <div
        className={`min-h-0 flex-1 overflow-y-auto ${
          useCenteredLayout ? "flex items-center justify-center" : "space-y-2"
        }`}
      >
        {isHydrating ? (
          <MemberListLoadingState
            isCreateOwnerPending={isCreateOwnerPending}
            isCurrentUserPending={isCurrentUserPending}
            isEditMode={isEditMode}
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

type MemberListLoadingStateProps = {
  isCreateOwnerPending: boolean;
  isCurrentUserPending: boolean;
  isEditMode: boolean;
};

function MemberListLoadingState({
  isCreateOwnerPending,
  isCurrentUserPending,
  isEditMode,
}: MemberListLoadingStateProps) {
  if (isEditMode) {
    return (
      <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
    );
  }
  if (isCreateOwnerPending) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        {isCurrentUserPending ? (
          <LoaderIcon className="h-4 w-4 animate-spin" />
        ) : null}
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
            <Avatar className="h-5 w-5">
              {user.avatarUrl ? <AvatarImage src={user.avatarUrl} /> : null}
              <AvatarFallback className="text-[10px]">
                {getUserInitials(user.firstName, user.lastName)}
              </AvatarFallback>
            </Avatar>
            <span>{getUserDisplayName(user)}</span>
          </div>
        </SelectItem>
      ))}
    </>
  );
}
