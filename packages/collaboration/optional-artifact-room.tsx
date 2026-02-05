"use client";

import type { ReactNode } from "react";
import { ArtifactRoom, type UserInfo } from "./artifact-room";

type OptionalArtifactRoomProps = {
  roomId: string | null | undefined;
  children: ReactNode;
  users?: UserInfo[];
};

/**
 * Conditionally wraps children with ArtifactRoom if roomId exists.
 * This allows components to use Liveblocks hooks conditionally.
 * Supports @mentions when users array is provided.
 */
export function OptionalArtifactRoom({
  roomId,
  children,
  users,
}: Readonly<OptionalArtifactRoomProps>) {
  if (!roomId) {
    return <>{children}</>;
  }

  return (
    <ArtifactRoom roomId={roomId} users={users}>
      {children}
    </ArtifactRoom>
  );
}
