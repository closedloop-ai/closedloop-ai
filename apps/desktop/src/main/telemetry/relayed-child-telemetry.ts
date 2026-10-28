/**
 * @file relayed-child-telemetry.ts
 * @description How main re-emits a telemetry event the db-host child relayed
 * (ISS-7109). Most events travel as-is; a category whose handling main must
 * perform for the child is dispatched here. Split out of `db-host-client.ts`,
 * which sits at the 1,000-line ceiling.
 */

import {
  LOCAL_READ_FAILED_CATEGORY,
  relayLocalReadFailed,
} from "./local-read-failed-telemetry.js";
import { Observability } from "./observability.js";
import { processExceptionTelemetryBridge } from "./process-exception-telemetry-bridge.js";
import {
  MARKETPLACE_MANIFEST_INVALID_TELEMETRY_CATEGORY,
  MARKETPLACE_MANIFEST_VALIDATION_ERROR_MESSAGE,
  MARKETPLACE_MANIFEST_VALIDATION_ERROR_NAME,
  type TelemetryEventPayload,
} from "./telemetry-protocol.js";

export function emitRelayedChildTelemetry(event: TelemetryEventPayload): void {
  if (event.category === MARKETPLACE_MANIFEST_INVALID_TELEMETRY_CATEGORY) {
    // Carry the child's bounded count diagnostics into the monitored
    // exception; without them `app.exception` cannot tell a corrupt
    // manifest from one bad plugin. `name` stays fixed, so grouping is
    // unaffected by the varying counts in the message.
    const error = new Error(
      event.message || MARKETPLACE_MANIFEST_VALIDATION_ERROR_MESSAGE
    );
    error.name = MARKETPLACE_MANIFEST_VALIDATION_ERROR_NAME;
    processExceptionTelemetryBridge.emitMainException(error);
    return;
  }
  if (event.category === LOCAL_READ_FAILED_CATEGORY) {
    relayLocalReadFailed(event);
    return;
  }
  Observability.getTelemetryEmitter().emit(event);
}
