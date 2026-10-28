/**
 * FEA-3425 (PLN-1437 Phase 3): contract values shared by the desktop write-lane
 * REST routes — `/desktop/analytics`, `/desktop/telemetry`, `/desktop/components/sync`,
 * `/desktop/agent-sessions/sync` and `/desktop/agent-sessions/invocations/sync`.
 * Homed in a neutral module so no route reaches into another's domain-specific
 * contract file for a shared value.
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
 * ISS-8618 (PRD-699 §7.5): the one rejection-reason vocabulary of the desktop
 * write lane. Every machine-readable `code` any of these routes can send —
 * `/desktop/agent-sessions/sync`, `/desktop/agent-sessions/invocations/sync`,
 * `/desktop/analytics`, `/desktop/components/sync`, `/desktop/telemetry` — is a
 * member here, so the lane has ONE place that answers "what can the server say
 * no with", instead of five per-route lists that agree only by coincidence.
 *
 * Declared ABOVE the per-route objects, against this file's bottom-of-file
 * convention, because they are initialized from it.
 *
 * ADDITIVE by construction: every object that derives from this one keeps its
 * name, its export and its byte-identical values. Nothing on the wire changes.
 *
 * `AgentComponentInvocationSyncRejectReason` (`agent-component-invocation.ts`)
 * and `DesktopAgentSessionsSyncErrorCode` (`agent-session.ts`) both initialize
 * from it over a relative `.ts` runtime import (ISS-10197). The extension is
 * load-bearing: `rewriteRelativeImportExtensions` leaves an extensionless
 * specifier unchanged in `dist`, so the emitted module throws
 * `ERR_MODULE_NOT_FOUND` under plain Node ESM while `tsc` stays green
 * (ISS-10073).
 *
 * `DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID`
 * (`desktop-sync-ack-detail.ts`) is deliberately NOT a member, and the
 * conformance suite pins the exclusion so it cannot drift in silently: it rides
 * a different CARRIER — `details.reason` rather than `code` — because it is
 * rejected before a body is read. Same lane, different field; merging the two
 * carriers' vocabularies would let a `code`-only consumer believe it had seen
 * every reason.
 */
export const DesktopWriteLaneRejectReason = {
  AnalyticsUnavailable: "analytics_unavailable",
  CaptureFailed: "capture_failed",
  FeatureDisabled: "feature_disabled",
  GenerationConflict: "generation_conflict",
  IngestionFailed: "ingestion_failed",
  InternalError: "internal_error",
  PartConflict: "part_conflict",
  ProtocolUnsupported: "protocol_unsupported",
  RateLimited: "rate_limited",
  SchemaVersionUnsupported: "schema_version_unsupported",
  SessionMissing: "session_missing",
  TargetNotOwned: "target_not_owned",
  ValidationFailed: "validation_failed",
} as const;
export type DesktopWriteLaneRejectReason =
  (typeof DesktopWriteLaneRejectReason)[keyof typeof DesktopWriteLaneRejectReason];

/**
 * Machine-readable `code` values common to every desktop write-lane REST
 * route's failure `ApiResult` envelope. Each route composes this base with its
 * own route-specific codes rather than re-declaring these literals (the
 * SSOT-drift-by-copy pattern the root AGENTS.md calls out). The desktop clients
 * dispatch on code + status, never status alone.
 *
 * ONE INVARIANT binds `validation_failed` specifically, because a lane may map it
 * to Appendix A's ITEM class and a coded reason OUTRANKS the status it rides
 * (`apps/desktop/src/shared/sync-failure-classification.ts`): never send it on a
 * status where the failure is not the payload's own fault — no 5xx, no 429, and
 * not a 400 that is really about lane state, such as a stale `computeTargetId`.
 * Doing so charges a per-item dead-letter budget for an environmental condition,
 * which is the ISS-7730 shape. Give such a condition its own code instead.
 */
export const DesktopWriteLaneRestErrorCode = {
  InternalError: DesktopWriteLaneRejectReason.InternalError,
  TargetNotOwned: DesktopWriteLaneRejectReason.TargetNotOwned,
  ValidationFailed: DesktopWriteLaneRejectReason.ValidationFailed,
} as const;
export type DesktopWriteLaneRestErrorCode =
  (typeof DesktopWriteLaneRestErrorCode)[keyof typeof DesktopWriteLaneRestErrorCode];

/**
 * Failure `code` values for `POST /desktop/analytics` — the shared base plus
 * the analytics-only codes. Homed here (not in `desktop-analytics.ts`) so the
 * composition is an in-file spread rather than a cross-`types`-file relative
 * import: `desktop-analytics.ts` is consumed by toolchains whose
 * relative-extension rules disagree — Turbopack rejects a `.js` value import,
 * desktop's dist-load rejects extensionless — so no spelling of a runtime
 * relative import there is proven across all of them. Package-subpath imports
 * of this module (`@repo/api/src/types/desktop-write-lane`) resolve cleanly
 * everywhere.
 *
 * 403 is both `feature_disabled` (the flag evaluated off for this user → the
 * desktop latches, bounded by a recheck window) and `target_not_owned`
 * (wrong/stale computeTargetId), and 500 is both `capture_failed` (PostHog
 * forwarding failed) and `internal_error` (unexpected exception). The desktop
 * HTTP analytics lane dispatches on code + status, never status alone.
 *
 * ISS-7704: `analytics_unavailable` (503) is the flag lookup itself failing to
 * answer, which is NOT a rollout verdict and must never latch the lane.
 *
 * PRD-736 P1: the current server emits neither `feature_disabled` nor
 * `analytics_unavailable` — both went with the retired
 * `desktop-server-analytics-relay` flag. The codes and the desktop lane's
 * handling of them stay for one release as version-skew compatibility surface
 * (a new desktop build can meet a pre-P1 API deployment mid-rollout).
 */
export const DesktopAnalyticsRestErrorCode = {
  ...DesktopWriteLaneRestErrorCode,
  AnalyticsUnavailable: DesktopWriteLaneRejectReason.AnalyticsUnavailable,
  CaptureFailed: DesktopWriteLaneRejectReason.CaptureFailed,
  FeatureDisabled: DesktopWriteLaneRejectReason.FeatureDisabled,
  RateLimited: DesktopWriteLaneRejectReason.RateLimited,
} as const;
export type DesktopAnalyticsRestErrorCode =
  (typeof DesktopAnalyticsRestErrorCode)[keyof typeof DesktopAnalyticsRestErrorCode];

/**
 * Failure `code` values for `POST /desktop/components/sync` — the shared base
 * plus this route's own. Composed by in-file spread for the same reason
 * {@link DesktopAnalyticsRestErrorCode} is.
 *
 * `schema_version_unsupported` is the one rejection on this route an API deploy
 * can fix, and so the only one that earns the cursor-holding 400 (ISS-7978).
 * Until ISS-8609 it travelled as a BARE 400, which forced the component lane to
 * read every 400 as skew — the alternative was dead-lettering a whole inventory
 * on one side of a version skew — and that blanket fold is what hid a
 * content-attributable 400 behind an environmental defer. The code is what lets
 * the lane tell the two apart instead of inferring one from the status.
 */
export const DesktopComponentsSyncRestErrorCode = {
  ...DesktopWriteLaneRestErrorCode,
  SchemaVersionUnsupported:
    DesktopWriteLaneRejectReason.SchemaVersionUnsupported,
} as const;
export type DesktopComponentsSyncRestErrorCode =
  (typeof DesktopComponentsSyncRestErrorCode)[keyof typeof DesktopComponentsSyncRestErrorCode];

/**
 * Failure `code` values for the 403 of
 * `POST /desktop/agent-sessions/invocations/sync` (ISS-11426).
 *
 * Until this issue that route answered a BARE `forbiddenResponse()`, so its two
 * independent denials — an ownership miss on the `computeTargetId`, and the
 * FEA-4169 org session-sync policy being off — were one indistinguishable
 * status on the wire. The desktop folded every 403 on this lane to
 * `target_not_owned`, which is the ISS-8599 collapse the transcript control
 * plane already removed with `TranscriptForbiddenCode` (`desktop-transcripts.ts`): the two want
 * different responses (an identity the device can re-resolve or relink, versus
 * an org-admin setting), and ISS-11426 needs them apart so a recovery
 * affordance is only offered where relinking is actually the remedy.
 *
 * Deliberately the two 403 codes ONLY, not the shared base: this route sends no
 * other coded failure — its 400/413/501 carry a message or an ack reason — and
 * spreading {@link DesktopWriteLaneRestErrorCode} in would claim an
 * `internal_error`/`validation_failed` `code` channel the route does not have.
 *
 * Purely additive and skew-safe in both directions: an older desktop never
 * looks at the body on this status and keeps the status fold it has today, and
 * an older server sends no code, which the desktop reads as the same fold.
 */
export const DesktopAgentComponentInvocationSyncRestErrorCode = {
  FeatureDisabled: DesktopWriteLaneRejectReason.FeatureDisabled,
  TargetNotOwned: DesktopWriteLaneRejectReason.TargetNotOwned,
} as const;
export type DesktopAgentComponentInvocationSyncRestErrorCode =
  (typeof DesktopAgentComponentInvocationSyncRestErrorCode)[keyof typeof DesktopAgentComponentInvocationSyncRestErrorCode];
