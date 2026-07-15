import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import type { JsonValue } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import {
  DESKTOP_ANALYTICS_SOCKET_EVENT,
  DESKTOP_SERVER_ANALYTICS_RELAY_FLAG,
  type DesktopAnalyticsAck,
  DesktopAnalyticsAckReason,
  parseDesktopAnalyticsPayload,
} from "./desktop-analytics-schema";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter";

export type DesktopAnalyticsHandlerContext = {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  targetId: string;
  gatewaySessionId?: string;
  pluginVersion?: string;
  relaySocketId?: string;
};

export type DesktopAnalyticsCaptureInput = {
  event: string;
  distinctId: string;
  properties: Record<string, JsonValue>;
};

export type DesktopAnalyticsHandlerDeps = {
  capture: (input: DesktopAnalyticsCaptureInput) => void | Promise<void>;
  isFeatureEnabled?: (
    flag: string,
    distinctId: string
  ) => boolean | null | Promise<boolean | null>;
  rateLimiter?: DesktopAnalyticsRateLimiter;
  now?: () => number;
};

/**
 * Fixed-window in-memory limiter for best-effort Desktop analytics abuse
 * control. It is intentionally not a durable authorization primitive.
 */
export class DesktopAnalyticsRateLimiter extends FixedWindowRateLimiter {}

const defaultRateLimiter = new DesktopAnalyticsRateLimiter();

/**
 * Validates, feature-gates, enriches, rate-limits, and forwards one Desktop
 * product analytics event. Gateway-owner Clerk identity from authenticated
 * socket context is the only PostHog distinct id source.
 */
export async function handleDesktopAnalyticsEvent(
  payload: unknown,
  context: DesktopAnalyticsHandlerContext,
  deps: DesktopAnalyticsHandlerDeps
): Promise<DesktopAnalyticsAck> {
  const parsed = parseDesktopAnalyticsPayload(payload);
  if (!parsed.ok) {
    log.warn("Desktop analytics validation failed", {
      event: DESKTOP_ANALYTICS_SOCKET_EVENT,
      computeTargetId: context.targetId,
      reason: parsed.reason,
    });
    return {
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    };
  }

  const clerkUserId = toNonEmptyString(context.clerkUserId);
  if (!clerkUserId) {
    log.warn("Desktop analytics missing gateway-owner Clerk identity", {
      event: parsed.payload.event,
      computeTargetId: context.targetId,
      organizationId: context.organizationId,
    });
    return {
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    };
  }

  const isFeatureEnabled =
    deps.isFeatureEnabled ?? isFeatureFlagEnabledForDistinctId;
  let enabled = false;
  try {
    enabled =
      (await isFeatureEnabled(
        DESKTOP_SERVER_ANALYTICS_RELAY_FLAG,
        clerkUserId
      )) === true;
  } catch (error) {
    log.warn("Desktop analytics feature flag evaluation failed", {
      flag: DESKTOP_SERVER_ANALYTICS_RELAY_FLAG,
      computeTargetId: context.targetId,
      error,
    });
  }

  if (!enabled) {
    return {
      accepted: false,
      reason: DesktopAnalyticsAckReason.FeatureDisabled,
    };
  }

  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter;
  if (
    !rateLimiter.attempt(
      buildRateLimitKey(context, clerkUserId),
      deps.now?.() ?? Date.now()
    )
  ) {
    return {
      accepted: false,
      reason: DesktopAnalyticsAckReason.RateLimited,
    };
  }

  try {
    await deps.capture({
      event: parsed.payload.event,
      distinctId: clerkUserId,
      properties: {
        ...parsed.payload.properties,
        occurred_at: parsed.payload.occurredAt,
        origin: "desktop",
        desktop_attribution_model: "gateway_owner",
        organization_id: context.organizationId,
        compute_target_id: context.targetId,
        ...(context.gatewaySessionId
          ? { gateway_session_id: context.gatewaySessionId }
          : {}),
        ...(context.pluginVersion
          ? { code_plugin_version: context.pluginVersion }
          : {}),
      },
    });
  } catch (error) {
    log.warn("Desktop analytics PostHog forwarding failed", {
      event: parsed.payload.event,
      computeTargetId: context.targetId,
      organizationId: context.organizationId,
      error,
    });
    return {
      accepted: false,
      reason: DesktopAnalyticsAckReason.CaptureFailed,
    };
  }

  return { accepted: true };
}

function buildRateLimitKey(
  context: DesktopAnalyticsHandlerContext,
  clerkUserId: string
): string {
  if (context.relaySocketId) {
    return `relay:${context.organizationId}:${clerkUserId}:${context.targetId}`;
  }
  return `direct:${context.organizationId}:${clerkUserId}:${context.targetId}`;
}

function toNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
