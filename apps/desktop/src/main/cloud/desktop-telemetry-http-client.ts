/**
 * @file desktop-telemetry-http-client.ts
 * @description FEA-3425 (PLN-1437 Phase 3): HTTP transport for the
 * fire-and-forget diagnostics-telemetry lane. Posts the same event payload the
 * relay socket used to carry (`desktop.telemetry`) to `POST /desktop/telemetry`,
 * authenticated with the first-party Desktop session token. The socket lane was
 * ack-less fire-and-forget (a disconnected socket silently dropped), and this
 * twin keeps that best-effort durability class.
 *
 * Best-effort since PLN-1437 Phase 4a: the socket fallback was retired once
 * session coverage cleared, so every non-terminal outcome is a DROP. Telemetry
 * carries no idempotency key, so a re-send would duplicate the Datadog line —
 * the lane never retries.
 * - no session token / no valid origin / connection-level failure → DROP
 *   (never reached the server)
 * - HTTP 401 → `onUnauthorized` (invalidate the cached token) + DROP
 * - HTTP 404/405 → DROP (the API deployment predates the route — version skew)
 * - abort timeout or any other server-answered rejection → DROP with a debug log
 */
import { DESKTOP_PLUGIN_VERSION_HEADER } from "@repo/api/src/types/desktop-write-lane";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { DesktopTelemetryEvent } from "../telemetry/telemetry-protocol.js";
import type { SessionFetchOptions } from "../util/api-response-utils.js";
import {
  postSessionJson,
  resolveSessionPostOutcome,
} from "../util/api-response-utils.js";
import type { ProtocolEnvelope } from "./cloud-protocol.js";

export const TELEMETRY_HTTP_REQUEST_TIMEOUT_MS = 10_000;

const TELEMETRY_PATH = "/desktop/telemetry";
const LOG_SCOPE = "desktop-telemetry-http";

export type DesktopTelemetryLaneEvent = Omit<
  DesktopTelemetryEvent,
  keyof ProtocolEnvelope
>;

export type DesktopTelemetryHttpClientOptions = SessionFetchOptions & {
  /**
   * Resolves the Code plugin version, sent as
   * {@link DESKTOP_PLUGIN_VERSION_HEADER} so telemetry trace enrichment
   * (`pluginVersion`) stays in parity with the socket path's hello-derived
   * `getCodePluginVersion()`.
   */
  getPluginVersion: () => string;
  /**
   * Invoked on HTTP 401 (early token revocation/rotation) so the owner drops
   * its cached access token and the next send presents a fresh credential.
   */
  onUnauthorized?: () => void;
};

export type DesktopTelemetryHttpClient = {
  /**
   * Fire-and-forget send of one telemetry event; the returned promise never
   * rejects and callers ignore it — it exists so tests and {@link flush} can
   * synchronize on the settled outcome instead of polling.
   */
  send(
    event: DesktopTelemetryLaneEvent,
    computeTargetId: string
  ): Promise<void>;
  /**
   * Awaits in-flight sends, bounded by `timeoutMs` — the shutdown drain, so a
   * telemetry POST issued just before quit is not abandoned mid-flight. Does
   * not cover events emitted *after* the drain (e.g. shutdown-failure
   * telemetry), which the fire-and-forget socket path never guaranteed either.
   */
  flush(options: { timeoutMs: number }): Promise<void>;
};

export function createDesktopTelemetryHttpClient(
  options: DesktopTelemetryHttpClientOptions
): DesktopTelemetryHttpClient {
  const inFlight = new Set<Promise<void>>();

  const deliver = async (
    event: DesktopTelemetryLaneEvent,
    computeTargetId: string
  ): Promise<void> => {
    const path = `${TELEMETRY_PATH}?computeTargetId=${encodeURIComponent(computeTargetId)}`;
    const pluginVersion = options.getPluginVersion();
    const outcome = await postSessionJson(options, path, event, {
      headers: pluginVersion
        ? { [DESKTOP_PLUGIN_VERSION_HEADER]: pluginVersion }
        : undefined,
      timeoutMs: TELEMETRY_HTTP_REQUEST_TIMEOUT_MS,
    });

    // Shared pre-terminal dispatch (timeout / no-server / 401 / 404-405 all
    // best-effort DROP); `null` means it was fully handled.
    const response = resolveSessionPostOutcome(outcome, {
      onUnauthorized: options.onUnauthorized,
      onTimeoutDrop: () =>
        gatewayLog.debug(
          LOG_SCOPE,
          "desktop telemetry POST timed out; dropping fire-and-forget event"
        ),
    });
    if (!response) {
      return;
    }
    if (!response.ok) {
      gatewayLog.debug(
        LOG_SCOPE,
        `desktop telemetry POST rejected: status=${response.status}`
      );
    }
  };

  return {
    send(event, computeTargetId) {
      const sendPromise = deliver(event, computeTargetId)
        .catch((error) => {
          gatewayLog.debug(
            LOG_SCOPE,
            `desktop telemetry POST failed unexpectedly: ${String(error)}`
          );
        })
        .finally(() => {
          inFlight.delete(sendPromise);
        });
      inFlight.add(sendPromise);
      return sendPromise;
    },
    async flush(flushOptions) {
      if (inFlight.size === 0) {
        return;
      }
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
