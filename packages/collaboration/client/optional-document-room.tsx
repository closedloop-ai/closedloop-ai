"use client";

import type { ReactNode } from "react";
import { DocumentRoom } from "./document-room";

type OptionalDocumentRoomProps = {
  roomId: string | null | undefined;
  children: ReactNode;
  /**
   * Passed through to `DocumentRoom` — see its prop docs. Caller sets this
   * true when the viewer is in a read-only context (e.g. historical
   * artifact version) so the connection is hidden from live editors'
   * presence stack.
   */
  readOnly?: boolean;
};

/**
 * Conditionally wraps children with DocumentRoom if roomId exists.
 * This allows components to use Liveblocks hooks conditionally.
 * Mention resolution is handled by the top-level LiveblocksProvider.
 */
export function OptionalDocumentRoom({
  roomId,
  children,
  readOnly,
}: Readonly<OptionalDocumentRoomProps>) {
  if (!roomId) {
    return <>{children}</>;
  }

  return (
    <DocumentRoom readOnly={readOnly} roomId={roomId}>
      {children}
    </DocumentRoom>
  );
}
