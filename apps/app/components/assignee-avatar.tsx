"use client";

import type { BasicUser } from "@repo/api/src/types/user";
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
import { User2Icon } from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";

type AssigneeAvatarProps = {
  assignee?: BasicUser | null;
  className?: string;
  /** When true, the avatar does NOT link to the user profile. Use when already wrapped in an interactive element (e.g. UserSelectPopover). */
  disableLink?: boolean;
};

export function AssigneeAvatar({
  assignee,
  className,
  disableLink,
}: Readonly<AssigneeAvatarProps>) {
  if (!assignee) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Avatar className={cn("size-6", className)} key="unassigned">
            <AvatarFallback className="text-[10px]">
              <User2Icon className="h-5 w-5 text-muted-foreground" />
            </AvatarFallback>
          </Avatar>
        </TooltipTrigger>
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

  if (disableLink) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{avatar}</TooltipTrigger>
        <TooltipContent>{displayName}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={`/users/${assignee.id}`}
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
          }}
        >
          {avatar}
        </Link>
      </TooltipTrigger>
      <TooltipContent>{displayName}</TooltipContent>
    </Tooltip>
  );
}
