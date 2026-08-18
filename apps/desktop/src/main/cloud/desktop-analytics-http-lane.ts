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
 * - coded 403 `feature_disabled` → latch: drop this and every later event until
 *   the desktop auth session changes (`resetForSession`), then re-evaluate the
 *   per-`clerkUserId` gate on the next send
 * - any other server-answered rejection (400/403/413/429/5xx) → DROP with a
 *   debug log
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
};

export type DesktopAnalyticsHttpLane = {
  /** Fire-and-forget send of one analytics event; never throws. */
  send(event: DesktopAnalyticsLaneEvent, computeTargetId: string): void;
  /** Awaits in-flight sends, bounded by `timeoutMs` (shutdown flush). */
  flush(options: { timeoutMs: number }): Promise<void>;
  /**
   * Clears the `feature_disabled` latch so the next send re-evaluates the
   * per-`clerkUserId` analytics gate. Wired to desktop auth-session changes
   * (sign-in/sign-out/re-auth) — the HTTP lane's session boundary — so a
   * feature-disabled verdict for one user never pins analytics off for the next
   * user in the same process.
   */
  resetForSession(): void;
};

export function createDesktopAnalyticsHttpLane(
  options: DesktopAnalyticsHttpLaneOptions
): DesktopAnalyticsHttpLane {
  let disabledForSession = false;
  const inFlight = new Set<Promise<void>>();

  const deliver = async (
    event: DesktopAnalyticsLaneEvent,
    computeTargetId: string
  ): Promise<void> => {
    const path = `${ANALYTICS_PATH}?computeTargetId=${encodeURIComponent(computeTargetId)}`;
    const pluginVersion = options.getPluginVersion();
    const outcome = await postSessionJson(options, path, event, {
      headers: pluginVersion
        ? { [DESKTOP_PLUGIN_VERSION_HEADER]: pluginVersion }
        : undefined,
      timeoutMs: ANALYTICS_HTTP_REQUEST_TIMEOUT_MS,
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
      const parsed = desktopAnalyticsCaptureApiResultValidator.safeParse(body);
      if (!(parsed.success && parsed.data.success === true)) {
        gatewayLog.debug(
          LOG_SCOPE,
          "desktop analytics POST returned a 2xx with an unexpected body; dropping best-effort event"
        );
      }
      return;
    }

    const code = extractApiErrorCode(body);
    if (
      response.status === 403 &&
      code === DesktopAnalyticsRestErrorCode.FeatureDisabled
    ) {
      disabledForSession = true;
      return;
    }
    gatewayLog.debug(
      LOG_SCOPE,
      `desktop analytics POST rejected: status=${response.status} code=${code ?? "none"}`
    );
  };

  return {
    send(event, computeTargetId) {
      if (disabledForSession) {
        return;
      }
      const sendPromise = deliver(event, computeTargetId)
        .catch((error) => {
          gatewayLog.debug(
            LOG_SCOPE,
            `desktop analytics POST failed unexpectedly: ${String(error)}`
          );
        })
        .finally(() => {
          inFlight.delete(sendPromise);
        });
      inFlight.add(sendPromise);
    },
    resetForSession() {
      disabledForSession = false;
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
