"use client";

import { useOthers, useSelf } from "@liveblocks/react/suspense";
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

/**
 * Displays an avatar stack of active users in the current room.
 * Shows up to 3 avatars with a "+N" indicator for additional users.
 */
export function Presence() {
  const others = useOthers();
  const currentUser = useSelf();

  const hasMoreUsers = others.length > 3;
  const displayedOthers = hasMoreUsers ? others.slice(0, 3) : others;

  if (others.length === 0) {
    return null;
  }

  return (
    <div className="border-b px-4 py-2">
      <div className="flex items-center">
        {currentUser && (
          <UserAvatar
            avatar={currentUser.info.avatar}
            color={currentUser.info.color}
            isCurrentUser
            name={currentUser.info.name || "You"}
          />
        )}

        <div className="ml-2 flex -space-x-2">
          {displayedOthers.map(({ connectionId, info }) => (
            <UserAvatar
              avatar={info.avatar}
              color={info.color}
              key={connectionId}
              name={info.name || "Anonymous"}
            />
          ))}

          {hasMoreUsers && (
            <div className="flex size-8 items-center justify-center rounded-full border-2 border-background bg-muted font-medium text-xs">
              +{others.length - 3}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type UserAvatarProps = {
  name: string;
  avatar?: string;
  color: string;
  isCurrentUser?: boolean;
};

function UserAvatar({
  name,
  avatar,
  color,
  isCurrentUser,
}: Readonly<UserAvatarProps>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar
          className={cn(
            "size-8 border-2",
            isCurrentUser
              ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
              : "transition-transform hover:z-10 hover:scale-110"
          )}
          style={{
            borderColor: color,
          }}
        >
          {avatar && <AvatarImage alt={name} src={avatar} />}
          <AvatarFallback
            style={{
              backgroundColor: color,
              color: "white",
            }}
          >
            {getInitials(name)}
          </AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Extracts initials from a name (max 2 characters).
 * Examples: "John Doe" -> "JD", "Jane" -> "JA", "?" -> "?"
 */
function getInitials(name: string): string {
  if (!name || name === "?") {
    return "?";
  }

  const parts = name.trim().split(whitespaceRegex);

  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  return name.slice(0, 2).toUpperCase();
}

const whitespaceRegex = /\s+/;

/**
 * Inline avatar stack for use in toolbars. No border/padding wrapper.
 * Returns null when no other users are present.
 */
export function InlinePresence() {
  const others = useOthers();
  const currentUser = useSelf();

  if (others.length === 0) {
    return null;
  }

  const hasMoreUsers = others.length > 3;
  const displayedOthers = hasMoreUsers ? others.slice(0, 3) : others;

  return (
    <div className="flex items-center">
      {currentUser && (
        <UserAvatar
          avatar={currentUser.info.avatar}
          color={currentUser.info.color}
          isCurrentUser
          name={currentUser.info.name || "You"}
        />
      )}

      <div className="ml-2 flex -space-x-2">
        {displayedOthers.map(({ connectionId, info }) => (
          <UserAvatar
            avatar={info.avatar}
            color={info.color}
            key={connectionId}
            name={info.name || "Anonymous"}
          />
        ))}

        {hasMoreUsers && (
          <div className="flex size-8 items-center justify-center rounded-full border-2 border-background bg-muted font-medium text-xs">
            +{others.length - 3}
          </div>
        )}
      </div>
    </div>
  );
}
