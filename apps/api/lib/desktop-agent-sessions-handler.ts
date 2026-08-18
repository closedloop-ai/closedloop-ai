import type { DesktopAgentSessionsAck } from "@repo/api/src/types/agent-session";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { isAgentSessionSyncSupportedForUser } from "./agent-session-sync-feature";
import { TokenEventTransportIdentityCollisionError } from "./desktop-agent-sessions-errors";
import {
  DesktopAgentSessionsAckReason,
  type DesktopAgentSessionsPayload,
  parseDesktopAgentSessionsPayload,
} from "./desktop-agent-sessions-schema";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter";
import { isOrgSessionSyncPolicyEnabled } from "./org-session-sync-policy";

export type DesktopAgentSessionsHandlerContext = {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  targetId: string;
  gatewaySessionId?: string;
  relaySocketId?: string;
};

export type DesktopAgentSessionsHandlerDeps = {
  isFeatureEnabled?: (input: {
    userId: string;
    clerkUserId?: string | null;
  }) => Promise<boolean>;
  /**
   * FEA-4169: server-side ORG POLICY gate. Defaults to the DB-backed
   * {@link isOrgSessionSyncPolicyEnabled}. Overridable in tests.
   */
  isOrgPolicyEnabled?: (organizationId: string) => Promise<boolean>;
  rateLimiter?: DesktopAgentSessionsRateLimiter;
  upsertBatch?: (
    context: {
      organizationId: string;
      userId: string;
      computeTargetId: string;
      gatewaySessionId?: string;
    },
    payload: DesktopAgentSessionsPayload
  ) => Promise<{ persistedSessionIds: string[] }>;
  now?: () => number;
};

export class DesktopAgentSessionsRateLimiter extends FixedWindowRateLimiter {}

const defaultRateLimiter = new DesktopAgentSessionsRateLimiter();

export async function handleDesktopAgentSessionsEvent(
  payload: unknown,
  context: DesktopAgentSessionsHandlerContext,
  deps: DesktopAgentSessionsHandlerDeps = {}
): Promise<DesktopAgentSessionsAck> {
  // FEA-2258: rate-limit BEFORE parsing/sanitizing so an abusive (authenticated
  // or compromised) target is throttled with a cheap in-memory check before the
  // handler pays the O(payload) Zod parse + recursive sanitize cost.
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter;
  if (
    !rateLimiter.attempt(buildRateLimitKey(context), deps.now?.() ?? Date.now())
  ) {
    log.warn("Desktop agent sessions request rate limit exceeded", {
      computeTargetId: context.targetId,
      gatewaySessionId: context.gatewaySessionId,
      organizationId: context.organizationId,
      relaySocketId: context.relaySocketId,
      userId: context.userId,
    });
    emitTelemetryMetric({
      metric: "agent_sessions.sync.failed",
      organizationId: context.organizationId,
      computeTargetId: context.targetId,
      gatewaySessionId: context.gatewaySessionId,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    });
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    };
  }

  const parsed = parseDesktopAgentSessionsPayload(payload);
  if (!parsed.ok) {
    log.warn("Desktop agent sessions validation failed", {
      computeTargetId: context.targetId,
      reason: parsed.reason,
    });
    emitTelemetryMetric({
      metric: "agent_sessions.sync.failed",
      organizationId: context.organizationId,
      computeTargetId: context.targetId,
      gatewaySessionId: context.gatewaySessionId,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
      // ISS-5090: return the stable, value-free field/path summary the server
      // already logs, so the desktop can record WHY a payload was rejected. It
      // is what lets an operator tell a genuine local-data defect apart from
      // capability/version skew without server log access.
      detail: parsed.reason,
    };
  }

  // FEA-4169: server-owned ORG POLICY gate. The client-side OrgSyncPolicyStore
  // is UX-first; the server must deny ingest for a policy-off org here so an
  // older/compromised Desktop that ignores the optional identity field cannot
  // persist session batches for an org whose policy is off. Fail-closed
  // (unresolved org → false), so this is enforced identically across version
  // skew and never depends on a client-sent field.
  const isOrgPolicyEnabled =
    deps.isOrgPolicyEnabled ?? isOrgSessionSyncPolicyEnabled;
  const orgPolicyEnabled = await isOrgPolicyEnabled(context.organizationId);
  if (!orgPolicyEnabled) {
    emitTelemetryMetric({
      metric: "agent_sessions.sync.failed",
      organizationId: context.organizationId,
      computeTargetId: context.targetId,
      gatewaySessionId: context.gatewaySessionId,
      reason: DesktopAgentSessionsAckReason.FeatureDisabled,
    });
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.FeatureDisabled,
    };
  }

  const isFeatureEnabled =
    deps.isFeatureEnabled ??
    ((identity: { userId: string; clerkUserId?: string | null }) =>
      isAgentSessionSyncSupportedForUser(identity));

  const enabled = await isFeatureEnabled({
    userId: context.userId,
    clerkUserId: context.clerkUserId,
  });
  if (!enabled) {
    emitTelemetryMetric({
      metric: "agent_sessions.sync.failed",
      organizationId: context.organizationId,
      computeTargetId: context.targetId,
      gatewaySessionId: context.gatewaySessionId,
      reason: DesktopAgentSessionsAckReason.FeatureDisabled,
    });
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.FeatureDisabled,
    };
  }

  const upsertBatch = deps.upsertBatch ?? agentSessionsService.upsertSessions;

  let persistedSessionIds: string[];
  try {
    ({ persistedSessionIds } = await upsertBatch(
      {
        organizationId: context.organizationId,
        userId: context.userId,
        computeTargetId: context.targetId,
        gatewaySessionId: context.gatewaySessionId,
      },
      parsed.payload
    ));
  } catch (error) {
    if (error instanceof TokenEventTransportIdentityCollisionError) {
      log.warn("Desktop agent sessions validation failed", {
        computeTargetId: context.targetId,
        reason: error.message,
      });
      emitTelemetryMetric({
        metric: "agent_sessions.sync.failed",
        organizationId: context.organizationId,
        computeTargetId: context.targetId,
        gatewaySessionId: context.gatewaySessionId,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      });
      return {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      };
    }
    log.error("Desktop agent sessions ingestion failed", {
      computeTargetId: context.targetId,
      gatewaySessionIdHash: redactGatewaySessionId(context.gatewaySessionId),
      organizationId: context.organizationId,
      relaySocketId: context.relaySocketId,
      error,
    });
    emitTelemetryMetric({
      metric: "agent_sessions.sync.failed",
      organizationId: context.organizationId,
      computeTargetId: context.targetId,
      gatewaySessionId: context.gatewaySessionId,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    };
  }

  // Goal stage 2 (atomic row-level ack): when the batch opted in, return the
  // `externalSessionId`s this request actually PERSISTED, so the desktop clears
  // exactly those outbox rows. These come from `upsertSessions`, NOT from the
  // sent payload: the per-session transaction loop throws on a failing slice
  // (handled above), but it also deliberately SKIPS a slice it will not write —
  // a foreign chunk, whose revision does not match the server's pending
  // assembly — and that id must be absent from the echo. Echoing the sent ids
  // instead would let the desktop clear a row the server never stored, which is
  // exactly the silent loss this stage exists to remove; the desktop's bounded
  // `ack_omitted` budget re-sends the omitted row and recoverably dead-letters
  // it if it never lands. REQUEST-GATED: installed desktops parse the success
  // response with a `.strict()` validator, so the field must never appear for a
  // batch that did not ask for it.
  if (parsed.payload.wantsAcceptedSessionIds === true) {
    return { accepted: true, acceptedSessionIds: persistedSessionIds };
  }
  return { accepted: true };
}

function buildRateLimitKey(
  context: DesktopAgentSessionsHandlerContext
): string {
  if (context.relaySocketId) {
    return `relay:${context.organizationId}:${context.userId}:${context.targetId}`;
  }
  return `direct:${context.organizationId}:${context.userId}:${context.targetId}`;
}
