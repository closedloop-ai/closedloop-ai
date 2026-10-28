/**
 * @file local-read-failed-diagnostics.ts
 * @description ISS-11351 — which local durable read a `desktop.local_read.failed`
 * event is about. Its own module, beside `sync-lane-give-up-diagnostics.ts`, so
 * `telemetry-protocol.ts` (which sits near the file-size ceiling) and the
 * reporter can both import it without an import cycle.
 *
 * Mirrored as `LocalReadFailedRead` in
 * `@repo/observability/telemetry/local-read-failed-read`, which coarsens a
 * member it does not know to `unknown` instead of dropping the event;
 * `no-unmirrored-desktop-telemetry-enum` fails CI on a member declared here that
 * the ingest half lacks.
 */

export const LocalReadFailedRead = {
  /** `aggregateUsage` on the Sessions surface (ISS-10573). */
  UsageAggregate: "usage_aggregate",
  /** `aggregateAnalytics` on the Sessions surface (ISS-10606). */
  AnalyticsAggregate: "analytics_aggregate",
  /** The component lane's durable-cursor read in `hydrateCursorFor` (ISS-10910). */
  ComponentCursorHydrate: "component_cursor_hydrate",
  /** The component lane's keyset cursor page read. */
  ComponentCursorRead: "component_cursor_read",
  /** The component lane's row load for a cursor page. */
  ComponentRowsLoad: "component_rows_load",
} as const;
export type LocalReadFailedRead =
  (typeof LocalReadFailedRead)[keyof typeof LocalReadFailedRead];

/** A bounded read name and nothing else: the driver error stays in the local log. */
export type LocalReadFailedDiagnostics = {
  read: LocalReadFailedRead;
};
