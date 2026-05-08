"use client";

import { TeamRole } from "@repo/api/src/types/teams";
import type { BasicUser } from "@repo/api/src/types/user";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { TrashIcon } from "lucide-react";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";
import type { TeamMemberDraft } from "./use-team-modal";

type MemberAvatarInfoProps = {
  user: BasicUser;
};

export function MemberAvatarInfo({ user }: MemberAvatarInfoProps) {
  return (
    <div className="flex items-center gap-2">
      <Avatar className="h-7 w-7">
        {user.avatarUrl ? <AvatarImage src={user.avatarUrl} /> : null}
        <AvatarFallback className="text-xs">
          {getUserInitials(user.firstName, user.lastName)}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col">
        <span className="text-sm">{getUserDisplayName(user)}</span>
        <span className="text-muted-foreground text-xs">{user.email}</span>
      </div>
    </div>
  );
}

type RoleSelectProps = {
  disabled?: boolean;
  onValueChange: (value: TeamRole) => void;
  value: TeamRole;
};

export function RoleSelect({
  disabled,
  onValueChange,
  value,
}: RoleSelectProps) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(v) => onValueChange(v as TeamRole)}
      value={value}
    >
      <SelectTrigger className="h-7 w-[110px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={TeamRole.Member}>Member</SelectItem>
        <SelectItem value={TeamRole.Admin}>Admin</SelectItem>
        <SelectItem value={TeamRole.Owner}>Owner</SelectItem>
      </SelectContent>
    </Select>
  );
}

type MemberRowProps = {
  canManage: boolean;
  draft: TeamMemberDraft;
  isCurrentUser: boolean;
  onRemove: (draftId: string) => void;
  onRoleChange: (draftId: string, role: TeamRole) => void;
};

export function MemberRow({
  canManage,
  draft,
  isCurrentUser,
  onRemove,
  onRoleChange,
}: MemberRowProps) {
  // Staged adds and the create-mode current-user seed both have no
  // teamMemberId; render with a dashed border so the user can tell they
  // haven't been persisted yet.
  const isStaged = draft.teamMemberId === null;
  // Self-row is locked so users don't accidentally remove themselves; admins
  // still mutate other members freely.
  const disabled = !canManage || isCurrentUser;

  return (
    <div
      className={`flex items-center justify-between rounded-md p-2 ${
        isStaged ? "border border-dashed" : "border"
      }`}
    >
      <MemberAvatarInfo user={draft.user} />
      <div className="flex items-center gap-2">
        <RoleSelect
          disabled={disabled}
          onValueChange={(role) => onRoleChange(draft.draftId, role)}
          value={draft.role}
        />
        <Button
          className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={disabled}
          onClick={() => onRemove(draft.draftId)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
