"use client";

import type { User } from "@repo/api/src/types/user";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";

type UserProfileHeaderProps = {
  user: User;
};

function getInitials(
  firstName: string | null,
  lastName: string | null
): string {
  const first = firstName?.[0] ?? "";
  const last = lastName?.[0] ?? "";
  return (first + last).toUpperCase() || "?";
}

export function UserProfileHeader({ user }: UserProfileHeaderProps) {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  const displayName = fullName || user.email;

  return (
    <div className="flex items-center gap-4">
      <Avatar className="h-16 w-16">
        <AvatarImage alt={displayName} src={user.avatarUrl ?? undefined} />
        <AvatarFallback className="text-lg">
          {getInitials(user.firstName, user.lastName)}
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
