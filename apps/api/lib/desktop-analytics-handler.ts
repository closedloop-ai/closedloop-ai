import type { JsonValue } from "@repo/api/src/types/common";
import { DesktopAnalyticsAttributionModel } from "@repo/api/src/types/desktop-analytics";
import { log } from "@repo/observability/log";
import {
  DESKTOP_ANALYTICS_SOCKET_EVENT,
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
  pluginVersion?: string;
};

export type DesktopAnalyticsCaptureInput = {
  event: string;
  distinctId: string;
  properties: Record<string, JsonValue>;
};

export type DesktopAnalyticsHandlerDeps = {
  capture: (input: DesktopAnalyticsCaptureInput) => void | Promise<void>;
  /**
   * ISS-10503 (PRD-736 D5, invariant 5): emits the one PostHog alias that folds
   * a pre-auth onboarding attempt into the authenticated person, when an
   * authenticated payload carries the envelope `distinctId`. Optional because
   * the desktop presents the onboarding id only over the HTTP write lane —
   * the REST route supplies it.
   */
  alias?: (input: {
    distinctId: string;
    alias: string;
  }) => void | Promise<void>;
  rateLimiter?: DesktopAnalyticsRateLimiter;
  now?: () => number;
};

/**
 * Fixed-window in-memory limiter for best-effort Desktop analytics abuse
 * control. It is intentionally not a durable authorization primitive.
 *
 * PRD-736 D6 (sizing rationale, confirmed 2026-09 — no resize): the inherited
 * default of 120 requests per 60s applies per `buildRateLimitKey` key —
 * `direct:org:clerkUser:target`. That fits this lane's real load with wide margin — the
 * FTUE onboarding burst is ~25 events, and
 * steady-state `page_viewed` traffic is tens of events per user per DAY.
 * Raise it only if a measured page-view rate exceeds it. This in-memory,
 * per-instance limiter is a spend bound, never the lane's kill switch (see
 * the handler docstring below).
 */
export class DesktopAnalyticsRateLimiter extends FixedWindowRateLimiter {}

const defaultRateLimiter = new DesktopAnalyticsRateLimiter();

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

  // ISS-10503 (PRD-736 D5, invariant 5): an authenticated payload carrying the
  // envelope distinctId is the alias handshake — the first authenticated call
  // after account establishment presents the onboarding id once, and this
  // handler (which alone knows the authoritative clerkUserId) emits the merge.
  // Best-effort relative to the capture: a failed alias must not cost the
  // event. The ack's `aliased` field reports the outcome (PR #7768 review:
  // the capture ack alone must not clear the client's pending-alias latch),
  // and the desktop re-presents the id until an ack says `aliased: true`. The
  // no-logging rule for the ids (PRD-736 decision #13) binds the catch below —
  // log the event, never the id.
  let aliased: boolean | undefined;
  if (parsed.payload.distinctId && deps.alias) {
    try {
      await deps.alias({
        distinctId: clerkUserId,
        alias: parsed.payload.distinctId,
      });
      aliased = true;
    } catch (error) {
      aliased = false;
      log.warn("Desktop analytics alias emission failed", {
        event: parsed.payload.event,
        computeTargetId: context.targetId,
        error,
      });
    }
  }

  try {
    await deps.capture({
      event: parsed.payload.event,
      distinctId: clerkUserId,
      properties: {
        ...parsed.payload.properties,
        occurred_at: parsed.payload.occurredAt,
        origin: "desktop",
        desktop_attribution_model:
          DesktopAnalyticsAttributionModel.GatewayOwner,
        organization_id: context.organizationId,
        compute_target_id: context.targetId,
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

  // Omission preserved (Cross-Repo rule): no alias was attempted, no field.
  return aliased === undefined
    ? { accepted: true }
    : { accepted: true, aliased };
}

export type DesktopAnalyticsPreAuthHandlerDeps = {
  capture: (input: DesktopAnalyticsCaptureInput) => void | Promise<void>;
  rateLimiter?: DesktopAnalyticsRateLimiter;
  globalRateLimiter?: DesktopAnalyticsRateLimiter;
  now?: () => number;
};

/**
 * ISS-10503 (PRD-736 D5): a SEPARATE limiter instance for the pre-auth mode.
 * Pre-auth keys are client-supplied UUIDs, so sharing the authenticated
 * limiter's bounded entry set would let a flood of minted ids evict live
 * authenticated windows. Budget stays the inherited 120/60s per distinct id —
 * re-sized per PRD-736 decision #12 from the onboarding-only 30/hour to cover
 * lifetime single-player traffic (same order as the authenticated ceiling; the
 * FTUE burst is ~25 events and steady-state page views are tens per DAY).
 * Bounding a flood is the edge-WAF rule's job (ISS-10504 P1), not this
 * in-memory spend bound's.
 */
const preAuthRateLimiter = new DesktopAnalyticsRateLimiter();

/**
 * ISS-10503 (PR #7768 review): a per-id window alone is no flood bound — every
 * freshly minted v4 UUID opens a new window, so an unauthenticated caller
 * could stream events by rotating ids. The edge-WAF rate limit is per IP and
 * the kill-switch deny rule is off; this per-instance GLOBAL window bounds
 * pre-auth spend across ALL distinct ids. The budget is the PRD-736 P1 edge
 * number (600 requests/min — sized so an enterprise office NATed behind one IP
 * is not throttled on a rollout day); per-instance, it is a spend bound, not a
 * precise limit, matching the class of every limiter in this file.
 */
export const PRE_AUTH_GLOBAL_RATE_LIMIT_MAX_PER_WINDOW = 600;
const PRE_AUTH_GLOBAL_RATE_LIMIT_KEY = "preauth:global";
const preAuthGlobalRateLimiter = new DesktopAnalyticsRateLimiter({
  maxRequests: PRE_AUTH_GLOBAL_RATE_LIMIT_MAX_PER_WINDOW,
});

/**
 * ISS-10503 (PRD-736 D5): the pre-auth mode of the desktop analytics lane —
 * validates and forwards one event from an UNAUTHENTICATED desktop install.
 * The PostHog person is the client-supplied envelope `distinctId`: the
 * attempt-scoped onboarding id (pre-auth onboarding steps) or `node_uuid`
 * (a single-player install's whole life). The schema's v4-UUID shape check is
 * the load-bearing injection control (decision #12). No org, user, or
 * compute-target context exists here, so none is stamped — absent, not null
 * (Cross-Repo rule). The no-logging rule (decision #13) binds every log call:
 * the distinct id never appears in one.
 */
export async function handleDesktopAnalyticsPreAuthEvent(
  payload: unknown,
  deps: DesktopAnalyticsPreAuthHandlerDeps
): Promise<DesktopAnalyticsAck> {
  const parsed = parseDesktopAnalyticsPayload(payload);
  if (!parsed.ok) {
    log.warn("Desktop analytics pre-auth validation failed", {
      event: DESKTOP_ANALYTICS_SOCKET_EVENT,
      reason: parsed.reason,
    });
    return {
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    };
  }

  const distinctId = parsed.payload.distinctId;
  if (!distinctId) {
    log.warn("Desktop analytics pre-auth payload missing distinct id", {
      event: parsed.payload.event,
    });
    return {
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    };
  }

  const now = deps.now?.() ?? Date.now();
  const globalRateLimiter = deps.globalRateLimiter ?? preAuthGlobalRateLimiter;
  if (!globalRateLimiter.attempt(PRE_AUTH_GLOBAL_RATE_LIMIT_KEY, now)) {
    return {
      accepted: false,
      reason: DesktopAnalyticsAckReason.RateLimited,
    };
  }

  const rateLimiter = deps.rateLimiter ?? preAuthRateLimiter;
  if (!rateLimiter.attempt(`preauth:${distinctId}`, now)) {
    return {
      accepted: false,
      reason: DesktopAnalyticsAckReason.RateLimited,
    };
  }

  try {
    await deps.capture({
      event: parsed.payload.event,
      distinctId,
      properties: {
        ...parsed.payload.properties,
        occurred_at: parsed.payload.occurredAt,
        origin: "desktop",
        desktop_attribution_model:
          DesktopAnalyticsAttributionModel.PreAuthDistinctId,
      },
    });
  } catch (error) {
    log.warn("Desktop analytics pre-auth PostHog forwarding failed", {
      event: parsed.payload.event,
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
  return `direct:${context.organizationId}:${clerkUserId}:${context.targetId}`;
}

function toNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function consumeDesktopAnalyticsPreAuthBudget(
  distinctId: string,
  now = Date.now()
): boolean {
  return (
    preAuthGlobalRateLimiter.attempt(PRE_AUTH_GLOBAL_RATE_LIMIT_KEY, now) &&
    preAuthRateLimiter.attempt(`preauth:${distinctId}`, now)
  );
}
