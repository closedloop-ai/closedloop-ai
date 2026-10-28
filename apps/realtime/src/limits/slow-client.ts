import { log } from "@repo/observability/log";
import type { RealtimeSocket } from "../edge/socket-server";

/**
 * PLN-2104 step 6: a socket whose engine write buffer passes
 * `maxBufferedPackets` is dropped, and its client reconnects and resyncs.
 *
 * engine.io 6.6 queues every outgoing packet in `writeBuffer` while the
 * transport has an unacknowledged write, so the buffer only grows for a
 * client that is not reading. The field is typed private, hence the
 * reflective read; the edge tests pin that a live engine socket still has it.
 */
export function dropSlowClient(
  socket: RealtimeSocket,
  maxBufferedPackets: number
): void {
  const { conn } = socket;
  let dropping = false;
  const onPacketCreate = () => {
    const buffered = bufferedPacketCount(conn);
    if (dropping || buffered < maxBufferedPackets) {
      return;
    }
    dropping = true;
    log.warn("Realtime dropped a slow client", {
      event: SLOW_CLIENT_DROPPED_EVENT,
      socketId: socket.id,
      bufferedPackets: buffered,
    });
    // `close()` without `discard` waits for the buffer to drain, which a slow
    // client never does. Deferred so the emit in progress finishes first.
    queueMicrotask(() => conn.close(true));
  };
  conn.on("packetCreate", onPacketCreate);
  socket.once("disconnect", () => conn.off("packetCreate", onPacketCreate));
}

/** 0 when the engine no longer keeps the buffer where 6.6 does. */
export function bufferedPacketCount(conn: object): number {
  const buffer: unknown = Reflect.get(conn, "writeBuffer");
  return Array.isArray(buffer) ? buffer.length : 0;
}

export const SLOW_CLIENT_DROPPED_EVENT = "realtime.slow_client_dropped";
