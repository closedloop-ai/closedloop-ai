"use client";

import { TeamRole } from "@repo/api/src/types/teams";
import type { BasicUser } from "@repo/api/src/types/user";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
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
import type { TeamMemberDraft } from "./use-team-modal";

type MemberAvatarInfoProps = {
  isCurrentUser?: boolean;
  user: BasicUser;
};

export function MemberAvatarInfo({
  isCurrentUser = false,
  user,
}: MemberAvatarInfoProps) {
  return (
    <div className="flex items-center gap-2">
      <Avatar className="h-7 w-7">
        {user.avatarUrl ? <AvatarImage alt="" src={user.avatarUrl} /> : null}
        <AvatarFallback className="text-xs">
          {getUserInitials(user.firstName, user.lastName)}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col">
        <span className="text-sm">
          {getUserDisplayName(user)}
          {isCurrentUser ? (
            // A plain muted "You" explains why this row is locked (role
            // dropdown disabled, remove control hidden). Plain string, not a
            // Badge — the extra weight would over-signal a self-identifier.
            <span className="ml-1.5 text-muted-foreground">You</span>
          ) : null}
        </span>
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
  // The row is locked when the viewer can't manage members, or on the viewer's
  // own row — you can't remove yourself (in Create Team the seeded self row is
  // the Owner). This is a self-row rule, not a role/ownership rule: an admin
  // still gets a live remove control on someone else's Owner row (last-owner
  // protection is enforced server-side, not here). Same predicate drives the
  // dropdown and the remove control so the two can't drift.
  const disabled = !canManage || isCurrentUser;

  return (
    <div
      className={`flex items-center justify-between rounded-md p-2 ${
        isStaged ? "border border-dashed" : "border"
      }`}
    >
      <MemberAvatarInfo isCurrentUser={isCurrentUser} user={draft.user} />
      <div className="flex items-center gap-2">
        <RoleSelect
          disabled={disabled}
          onValueChange={(role) => onRoleChange(draft.draftId, role)}
          value={draft.role}
        />
        {/* Hide the remove control on locked rows instead of rendering a
            disabled trash button — a control that can never act is a dead
            affordance. The role dropdown stays visible-but-disabled because it
            still conveys the member's role, whereas a greyed-out trash icon
            conveys nothing. Keep the button's footprint with a same-size
            placeholder so hiding it doesn't slide the aligned rows sideways. */}
        {disabled ? (
          <div aria-hidden="true" className="h-7 w-7" />
        ) : (
          <Button
            aria-label="Remove member"
            className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onRemove(draft.draftId)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
