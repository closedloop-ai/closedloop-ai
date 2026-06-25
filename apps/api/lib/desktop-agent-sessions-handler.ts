import type { DesktopAgentSessionsAck } from "@repo/api/src/types/agent-session";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { isAgentSessionSyncSupportedForUser } from "./agent-session-sync-feature";
import {
  DesktopAgentSessionsAckReason,
  type DesktopAgentSessionsPayload,
  parseDesktopAgentSessionsPayload,
} from "./desktop-agent-sessions-schema";

const DESKTOP_AGENT_SESSIONS_RATE_LIMIT_MAX = 120;
const DESKTOP_AGENT_SESSIONS_RATE_LIMIT_WINDOW_MS = 60_000;
const DESKTOP_AGENT_SESSIONS_RATE_LIMIT_MAX_ENTRIES = 10_000;

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

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export class DesktopAgentSessionsRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries =
      options.maxEntries ?? DESKTOP_AGENT_SESSIONS_RATE_LIMIT_MAX_ENTRIES;
  }

  attempt(key: string, now: number): boolean {
    this.pruneExpired(now);

    const current = this.entries.get(key);
    if (!current || now >= current.resetAt) {
      this.entries.set(key, {
        count: 1,
        resetAt: now + DESKTOP_AGENT_SESSIONS_RATE_LIMIT_WINDOW_MS,
      });
      this.pruneOldestEntries();
      return true;
    }

    if (current.count >= DESKTOP_AGENT_SESSIONS_RATE_LIMIT_MAX) {
      return false;
    }

    current.count += 1;
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) {
        this.entries.delete(key);
      }
    }
  }

  private pruneOldestEntries(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}

const defaultRateLimiter = new DesktopAgentSessionsRateLimiter();

export async function handleDesktopAgentSessionsEvent(
  payload: unknown,
  context: DesktopAgentSessionsHandlerContext,
  deps: DesktopAgentSessionsHandlerDeps = {}
): Promise<DesktopAgentSessionsAck> {
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

  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter;
  if (
    !rateLimiter.attempt(buildRateLimitKey(context), deps.now?.() ?? Date.now())
  ) {
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

  const upsertBatch = deps.upsertBatch ?? agentSessionsService.upsertSessions;

  try {
    emitTelemetryMetric({
      metric: "agent_sessions.sync.received",
      organizationId: context.organizationId,
      computeTargetId: context.targetId,
      gatewaySessionId: context.gatewaySessionId,
      sessionCount: parsed.payload.sessions.length,
      syncMode: parsed.payload.syncMode,
      count: 1,
    });
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
      organizationId: context.organizationId,
      error,
    });
    emitTelemetryMetric({
      metric: "agent_sessions.sync.failed",
      organizationId: context.organizationId,
      computeTargetId: context.targetId,
      gatewaySessionId: context.gatewaySessionId,
      reason: "ingestion_failed",
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
