import {
  RealtimeErrorCode,
  type RealtimeErrorCode as RealtimeErrorCodeValue,
} from "@repo/realtime-contract/error-codes";
import {
  type JoinPayload,
  joinAckSchema,
  type LeavePayload,
  RealtimeEvent,
  resyncPayloadSchema,
  signalPayloadSchema,
} from "@repo/realtime-contract/protocol";
import { type Backoff, backoffDelayMs } from "./backoff";
import { type PollLoop, startListenerPoll } from "./poll";
import { applyResyncRule, type RealtimeChannelListener } from "./port";

export type ChannelTransport = {
  isConnected: () => boolean;
  /** The client's status is `open`. */
  isOpen: () => boolean;
  emit: (event: string, payload: unknown, ack?: (ack: unknown) => void) => void;
};

export type ChannelRegistryOptions = {
  now: () => number;
  random: () => number;
};

export type ChannelRegistry = {
  join: (channel: string, listener: RealtimeChannelListener) => () => void;
  /** Joins every held channel, exactly once per connection. */
  onConnect: () => void;
  onDisconnect: () => void;
  /** Re-reads `isOpen`, so a channel goes live once both it and its join hold. */
  onStatusChange: () => void;
  onSignal: (payload: unknown) => void;
  onResync: (payload: unknown) => void;
  /** A channel-scoped `rt:error`, such as a revoke: the service has left the channel. */
  onChannelError: (channel: string, code: RealtimeErrorCodeValue) => void;
  /** Drops every channel, reporting `code` to each listener. */
  failAll: (code: RealtimeErrorCodeValue) => void;
  dispose: () => void;
};

/**
 * PLN-2106 step 4. Joins are reference-counted by address: the first
 * listener sends `rt:join`, the last leave sends `rt:leave`. A join is sent
 * only while connected (decision 6); the connect handler joins the rest.
 * Each listener's poll loop (step 5) runs from its join to its leave.
 */
export function createChannelRegistry(
  transport: ChannelTransport,
  options: ChannelRegistryOptions
): ChannelRegistry {
  const entries = new Map<string, ChannelEntry>();

  const isLive = (entry: ChannelEntry) =>
    entry.phase === ChannelPhase.Joined &&
    entries.get(entry.channel) === entry &&
    transport.isOpen();

  const updateLiveness = (entry: ChannelEntry) => {
    const live = isLive(entry);
    for (const subscription of entry.subscriptions) {
      subscription.poll?.setLive(live);
    }
  };

  const sendJoin = (entry: ChannelEntry) => {
    clearRetry(entry);
    entry.phase = ChannelPhase.Joining;
    entry.sequence += 1;
    const sequence = entry.sequence;
    const payload: JoinPayload = { channel: entry.channel };
    transport.emit(RealtimeEvent.Join, payload, (ack) => {
      if (entries.get(entry.channel) === entry && entry.sequence === sequence) {
        onJoinAck(entry, ack);
      }
    });
  };

  const drop = (entry: ChannelEntry, code: RealtimeErrorCodeValue) => {
    retire(entries, entry);
    updateLiveness(entry);
    for (const subscription of [...entry.subscriptions]) {
      subscription.listener.onError?.(code);
    }
  };

  const onJoinAck = (entry: ChannelEntry, raw: unknown) => {
    const parsed = joinAckSchema.safeParse(raw);
    const ack = parsed.success
      ? parsed.data
      : { ok: false as const, code: RealtimeErrorCode.Internal };
    if (ack.ok) {
      entry.phase = ChannelPhase.Joined;
      entry.retryAttempt = 0;
      const ackedAt = options.now();
      for (const subscription of [...entry.subscriptions]) {
        applyResyncRule(subscription.listener, ackedAt);
      }
      updateLiveness(entry);
      return;
    }
    if (ack.code === RealtimeErrorCode.RateLimited) {
      entry.phase = ChannelPhase.RetryWait;
      const delayMs = backoffDelayMs(
        entry.retryAttempt,
        JOIN_RETRY_BACKOFF,
        options.random
      );
      entry.retryAttempt += 1;
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = undefined;
        if (transport.isConnected()) {
          sendJoin(entry);
        }
      }, delayMs);
      return;
    }
    drop(entry, ack.code);
  };

  const leave = (entry: ChannelEntry, subscription: Subscription) => {
    if (!entry.subscriptions.delete(subscription)) {
      return;
    }
    subscription.poll?.stop();
    if (entry.subscriptions.size > 0 || entries.get(entry.channel) !== entry) {
      return;
    }
    const wasSent =
      entry.phase === ChannelPhase.Joining ||
      entry.phase === ChannelPhase.Joined;
    retire(entries, entry);
    if (wasSent && transport.isConnected()) {
      const payload: LeavePayload = { channel: entry.channel };
      transport.emit(RealtimeEvent.Leave, payload);
    }
  };

  return {
    join(channel, listener) {
      const subscription: Subscription = { listener };
      let entry = entries.get(channel);
      if (entry === undefined) {
        entry = createEntry(channel);
        entries.set(channel, entry);
        entry.subscriptions.add(subscription);
        if (transport.isConnected()) {
          sendJoin(entry);
        }
      } else {
        entry.subscriptions.add(subscription);
        // A listener added to a live channel hears signals only from now on.
        if (entry.phase === ChannelPhase.Joined) {
          applyResyncRule(listener, options.now());
        }
      }
      subscription.poll = startListenerPoll(listener, isLive(entry));
      const joined = entry;
      return () => leave(joined, subscription);
    },
    onConnect() {
      for (const entry of entries.values()) {
        sendJoin(entry);
      }
    },
    onDisconnect() {
      for (const entry of entries.values()) {
        clearRetry(entry);
        entry.phase = ChannelPhase.Pending;
        entry.sequence += 1;
      }
    },
    onStatusChange() {
      for (const entry of entries.values()) {
        updateLiveness(entry);
      }
    },
    onSignal(payload) {
      const parsed = signalPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      const { channel, type, data } = parsed.data;
      const entry = entries.get(channel);
      if (entry === undefined) {
        return;
      }
      for (const subscription of [...entry.subscriptions]) {
        subscription.listener.onSignal({ type, data });
      }
    },
    onResync(payload) {
      const parsed = resyncPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      const { channel } = parsed.data;
      const targets =
        channel === undefined
          ? [...entries.values()]
          : [entries.get(channel)].filter((entry) => entry !== undefined);
      for (const entry of targets) {
        for (const subscription of [...entry.subscriptions]) {
          subscription.listener.onResync();
        }
      }
    },
    onChannelError(channel, code) {
      const entry = entries.get(channel);
      if (entry !== undefined) {
        drop(entry, code);
      }
    },
    failAll(code) {
      for (const entry of [...entries.values()]) {
        drop(entry, code);
      }
    },
    dispose() {
      for (const entry of [...entries.values()]) {
        retire(entries, entry);
        updateLiveness(entry);
      }
    },
  };
}

const ChannelPhase = {
  /** Held while disconnected; the connect handler joins it. */
  Pending: "pending",
  Joining: "joining",
  Joined: "joined",
  /** Refused `rate_limited`; a retry is scheduled. */
  RetryWait: "retry_wait",
} as const;
type ChannelPhase = (typeof ChannelPhase)[keyof typeof ChannelPhase];

/** One per `join` call, so one listener joined twice needs two leaves. */
type Subscription = {
  listener: RealtimeChannelListener;
  poll?: PollLoop;
};

type ChannelEntry = {
  channel: string;
  subscriptions: Set<Subscription>;
  phase: ChannelPhase;
  /** Bumped per join sent and per disconnect, so a stale ack is ignored. */
  sequence: number;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
};

function createEntry(channel: string): ChannelEntry {
  return {
    channel,
    subscriptions: new Set(),
    phase: ChannelPhase.Pending,
    sequence: 0,
    retryAttempt: 0,
    retryTimer: undefined,
  };
}

function retire(entries: Map<string, ChannelEntry>, entry: ChannelEntry): void {
  if (entries.get(entry.channel) === entry) {
    entries.delete(entry.channel);
  }
  clearRetry(entry);
  entry.sequence += 1;
}

function clearRetry(entry: ChannelEntry): void {
  if (entry.retryTimer !== undefined) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
  }
}

/** "2 s doubling to 30 s", jittered like the reconnect backoff. */
const JOIN_RETRY_BACKOFF: Backoff = {
  minMs: 2000,
  maxMs: 30_000,
  randomizationFactor: 0.5,
};
