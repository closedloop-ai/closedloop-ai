"use client";

import { useOthers, useSelf } from "@liveblocks/react/suspense";
import { avatarInitial } from "@repo/design-system/components/ui/avatar";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import {
  ANONYMOUS_USER_NAME,
  filterLiveOthers,
} from "../shared/presence-utils";
import { useDocSyncPeers } from "./doc-sync-peers";
import { useIsOnDocSync } from "./doc-sync-room";

/**
 * The room's peers: doc-sync awareness under a `DocSyncRoom` (PLN-2189 T-2.5),
 * Liveblocks otherwise. Both sources are read unconditionally; the Liveblocks
 * `RoomProvider` stays mounted for threads either way.
 */
function usePeers(): {
  others: readonly PresencePeer[];
  self: Pick<PresencePeer, "info"> | null;
} {
  const liveblocksOthers = useOthers();
  const liveblocksSelf = useSelf();
  const docSyncPeers = useDocSyncPeers();
  const isOnDocSync = useIsOnDocSync();
  if (isOnDocSync) {
    return docSyncPeers;
  }
  return { others: liveblocksOthers, self: liveblocksSelf };
}

/**
 * Displays an avatar stack of active users in the current room.
 * Shows up to 3 avatars with a "+N" indicator for additional users.
 */
export function Presence() {
  const { others, self: currentUser } = usePeers();

  const liveOthers = filterLiveOthers(others);
  const hasMoreUsers = liveOthers.length > 3;
  const displayedOthers = hasMoreUsers ? liveOthers.slice(0, 3) : liveOthers;

  if (liveOthers.length === 0) {
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
              name={info.name || ANONYMOUS_USER_NAME}
            />
          ))}

          {hasMoreUsers && (
            <div className="flex size-8 items-center justify-center rounded-full border-2 border-background bg-muted font-medium text-xs">
              +{liveOthers.length - 3}
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
        {/* The presence colour rings the avatar (`style` reaches the root);
            the initial sits on the shared avatar colours (Nerys,
            2026-10-22). */}
        <PersonAvatar
          avatarUrl={avatar}
          className={cn(
            "size-8 border-2",
            isCurrentUser
              ? ""
              : "transition-transform hover:z-10 hover:scale-110"
          )}
          imageAlt={name}
          initials={avatarInitial(name, "?")}
          name={name}
          style={{ borderColor: color }}
        />
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Inline avatar stack for use in toolbars. No border/padding wrapper.
 * Returns null when no other users are present.
 */
export function InlinePresence() {
  const { others, self: currentUser } = usePeers();

  const liveOthers = filterLiveOthers(others);

  if (liveOthers.length === 0) {
    return null;
  }

  const hasMoreUsers = liveOthers.length > 3;
  const displayedOthers = hasMoreUsers ? liveOthers.slice(0, 3) : liveOthers;

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
            name={info.name || ANONYMOUS_USER_NAME}
          />
        ))}

        {hasMoreUsers && (
          <div className="flex size-8 items-center justify-center rounded-full border-2 border-background bg-muted font-medium text-xs">
            +{liveOthers.length - 3}
          </div>
        )}
      </div>
    </div>
  );
}

type PresencePeer = {
  connectionId: number;
  info: { name?: string; avatar?: string; color: string };
  presence: { readOnly?: boolean };
};
