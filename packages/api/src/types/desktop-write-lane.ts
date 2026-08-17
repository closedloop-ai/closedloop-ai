/**
 * FEA-3425 (PLN-1437 Phase 3): contract values shared by the desktop write-lane
 * REST routes (`/desktop/analytics`, `/desktop/telemetry`, and the pre-existing
 * `/desktop/agent-sessions/sync`). Homed in a neutral module so neither twin
 * reaches into the other's domain-specific contract file for a shared value.
 */

/**
 * Request header carrying the Code plugin version on the desktop write-lane
 * REST routes. The relay socket transport derived this from the `hello`
 * handshake's `pluginVersion` (`getCodePluginVersion()`); the stateless REST
 * twins receive it per-request so server-side enrichment (`code_plugin_version`
 * on captured analytics, telemetry trace `pluginVersion`) stays in parity
 * across transports. The Electron desktop app version is a *different* value
 * that already travels as the `desktop_client_version` analytics property /
 * telemetry trace field — do not conflate the two.
 */
export const DESKTOP_PLUGIN_VERSION_HEADER = "x-desktop-plugin-version";

/**
 * Machine-readable `code` values common to every desktop write-lane REST
 * route's failure `ApiResult` envelope. Each route composes this base with its
 * own route-specific codes rather than re-declaring these literals (the
 * SSOT-drift-by-copy pattern the root AGENTS.md calls out). The desktop clients
 * dispatch on code + status, never status alone.
 */
export const DesktopWriteLaneRestErrorCode = {
  InternalError: "internal_error",
  TargetNotOwned: "target_not_owned",
  ValidationFailed: "validation_failed",
} as const;
export type DesktopWriteLaneRestErrorCode =
  (typeof DesktopWriteLaneRestErrorCode)[keyof typeof DesktopWriteLaneRestErrorCode];

/**
 * Failure `code` values for `POST /desktop/analytics` — the shared base plus
 * the analytics-only codes. Homed here (not in `desktop-analytics.ts`) so the
 * composition is an in-file spread rather than a cross-`types`-file relative
 * import: `desktop-analytics.ts` is consumed by three toolchains with
 * conflicting relative-extension rules (Turbopack rejects a `.js` value import,
 * `apps/relay`'s tsc rejects `.ts`, desktop's dist-load rejects extensionless),
 * so it must not carry a runtime relative import. Package-subpath imports of
 * this module (`@repo/api/src/types/desktop-write-lane`) resolve cleanly
 * everywhere.
 *
 * 403 is both `feature_disabled` (org capability off → the desktop latches and
 * stops for the session) and `target_not_owned` (wrong/stale computeTargetId),
 * and 500 is both `capture_failed` (PostHog forwarding failed) and
 * `internal_error` (unexpected exception). The desktop HTTP analytics lane
 * dispatches on code + status, never status alone.
 */
export const DesktopAnalyticsRestErrorCode = {
  ...DesktopWriteLaneRestErrorCode,
  CaptureFailed: "capture_failed",
  FeatureDisabled: "feature_disabled",
  RateLimited: "rate_limited",
} as const;
export type DesktopAnalyticsRestErrorCode =
  (typeof DesktopAnalyticsRestErrorCode)[keyof typeof DesktopAnalyticsRestErrorCode];
