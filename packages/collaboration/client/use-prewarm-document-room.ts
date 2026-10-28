"use client";

import { useClient } from "@liveblocks/react/suspense";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import { useEffect } from "react";

/**
 * Presence for a connection that is only warming the room.
 *
 * `readOnly` keeps the warming connection out of the live editors' avatar
 * stack, so nobody else sees this user arrive before the editor they are
 * opening exists. `ReadOnlyPresenceSync` in `DocumentRoom` publishes the real
 * value once that editor mounts.
 */
const PREWARM_PRESENCE = { readOnly: true };

/**
 * Connect `roomId` and start loading its Y.Doc, ahead of the editor that will
 * read it (ISS-7492).
 *
 * The room is otherwise entered by the editor's own `RoomProvider`, which
 * cannot mount until the page does. Measured on production RUM over 7 days of
 * artifact-route loads, that put the WebSocket connect and the Y.Doc round trip
 * — p75 1,151 ms between the room's first REST call and the editor's first
 * paint — entirely after the document read and the page mount, rather than
 * beside them.
 *
 * `enterRoom` is reference-counted and `getYjsProviderForRoom` is cached per
 * room, so the editor's `RoomProvider` and `useLiveblocksExtension()` adopt
 * this connection and this provider instead of opening a second one. The
 * provider is created with no options, matching what the Tiptap extension's own
 * defaults produce for every call site in this repo — see the
 * `useLiveblocksExtension()` argument test in `packages/app`.
 *
 * Pass `null` whenever the room is not knowable yet, or must not be joined:
 * the caller owns the same user/org readiness gate the editor applies
 * (FEA-2404), because an auth callback fired before Clerk and the org hydrate
 * can exhaust Liveblocks' 10s auth timeout.
 */
export function usePrewarmDocumentRoom(roomId: string | null): void {
  const client = useClient();

  useEffect(() => {
    if (!roomId) {
      return;
    }
    const { room, leave } = client.enterRoom(roomId, {
      initialPresence: PREWARM_PRESENCE,
    });
    getYjsProviderForRoom(room);
    return leave;
  }, [client, roomId]);
}
