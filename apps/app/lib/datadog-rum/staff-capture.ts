"use client";

import { datadogRum } from "@datadog/browser-rum";
import { setDatadogRumStaffCapture } from "./config";

/**
 * Staff-scoped Datadog RUM capture controls (FEA-2400).
 *
 * The base RUM config keeps `sessionReplaySampleRate: 0` and gates `action`
 * egress on `staffCaptureEnabled`. These helpers, driven by the
 * `web-frontend-capture` feature flag, flip that gate on/off for the identified
 * staff user. Session replay is off for staff too (ISS-12356(f), PRD-791 v10
 * Option B), so nothing here starts a recording. All SDK calls are wrapped so
 * telemetry can never affect app behavior — matching `initDatadogRum`'s
 * fail-safe posture.
 *
 * Only reaches the ~42% of staff sessions the SDK's `sessionSampleRate`
 * sampled in (ISS-12356 row f); on the other ~58% the session is untracked,
 * so these calls are no-ops. Accepted as-is — staff capture is a documented
 * coin flip (Perrin Upcott, 2026-10-12 ruling).
 */

/** Enable staff RUM capture: forward actions and attach the user. */
export function enableDatadogRumStaffCapture(userId: string): void {
  try {
    // Id only — no email/name — keeps parity with the runbook's minimal
    // user-context guarantee while letting us filter RUM to a staff user.
    datadogRum.setUser({ id: userId });
    // Open the action-egress gate only after the SDK calls succeed, so a failed
    // enable stays fail-CLOSED (no actions egress) — matching the disable path.
    setDatadogRumStaffCapture(true);
  } catch {
    // Telemetry must never affect app behavior.
  }
}

/** Disable staff RUM capture: drop the user and re-gate actions. */
export function disableDatadogRumStaffCapture(): void {
  try {
    setDatadogRumStaffCapture(false);
    datadogRum.clearUser();
  } catch {
    // Telemetry must never affect app behavior.
  }
}
