import { describeCause } from "@repo/http-service/describe-cause";
import { log } from "@repo/observability/log";
import {
  type BusMessage,
  BusOp,
  busMessageSchema,
  REALTIME_BUS_CHANNEL,
} from "@repo/realtime-contract/internal";
import type { Revocations } from "@repo/realtime-contract/revocations";
import type { RealtimeServer } from "../edge/socket-server";
import { withDeadline } from "../lifecycle/deadline";
import { Dependency, type Readiness } from "../lifecycle/readiness";
import { applyBusMessage, applyRevocation } from "./apply";
import {
  appendRevocation,
  type RevocationLogClient,
  readRevocations,
} from "./revocation-log";
import { joinRevokeRooms } from "./revoke-rooms";

/**
 * The commands the bus publishes and keeps its revocation log with, on a
 * connection that fails a command while it is down instead of queueing it: a
 * publish the caller was told failed must not go out after a reconnect.
 */
export type BusPublisherClient = RevocationLogClient & {
  publish(channel: string, message: string): Promise<number>;
};

/** A dedicated client: a subscribed ioredis connection can run nothing else. */
export type BusSubscriberClient = {
  readonly status: string;
  subscribe(channel: string): Promise<unknown>;
  on(event: "ready" | "close", listener: () => void): unknown;
  on(
    event: "message",
    listener: (channel: string, message: string) => void
  ): unknown;
  disconnect(): void;
};

export type RealtimeBus = {
  /**
   * Rejects when Redis does not take the message within the deadline. A
   * message already written to Redis when the deadline passes can still be
   * delivered. Publishes while this instance's own subscription is down: every
   * other instance applies it, and a revoke reaches this instance's sockets
   * from the log when it subscribes again; a publish misses them.
   */
  publish(message: BusMessage): Promise<void>;
  /**
   * Subscribes and applies every message to `io`'s local sockets. On every
   * subscribe, the first included, it first applies the revokes the log holds,
   * so one taken while this subscription was down still lands.
   */
  start(io: RealtimeServer): { stop(): Promise<void> };
};

export type RealtimeBusOptions = {
  publisher: BusPublisherClient;
  subscriber: BusSubscriberClient;
  readiness: Readiness;
  revocations: Revocations;
  now?: () => number;
};

/**
 * PLN-2105 decision 4 and step 5: our own Redis pub/sub on one channel, not
 * socket.io's adapter, because signals already reach every instance through
 * LISTEN. The subscriber is a readiness dependency: losing it after readiness
 * degrades the instance and never fails `/health`, and signals keep flowing
 * because they never use the bus.
 */
export function createRealtimeBus(options: RealtimeBusOptions): RealtimeBus {
  const { publisher, subscriber, readiness, revocations } = options;
  const now = options.now ?? Date.now;
  return {
    async publish(message) {
      // In cluster mode (ElastiCache Serverless Valkey) PUBLISH counts only the receiving node's subscribers, so its count says nothing about delivery.
      const sent =
        message.op === BusOp.Revoke
          ? appendRevocation(publisher, {
              target: message.target,
              at: now(),
            }).then(() => publishOnBus(publisher, message))
          : publishOnBus(publisher, message);
      await withDeadline(sent, BUS_PUBLISH_TIMEOUT_MS);
    },
    start(io) {
      let stopped = false;
      // Bumped on every subscribe and close, so work begun under an earlier
      // subscription never marks a later one up.
      let generation = 0;
      let replayTimer: ReturnType<typeof setTimeout> | undefined;
      const cancelReplay = (): void => {
        clearTimeout(replayTimer);
        replayTimer = undefined;
      };
      const isCurrent = (started: number): boolean =>
        !stopped && started === generation;
      const replay = (started: number): void => {
        cancelReplay();
        withDeadline(
          readRevocations(publisher, now()),
          BUS_PUBLISH_TIMEOUT_MS
        ).then(
          (missed) => {
            if (!isCurrent(started)) {
              return;
            }
            for (const revocation of missed) {
              applyRevocation(io, revocations, revocation);
            }
            readiness.markUp(Dependency.Bus);
          },
          (error: unknown) => {
            if (!isCurrent(started)) {
              return;
            }
            readiness.markDown(Dependency.Bus, describeCause(error));
            replayTimer = setTimeout(
              () => replay(started),
              BUS_REPLAY_RETRY_MS
            );
          }
        );
      };
      const subscribe = (): void => {
        generation += 1;
        const started = generation;
        subscriber.subscribe(REALTIME_BUS_CHANNEL).then(
          () => {
            if (isCurrent(started)) {
              replay(started);
            }
          },
          (error: unknown) => {
            readiness.markDown(Dependency.Bus, describeCause(error));
          }
        );
      };
      joinRevokeRooms(io);
      subscriber.on("ready", subscribe);
      subscriber.on("close", () => {
        generation += 1;
        cancelReplay();
        if (!stopped) {
          readiness.markDown(Dependency.Bus, BUS_CONNECTION_CLOSED);
        }
      });
      subscriber.on("message", (channel, raw) => {
        if (channel === REALTIME_BUS_CHANNEL) {
          applyRawBusMessage(io, raw, revocations, now);
        }
      });
      if (subscriber.status === REDIS_READY_STATUS) {
        subscribe();
      }
      return {
        stop: () => {
          stopped = true;
          cancelReplay();
          subscriber.disconnect();
          return Promise.resolve();
        },
      };
    },
  };
}

function publishOnBus(
  publisher: BusPublisherClient,
  message: BusMessage
): Promise<number> {
  return publisher.publish(REALTIME_BUS_CHANNEL, JSON.stringify(message));
}

function applyRawBusMessage(
  io: RealtimeServer,
  raw: string,
  revocations: Revocations,
  now: () => number
): void {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const parsed = busMessageSchema.safeParse(json);
  if (!parsed.success) {
    log.warn("Realtime bus message dropped", {
      event: BUS_MESSAGE_DROPPED_EVENT,
      bytes: Buffer.byteLength(raw, "utf8"),
    });
    return;
  }
  applyBusMessage(io, parsed.data, revocations, now);
}

const REDIS_READY_STATUS = "ready";
const BUS_CONNECTION_CLOSED = "connection_closed";
export const BUS_PUBLISH_TIMEOUT_MS = 2000;
/** How soon a subscribe whose revocation log read failed tries the read again. */
export const BUS_REPLAY_RETRY_MS = 500;

export const BUS_MESSAGE_DROPPED_EVENT = "realtime.bus_message_dropped";
