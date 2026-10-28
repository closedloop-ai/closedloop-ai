import { type PollLoop, startListenerPoll } from "@repo/realtime-client/poll";
import {
  applyResyncRule,
  type RealtimeChannelListener,
  type RealtimeClientPort,
  RealtimeStatus,
} from "@repo/realtime-client/port";
import {
  RealtimeErrorCode,
  type RealtimeErrorCode as RealtimeErrorCodeValue,
} from "@repo/realtime-contract/error-codes";
import {
  type DesktopRealtimeApi,
  type DesktopRealtimeEvent,
  DesktopRealtimeEventKind,
  desktopRealtimeEventSchema,
  desktopRealtimeJoinResultSchema,
} from "../../shared/desktop-realtime-contract";

export type IpcRealtimePort = RealtimeClientPort & {
  /** Leaves every channel and stops listening; a later join only polls. */
  dispose: () => void;
};

/**
 * PLN-2162 M4 (decision 10): the renderer's `RealtimeClientPort` over the
 * socket main holds. Listener functions cannot cross IPC, so each listener's
 * poll loop and its resync rule run here. A channel is live while main
 * reports the status `open` and the service acknowledged its join; a join
 * main refuses or never answers, an older main included, leaves it polling.
 */
export function createIpcRealtimePort(
  api: DesktopRealtimeApi
): IpcRealtimePort {
  let status: RealtimeStatus = RealtimeStatus.Connecting;
  // Bumped per pushed status, so a join's answer older than one is ignored.
  let statusEpoch = 0;
  let disposed = false;
  const entries = new Map<string, ChannelEntry>();
  const statusCallbacks = new Set<(next: RealtimeStatus) => void>();

  const isLive = (entry: ChannelEntry) =>
    entry.joined &&
    entries.get(entry.channel) === entry &&
    status === RealtimeStatus.Open;

  const updateLiveness = (entry: ChannelEntry) => {
    const live = isLive(entry);
    for (const subscription of entry.subscriptions) {
      subscription.poll?.setLive(live);
    }
  };

  const setStatus = (next: RealtimeStatus) => {
    if (next === status) {
      return;
    }
    status = next;
    for (const entry of entries.values()) {
      if (next !== RealtimeStatus.Open) {
        // Main rejoins after every reconnect and reports each ack again.
        entry.joined = false;
      }
      updateLiveness(entry);
    }
    for (const callback of [...statusCallbacks]) {
      callback(next);
    }
  };

  const markJoined = (entry: ChannelEntry) => {
    if (entry.joined || entries.get(entry.channel) !== entry) {
      return;
    }
    entry.joined = true;
    const joinedAt = Date.now();
    for (const subscription of [...entry.subscriptions]) {
      applyResyncRule(subscription.listener, joinedAt);
    }
    updateLiveness(entry);
  };

  const drop = (entry: ChannelEntry, code: RealtimeErrorCodeValue) => {
    if (entries.get(entry.channel) === entry) {
      entries.delete(entry.channel);
    }
    entry.joined = false;
    updateLiveness(entry);
    for (const subscription of [...entry.subscriptions]) {
      subscription.listener.onError?.(code);
    }
  };

  const onEvent = (event: DesktopRealtimeEvent) => {
    if (event.event === DesktopRealtimeEventKind.Status) {
      statusEpoch += 1;
      setStatus(event.status);
      return;
    }
    const entry = entries.get(event.channel);
    if (entry === undefined) {
      return;
    }
    switch (event.event) {
      case DesktopRealtimeEventKind.Signal:
        for (const subscription of [...entry.subscriptions]) {
          subscription.listener.onSignal(event.signal);
        }
        return;
      case DesktopRealtimeEventKind.Resync:
        for (const subscription of [...entry.subscriptions]) {
          subscription.listener.onResync();
        }
        return;
      case DesktopRealtimeEventKind.Joined:
        markJoined(entry);
        return;
      case DesktopRealtimeEventKind.Error:
        drop(entry, event.code);
        return;
      default:
        assertNever(event);
    }
  };

  const unsubscribe = api.onEvent((raw) => {
    const parsed = desktopRealtimeEventSchema.safeParse(raw);
    if (parsed.success && !disposed) {
      onEvent(parsed.data);
    }
  });

  const requestJoin = (entry: ChannelEntry) => {
    const epoch = statusEpoch;
    invokeQuietly(
      () => api.join({ channel: entry.channel }),
      (raw) => {
        const result = desktopRealtimeJoinResultSchema.safeParse(raw);
        if (
          !result.success ||
          epoch !== statusEpoch ||
          entries.get(entry.channel) !== entry
        ) {
          return;
        }
        setStatus(result.data.status);
        if (result.data.joined) {
          markJoined(entry);
        }
      }
    );
  };

  const leave = (entry: ChannelEntry, subscription: Subscription) => {
    if (!entry.subscriptions.delete(subscription)) {
      return;
    }
    subscription.poll?.stop();
    if (entry.subscriptions.size > 0 || entries.get(entry.channel) !== entry) {
      return;
    }
    entries.delete(entry.channel);
    invokeQuietly(() => api.leave({ channel: entry.channel }));
  };

  return {
    join(channel, listener) {
      if (disposed) {
        listener.onError?.(RealtimeErrorCode.Internal);
        const poll = startListenerPoll(listener, false);
        return () => poll?.stop();
      }
      const subscription: Subscription = { listener };
      let entry = entries.get(channel);
      if (entry === undefined) {
        entry = {
          channel,
          subscriptions: new Set([subscription]),
          joined: false,
        };
        entries.set(channel, entry);
        requestJoin(entry);
      } else {
        entry.subscriptions.add(subscription);
        // A listener added to a joined channel hears signals only from now on.
        if (entry.joined) {
          applyResyncRule(listener, Date.now());
        }
      }
      subscription.poll = startListenerPoll(listener, isLive(entry));
      const joined = entry;
      return () => leave(joined, subscription);
    },
    status: () => status,
    onStatus(callback) {
      statusCallbacks.add(callback);
      return () => {
        statusCallbacks.delete(callback);
      };
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      for (const entry of [...entries.values()]) {
        for (const subscription of entry.subscriptions) {
          subscription.poll?.stop();
        }
        invokeQuietly(() => api.leave({ channel: entry.channel }));
      }
      entries.clear();
    },
  };
}

/** One per `join` call, so one listener joined twice needs two leaves. */
type Subscription = {
  listener: RealtimeChannelListener;
  poll?: PollLoop;
};

type ChannelEntry = {
  channel: string;
  subscriptions: Set<Subscription>;
  /** Main reported the service's ack for the current connection. */
  joined: boolean;
};
/**
 * An invoke main may refuse, or have no handler for: either way the channel
 * stays not live and its listeners poll, so the rejection is not surfaced.
 */
function invokeQuietly(
  invoke: () => Promise<unknown>,
  onResult?: (raw: unknown) => void
): void {
  let pending: Promise<unknown>;
  try {
    pending = invoke();
  } catch {
    return;
  }
  pending.then(
    (raw) => onResult?.(raw),
    () => undefined
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled realtime event: ${JSON.stringify(value)}`);
}
