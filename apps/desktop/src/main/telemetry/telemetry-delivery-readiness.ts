/**
 * @file telemetry-delivery-readiness.ts
 * @description ISS-7496 — can a telemetry event emitted RIGHT NOW be carried,
 * or would it be dropped at the lane's send gate?
 *
 * Every layer of the telemetry path is void-returning and swallows failure by
 * design: the lane router drops when its send gate is closed,
 * `TelemetryService.emit` catches everything, and the HTTP send is
 * fire-and-forget. A reporter therefore has no way to learn that its event went
 * nowhere.
 *
 * That is harmless for a per-event reporter and NOT harmless for one that
 * latches "already reported" once per process. Such a latch, set on the
 * ATTEMPT, is burned by the first event raised while the lane is down; because
 * the drop is silent the report never happens again, and an operator reads the
 * resulting silence as health. Those reporters gate their latch on
 * {@link canDeliverTelemetry} instead.
 *
 * Deliberately its own module rather than another member of `Observability`:
 * that class is at the 1,000-line ceiling, and the readiness predicate belongs
 * to whoever owns the send gate (the lane router), not to the emit facade.
 */

import { getTelemetryRelaySink } from "./telemetry-relay-sink.js";

let deliverable: (() => boolean) | null = null;

/**
 * Publish the send gate's readiness. Called by the owner of that gate — the
 * observability lane router — so no other wiring has to know the gate exists.
 *
 * `null` clears it, which restores the permissive default below; tests that
 * install a predicate must clear it again.
 */
export function setTelemetryDeliverable(
  predicate: (() => boolean) | null
): void {
  deliverable = predicate;
}

/**
 * Whether an event emitted now would be carried.
 *
 * `true` means "accepted by a ready lane", never "delivered" — the send is
 * fire-and-forget and no layer reports back. It is the strongest signal this
 * transport can give, and it is enough to stop a once-per-process latch being
 * burned by an event that provably reached nothing.
 *
 * A relay sink always accepts: a child process hands the event to main, which
 * re-emits it under main's own readiness. With no predicate registered the
 * answer is `true`, which is the honest default for a synchronous transport
 * that cannot refuse.
 */
export function canDeliverTelemetry(): boolean {
  if (getTelemetryRelaySink()) {
    return true;
  }
  return deliverable?.() ?? true;
}
