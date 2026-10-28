/**
 * @file desktop-analytics-http-lane.ts
 * @description FEA-3425 (PLN-1437 Phase 3): HTTP transport for the best-effort
 * product-analytics lane. Posts the same event payload the relay socket used to
 * carry (`desktop.analytics`) to `POST /desktop/analytics`, authenticated with
 * the first-party Desktop session token.
 *
 * Best-effort since PLN-1437 Phase 4a: the legacy socket fallback was retired
 * once session coverage cleared the D7 no-strand gate, so every non-terminal
 * outcome is now a DROP (matching the retired socket lane's silent drop on
 * disconnect). PostHog events carry no idempotency key, so a re-send would
 * double-count — the lane never retries.
 * - no session token / no valid origin / connection-level failure → DROP
 *   (never reached the server)
 * - abort timeout → DROP (the server may have captured it)
 * - HTTP 401 → `onUnauthorized` (invalidate the cached token) + DROP
 * - HTTP 404/405 → DROP (the API deployment predates the route — version skew)
 * - coded 403 `feature_disabled` → latch, BOUNDED by
 *   {@link ANALYTICS_FEATURE_DISABLED_RECHECK_MS}: drop this and every later
 *   event until the window lapses or the desktop auth session changes
 *   (`resetForSession`), then re-evaluate the per-`clerkUserId` gate
 * - coded 503 `analytics_unavailable` → DROP + a SHORTER suppression window
 *   ({@link ANALYTICS_UNAVAILABLE_RECHECK_MS}). Nothing was learned about the
 *   rollout, so this is not a disabled verdict — but the unanswered state can
 *   be permanent, so it is still bounded (ISS-7704).
 * - any other server-answered rejection (400/403/413/429/5xx) → DROP with a
 *   debug log. The edge-WAF deny rule on `/desktop/analytics` — the lane's
 *   kill switch since PRD-736 P1 — lands here as an uncoded 403.
 *
 * PRD-736 P1 version-skew note: the current API emits neither coded latching
 * rejection any more (both went with the retired `desktop-server-analytics-relay`
 * flag), but this lane keeps both branches for one release because a new
 * desktop build can meet a pre-P1 API deployment mid-rollout.
 *
 * Both latching branches dispatch on code AND status, per the contract stated
 * on `DesktopAnalyticsRestErrorCode`; neither reads a status alone.
 *
 * A lapsed window releases exactly ONE probe, and a verdict that lands after
 * `resetForSession()` is discarded rather than applied to the new session — see
 * `recheckInFlight` and `sessionGeneration` below.
 */
import { desktopAnalyticsCaptureApiResultValidator } from "@repo/api/src/types/desktop-analytics";
import {
  DESKTOP_PLUGIN_VERSION_HEADER,
  DesktopAnalyticsRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { SessionFetchOptions } from "../util/api-response-utils.js";
import {
  extractApiErrorCode,
  postSessionJson,
  resolveSessionPostOutcome,
} from "../util/api-response-utils.js";
import type {
  DesktopAnalyticsEvent,
  ProtocolEnvelope,
} from "./cloud-protocol.js";

/**
 * Matches the socket transport's `ANALYTICS_ACK_TIMEOUT_MS` class of bound —
 * analytics is best-effort, so a slow round-trip drops the event rather than
 * queueing a retry that could double-count.
 */
export const ANALYTICS_HTTP_REQUEST_TIMEOUT_MS = 10_000;

/**
 * ISS-7704: how long a `feature_disabled` verdict pins the lane off before the
 * next send re-asks. The verdict is a per-`clerkUserId` PostHog rollout answer,
 * and a rollout can be widened while the app is already running — an unbounded
 * latch meant a user whose flag was switched on mid-session stayed dark until
 * they quit, with no signal that it had happened. The window still collapses a
 * disabled install's traffic to at most one probe per interval.
 */
export const ANALYTICS_FEATURE_DISABLED_RECHECK_MS = 5 * 60 * 1000;

/**
 * ISS-7704: the same bound for an `analytics_unavailable` verdict, but shorter,
 * because the two states differ in how long they are expected to last rather
 * than in kind. "PostHog did not answer" covers a transient blip AND two
 * permanent states — an API deployment with no `NEXT_PUBLIC_POSTHOG_KEY`
 * (`packages/analytics/node.ts` then exposes no `isFeatureEnabled` at all) and a
 * flag key the project has not defined yet. Leaving this path unbounded would
 * turn either permanent case into one authenticated POST, one compute-target
 * ownership lookup, and one server warn PER EVENT, forever — load shed at
 * exactly the wrong moment. A minute keeps recovery from a real outage prompt
 * while collapsing a permanently-dark deployment to one probe per interval.
 */
export const ANALYTICS_UNAVAILABLE_RECHECK_MS = 60 * 1000;

const ANALYTICS_PATH = "/desktop/analytics";
const LOG_SCOPE = "desktop-analytics-http";

export type DesktopAnalyticsLaneEvent = Omit<
  DesktopAnalyticsEvent,
  keyof ProtocolEnvelope
>;

export type DesktopAnalyticsHttpLaneOptions = SessionFetchOptions & {
  /**
   * Resolves the Code plugin version, sent as
   * {@link DESKTOP_PLUGIN_VERSION_HEADER} so server-side enrichment
   * (`code_plugin_version`) stays in parity with the socket path's
   * hello-derived `getCodePluginVersion()`. This is NOT the Electron app
   * version (that travels as the `desktop_client_version` property).
   */
  getPluginVersion: () => string;
  /**
   * Invoked on HTTP 401 (early token revocation/rotation) so the owner drops
   * its cached access token and the next send presents a fresh credential.
   */
  onUnauthorized?: () => void;
  /**
   * Clock for the bounded recheck windows. Injected so they are exercised by
   * advancing a value rather than by waiting.
   */
  now?: () => number;
};

/**
 * ISS-10503 (PRD-736 D5): per-send options for the authenticated path. When
 * `aliasDistinctId` is set, the POST body carries the envelope `distinctId` —
 * the pre-auth onboarding id the server aliases to the authenticated person.
 * `onAliasDelivered` fires only on an ack whose `aliased` field attests the
 * merge (PR #7768 review: a `captured: true` alone survives an alias failure,
 * and a pre-#7768 API never aliases), so the caller keeps re-presenting the id
 * until the handshake is known to have happened.
 */
export type DesktopAnalyticsSendOptions = {
  /** Identity-bound readiness buffers can survive compatible session refreshes. */
  canStillSend?: () => boolean;
  aliasDistinctId?: string;
  onAliasDelivered?: () => void;
};

export type DesktopAnalyticsHttpLane = {
  /** Fire-and-forget send of one analytics event; never throws. */
  send(
    event: DesktopAnalyticsLaneEvent,
    computeTargetId: string,
    sendOptions?: DesktopAnalyticsSendOptions
  ): void;
  /**
   * ISS-10503 (PRD-736 D5): fire-and-forget UNAUTHENTICATED send — no session
   * token, no compute-target id. `distinctId` (the attempt-scoped onboarding id
   * or the install's node_uuid, both v4 UUIDs) travels envelope-level and
   * becomes the PostHog person server-side. Every failure is a best-effort
   * DROP: a 401/403/404 here is version skew or the edge kill switch, never a
   * session-token problem, so `onUnauthorized` is deliberately not invoked.
   */
  sendPreAuth(event: DesktopAnalyticsLaneEvent, distinctId: string): void;
  /** Awaits in-flight sends, bounded by `timeoutMs` (shutdown flush). */
  flush(options: { timeoutMs: number }): Promise<void>;
  /**
   * Clears any suppression window immediately so the next send re-evaluates the
   * per-`clerkUserId` analytics gate without waiting the window out. Wired to
   * desktop auth-session changes (sign-in/sign-out/re-auth) — the HTTP lane's
   * session boundary — so a feature-disabled verdict for one user never pins
   * analytics off for the next user in the same process.
   */
  resetForSession(): void;
};

export function createDesktopAnalyticsHttpLane(
  options: DesktopAnalyticsHttpLaneOptions
): DesktopAnalyticsHttpLane {
  const now = options.now ?? Date.now;
  let suppressedUntilMs: number | null = null;
  /**
   * Bumped by every {@link DesktopAnalyticsHttpLane.resetForSession}. A send
   * captures the value it started under so a verdict that lands after the auth
   * session already moved on cannot latch the next user's lane.
   */
  let sessionGeneration = 0;
  let sessionAbort = new AbortController();
  /**
   * True while the one probe allowed out of a lapsed suppression window is
   * still in flight. Without it a burst arriving after expiry each starts its
   * own POST, because suppression is only restored asynchronously when the
   * first response lands — which is precisely the load the window exists to
   * shed.
   */
  let recheckInFlight = false;
  const inFlight = new Set<Promise<void>>();

  const deliver = async (
    event: DesktopAnalyticsLaneEvent,
    computeTargetId: string,
    generation: number,
    sendOptions?: DesktopAnalyticsSendOptions
  ): Promise<void> => {
    const path = `${ANALYTICS_PATH}?computeTargetId=${encodeURIComponent(computeTargetId)}`;
    const pluginVersion = options.getPluginVersion();
    const requestBody = sendOptions?.aliasDistinctId
      ? { ...event, distinctId: sendOptions.aliasDistinctId }
      : event;
    const outcome = await postSessionJson(options, path, requestBody, {
      headers: pluginVersion
        ? { [DESKTOP_PLUGIN_VERSION_HEADER]: pluginVersion }
        : undefined,
      timeoutMs: ANALYTICS_HTTP_REQUEST_TIMEOUT_MS,
      // A queued event carries its original identity through compatible refreshes.
      // Ordinary sends retain the lane's stricter session-generation boundary.
      canStillSend:
        sendOptions?.canStillSend ?? (() => generation === sessionGeneration),
      signal: sendOptions?.canStillSend ? undefined : sessionAbort.signal,
    });

    // Shared pre-terminal dispatch (timeout / no-server / 401 / 404-405 all
    // best-effort DROP); `null` means it was fully handled.
    const response = resolveSessionPostOutcome(outcome, {
      onUnauthorized: options.onUnauthorized,
      onTimeoutDrop: () =>
        gatewayLog.debug(
          LOG_SCOPE,
          "desktop analytics POST timed out; dropping best-effort event"
        ),
    });
    if (!response) {
      return;
    }

    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      settleCapturedResponse(body, sendOptions);
      return;
    }

    const code = extractApiErrorCode(body);
    const suppression = resolveSuppressionVerdict(response.status, code);
    if (suppression) {
      // A verdict is only about the session that asked for it. This POST can
      // settle after `resetForSession()` has moved the lane to a new auth
      // session, and latching then would let the previous user's answer pin the
      // next user's analytics off for the whole window.
      if (generation === sessionGeneration) {
        suppressedUntilMs = now() + suppression.windowMs;
        gatewayLog.debug(LOG_SCOPE, suppression.message);
      }
      return;
    }
    gatewayLog.debug(
      LOG_SCOPE,
      `desktop analytics POST rejected: status=${response.status} code=${code ?? "none"}`
    );
  };

  // ISS-10503 (PRD-736 D5): the unauthenticated twin of `deliver`. No session
  // token, no compute-target id, no suppression interplay — the latching
  // verdicts (`feature_disabled` / `analytics_unavailable`) are per-user
  // answers of the authenticated lane, and a pre-auth 4xx is version skew or
  // the edge kill switch, both of which drop silently.
  const deliverPreAuth = async (
    event: DesktopAnalyticsLaneEvent,
    distinctId: string
  ): Promise<void> => {
    const apiOrigin = options.getApiOrigin();
    if (!apiOrigin) {
      return;
    }
    const pluginVersion = options.getPluginVersion();
    const response = await (options.fetch ?? fetch)(
      new URL(ANALYTICS_PATH, apiOrigin),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(pluginVersion
            ? { [DESKTOP_PLUGIN_VERSION_HEADER]: pluginVersion }
            : {}),
        },
        body: JSON.stringify({ ...event, distinctId }),
        signal: AbortSignal.timeout(ANALYTICS_HTTP_REQUEST_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      gatewayLog.debug(
        LOG_SCOPE,
        `desktop analytics pre-auth POST rejected: status=${response.status}`
      );
    }
  };

  return {
    send(event, computeTargetId, sendOptions) {
      let isRecheckProbe = false;
      if (suppressedUntilMs !== null) {
        if (now() < suppressedUntilMs) {
          return;
        }
        // The window lapsed. Exactly ONE event becomes the probe that re-asks;
        // every other event in the same burst still drops, which is what keeps
        // a permanently-unavailable API to one ownership lookup, flag
        // evaluation and server warn per interval instead of per event. The
        // lapsed window deliberately stays set until the probe settles — it is
        // what makes those other events drop.
        if (recheckInFlight) {
          return;
        }
        recheckInFlight = true;
        isRecheckProbe = true;
      }
      const generation = sessionGeneration;
      const sendPromise = deliver(
        event,
        computeTargetId,
        generation,
        sendOptions
      )
        .catch((error) => {
          gatewayLog.debug(
            LOG_SCOPE,
            `desktop analytics POST failed unexpectedly: ${String(error)}`
          );
        })
        .finally(() => {
          inFlight.delete(sendPromise);
          if (!(isRecheckProbe && generation === sessionGeneration)) {
            return;
          }
          recheckInFlight = false;
          // The probe settled. A re-rejection already moved the window forward
          // through `latchSuppression`; anything still at or behind the clock
          // is the lapsed window this probe was sent to test, so clearing it is
          // what lets the lane resume normal sending.
          if (suppressedUntilMs !== null && now() >= suppressedUntilMs) {
            suppressedUntilMs = null;
          }
        });
      inFlight.add(sendPromise);
    },
    sendPreAuth(event, distinctId) {
      const sendPromise = deliverPreAuth(event, distinctId)
        .catch((error) => {
          gatewayLog.debug(
            LOG_SCOPE,
            `desktop analytics pre-auth POST failed: ${String(error)}`
          );
        })
        .finally(() => {
          inFlight.delete(sendPromise);
        });
      inFlight.add(sendPromise);
    },
    resetForSession() {
      suppressedUntilMs = null;
      recheckInFlight = false;
      sessionGeneration += 1;
      const previousSession = sessionAbort;
      sessionAbort = new AbortController();
      previousSession.abort();
    },
    async flush(flushOptions) {
      if (inFlight.size === 0) {
        return;
      }
      // The timeout timer is cleared once the race settles so a bounded flush
      // never leaves a dangling timer behind.
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, flushOptions.timeoutMs);
      });
      try {
        await Promise.race([
          Promise.allSettled([...inFlight]).then(() => undefined),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * ISS-10503 (PR #7768 review): settles a 2xx capture ack. Only an ack that
 * attests the MERGE (`aliased: true`) clears the pending-alias latch — the
 * handler survives an alias failure and still answers `captured: true`, and a
 * pre-#7768 API answers with no `aliased` at all (it never aliases, so
 * re-presenting against it is correct).
 */
function settleCapturedResponse(
  body: unknown,
  sendOptions?: DesktopAnalyticsSendOptions
): void {
  const parsed = desktopAnalyticsCaptureApiResultValidator.safeParse(body);
  if (!(parsed.success && parsed.data.success === true)) {
    gatewayLog.debug(
      LOG_SCOPE,
      "desktop analytics POST returned a 2xx with an unexpected body; dropping best-effort event"
    );
    return;
  }
  if (parsed.data.data.aliased === true) {
    sendOptions?.onAliasDelivered?.();
  }
}

/** A suppression window a rejected response earns, with the line to log for it. */
type SuppressionVerdict = { windowMs: number; message: string };

/**
 * Which coded rejections open a suppression window, and for how long.
 *
 * Extracted from `deliver` so the send path stays under the cognitive-complexity
 * ceiling, and because "which rejection earns a window" is the one part of that
 * path a reader comes here to check. Both entries dispatch on code AND status,
 * per the contract stated on `DesktopAnalyticsRestErrorCode`; neither reads a
 * status alone, and the codes are shared with 403 `target_not_owned` and 500
 * `internal_error` respectively, so a status-only test would latch on the wrong
 * failure.
 */
function resolveSuppressionVerdict(
  status: number,
  code: string | null
): SuppressionVerdict | null {
  if (
    status === 403 &&
    code === DesktopAnalyticsRestErrorCode.FeatureDisabled
  ) {
    return {
      windowMs: ANALYTICS_FEATURE_DISABLED_RECHECK_MS,
      message: `desktop analytics disabled for this user by the server relay flag; suppressing sends for ${ANALYTICS_FEATURE_DISABLED_RECHECK_MS}ms`,
    };
  }
  if (
    status === 503 &&
    code === DesktopAnalyticsRestErrorCode.AnalyticsUnavailable
  ) {
    // No rollout verdict was learned, so this must NOT be treated as a disabled
    // verdict — but it still has to be bounded, because the unanswered state
    // can be permanent.
    return {
      windowMs: ANALYTICS_UNAVAILABLE_RECHECK_MS,
      message: `desktop analytics feature flag was unavailable server-side; retrying in ${ANALYTICS_UNAVAILABLE_RECHECK_MS}ms`,
    };
  }
  return null;
}
