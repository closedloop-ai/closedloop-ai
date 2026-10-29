import { z } from "zod";
import { parseChannelAddress, utf8ByteLength } from "./channels";

export const REALTIME_SIGNAL_CHANNEL = "realtime_signal";

/** Measured in UTF-8 bytes of the serialized envelope; Postgres NOTIFY's own limit is 8000. */
export const MAX_SIGNAL_PAYLOAD_BYTES = 1024;

export const SIGNAL_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * The `pg_notify` envelope. `t` is any string matching the type grammar and
 * `d` is opaque JSON: per-type schemas live in `./signals`, which the
 * kind-opaque service never imports (PLN-2103 v3).
 */
export const signalEnvelopeSchema = z.object({
  c: z.string().refine((address) => parseChannelAddress(address) !== null),
  t: z.string().regex(SIGNAL_TYPE_PATTERN),
  d: z.json(),
  ts: z.number().int().nonnegative(),
  tp: z.string().min(1).optional(),
});
export type SignalEnvelope = z.infer<typeof signalEnvelopeSchema>;

export const SignalEnvelopeRejection = {
  PayloadTooLarge: "payload_too_large",
  Malformed: "malformed",
} as const;
export type SignalEnvelopeRejection =
  (typeof SignalEnvelopeRejection)[keyof typeof SignalEnvelopeRejection];

export type SignalEnvelopeParseResult =
  | { success: true; envelope: SignalEnvelope }
  | { success: false; reason: SignalEnvelopeRejection };

export function parseSignalEnvelope(raw: string): SignalEnvelopeParseResult {
  if (utf8ByteLength(raw) > MAX_SIGNAL_PAYLOAD_BYTES) {
    return { success: false, reason: SignalEnvelopeRejection.PayloadTooLarge };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { success: false, reason: SignalEnvelopeRejection.Malformed };
  }
  const parsed = signalEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return { success: false, reason: SignalEnvelopeRejection.Malformed };
  }
  return { success: true, envelope: parsed.data };
}

/** Throws on an invalid envelope or one over `MAX_SIGNAL_PAYLOAD_BYTES`. */
export function serializeSignalEnvelope(envelope: SignalEnvelope): string {
  const payload = JSON.stringify(signalEnvelopeSchema.parse(envelope));
  const bytes = utf8ByteLength(payload);
  if (bytes > MAX_SIGNAL_PAYLOAD_BYTES) {
    throw new Error(
      `Realtime signal payload is ${bytes} bytes; the limit is ${MAX_SIGNAL_PAYLOAD_BYTES}`
    );
  }
  return payload;
}
