import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import { scheduleLogFlush } from "@/lib/route-utils";

export const DESKTOP_NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/** Exact success body returned by POST /desktop/onboarding-attempt. */
export type OnboardingAttemptResponse = {
  onboardingAttemptId: string;
  expiresAt: string;
};

/** Exact success body returned by POST /desktop/bootstrap/claim. */
export type BootstrapClaimResponse = {
  apiKey: string;
  source: "DESKTOP_MANAGED";
  gatewayId: string;
};

/**
 * PRD-532 §5.5 (PR-K / M8): exact success body returned by
 * POST /desktop/managed-key/provision. The session-authenticated provisioning
 * endpoint mints the same DESKTOP_MANAGED `sk_live_*` relay key as the
 * onboarding-attempt bootstrap claim, so it returns the identical wire
 * contract. Backend-only (never surfaced to a renderer or logged).
 */
export type DesktopManagedKeyProvisionResponse = BootstrapClaimResponse;

/** Exact non-2xx error body required by the desktop onboarding contract. */
export type DesktopContractErrorBody<TCode extends string = string> = {
  code: TCode;
  retryable: boolean;
};

/**
 * Returns an exact JSON error body for desktop onboarding/bootstrap routes.
 */
export function desktopContractError<TCode extends string>(
  status: number,
  code: TCode,
  retryable: boolean
): NextResponse<DesktopContractErrorBody<TCode>> {
  return NextResponse.json(
    { code, retryable },
    { status, headers: DESKTOP_NO_STORE_HEADERS }
  );
}

/**
 * Returns an exact JSON success body for desktop onboarding/bootstrap routes.
 */
export function desktopContractSuccess<TBody>(
  body: TBody,
  status = 200
): NextResponse<TBody> {
  return NextResponse.json(body, {
    status,
    headers: DESKTOP_NO_STORE_HEADERS,
  });
}

/** Datadog event name for a rejected browser-facing desktop-connect request. */
export const DESKTOP_CONNECT_REJECTED_EVENT = "desktop_connect_rejected";

/** Which step of the desktop-connect funnel a rejection came from. */
export const DesktopConnectStage = {
  OnboardingAttempt: "onboarding_attempt",
  DeviceOnboardingStart: "device_onboarding_start",
  SessionExchange: "session_exchange",
  /**
   * ISS-7974. Reports only the session-lookup fault arm of /desktop/authorize —
   * the one emission this route has. Its other refusals (401/400/403) still
   * return a bare `desktopContractError` and are outside that ticket, so a query
   * filtered to this stage is a floor on authorize rejections, not the total.
   */
  Authorize: "authorize",
  /** Pending-session lookup faults from the separate bootstrap mint. */
  BootstrapAuthorize: "bootstrap_authorize",
  /**
   * ISS-8132. Reports only the rollout-flag fault arm of
   * /desktop/device-onboarding/approve. Its other refusals (401/400/403/404 and
   * the persistence 503) still return a bare `desktopContractError` and are
   * outside that ticket, so a query filtered to this stage is a floor on
   * approve rejections, not the total.
   */
  DeviceOnboardingApprove: "device_onboarding_approve",
} as const;
export type DesktopConnectStage =
  (typeof DesktopConnectStage)[keyof typeof DesktopConnectStage];

/**
 * Separates rejections that share one wire `code` but not one root cause. The
 * contract deliberately collapses every server-side failure into a single
 * retryable 503 bucket; the counter must not inherit that collapse, or an auth
 * provider outage reads as a confirmed persistence failure (ISS-6692, #5485).
 */
export const DesktopConnectRejectionCause = {
  SessionLookupFaulted: "session_lookup_faulted",
  AttemptPersistFaulted: "attempt_persist_faulted",
  /**
   * ISS-8132. The rollout-flag provider was unreachable, so the policy was
   * never asked — distinct from a persistence failure and from a policy that
   * genuinely answered no.
   */
  FeatureFlagLookupFaulted: "feature_flag_lookup_faulted",
} as const;
export type DesktopConnectRejectionCause =
  (typeof DesktopConnectRejectionCause)[keyof typeof DesktopConnectRejectionCause];

/**
 * ISS-6343: `desktopContractError` plus the rejection counter the browser-facing
 * connect routes lacked. The logged `reason` is the same argument that becomes
 * the wire `code`, so the two cannot drift.
 *
 * The emission is bounded (see {@link desktopConnectRejectionThrottle}); the
 * RESPONSE is not. Every caller gets the same status and body whether its
 * occurrence emitted or was suppressed into a rollup.
 */
export function desktopConnectRejected<TCode extends string>(
  status: number,
  code: TCode,
  retryable: boolean,
  context: {
    stage: DesktopConnectStage;
    orgId?: string;
    cause?: DesktopConnectRejectionCause;
  }
): NextResponse<DesktopContractErrorBody<TCode>> {
  reportDesktopConnectRejection({
    stage: context.stage,
    reason: code,
    ...(context.orgId ? { orgId: context.orgId } : {}),
    ...(context.cause ? { cause: context.cause } : {}),
  });
  // These routes bypass the auth wrappers, so nothing else flushes the buffer.
  // `log.warn` only enqueues; without a `waitUntil` flush the line freezes with
  // the serverless function and the counter loses exactly the rejections it
  // exists to count. Unconditional: a suppressed occurrence still may have
  // pushed ANOTHER key's rollup out through `onFlush` or the expiry drain.
  scheduleLogFlush();
  return desktopContractError(status, code, retryable);
}

/**
 * The bound on emission: what is stable about a rejection, and nothing an
 * anonymous caller can vary. Every part is server-derived — `stage` and
 * `reason` are literals chosen by the handler, `cause` is a closed enum, and
 * `orgId` comes from a resolved session, never from the body. A caller
 * therefore cannot churn the keyspace to escape its own budget, which is the
 * hole that would otherwise make the cap decorative (#5209).
 */
type DesktopConnectRejectionScope = {
  stage: DesktopConnectStage;
  reason: string;
  cause?: DesktopConnectRejectionCause;
  orgId?: string;
};

/** Composite-key delimiter. No key part is free text that could contain it. */
const DESKTOP_CONNECT_KEY_DELIMITER = "|";

/**
 * WHY THIS IS THROTTLED (#5535 review, whitlockk). `apps/api/AGENTS.md` ("Emission
 * and Abuse Control"): a metric or alert emitted per request is an
 * amplification vector when a caller can drive the path. Two of the three
 * stages are worse than the authenticated case the rule was written for —
 * `device_onboarding_start` and `session_exchange` reject a malformed body on
 * the Zod branch, BEFORE the service that owns the rate limiter is ever
 * reached, so an UNAUTHENTICATED caller could mint one Datadog warning per
 * request in a loop.
 *
 * `FixedWindowEmissionThrottle` supplies both bounds: at most one line per
 * (stage, reason, cause, org) per window plus one aggregate rollup, and a hard
 * max-entry LRU cap on the keyspace, since an in-memory map keyed on
 * caller-reachable input would just trade a log leak for a memory leak (root
 * `AGENTS.md`).
 *
 * WHAT THE SUPPRESSED COUNT IS WORTH. Suppressed occurrences are rolled up,
 * never discarded — `sum(occurrences)` over the event is the total. But a
 * rollup is materialised by an EVENT, never a clock: the same key rolling its
 * window over, an LRU eviction, or the {@link FixedWindowEmissionThrottle
 * .drainExpired} call below, which every rejection runs so a burst followed by
 * quiet ON THAT KEY is still flushed by the next rejection through any of the
 * three routes. What remains, and is not fixable in process memory: an
 * instance that takes a burst and then serves no further rejection at all
 * before freezing loses its terminal window. `sum(occurrences)` is therefore a
 * lower-bounded eventual total, not a live exact one.
 *
 * Process-local and best-effort per serverless instance, matching
 * `orgAdminDenialThrottle`. Exported so tests can reset it between cases;
 * production code must not reach into it.
 */
export const desktopConnectRejectionThrottle =
  new FixedWindowEmissionThrottle<DesktopConnectRejectionScope>({
    onFlush: (scope, occurrences, flushedBy) =>
      emitDesktopConnectRollup(scope, occurrences, flushedBy),
  });

/**
 * Emit one rejection record, bounded. Never throws: this runs on the refusal
 * path, and a failure to REPORT a rejection must not change whether the
 * rejection happened or what the caller receives.
 */
function reportDesktopConnectRejection(
  scope: DesktopConnectRejectionScope
): void {
  try {
    const now = Date.now();
    const decision = desktopConnectRejectionThrottle.record(
      buildDesktopConnectKey(scope),
      scope,
      now
    );
    if (decision.flushedSuppressedCount > 0) {
      emitDesktopConnectRollup(
        scope,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (decision.emit) {
      log.warn(DESKTOP_CONNECT_REJECTED_EVENT, {
        ...desktopConnectFields(scope),
        occurrences: 1,
      });
    }
    // A terminal path these routes already run on every rejection, so a quiet
    // key's pending count does not wait for that exact key to be hit again.
    // O(1) when nothing has expired.
    desktopConnectRejectionThrottle.drainExpired(now);
  } catch (error) {
    log.warn("[desktop-connect] Failed to report a rejection", {
      event: DESKTOP_CONNECT_REJECTED_EVENT,
      stage: scope.stage,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildDesktopConnectKey(scope: DesktopConnectRejectionScope): string {
  return [scope.stage, scope.reason, scope.cause ?? "", scope.orgId ?? ""].join(
    DESKTOP_CONNECT_KEY_DELIMITER
  );
}

/**
 * An absent `orgId`/`cause` is OMITTED, not serialized as `null` — a rejection
 * that never resolved a session did not observe an org, and a field present as
 * `null` reads in a query as one that was looked up and came back empty.
 */
function desktopConnectFields(scope: DesktopConnectRejectionScope) {
  return {
    reason: scope.reason,
    stage: scope.stage,
    ...(scope.orgId ? { orgId: scope.orgId } : {}),
    ...(scope.cause ? { cause: scope.cause } : {}),
  };
}

/**
 * The rollup for occurrences a closed window suppressed, emitted as ONE line
 * carrying their total. `aggregated` lets a query tell a rollup from a first
 * occurrence, and `flushedBy` is not decoration: a rollup arriving by
 * `eviction` says the keyspace cap was hit, which is a different operational
 * story from a quiet key drained by `expiry` or a busy one rolling over by
 * `window`.
 */
function emitDesktopConnectRollup(
  scope: DesktopConnectRejectionScope,
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(DESKTOP_CONNECT_REJECTED_EVENT, {
    ...desktopConnectFields(scope),
    occurrences,
    aggregated: true,
    flushedBy,
  });
}
