import type { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import type { SignalPayload } from "@repo/realtime-contract/protocol";

/** PLN-2106 decision 4. How each status looks to users is design's call. */
export const RealtimeStatus = {
  /** First connection attempt in progress. */
  Connecting: "connecting",
  /** Connected and welcomed. */
  Open: "open",
  /** Was open, now reconnecting. */
  Degraded: "degraded",
  /** Stopped, or refused for good. */
  Closed: "closed",
} as const;
export type RealtimeStatus =
  (typeof RealtimeStatus)[keyof typeof RealtimeStatus];

/**
 * A signal as the service delivered it. The type is not checked against the
 * per-type schemas here (PLN-2106 decision 7): a type this build has never seen
 * reaches the listener unchanged.
 */
export type RealtimeSignal = Pick<SignalPayload, "type" | "data">;

export type RealtimeChannelListener = {
  onSignal: (signal: RealtimeSignal) => void;
  /** Reload current state from the API. */
  onResync: () => void;
  /** The channel was refused or revoked. It is no longer joined and is never rejoined on its own. */
  onError?: (code: RealtimeErrorCode) => void;
  /**
   * When the consumer's data was loaded, on the client's clock in epoch
   * milliseconds; undefined when it has not loaded. Data loaded before the
   * join was acknowledged may have missed a signal, so it gets `onResync`.
   */
  dataLoadedAt?: () => number | undefined;
  /**
   * Reloads the consumer's data from the API. Runs only while the channel is
   * not live (status `open` and the join acknowledged), from `join` until its
   * leave, a dropped channel included.
   */
  poll?: () => Promise<void>;
  /** A poll rejected; polling carries on. */
  onPollError?: (error: unknown) => void;
};

/** PLN-2106 decision 1: what hosts and the React bindings program against. */
export type RealtimeClientPort = {
  /** Returns the matching leave; calling it more than once is harmless. */
  join: (channel: string, listener: RealtimeChannelListener) => () => void;
  status: () => RealtimeStatus;
  /** Called on each status change; returns the unsubscribe. */
  onStatus: (callback: (status: RealtimeStatus) => void) => () => void;
};

/**
 * PLN-2106 decision 5: a listener whose data loaded before the channel went
 * live, or has not loaded, may have missed a signal, so it reloads.
 */
export function applyResyncRule(
  listener: RealtimeChannelListener,
  liveAt: number
): void {
  const loadedAt = listener.dataLoadedAt?.();
  if (loadedAt === undefined || loadedAt < liveAt) {
    listener.onResync();
  }
}
