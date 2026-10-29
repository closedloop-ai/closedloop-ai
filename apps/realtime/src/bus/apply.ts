import {
  type BusMessage,
  BusOp,
  type RevokeTarget,
} from "@repo/realtime-contract/internal";
import {
  RealtimeEvent,
  type SignalPayload,
} from "@repo/realtime-contract/protocol";
import type {
  Revocation,
  Revocations,
} from "@repo/realtime-contract/revocations";
import { revokeChannel } from "../edge/channels";
import type { RealtimeServer, RealtimeSocket } from "../edge/socket-server";
import { recordBusApply } from "../telemetry/spans";
import { orgRoom, userRoom } from "./revoke-rooms";

/**
 * PLN-2105 step 5: applies one bus message to this instance's own sockets.
 * Every instance, the one that received the internal request included,
 * applies it from its own subscription, so there is one delivery path. A
 * revoke is taken as of `now()`, when this instance learns of it.
 * Returns how many local sockets it reached.
 */
export function applyBusMessage(
  io: RealtimeServer,
  message: BusMessage,
  revocations: Revocations,
  now: () => number
): number {
  if (message.op === BusOp.Publish) {
    const { channel, type, data } = message;
    const recipients = io.of("/").adapter.rooms.get(channel)?.size ?? 0;
    const signal: SignalPayload = { channel, type, data };
    io.local.to(channel).emit(RealtimeEvent.Signal, signal);
    recordBusApply(message.op, recipients);
    return recipients;
  }
  const revoked = applyRevocation(io, revocations, {
    target: message.target,
    at: now(),
  });
  recordBusApply(message.op, revoked, revokeTargetField(message.target));
  return revoked;
}

export function revokeTargetField(target: RevokeTarget): string {
  if ("userId" in target) {
    return RevokeTargetField.User;
  }
  if ("channel" in target) {
    return RevokeTargetField.Channel;
  }
  return RevokeTargetField.Org;
}

export const RevokeTargetField = {
  User: "user",
  Channel: "channel",
  Org: "org",
} as const;

/**
 * Records the revoke, then closes every matching channel held by a local
 * socket whose token it binds. Returns how many sockets lost a channel.
 */
export function applyRevocation(
  io: RealtimeServer,
  revocations: Revocations,
  revocation: Revocation
): number {
  revocations.record(revocation);
  const { target } = revocation;
  const affected = new Set<RealtimeSocket>();
  const revoke = (socket: RealtimeSocket, channel: string): void => {
    if (
      revocations.covers(socket.data.claims, channel) &&
      revokeChannel(socket, channel)
    ) {
      affected.add(socket);
    }
  };
  if ("channel" in target) {
    for (const socket of socketsIn(io, target.channel)) {
      revoke(socket, target.channel);
    }
    return affected.size;
  }
  const holders =
    "userId" in target ? userRoom(target.userId) : orgRoom(target.orgId);
  for (const socket of socketsIn(io, holders)) {
    for (const room of [...socket.rooms]) {
      revoke(socket, room);
    }
  }
  return affected.size;
}

/** A snapshot, since revoking changes the room being read. */
function socketsIn(io: RealtimeServer, room: string): RealtimeSocket[] {
  const namespace = io.of("/");
  const ids = namespace.adapter.rooms.get(room);
  if (ids === undefined) {
    return [];
  }
  const sockets: RealtimeSocket[] = [];
  for (const id of ids) {
    const socket = namespace.sockets.get(id);
    if (socket) {
      sockets.push(socket);
    }
  }
  return sockets;
}
