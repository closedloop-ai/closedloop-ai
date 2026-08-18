import { z } from "zod";

/**
 * FEA-3425 (PLN-1437 Phase 3): REST wire contract for `POST /desktop/telemetry`,
 * the HTTP twin of the relay socket's `desktop.telemetry` event. The event
 * payload itself is validated server-side against `desktopTelemetryEventSchema`
 * (`@repo/observability/telemetry/schema`); this module only names the HTTP
 * success-response envelope.
 *
 * Failure `code`s reuse the shared {@link DesktopWriteLaneRestErrorCode} base
 * (`internal_error` / `target_not_owned` / `validation_failed`) — the telemetry
 * route emits no route-specific codes, so it imports the base directly rather
 * than re-declaring a byte-identical copy.
 */

/**
 * FEA-3425: success payload of `POST /desktop/telemetry`. Sources the route's
 * response type; the fire-and-forget telemetry client never parses the body
 * (it dispatches on status alone), so this is not client-shared. Not `.strict()`
 * for the same version-skew reason as the analytics twin.
 */
export const desktopTelemetryReceiveResponseValidator = z.object({
  received: z.literal(true),
});
export type DesktopTelemetryReceiveResponse = z.infer<
  typeof desktopTelemetryReceiveResponseValidator
>;
