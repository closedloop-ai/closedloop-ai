"use client";

import type { User } from "@repo/api/src/types/user";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";

type UserProfileHeaderProps = {
  user: User;
};

export function UserProfileHeader({ user }: UserProfileHeaderProps) {
  const displayName = getUserDisplayName(user);

  return (
    <div className="flex items-center gap-4">
      <PersonAvatar
        avatarUrl={user.avatarUrl}
        className="h-16 w-16"
        fallbackClassName="text-lg"
        imageAlt={displayName}
        initials={getUserInitials(user.firstName, user.lastName) || "?"}
        name={displayName}
      />
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
