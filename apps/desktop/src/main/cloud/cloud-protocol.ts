import type { DesktopAgentSessionsAck as CanonicalDesktopAgentSessionsAck } from "@repo/api/src/types/agent-session";
import type {
  ComputeTargetServerCapabilities,
  DesktopHelloAckMintingOrigin,
} from "@repo/api/src/types/compute-target";
import { DesktopAnalyticsEventName as ApiDesktopAnalyticsEventName } from "@repo/api/src/types/desktop-analytics";
import {
  type CloudSocketDegradedReason,
  CloudSocketState,
} from "../../shared/cloud-socket-error.js";
import type { AgentSessionSyncTransportPayload } from "../agent-sync/agent-session-sync-contract.js";

export type OnlineCloudSocketStatus = {
  state: typeof CloudSocketState.Online;
  targetId: string;
  /**
   * ISS-9081: the origin the hello ack said minted `targetId`, carried on the
   * status so it reaches the retained-identity record alongside the id it
   * describes. Absent whenever the sender stated none — an older build, or one
   * that cannot name its own API.
   */
  mintingApiOrigin?: string;
};

export type CloudSocketStatus =
  | { state: typeof CloudSocketState.Idle }
  | OnlineCloudSocketStatus
  | {
      state: typeof CloudSocketState.Degraded;
      error: string;
      reason?: CloudSocketDegradedReason;
    }
  // `reason`, not `error`: nothing failed. The socket never reports this — only
  // the app does, for a connection it was told not to open.
  | { state: typeof CloudSocketState.Disabled; reason: string };

/**
 * The one "the user switched cloud egress off" status. Both main-process sites
 * that report it — the boot decision and the runtime disable transition — read
 * it from here, so the wording cannot drift between the two and the renderer
 * sees one string for one fact.
 */
export const CLOUD_DISABLED_BY_USER_STATUS: CloudSocketStatus = {
  state: CloudSocketState.Disabled,
  reason: "Cloud connection disabled by user",
};

export type ProtocolVersion = "1";

export const PROTOCOL_VERSION: ProtocolVersion = "1";

export type ProtocolEnvelope = {
  protocolVersion: ProtocolVersion;
  messageId: string;
  timestamp: string;
};

export interface DesktopHelloEvent extends ProtocolEnvelope {
  computeTargetId?: string;
  gatewayId?: string;
  desktopSecurityUpgradeProtocolVersion?: 1;
  machineName: string;
  platform: NodeJS.Platform;
  pluginVersion: string;
  /** Electron app version (from app.getVersion()), distinct from the gateway wire protocol version. */
  desktopClientVersion: string;
  /**
   * Gateway wire-protocol version (e.g. "0.1.0"), distinct from ProtocolEnvelope.protocolVersion
   * which identifies the Socket.IO envelope schema version ("1", "2", …).
   */
  gatewayProtocolVersion: string;
  supportedOperations: string[];
  maxInFlightCommands: number;
  allowedDirectoriesHash: string;
  capabilities?: Record<string, unknown>;
}

export interface DesktopHelloAckEvent
  extends ProtocolEnvelope,
    DesktopHelloAckMintingOrigin {
  computeTargetId: string;
  sessionId: string;
  serverTime: string;
  resumeFromSequence?: Record<string, number>;
  serverCapabilities?: ComputeTargetServerCapabilities;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface DesktopCommandEvent extends ProtocolEnvelope {
  commandId: string;
  operationId: string;
  method: HttpMethod;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: unknown;
  timeoutMs?: number;
  queuedAt?: string;
  lockKey?: string;
  requiresApproval?: boolean;
  approvalReason?: string;
}

export interface DesktopCommandAckEvent extends ProtocolEnvelope {
  commandId: string;
  accepted: boolean;
  state?: "accepted" | "failed";
  reason?: string;
}

export type CommandStreamEventType =
  | "status"
  | "chunk"
  | "result"
  | "error"
  | "done";

export interface DesktopCommandStreamEvent extends ProtocolEnvelope {
  commandId: string;
  sequence: number;
  eventType: CommandStreamEventType;
  data: unknown;
}

export interface DesktopCommandStreamAckEvent extends ProtocolEnvelope {
  commandId: string;
  sequence: number;
}

export interface DesktopCancelEvent extends ProtocolEnvelope {
  commandId: string;
  reason?: string;
}

export interface DesktopPresenceEvent extends ProtocolEnvelope {
  state: "online" | "degraded" | "paused";
  error?: string;
  activeCommands?: number;
  queueDepth?: number;
}

export const DesktopAgentSessionsAckReason = {
  /**
   * An HTTP 408 arrived on the sync response (in practice from an intermediary
   * proxy or CDN — the route itself was verified never to emit one).
   *
   * ISS-8605 (PRD-699 F2): ENVIRONMENTAL, not attributable to the batch. It used
   * to burn a bounded per-session timeout budget toward a dead-letter; that
   * budget is deleted. It now defers with every budget intact and terminates
   * only on the durable 24h `lane_stalled_since` wall clock.
   *
   * ISS-5088: this does not cover a CLIENT-side abort — see
   * {@link DesktopAgentSessionsAckReason.TransportTimeout}.
   */
  AckTimeout: "ack_timeout",
  FeatureDisabled: "feature_disabled",
  IngestionFailed: "ingestion_failed",
  // FEA-3792 (PRD-536 D9): `RateLimited` was overloaded across a genuine
  // server-side throttle AND local transport unavailability (relay not ready /
  // socket disconnected after the batch was prepared). Split them so backoff /
  // retry logic and telemetry stop reverse-engineering the cause via a racy
  // post-hoc `isHttpReady()` re-read. `RateLimited` now means ONLY a server
  // throttle (received over the wire); `TransportUnavailable` is a desktop-local
  // reason the client returns without ever reaching the server.
  //
  // ISS-8605 (PRD-699 F1): ENVIRONMENTAL. The route's limiter is keyed on the
  // compute target, never on a session, so a 429 cannot single one out — it
  // burns no per-row budget (it used to dead-letter after 5 consecutive) and is
  // bounded by the same durable 24h lane-stall clock as `ack_timeout`.
  RateLimited: "rate_limited",
  /**
   * FEA-3425, client-only: the HTTP transport's coded 403 — the sent
   * computeTargetId is not owned by the authenticated identity. Waiting cannot
   * fix a wrong id, so the sync service defers WITHOUT burning any retry
   * budget and surfaces the condition loudly; identity re-resolves via the
   * normal hello/refresh path.
   */
  TargetNotOwned: "target_not_owned",
  /**
   * ISS-5088, client-only: the local request aborted at its own timeout without
   * the server ever answering. Split out of {@link
   * DesktopAgentSessionsAckReason.AckTimeout} because the two arrive by
   * different ROUTES and carry different evidence: a 408 came back over the wire
   * from something that answered, while a client-side abort means nothing
   * answered at all. (Since ISS-8605 they no longer differ in BLAME — 408 is
   * environmental too — but they still differ in what they prove.) A client-side
   * abort is a LANE-WIDE stall (the transport, not the payload) —
   * production ISS-5088 windows show the session lane, the component lane, and
   * the relay socket's ping all timing out together, which one session's payload
   * cannot cause. Per `main/sync/AGENTS.md` invariant 4 a lane-wide failure must
   * not burn a row's retry budget, so this reason carries its own bounded budget
   * that is REFUNDED once the lane observes unambiguous connectivity loss.
   */
  TransportTimeout: "transport_timeout",
  TransportUnavailable: "transport_unavailable",
  /**
   * FEA-3425, client-only: the HTTP transport had no session token or the
   * server rejected it (401). Auth loss must pause the lane with all retry
   * budgets intact — it is never a payload problem.
   */
  Unauthenticated: "unauthenticated",
  ValidationFailed: "validation_failed",
} as const;

export type DesktopAgentSessionsAckReason =
  (typeof DesktopAgentSessionsAckReason)[keyof typeof DesktopAgentSessionsAckReason];

/**
 * The ACCEPTED arm, DERIVED from the canonical `packages/api` ack rather than
 * restated here (ISS-6202).
 *
 * It used to be a hand-copied `{ accepted: true; acceptedSessionIds?: string[] }`
 * sitting one repo away from the type the server actually serializes, so a field
 * added or narrowed there would have gone unnoticed here until a payload arrived
 * that this build could not read. Extracting it means the success shape has one
 * owner and `tsc` reports the drift.
 *
 * Only the SUCCESS arm is shared. The failure arm below stays desktop-owned
 * because {@link DesktopAgentSessionsAckReason} is a deliberate superset: the
 * client-only reasons (`transport_timeout`, `target_not_owned`,
 * `unauthenticated`, …) are verdicts the desktop reaches without the server ever
 * answering, so they cannot come from a wire contract.
 */
export type DesktopAgentSessionsAcceptedAck = Extract<
  CanonicalDesktopAgentSessionsAck,
  { accepted: true }
>;

/**
 * ISS-8595: the reason a rejection carries when the cloud named a class NEITHER
 * this build's {@link DesktopAgentSessionsAckReason} nor the shared
 * `DesktopAgentSessionsSyncErrorCode` can map — the version-skew case, which is
 * real rather than hypothetical because the cloud deploys independently of an
 * installed desktop.
 *
 * RESOLVED at the transport boundary rather than echoed: the received string is
 * untrusted JSON, and the sync lane switches on this value and writes it to a
 * durable `last_error` column. One fixed spelling is what lets the lane classify
 * the skew (PRD-699 Appendix A: environmental) without ever storing or
 * dispatching on free text. Deliberately NOT a member of the reason const above
 * — that const's members all have a `SyncReason` spelling, and this one has none.
 */
export const UNKNOWN_ACK_REASON = "unknown_ack_reason" as const;

export type DesktopAgentSessionsAck =
  | DesktopAgentSessionsAcceptedAck
  | {
      accepted: false;
      reason: DesktopAgentSessionsAckReason | typeof UNKNOWN_ACK_REASON;
      /**
       * ISS-5090: the server's stable, value-free field/path summary for a
       * rejection, when it sent one. Optional and additive (an older API omits
       * it); logged only, never used to classify or retry.
       */
      detail?: string;
      /**
       * ISS-8595: the code the server actually sent, carried ONLY alongside
       * {@link UNKNOWN_ACK_REASON}. Its own field rather than folded into
       * `detail`, which means something else — an operator asking "what did the
       * newer cloud call this?" has no other way to find out once the reason has
       * been resolved to a fixed spelling. Log-only, and never persisted: the
       * durable `last_error` stays the fixed spelling.
       */
      unrecognizedReason?: string;
      /**
       * ISS-10014: how long the SERVER asked this lane to wait, in ms, parsed
       * from the rejection's `Retry-After`. Present whenever the header was
       * readable, on any reason; which consumers honor it is the dispatch's
       * decision — the lane-stall fold (`ack_timeout`, `rate_limited`,
       * `ingestion_failed`, an unrecognized reason) and the lane gate
       * (`unauthenticated`, `target_not_owned`) both take it as a MINIMUM wait,
       * while `validation_failed` and `feature_disabled` ignore it because a
       * wait fixes neither.
       *
       * Additive and optional in both directions: an older cloud sends no
       * header, and every consumer treats absence as "no instruction" rather
       * than as a wait of zero.
       */
      retryAfterMs?: number;
    };

export type DesktopAgentSessionsEvent = ProtocolEnvelope &
  AgentSessionSyncTransportPayload;

// ISS-8752: the event-name set is owned by the shared wire contract in
// @repo/api (the apps/api ingest schema derives from the same const). This
// module used to re-declare it, and the two drifted the moment a member was
// added; re-exporting keeps every desktop importer on the one declaration.
export const DesktopAnalyticsEventName = ApiDesktopAnalyticsEventName;
export type DesktopAnalyticsEventName = ApiDesktopAnalyticsEventName;

export interface DesktopAnalyticsEvent extends ProtocolEnvelope {
  event: DesktopAnalyticsEventName;
  properties?: Record<string, unknown>;
  occurredAt: string;
}

export type CommandEventRecord = {
  sequence: number;
  eventType: CommandStreamEventType;
  data: unknown;
};

/**
 * The live compute target while the socket is online, else null. Strict-online:
 * no `lastComputeTargetId` fallback, unlike the persisted-fallback accessor. Lives
 * beside {@link CloudSocketStatus} so every reader folds the status once.
 */
export function resolveOnlineComputeTargetId(
  status: CloudSocketStatus
): string | null {
  return status.state === CloudSocketState.Online ? status.targetId : null;
}
