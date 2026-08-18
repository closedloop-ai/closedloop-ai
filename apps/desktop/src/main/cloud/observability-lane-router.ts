/**
 * @file observability-lane-router.ts
 * @description FEA-3425 (PLN-1437 Phase 3): the write-lane routing for the two
 * best-effort observability lanes — product analytics (`desktop.analytics`) and
 * diagnostics telemetry (`desktop.telemetry`). Owns the two authenticated HTTP
 * twins and the bounded shutdown drain, kept off the application god-object so
 * the next observability lane lands here, not in `app.ts`.
 *
 * HTTP-only since PLN-1437 Phase 4a: the legacy relay-socket fallback was
 * retired once session coverage cleared the D7 no-strand gate. An event is sent
 * over the HTTP twin when a first-party session is live and the socket-derived
 * compute-target identity is known; otherwise it is a best-effort DROP (matching
 * the retired socket lane's silent drop on disconnect). The HTTP twins own the
 * per-outcome durability policy; this router only gates the send and orders the
 * shutdown drain.
 */
import type { SessionFetchOptions } from "../util/api-response-utils.js";
import {
  createDesktopAnalyticsHttpLane,
  type DesktopAnalyticsLaneEvent,
} from "./desktop-analytics-http-lane.js";
import {
  createDesktopTelemetryHttpClient,
  type DesktopTelemetryLaneEvent,
} from "./desktop-telemetry-http-client.js";

export type ObservabilityLaneRouterOptions = SessionFetchOptions & {
  /**
   * Resolves the Code plugin version for the `x-desktop-plugin-version` header
   * on every HTTP write, kept in parity with the socket path's hello-derived
   * value. NOT the Electron app version.
   */
  getPluginVersion: () => string;
  /**
   * Invoked on HTTP 401 so the owner drops its cached access token and the next
   * send presents a fresh credential. Shared by both HTTP twins.
   */
  onUnauthorized: () => void;
  /**
   * Live HTTP-transport readiness — the same predicate Lane 1 uses
   * (`isHttpAgentSessionSyncReady`), passed in so the observability lanes stay
   * on the single readiness rule rather than duplicating it. When false, sends
   * are best-effort dropped.
   */
  isHttpReady: () => boolean;
  /** Socket-derived compute-target identity, or null when the cloud is offline. */
  getComputeTargetId: () => string | null;
};

export type ObservabilityLaneRouter = {
  /** Send one product-analytics event over the HTTP twin, or drop it. */
  sendAnalytics(event: DesktopAnalyticsLaneEvent): void;
  /** Bounded shutdown drain of the analytics HTTP twin's in-flight sends. */
  flushAnalytics(options: { timeoutMs: number }): Promise<void>;
  /** Send one diagnostics-telemetry event over the HTTP twin, or drop it. */
  sendTelemetry(event: DesktopTelemetryLaneEvent): void;
  /** Bounded shutdown drain of the telemetry HTTP twin's in-flight sends. */
  flushTelemetry(options: { timeoutMs: number }): Promise<void>;
  /**
   * Clear the analytics HTTP twin's `feature_disabled` latch so the next send
   * re-evaluates the per-`clerkUserId` gate. Wire to desktop auth-session
   * changes so a disabled verdict for one user never pins analytics off for the
   * next.
   */
  resetForSession(): void;
};

export function createObservabilityLaneRouter(
  options: ObservabilityLaneRouterOptions
): ObservabilityLaneRouter {
  const laneFetch: SessionFetchOptions & {
    getPluginVersion: () => string;
    onUnauthorized: () => void;
  } = {
    fetch: options.fetch,
    getAccessToken: options.getAccessToken,
    getApiOrigin: options.getApiOrigin,
    getPluginVersion: options.getPluginVersion,
    onUnauthorized: options.onUnauthorized,
  };
  const analyticsLane = createDesktopAnalyticsHttpLane(laneFetch);
  const telemetryClient = createDesktopTelemetryHttpClient(laneFetch);

  // The send gate: a live session + a known socket-derived identity. Otherwise
  // the event is best-effort dropped (no socket fallback since Phase 4a).
  const readyTargetId = (): string | null => {
    const computeTargetId = options.getComputeTargetId();
    return options.isHttpReady() && computeTargetId ? computeTargetId : null;
  };

  return {
    sendAnalytics(event) {
      const computeTargetId = readyTargetId();
      if (computeTargetId) {
        analyticsLane.send(event, computeTargetId);
      }
    },
    flushAnalytics(flushOptions) {
      return analyticsLane.flush(flushOptions);
    },
    sendTelemetry(event) {
      const computeTargetId = readyTargetId();
      if (computeTargetId) {
        // Fire-and-forget: the client's returned promise never rejects (it is
        // exposed only so tests and flush can synchronize); telemetry keeps its
        // best-effort class. The `.catch` is a floating-promise guard, not a
        // real error path.
        telemetryClient.send(event, computeTargetId).catch(() => undefined);
      }
    },
    flushTelemetry(flushOptions) {
      return telemetryClient.flush(flushOptions);
    },
    resetForSession() {
      analyticsLane.resetForSession();
    },
  };
}
