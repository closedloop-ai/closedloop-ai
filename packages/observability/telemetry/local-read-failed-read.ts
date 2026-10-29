/**
 * @file local-read-failed-read.ts
 * @description ISS-11351 — which local durable read a `desktop.local_read.failed`
 * event is about. One bounded vocabulary per module, as this directory does.
 */

import { tolerantDesktopTelemetryValue } from "./tolerant-desktop-value";

/**
 * The desktop mirror is `LocalReadFailedRead` in
 * `apps/desktop/src/main/telemetry/local-read-failed-diagnostics.ts`, declared
 * there with no shared import. TOLERANT: a read only a newer desktop names folds
 * to `Unknown` rather than failing the whole event, because desktop and cl-api
 * deploy independently. `no-unmirrored-desktop-telemetry-enum` fails CI on a
 * producer member this const lacks, so `Unknown` stays a skew bucket.
 */
export const LocalReadFailedRead = {
  UsageAggregate: "usage_aggregate",
  AnalyticsAggregate: "analytics_aggregate",
  ComponentCursorHydrate: "component_cursor_hydrate",
  ComponentCursorRead: "component_cursor_read",
  ComponentRowsLoad: "component_rows_load",
  /** A read this build does not recognise; no producer emits it. */
  Unknown: "unknown",
} as const;

export type LocalReadFailedRead =
  (typeof LocalReadFailedRead)[keyof typeof LocalReadFailedRead];

export const LOCAL_READ_FAILED_READ =
  tolerantDesktopTelemetryValue(LocalReadFailedRead);
