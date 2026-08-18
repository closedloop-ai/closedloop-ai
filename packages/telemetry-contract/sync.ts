import { z } from "zod";
import { TelemetryAttribute } from "./src/attributes";

/**
 * FEA-3426: closed set of reasons a sync batch was a `failure` or `dead_letter`.
 * The SSOT for the `sync.reason` attribute values. Defined as literals here (not
 * imported from `DesktopAgentSessionsAckReason`) because this is a leaf package
 * and the two same-named ack-reason consts disagree — the desktop protocol one
 * carries `ack_timeout` (locally synthesized) while the shared API one does not.
 * The union is the desktop ack reasons plus the locally-synthesized non-ack
 * producers: `transport_error` (a thrown send), `locally_oversized` (a payload
 * still over the cap after chunking), `unhydratable` (a candidate whose local
 * row was deleted after enqueue), and the goal-stage-2 pair described below.
 * Transport-health only — never ids or content.
 *
 * FEA-3425 adds the two reasons the HTTP sync transport synthesizes locally:
 * `unauthenticated` (401 / no session token — the lane defers with budgets
 * intact) and `target_not_owned` (coded 403 — the sent computeTargetId is not
 * owned by the authenticated identity).
 *
 * FEA-3792 (PRD-536 D9): `transport_unavailable` was split out of the overloaded
 * `rate_limited` — the desktop client returns it (never the server) when the
 * relay is not ready / the socket disconnected after the batch was prepared. It
 * is a distinct `sync.reason` so the SLO can separate a local relay flap from a
 * genuine server throttle instead of reverse-engineering the cause.
 *
 * ISS-5088 adds `transport_timeout`: a client-side request abort where the
 * server never answered, split out of `ack_timeout` (which now means only a
 * server-answered HTTP 408). They are distinct `sync.reason` values because they
 * have opposite blame — `ack_timeout` is attributable to the batch, while
 * `transport_timeout` is a lane-wide local/network stall — and the SLO must be
 * able to separate "our payloads are too slow" from "this desktop lost its
 * network" without inferring it from a correlated socket disconnect.
 *
 * Goal stage 2 (atomic row-level ack) adds two locally-synthesized reasons:
 * `ack_clear_failed` — the server acked the batch but the local durable
 * outbox clear failed to commit (db-host down), so ack processing was aborted
 * and the rows stay queued for a deduped re-send; this is what makes the
 * bounded "re-send of a cloud-persisted row" measurable instead of silent.
 * `ack_omitted` — the server's accepted-batch echo (`acceptedSessionIds`)
 * omitted a sent row; the lane is provably healthy (neighbors acked in the
 * same request), so the omission burns a bounded row-attributable budget.
 */
export const SyncReason = {
  AckClearFailed: "ack_clear_failed",
  AckOmitted: "ack_omitted",
  AckTimeout: "ack_timeout",
  RateLimited: "rate_limited",
  TransportTimeout: "transport_timeout",
  TransportUnavailable: "transport_unavailable",
  IngestionFailed: "ingestion_failed",
  ValidationFailed: "validation_failed",
  FeatureDisabled: "feature_disabled",
  LocallyOversized: "locally_oversized",
  TargetNotOwned: "target_not_owned",
  TransportError: "transport_error",
  Unauthenticated: "unauthenticated",
  Unhydratable: "unhydratable",
} as const;

/** Literal union of `sync.reason` values. */
export type SyncReason = (typeof SyncReason)[keyof typeof SyncReason];

/** Strict sync attribute schema for transport-health telemetry only. */
export const SyncTelemetrySchema = z
  .object({
    [TelemetryAttribute.SyncEvent]: z.enum(["batch"]).optional(),
    [TelemetryAttribute.SyncOutcome]: z
      .enum(["success", "failure", "dead_letter"])
      .optional(),
    [TelemetryAttribute.SyncPayloadBytes]: z.number().int().min(0).optional(),
    [TelemetryAttribute.SyncLatencyMs]: z.number().finite().min(0).optional(),
    [TelemetryAttribute.SyncReason]: z.enum(SyncReason).optional(),
  })
  .strict();

/** Parsed sync telemetry attribute shape. */
export type SyncTelemetry = z.infer<typeof SyncTelemetrySchema>;
