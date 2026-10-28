import { describeCause } from "@repo/http-service/describe-cause";
import { log } from "@repo/observability/log";
import { REALTIME_SIGNAL_CHANNEL } from "@repo/realtime-contract/signal";
import { recordListenReconnect } from "../telemetry/spans";
import { LISTEN_STATEMENT, type ListenOnlyClient } from "./listen-only-client";

export type SignalListenerOptions = {
  /** A new, unconnected client per attempt. */
  openClient: () => ListenOnlyClient;
  /** Each `realtime_signal` notification's raw payload. */
  onSignal: (payload: string) => void;
  /** Once LISTEN is in place; `resumed` when it replaces a lost listener. */
  onListening: (resumed: boolean) => void;
  /** An established listener was lost; reconnection has begun. */
  onLost: (cause: string) => void;
  /** Uniform in [0, 1). */
  random?: () => number;
  now?: () => number;
};

export type SignalListener = { stop(): Promise<void> };

/**
 * PLN-2105 step 1 and decision 1: every instance holds one dedicated
 * connection running `LISTEN realtime_signal`. Losing it (`error` or `end`)
 * reports the loss, then reconnects with jittered exponential backoff and
 * runs LISTEN again; the caller resyncs its channels when `onListening`
 * reports `resumed`, because notifications sent in the gap are gone.
 */
export function startSignalListener(
  options: SignalListenerOptions
): SignalListener {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  let generation = 0;
  let attempt = 0;
  let backoff = 0;
  let listeningSince = 0;
  let listening: ListenOnlyClient | undefined;
  let everListened = false;
  let loss: { cause: string; at: number } | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const fail = (
    clientGeneration: number,
    client: ListenOnlyClient,
    cause: string
  ): void => {
    if (clientGeneration !== generation || stopped) {
      return;
    }
    generation += 1;
    client.end().catch(() => undefined);
    if (listening === client) {
      listening = undefined;
      // A backend that accepts LISTEN and then drops it keeps backing off, so
      // a flapping connection cannot resync every socket several times a second.
      if (now() - listeningSince >= LISTEN_STABLE_MS) {
        backoff = 0;
      }
      loss = { cause, at: now() };
      log.warn("Realtime LISTEN connection lost", {
        event: LISTEN_LOST_EVENT,
        cause,
      });
      options.onLost(cause);
    } else {
      log.warn("Realtime LISTEN connection attempt failed", {
        event: LISTEN_CONNECT_FAILED_EVENT,
        cause,
        attempt,
      });
    }
    const delayMs = reconnectDelayMs(backoff, random);
    backoff += 1;
    attempt += 1;
    retryTimer = setTimeout(() => {
      connect().catch(() => undefined);
    }, delayMs);
  };

  const established = (client: ListenOnlyClient): void => {
    listening = client;
    listeningSince = now();
    const resumed = everListened;
    everListened = true;
    if (loss) {
      recordListenReconnect(loss.cause, loss.at, attempt);
      log.info("Realtime LISTEN connection restored", {
        event: LISTEN_RESTORED_EVENT,
        cause: loss.cause,
        attempts: attempt,
      });
      loss = undefined;
    }
    attempt = 0;
    options.onListening(resumed);
  };

  const connect = async (): Promise<void> => {
    generation += 1;
    const clientGeneration = generation;
    const client = options.openClient();
    client.on("error", (error) =>
      fail(clientGeneration, client, describeCause(error))
    );
    client.on("end", () =>
      fail(clientGeneration, client, LISTEN_CONNECTION_ENDED)
    );
    client.on("notification", (notification) => {
      if (
        clientGeneration === generation &&
        notification.channel === REALTIME_SIGNAL_CHANNEL &&
        notification.payload !== undefined
      ) {
        options.onSignal(notification.payload);
      }
    });
    try {
      await client.connect();
      await client.query(LISTEN_STATEMENT);
    } catch (error) {
      fail(clientGeneration, client, describeCause(error));
      return;
    }
    if (stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    if (clientGeneration === generation) {
      established(client);
    }
  };

  connect().catch(() => undefined);
  return {
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      await listening?.end().catch(() => undefined);
    },
  };
}

export function reconnectDelayMs(
  attempt: number,
  random: () => number
): number {
  const ceilingMs = Math.min(
    RECONNECT_CAP_MS,
    RECONNECT_BASE_MS * 2 ** attempt
  );
  return Math.floor(random() * ceilingMs);
}

export const RECONNECT_BASE_MS = 250;
export const RECONNECT_CAP_MS = 10_000;
/** How long a listener must hold before its loss restarts the backoff. */
export const LISTEN_STABLE_MS = 30_000;

export const LISTEN_CONNECTION_ENDED = "connection_ended";

export const LISTEN_LOST_EVENT = "realtime.listen_lost";
export const LISTEN_RESTORED_EVENT = "realtime.listen_restored";
export const LISTEN_CONNECT_FAILED_EVENT = "realtime.listen_connect_failed";
