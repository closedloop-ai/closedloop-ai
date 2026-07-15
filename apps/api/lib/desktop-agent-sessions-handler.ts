import type { DesktopAgentSessionsAck } from "@repo/api/src/types/agent-session";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { isAgentSessionSyncSupportedForUser } from "./agent-session-sync-feature";
import {
  DesktopAgentSessionsAckReason,
  type DesktopAgentSessionsPayload,
  parseDesktopAgentSessionsPayload,
} from "./desktop-agent-sessions-schema";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter";

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
  rateLimiter?: DesktopAgentSessionsRateLimiter;
  upsertBatch?: (
    context: {
      organizationId: string;
      userId: string;
      computeTargetId: string;
      gatewaySessionId?: string;
    },
    payload: DesktopAgentSessionsPayload
  ) => Promise<void>;
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

  try {
    await upsertBatch(
      {
        organizationId: context.organizationId,
        userId: context.userId,
        computeTargetId: context.targetId,
        gatewaySessionId: context.gatewaySessionId,
      },
      parsed.payload
    );
  } catch (error) {
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
