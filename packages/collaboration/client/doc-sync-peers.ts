"use client";

import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { getConsistentColor } from "../shared/user-colors";
import { DocSyncConfigContext } from "./doc-sync-config";
import { DocSyncAwarenessField, useDocSyncRoom } from "./doc-sync-room";

/** One awareness connection, in the shape `filterLiveOthers` and `Presence` read. */
export type DocSyncPeer = {
  connectionId: number;
  info: { name: string; avatar?: string; color: string };
  presence: { readOnly: boolean };
};

export type DocSyncPeers = { others: DocSyncPeer[]; self: DocSyncPeer | null };

/**
 * The room's awareness peers (PLN-2189 T-2.4). Awareness is snapshotted into
 * state on every `change` event, because a mutable map read during render is
 * memoized away by the React Compiler. A peer's name, avatar and colour are
 * resolved locally from its `userId`; nothing a peer wrote is rendered.
 */
export function useDocSyncPeers(): DocSyncPeers {
  const awareness = useDocSyncRoom()?.room?.provider.awareness ?? null;
  const resolveUser = useContext(DocSyncConfigContext)?.resolveUser;
  const [snapshot, setSnapshot] = useState<AwarenessSnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    if (!awareness) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    const onChange = () => {
      setSnapshot(readAwareness(awareness.getStates(), awareness.clientID));
    };
    onChange();
    awareness.on("change", onChange);
    return () => {
      awareness.off("change", onChange);
    };
  }, [awareness]);

  const toPeer = (state: PeerState): DocSyncPeer => {
    const user = resolveUser?.(state.userId);
    return {
      connectionId: state.clientId,
      info: {
        name: user?.name ?? "",
        avatar: user?.avatarUrl,
        color: getConsistentColor(state.userId),
      },
      presence: { readOnly: state.readOnly },
    };
  };

  return {
    others: snapshot.others.map(toPeer),
    self: snapshot.self ? toPeer(snapshot.self) : null,
  };
}

type PeerState = { clientId: number; userId: string; readOnly: boolean };

type AwarenessSnapshot = { others: PeerState[]; self: PeerState | null };

const EMPTY_SNAPSHOT: AwarenessSnapshot = { others: [], self: null };

/** A connection that has not written its `user` yet is not a peer yet. */
const awarenessStateSchema = z.object({
  [DocSyncAwarenessField.User]: z.object({ id: z.string().min(1) }),
  [DocSyncAwarenessField.ReadOnly]: z.boolean().optional(),
});

function readAwareness(
  states: ReadonlyMap<number, unknown>,
  ownClientId: number
): AwarenessSnapshot {
  const others: PeerState[] = [];
  let self: PeerState | null = null;
  for (const [clientId, state] of states) {
    const parsed = awarenessStateSchema.safeParse(state);
    if (!parsed.success) {
      continue;
    }
    const peer = {
      clientId,
      userId: parsed.data.user.id,
      readOnly: parsed.data.readOnly === true,
    };
    if (clientId === ownClientId) {
      self = peer;
    } else {
      others.push(peer);
    }
  }
  return { others, self };
}
