"use client";

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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { User2Icon } from "lucide-react";
import type { MouseEvent } from "react";

type AssigneeAvatarProps = {
  assignee?: BasicUser | null;
  className?: string;
  /** When true, the avatar does NOT link to the user profile. Use when already wrapped in an interactive element (e.g. UserSelectPopover). */
  disableLink?: boolean;
  /** When true, suppresses the name tooltip. Use when the name is already visible nearby. */
  disableTooltip?: boolean;
};

export function AssigneeAvatar({
  assignee,
  className,
  disableLink,
  disableTooltip,
}: Readonly<AssigneeAvatarProps>) {
  const buildOrgPath = useOrgPath();
  if (!assignee) {
    const avatar = (
      <Avatar className={cn("size-6", className)} key="unassigned">
        <AvatarFallback className="text-[10px]">
          <User2Icon className="h-5 w-5 text-muted-foreground" />
        </AvatarFallback>
      </Avatar>
    );

    if (disableTooltip) {
      return avatar;
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>{avatar}</TooltipTrigger>
        <TooltipContent>Unassigned</TooltipContent>
      </Tooltip>
    );
  }

  const initials = getUserInitials(assignee.firstName, assignee.lastName);
  const displayName = getUserDisplayName(assignee);

  const avatar = (
    <Avatar className={cn("size-6", className)} key={assignee.id}>
      {assignee.avatarUrl ? (
        <AvatarImage alt={displayName} src={assignee.avatarUrl} />
      ) : null}
      <AvatarFallback className="text-[10px]">{initials || "?"}</AvatarFallback>
    </Avatar>
  );

  if (disableTooltip && disableLink) {
    return avatar;
  }

  if (disableLink) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{avatar}</TooltipTrigger>
        <TooltipContent>{displayName}</TooltipContent>
      </Tooltip>
    );
  }

  const linked = (
    <Link
      href={buildOrgPath(`/users/${assignee.id}`)}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
      }}
    >
      {avatar}
    </Link>
  );

  if (disableTooltip) {
    return linked;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{linked}</TooltipTrigger>
      <TooltipContent>{displayName}</TooltipContent>
    </Tooltip>
  );
}
