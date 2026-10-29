"use client";

import type { BasicUser } from "@repo/api/src/types/user";
import {
  getUserDisplayName,
  getUserInitials,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "@repo/app/shared/lib/user-utils";
import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
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
  /**
   * Removes the avatar from the accessibility tree. Pass it ONLY where an
   * ancestor already states the identical name, and only where that ancestor
   * states it unconditionally: this deduplicates an announcement, it does not
   * relocate one, so a caller that sets it without such an ancestor deletes the
   * identity outright.
   */
  decorative?: boolean;
  /** When true, the avatar does NOT link to the user profile. Use when already wrapped in an interactive element (e.g. UserSelectPopover). */
  disableLink?: boolean;
  /**
   * When true, suppresses the hover tooltip. Not a statement about the
   * surrounding layout: `AssigneeCell` passes it while rendering the name only
   * in the assigned branch. Use `decorative` for "an ancestor already says it".
   */
  disableTooltip?: boolean;
};

/**
 * ISS-7746: the avatar carries its own accessible name, so the identity
 * survives the three ways a `Tooltip` cannot be reached: a screen reader, the
 * keyboard, and touch. `disableTooltip` suppresses only the hover affordance;
 * only `decorative` suppresses the name.
 */
export function AssigneeAvatar({
  assignee,
  className,
  decorative,
  disableLink,
  disableTooltip,
}: Readonly<AssigneeAvatarProps>) {
  const buildOrgPath = useOrgPath();
  if (!assignee) {
    const avatar = (
      <Avatar
        className={cn("size-6", className)}
        key="unassigned"
        {...nameOrHide(decorative, UNASSIGNED_ASSIGNEE_LABEL)}
      >
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
        <TooltipContent>{UNASSIGNED_ASSIGNEE_LABEL}</TooltipContent>
      </Tooltip>
    );
  }

  const initials = getUserInitials(assignee.firstName, assignee.lastName);
  const displayName = getUserDisplayName(assignee);

  const avatar = (
    <PersonAvatar
      {...(decorative
        ? { decorative: true as const }
        : { ariaLabel: displayName, role: "img" as const })}
      avatarUrl={assignee.avatarUrl}
      className={cn("size-6", className)}
      fallbackClassName="text-[10px]"
      imageAlt={displayName}
      initials={initials || "?"}
      key={assignee.id}
      name={displayName}
    />
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

/**
 * The avatar's accessibility-tree contribution: one name, or nothing at all.
 *
 * `role="img"` is what makes the label reliably exposed on a bare span, and it
 * prunes the descendants, which is the point: the fallback initials are a
 * derived abbreviation, not information, and a contents-named ancestor such as
 * `GroupSectionHeader` or the assignee picker button would otherwise fold "AL"
 * into its own name.
 */
function nameOrHide(
  decorative: boolean | undefined,
  name: string
): { "aria-hidden": true } | { "aria-label": string; role: "img" } {
  if (decorative) {
    return { "aria-hidden": true };
  }
  return { "aria-label": name, role: "img" };
}
