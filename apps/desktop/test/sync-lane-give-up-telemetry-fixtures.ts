/**
 * @file sync-lane-give-up-telemetry-fixtures.ts
 * @description The captured-emitter harness the `sync.lane.gave_up` suites share.
 *
 * One copy, because the two things it models are easy to get subtly wrong and a
 * second copy would only be wrong somewhere else. The emitter is installed
 * through `Observability.init` rather than stubbed, so what `events` holds is
 * what the lane router would really have shipped. And the send GATE is modelled
 * rather than assumed open: the give-up reporters are gated on it by design, and
 * the outage that produces a give-up is the same one that shuts it, so a suite
 * whose capture recorded dropped events could not tell a signal that reached an
 * operator from one that reached nothing.
 */
import { vi } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { setTelemetryDeliverable } from "../src/main/telemetry/telemetry-delivery-readiness.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";

export type GiveUpTelemetryCapture = {
  /** Every event the emitter ACCEPTED, in order. */
  events: EnrichedTelemetryEvent[];
  /** Those of one category. */
  categoriesOf: (category: string) => EnrichedTelemetryEvent[];
  /** Open or shut the telemetry lane's own send gate. */
  setDeliverable: (deliverable: boolean) => void;
};

/** Install the capture for one case. Pair with {@link resetGiveUpTelemetryCapture}. */
export function installGiveUpTelemetryCapture(): GiveUpTelemetryCapture {
  const events: EnrichedTelemetryEvent[] = [];
  let deliverable = true;
  setTelemetryDeliverable(() => deliverable);
  vi.spyOn(gatewayLog, "warn").mockImplementation(() => undefined);
  vi.spyOn(gatewayLog, "info").mockImplementation(() => undefined);
  Observability.init({
    telemetrySend: (event) => {
      if (deliverable) {
        events.push(event);
      }
    },
  });
  return {
    events,
    categoriesOf: (category) =>
      events.filter((event) => event.category === category),
    setDeliverable: (next) => {
      deliverable = next;
    },
  };
}

/**
 * Uninstall it — from an `afterEach` and never the last line of a case, or an
 * assertion that throws leaks a live emitter and an installed readiness
 * predicate into every later test in the worker.
 */
export function resetGiveUpTelemetryCapture(): void {
  setTelemetryDeliverable(null);
  Observability.reset();
}
