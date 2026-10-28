import type { RealtimeClient } from "@repo/realtime-client/connection";
import { startListenerPoll } from "@repo/realtime-client/poll";
import {
  type RealtimeClientPort,
  RealtimeStatus,
} from "@repo/realtime-client/port";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";

export type LazyRealtimePort = RealtimeClientPort & {
  /** Closes the client if one was built; a join after this only polls. */
  close: () => void;
};

/**
 * PLN-2162 decision 9: the client, and with it the socket and the token
 * fetch, is built on the first join rather than when the port is mounted.
 * Until then the port reads `connecting`, the status a new client starts in.
 * The client is closed when its last join leaves, and a client that closed
 * itself is replaced, so the next join builds a fresh one either way.
 */
export function createLazyRealtimePort(
  createClient: () => RealtimeClient
): LazyRealtimePort {
  let client: RealtimeClient | undefined;
  let stopListening: (() => void) | undefined;
  let held = 0;
  let closed = false;
  let reported: RealtimeStatus = RealtimeStatus.Connecting;
  const callbacks = new Set<(status: RealtimeStatus) => void>();
  const report = (status: RealtimeStatus) => {
    if (status === reported) {
      return;
    }
    reported = status;
    for (const callback of [...callbacks]) {
      callback(status);
    }
  };
  const ensureClient = (): RealtimeClient => {
    if (client === undefined || client.status() === RealtimeStatus.Closed) {
      stopListening?.();
      client = createClient();
      stopListening = client.onStatus(report);
      report(client.status());
    }
    return client;
  };
  const retireIfIdle = () => {
    if (held > 0 || closed || client === undefined) {
      return;
    }
    const idle = client;
    client = undefined;
    stopListening?.();
    stopListening = undefined;
    idle.close();
    report(RealtimeStatus.Connecting);
  };

  return {
    join(channel, listener) {
      if (closed) {
        // What a closed client tells a late join, so the listener still polls.
        listener.onError?.(RealtimeErrorCode.Internal);
        const poll = startListenerPoll(listener, false);
        return () => poll?.stop();
      }
      const leave = ensureClient().join(channel, listener);
      held += 1;
      let left = false;
      return () => {
        if (left) {
          return;
        }
        left = true;
        leave();
        held -= 1;
        retireIfIdle();
      };
    },
    status() {
      if (client !== undefined) {
        return client.status();
      }
      return closed ? RealtimeStatus.Closed : RealtimeStatus.Connecting;
    },
    onStatus(callback) {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      if (client === undefined) {
        report(RealtimeStatus.Closed);
      } else {
        client.close();
      }
    },
  };
}
