import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import type { Socket } from "socket.io";

/**
 * Forwards every response event the API asked the relay to deliver.
 *
 * Extracted so the rejection path can reuse it: the API answers a refused
 * `desktop.hello` with `{ emit: [desktop.hello.nack], disconnect: true }`, and
 * the relay must deliver that frame before it closes the socket. Dropping it
 * leaves the desktop with Socket.IO's own `io server disconnect` and no cause.
 * See ISS-6126.
 */
export function emitSocketEvents(
  socket: Pick<Socket, "emit">,
  events: Array<{ event: string; payload: unknown }>
): void {
  for (const { event, payload } of events) {
    socket.emit(event, payload);
  }
}

/**
 * Tells the desktop its hello failed on the relay/API side rather than being
 * refused (ISS-7976, ISS-11843). `internal_error` is an already-shipped
 * `DesktopHelloNackReason`, so every installed desktop maps it.
 */
export function emitHelloInternalErrorNack(socket: Pick<Socket, "emit">): void {
  emitSocketEvents(socket, [
    {
      event: "desktop.hello.nack",
      payload: { reason: DesktopHelloNackReason.InternalError },
    },
  ]);
}
