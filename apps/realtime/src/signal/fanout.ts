import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { Origin } from "@repo/observability/telemetry/origin";
import { parseChannelAddress } from "@repo/realtime-contract/channels";
import {
  RealtimeEvent,
  type SignalPayload,
} from "@repo/realtime-contract/protocol";
import { parseSignalEnvelope } from "@repo/realtime-contract/signal";
import type { RealtimeServer } from "../edge/socket-server";
import { RealtimeHistogram } from "../telemetry/gauges";
import { FanOutOutcome, recordSignalFanOut } from "../telemetry/spans";

/**
 * PLN-2105 step 2. Validates the envelope only: the type against its grammar,
 * the data as opaque JSON, so a kind or signal type this service has never
 * seen is delivered unchanged. `ts` and `tp` never reach a client. Delivery
 * is `io.local`: every instance receives each notification itself, so
 * nothing is re-broadcast (PLN-2104 decision 3).
 */
export function createSignalFanOut(
  io: RealtimeServer,
  now: () => number = Date.now
): (payload: string) => void {
  let sampleMinute = -1;
  let samplesThisMinute = 0;
  return (payload) => {
    const parsed = parseSignalEnvelope(payload);
    if (!parsed.success) {
      log.warn("Realtime signal dropped", {
        event: SIGNAL_DROPPED_EVENT,
        reason: parsed.reason,
        bytes: Buffer.byteLength(payload, "utf8"),
      });
      recordSignalFanOut({
        outcome: FanOutOutcome.Dropped,
        reason: parsed.reason,
      });
      return;
    }
    const { c: channel, t: type, d: data, ts, tp } = parsed.envelope;
    const recipients = io.of("/").adapter.rooms.get(channel)?.size ?? 0;
    const signal: SignalPayload = { channel, type, data };
    io.local.to(channel).emit(RealtimeEvent.Signal, signal);
    const deliveredAt = now();
    const emitToDeliveryMs = deliveredAt >= ts ? deliveredAt - ts : undefined;
    recordSignalFanOut({
      outcome:
        recipients > 0 ? FanOutOutcome.Delivered : FanOutOutcome.NoRecipients,
      kind: parseChannelAddress(channel)?.kind,
      type,
      recipients,
      emitToDeliveryMs,
      traceparent: tp,
    });
    const minute = Math.floor(deliveredAt / 60_000);
    if (minute !== sampleMinute) {
      sampleMinute = minute;
      samplesThisMinute = 0;
    }
    if (
      emitToDeliveryMs !== undefined &&
      (recipients > 0 || samplesThisMinute < SIGNAL_DELAY_SAMPLES_PER_MINUTE)
    ) {
      if (recipients === 0) {
        samplesThisMinute += 1;
      }
      emitTelemetryMetric({
        metric: RealtimeHistogram.SignalEmitToDeliveryMs,
        origin: Origin.Realtime,
        value: emitToDeliveryMs,
      });
    }
  };
}

export const SIGNAL_DROPPED_EVENT = "realtime.signal_dropped";

/**
 * ISS-12703: the most delay samples one instance logs per minute from fan-outs
 * that reached no socket; the span still records every fan-out. A fan-out that
 * reached a socket always logs its sample and does not count: at most 68 a day
 * (`pup traces aggregate --query 'service:cl-realtime env:prod
 * resource_name:realtime.signal_fanout @realtime.outcome:delivered'` per UTC
 * day, 10-07 to 10-20T15:48Z). 37 is the busiest minute before the 10-17
 * surge: 74 lines across 2 tasks, each of which fans out every notification
 * (`pup logs aggregate --query 'service:cl-realtime env:prod
 * @metric:realtime_signal_emit_to_delivery_ms' --interval 1m`, 10-07T17:10Z to
 * 10-17T16:00Z, n=21,563 over 3,131 minutes). No minute the signal-delay
 * monitor ran on before the surge is capped, and none that had a sample loses
 * it. Per minute, not per 10-minute monitor window, so a capped burst's
 * samples spread across the window instead of bunching at its start.
 */
export const SIGNAL_DELAY_SAMPLES_PER_MINUTE = 37;
