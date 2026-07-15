"use client";

import { datadogRum } from "@datadog/browser-rum";
import { setDatadogRumStaffCapture } from "./config";

/**
 * Staff-scoped Datadog RUM capture controls (FEA-2400).
 *
 * The base RUM config keeps `sessionReplaySampleRate: 0` (no automatic/customer
 * replay) and gates `action` egress on `staffCaptureEnabled`. These helpers,
 * driven by the `web-frontend-capture` feature flag, flip that gate on/off and
 * force session replay on demand for the identified staff user. All SDK calls
 * are wrapped so telemetry can never affect app behavior — matching
 * `initDatadogRum`'s fail-safe posture.
 */

/** Enable staff RUM capture: forward actions, attach the user, force replay. */
export function enableDatadogRumStaffCapture(userId: string): void {
  try {
    // Id only — no email/name — keeps parity with the runbook's minimal
    // user-context guarantee while letting us filter RUM to a staff user.
    datadogRum.setUser({ id: userId });
    // `sessionReplaySampleRate` is 0, so `force` is required to start replay
    // for this staff session regardless of the (zero) sample.
    datadogRum.startSessionReplayRecording({ force: true });
    // Open the action-egress gate only after the SDK calls succeed, so a failed
    // enable stays fail-CLOSED (no actions egress) — matching the disable path.
    setDatadogRumStaffCapture(true);
  } catch {
    // Telemetry must never affect app behavior.
  }
}

/** Disable staff RUM capture: stop replay, drop the user, re-gate actions. */
export function disableDatadogRumStaffCapture(): void {
  try {
    setDatadogRumStaffCapture(false);
    datadogRum.stopSessionReplayRecording();
    datadogRum.clearUser();
  } catch {
    // Telemetry must never affect app behavior.
  }
}
