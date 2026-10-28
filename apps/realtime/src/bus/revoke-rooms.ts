import type { RealtimeServer } from "../edge/socket-server";

/**
 * PLN-2105 decision 7: every socket joins `user:{sub}` and `org:{org}` at
 * connection, so a revoke by user or by org finds its sockets without scanning
 * every room. A refresh cannot change either claim, so neither room goes
 * stale. Neither room parses as a channel address (neither has a scope
 * segment), so no join, leave, refresh or limit ever treats one as a channel,
 * and a client cannot leave it.
 */
export function userRoom(sub: string): string {
  return `${USER_ROOM_PREFIX}${sub}`;
}

export function orgRoom(org: string): string {
  return `${ORG_ROOM_PREFIX}${org}`;
}

export function joinRevokeRooms(io: RealtimeServer): void {
  io.on("connection", (socket) => {
    const { sub, org } = socket.data.claims;
    socket.join([userRoom(sub), orgRoom(org)]);
  });
}

const USER_ROOM_PREFIX = "user:";
const ORG_ROOM_PREFIX = "org:";
