import type { ParsedChannelAddress } from "@repo/realtime-contract/channels";
import type { GrantAccess } from "@repo/realtime-contract/grants";
import type { RealtimeServer, RealtimeSocket } from "../edge/socket-server";
import { signalClass } from "./signal";

/**
 * PLN-2104 decision 7. `signal` is the only class in this phase; the
 * ephemeral and stateful-sync phases each add their member, module and
 * runtime together.
 */
export const DeliveryClass = {
  Signal: "signal",
} as const;
export type DeliveryClass = (typeof DeliveryClass)[keyof typeof DeliveryClass];

export type MessageRateLimit = {
  /** Events a connection may send at once. */
  burst: number;
  refillPerSecond: number;
};

/** Refusals by the message-rate bucket past which a connection is disconnected. */
export type FloodLimit = {
  maxRefusals: number;
  windowMs: number;
};

export type DeliveryClassLimits = {
  /** Largest incoming packet, enforced engine-wide by `maxHttpBufferSize`. */
  maxPacketBytes: number;
  maxChannelsPerConnection: number;
  /** A token bucket over every event a connection sends. */
  messageRate: MessageRateLimit;
  flood: FloodLimit;
  /** Unsent packets past which the engine drops a slow client. */
  maxBufferedPackets: number;
};

/**
 * The per-class runtime the edge calls into, so a class's runtime (PLN-2105
 * for `signal`) lands without an `edge/` change.
 */
export type DeliveryClassRuntime = {
  /** Once at boot, after the socket.io server exists. */
  start(io: RealtimeServer): void;
  /** Each authenticated socket, after `rt:welcome`. */
  onConnection(socket: RealtimeSocket): void;
  /** After a socket joins a room of this class. */
  onJoin(socket: RealtimeSocket, address: string): void;
  /** After a socket leaves a room of this class. */
  onLeave(socket: RealtimeSocket, address: string): void;
};

export type DeliveryClassModule = {
  /** The grant access a subscriber needs to join. */
  subscribeAccess: GrantAccess;
  clientPublish: boolean;
  serverPublish: boolean;
  limits: DeliveryClassLimits;
  runtime: DeliveryClassRuntime;
};

export const DELIVERY_CLASSES: Record<DeliveryClass, DeliveryClassModule> = {
  [DeliveryClass.Signal]: signalClass,
};

/**
 * Every channel is signal-class in this phase, whatever its kind. The phase
 * that adds a second class also decides how an address names it.
 */
export function resolveDeliveryClass(
  _address: ParsedChannelAddress
): DeliveryClass {
  return DeliveryClass.Signal;
}

export function deliveryClassRuntimes(): DeliveryClassRuntime[] {
  return Object.values(DELIVERY_CLASSES).map((module) => module.runtime);
}

/** The engine caps packets server-wide, so it takes the largest class limit. */
export function maxPacketBytesAcrossClasses(): number {
  return largestLimit((limits) => limits.maxPacketBytes);
}

export type ConnectionLimits = {
  messageRate: MessageRateLimit;
  flood: FloodLimit;
  maxBufferedPackets: number;
};

/**
 * The rate bucket and the write buffer belong to the connection, which can
 * carry channels of every class, so each takes the largest class limit.
 */
export function connectionLimitsAcrossClasses(): ConnectionLimits {
  return {
    messageRate: {
      burst: largestLimit((limits) => limits.messageRate.burst),
      refillPerSecond: largestLimit(
        (limits) => limits.messageRate.refillPerSecond
      ),
    },
    flood: {
      maxRefusals: largestLimit((limits) => limits.flood.maxRefusals),
      windowMs: largestLimit((limits) => limits.flood.windowMs),
    },
    maxBufferedPackets: largestLimit((limits) => limits.maxBufferedPackets),
  };
}

function largestLimit(read: (limits: DeliveryClassLimits) => number): number {
  return Math.max(
    ...Object.values(DELIVERY_CLASSES).map((module) => read(module.limits))
  );
}
