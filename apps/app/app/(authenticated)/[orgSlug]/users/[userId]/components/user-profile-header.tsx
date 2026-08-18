"use client";

import type { User } from "@repo/api/src/types/user";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";

type UserProfileHeaderProps = {
  user: User;
};

export function UserProfileHeader({ user }: UserProfileHeaderProps) {
  const displayName = getUserDisplayName(user);

  return (
    <div className="flex items-center gap-4">
      <Avatar className="h-16 w-16">
        <AvatarImage alt={displayName} src={user.avatarUrl ?? undefined} />
        <AvatarFallback className="text-lg">
          {getUserInitials(user.firstName, user.lastName) || "?"}
        </AvatarFallback>
      </Avatar>
      <div>
        <h1 className="font-semibold text-2xl">{displayName}</h1>
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <span>{user.email}</span>
          <Badge variant="secondary">{user.role}</Badge>
          {user.githubUsername && (
            <span className="text-muted-foreground">
              @{user.githubUsername}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
