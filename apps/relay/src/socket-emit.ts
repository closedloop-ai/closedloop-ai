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
