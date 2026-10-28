import {
  type ParsedChannelAddress,
  parseChannelAddress,
} from "@repo/realtime-contract/channels";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { matchGrant } from "@repo/realtime-contract/grants";
import {
  type ErrorPayload,
  type JoinAck,
  RealtimeEvent,
} from "@repo/realtime-contract/protocol";
import type { Revocations } from "@repo/realtime-contract/revocations";
import type { RealtimeTokenClaims } from "@repo/realtime-contract/token";
import {
  DELIVERY_CLASSES,
  type DeliveryClass,
  resolveDeliveryClass,
} from "../classes/registry";
import type { RealtimeSocket } from "./socket-server";

export type JoinOutcome = {
  ack: JoinAck;
  /** Read from the parsed address; absent when the address did not parse. */
  kind: string | undefined;
};

/**
 * PLN-2104 step 4, in the plan's order: the generic address grammar
 * (`bad_scope`), a grant for the class's subscribe access in the token's own
 * org that no revoke binds (`forbidden`), then the class's
 * channels-per-connection limit (`rate_limited`). No kind is checked: any kind
 * a grant covers is joinable. The ack's `channelId` is the channel address,
 * which is also the room name.
 */
export function admitJoin(
  socket: RealtimeSocket,
  channel: string,
  revocations: Revocations
): JoinOutcome {
  const address = parseChannelAddress(channel);
  if (address === null) {
    return { ack: refused(RealtimeErrorCode.BadScope), kind: undefined };
  }
  const { kind } = address;
  const deliveryClass = resolveDeliveryClass(address);
  const module = DELIVERY_CLASSES[deliveryClass];
  const { claims } = socket.data;
  if (
    !isGranted(claims, channel, deliveryClass) ||
    revocations.covers(claims, channel)
  ) {
    return { ack: refused(RealtimeErrorCode.Forbidden), kind };
  }
  if (socket.rooms.has(channel)) {
    return { ack: { ok: true, channelId: channel }, kind };
  }
  if (
    joinedChannelCount(socket, deliveryClass) >=
    module.limits.maxChannelsPerConnection
  ) {
    return { ack: refused(RealtimeErrorCode.RateLimited), kind };
  }
  socket.join(channel);
  module.runtime.onJoin(socket, channel);
  return { ack: { ok: true, channelId: channel }, kind };
}

/** Only a channel address is left, so a client cannot drop its own socket-id room. */
export function leaveChannel(socket: RealtimeSocket, channel: string): void {
  const address = parseChannelAddress(channel);
  if (address !== null && socket.rooms.has(channel)) {
    leaveJoined(socket, channel, address);
  }
}

/**
 * After a refresh swaps the claims, every joined channel the new grants no
 * longer cover, or a revoke binds, is left and reported
 * `rt:error { channel, code: "forbidden" }`.
 */
export function leaveUngrantedChannels(
  socket: RealtimeSocket,
  revocations: Revocations
): void {
  const { claims } = socket.data;
  for (const room of [...socket.rooms]) {
    const address = parseChannelAddress(room);
    if (
      address === null ||
      (isGranted(claims, room, resolveDeliveryClass(address)) &&
        !revocations.covers(claims, room))
    ) {
      continue;
    }
    closeChannel(socket, room, address);
  }
}

/**
 * PLN-2105 step 5: a revoke leaves `channel` and reports it
 * `rt:error { channel, code: "forbidden" }`. Returns false when the socket is
 * not in that channel; any room that is not a channel address is left alone.
 */
export function revokeChannel(
  socket: RealtimeSocket,
  channel: string
): boolean {
  const address = parseChannelAddress(channel);
  if (address === null || !socket.rooms.has(channel)) {
    return false;
  }
  closeChannel(socket, channel, address);
  return true;
}

function closeChannel(
  socket: RealtimeSocket,
  channel: string,
  address: ParsedChannelAddress
): void {
  leaveJoined(socket, channel, address);
  const payload: ErrorPayload = {
    channel,
    code: RealtimeErrorCode.Forbidden,
  };
  socket.emit(RealtimeEvent.Error, payload);
}

function leaveJoined(
  socket: RealtimeSocket,
  channel: string,
  address: ParsedChannelAddress
): void {
  socket.leave(channel);
  DELIVERY_CLASSES[resolveDeliveryClass(address)].runtime.onLeave(
    socket,
    channel
  );
}

function isGranted(
  claims: RealtimeTokenClaims,
  channel: string,
  deliveryClass: DeliveryClass
): boolean {
  return matchGrant(
    claims.grants,
    channel,
    DELIVERY_CLASSES[deliveryClass].subscribeAccess,
    claims.org
  );
}

function joinedChannelCount(
  socket: RealtimeSocket,
  deliveryClass: DeliveryClass
): number {
  let count = 0;
  for (const room of socket.rooms) {
    const address = parseChannelAddress(room);
    if (address !== null && resolveDeliveryClass(address) === deliveryClass) {
      count += 1;
    }
  }
  return count;
}

function refused(code: RealtimeErrorCode): JoinAck {
  return { ok: false, code };
}
