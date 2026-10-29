import {
  RealtimeEvent,
  type ResyncPayload,
} from "@repo/realtime-contract/protocol";
import type { DeliveryClassRuntime } from "../classes/registry";
import type { RealtimeServer, RealtimeSocket } from "../edge/socket-server";

/** Each socket's joined signal-class rooms, per socket server. */
type JoinedRooms = Map<RealtimeSocket, Set<string>>;

const joinedByServer = new WeakMap<RealtimeServer, JoinedRooms>();

/**
 * PLN-2105 step 4: the signal class's runtime hook (PLN-2104 step 5). State is
 * kept per socket server, so two instances in one process stay apart. A
 * socket's entry goes when its last room is left or it disconnects.
 */
export const signalRuntime: DeliveryClassRuntime = {
  start(io) {
    joinedByServer.set(io, new Map());
  },
  onConnection(socket) {
    socket.once("disconnect", () => {
      joinedRoomsOf(socket)?.delete(socket);
    });
  },
  onJoin(socket, address) {
    const joined = joinedRoomsOf(socket);
    if (!(joined && socket.connected)) {
      return;
    }
    const rooms = joined.get(socket) ?? new Set<string>();
    rooms.add(address);
    joined.set(socket, rooms);
  },
  onLeave(socket, address) {
    const joined = joinedRoomsOf(socket);
    const rooms = joined?.get(socket);
    if (!(joined && rooms)) {
      return;
    }
    rooms.delete(address);
    if (rooms.size === 0) {
      joined.delete(socket);
    }
  },
};

/**
 * PLN-2105 step 3: `rt:resync {}` once to each local socket holding at least
 * one signal-class room, after a break that may have lost signals on every
 * channel this instance serves. Returns how many sockets it reached.
 */
export function resyncAll(io: RealtimeServer): number {
  const joined = joinedByServer.get(io);
  if (!joined) {
    return 0;
  }
  const payload: ResyncPayload = {};
  for (const socket of joined.keys()) {
    socket.emit(RealtimeEvent.Resync, payload);
  }
  return joined.size;
}

function joinedRoomsOf(socket: RealtimeSocket): JoinedRooms | undefined {
  return joinedByServer.get(socket.nsp.server);
}
