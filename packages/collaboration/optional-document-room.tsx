"use client";

import type { ReactNode } from "react";
import { DocumentRoom } from "./document-room";

type OptionalDocumentRoomProps = {
  roomId: string | null | undefined;
  children: ReactNode;
};

/**
 * Conditionally wraps children with DocumentRoom if roomId exists.
 * This allows components to use Liveblocks hooks conditionally.
 * Mention resolution is handled by the top-level LiveblocksProvider.
 */
export function OptionalDocumentRoom({
  roomId,
  children,
}: Readonly<OptionalDocumentRoomProps>) {
  if (!roomId) {
    return <>{children}</>;
  }

  return <DocumentRoom roomId={roomId}>{children}</DocumentRoom>;
}
