"use client";

import type { ReactNode } from "react";
import { ArtifactRoom } from "./artifact-room";

type OptionalArtifactRoomProps = {
  roomId: string | null | undefined;
  children: ReactNode;
};

/**
 * Conditionally wraps children with ArtifactRoom if roomId exists.
 * This allows components to use Liveblocks hooks conditionally.
 */
export function OptionalArtifactRoom({
  roomId,
  children,
}: Readonly<OptionalArtifactRoomProps>) {
  if (!roomId) {
    return <>{children}</>;
  }

  return <ArtifactRoom roomId={roomId}>{children}</ArtifactRoom>;
}
