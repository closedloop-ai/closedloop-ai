import { isSpanContextValid, trace } from "@opentelemetry/api";
import type { TransactionClient } from "@repo/database";
import { parseChannelAddress } from "@repo/realtime-contract/channels";
import {
  REALTIME_SIGNAL_CHANNEL,
  type SignalEnvelope,
  serializeSignalEnvelope,
} from "@repo/realtime-contract/signal";
import { SignalTypes } from "@repo/realtime-contract/signals";
import type { ZodType } from "zod";

export type SignalTypeRegistry = Readonly<
  Record<string, Readonly<Record<string, ZodType<SignalEnvelope["d"]>>>>
>;

export type RealtimeSignal = {
  type: string;
  data: unknown;
};

export type ChannelSignal = {
  channel: string;
  signal: RealtimeSignal;
};

/**
 * Queues a realtime signal on `channel` through `pg_notify`. Call it inside the
 * caller's domain transaction: Postgres delivers the notification only when
 * that transaction commits, so a rolled-back write never reaches a socket.
 *
 * Throws, and so aborts the caller's transaction, when the address is
 * malformed, `type` is not declared for the channel's kind in `registry`,
 * `data` fails that type's schema, or the envelope exceeds
 * `MAX_SIGNAL_PAYLOAD_BYTES`. Writes no table.
 *
 * The envelope's `ts` is emit time, not commit time, and feeds only the
 * emit-to-delivery metric; the service strips it before any client sees it.
 * Never order signals by it: ordering comes from the revision in `data`.
 */
export async function emitSignal(
  tx: Pick<TransactionClient, "$executeRaw">,
  channel: string,
  signal: RealtimeSignal,
  registry: SignalTypeRegistry = SignalTypes
): Promise<void> {
  const payload = signalPayload(channel, signal, registry);
  await tx.$executeRaw`SELECT pg_notify(${REALTIME_SIGNAL_CHANNEL}, ${payload})`;
}

/**
 * `emitSignal` for several signals in ONE statement, so a write that touches N
 * channels pays one round-trip instead of N. Every signal is validated before
 * anything is queued: one invalid signal throws and notifies nothing. Sends no
 * statement for an empty list.
 */
export async function emitSignals(
  tx: Pick<TransactionClient, "$executeRaw">,
  signals: readonly ChannelSignal[],
  registry: SignalTypeRegistry = SignalTypes
): Promise<void> {
  if (signals.length === 0) {
    return;
  }
  const payloads = signals.map(({ channel, signal }) =>
    signalPayload(channel, signal, registry)
  );
  await tx.$executeRaw`SELECT pg_notify(${REALTIME_SIGNAL_CHANNEL}, payload) FROM unnest(${payloads}::text[]) WITH ORDINALITY AS signal(payload, position) ORDER BY position`;
}

function signalPayload(
  channel: string,
  signal: RealtimeSignal,
  registry: SignalTypeRegistry
): string {
  const address = parseChannelAddress(channel);
  if (address === null) {
    throw new Error("Invalid realtime channel address");
  }
  const schema = lookupSignalSchema(registry, address.kind, signal.type);
  if (schema === undefined) {
    throw new Error(
      `Realtime signal type "${signal.type}" is not declared for channel kind "${address.kind}"`
    );
  }
  const traceparent = activeTraceparent();
  return serializeSignalEnvelope({
    c: channel,
    t: signal.type,
    d: schema.parse(signal.data),
    ts: Date.now(),
    ...(traceparent === undefined ? {} : { tp: traceparent }),
  });
}

const W3C_TRACEPARENT_VERSION = "00";

/** The schema `registry` declares for `type` on `kind`; undefined when it declares none. */
export function lookupSignalSchema(
  registry: SignalTypeRegistry,
  kind: string,
  type: string
): ZodType<SignalEnvelope["d"]> | undefined {
  if (!Object.hasOwn(registry, kind)) {
    return undefined;
  }
  const types = registry[kind];
  return types !== undefined && Object.hasOwn(types, type)
    ? types[type]
    : undefined;
}

function activeTraceparent(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext === undefined || !isSpanContextValid(spanContext)) {
    return undefined;
  }
  const flags = spanContext.traceFlags.toString(16).padStart(2, "0");
  return `${W3C_TRACEPARENT_VERSION}-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}
