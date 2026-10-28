/**
 * Keyless telemetry over HTTPS (ISS-12211, ISS-11866 R1a).
 *
 * Ships the same opaque OTLP protobuf bodies as the relay transport, as plain
 * POSTs to the API host's `/desktop/otlp/v1/{signal}` route, which forwards
 * them unchanged to the Collector. No credential is sent: the install id rides
 * the shared attribution header, which keys the route's per-install budget.
 *
 * Version skew (AGENTS.md Cross-Repo Compatibility): an API deployment that
 * does not serve the route answers 404. The first 404 hands this export, and
 * every later one for the life of the process, to the relay `/telemetry`
 * transport, which is started only then. The counters stay one ledger across
 * that switch: `getDiagnostics()` sums both transports, and an export is
 * counted by whichever transport finally sent or dropped it.
 *
 * Best-effort and crash-safe like the relay transport: nothing here throws.
 */

import { buildDesktopClientAttributionHeaders } from "@repo/api/src/types/desktop-client-attribution";
import {
  KEYLESS_TELEMETRY_API_ROUTE_PREFIX,
  KEYLESS_TELEMETRY_COLLECTOR_TIMEOUT_MS,
  KEYLESS_TELEMETRY_CONTENT_TYPE,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  keylessTelemetrySignalPath,
} from "@repo/shared-platform/keyless-telemetry";
import { gatewayLog } from "../logging/gateway-logger.js";
import { normalizeAndValidateOrigin } from "../settings/origin-policy.js";
import {
  DEFAULT_SHUTDOWN_DRAIN_MS,
  laterCooldownDeadline,
  type RelayTelemetrySignal,
  type RelayTelemetryTransportDiagnostics,
  type RelayTelemetryTransportHandle,
  type TelemetrySessionContext,
} from "./relay-telemetry-transport.js";

const LOG_TAG = "telemetry-api";

/**
 * The route spends up to the Collector forward's bound answering, so the client
 * waits twice that before counting the export as unanswered.
 */
export const REQUEST_TIMEOUT_MS = KEYLESS_TELEMETRY_COLLECTOR_TIMEOUT_MS * 2;

const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;

export type CreateApiOtlpTelemetryTransportOptions = {
  getApiOrigin: () => string;
  /** The relay `/telemetry` transport, started only once the route answers 404. */
  fallback: RelayTelemetryTransportHandle;
  fetchFn?: typeof fetch;
  now?: () => number;
  shutdownDrainMs?: number;
};

type Counters = Omit<
  RelayTelemetryTransportDiagnostics,
  "connected" | "hasSession" | "inCooldown" | "warmUpQueueDepth"
>;

export function createApiOtlpTelemetryTransport(
  options: CreateApiOtlpTelemetryTransportOptions
): RelayTelemetryTransportHandle {
  return new ApiOtlpTelemetryTransport(options);
}

class ApiOtlpTelemetryTransport implements RelayTelemetryTransportHandle {
  private readonly options: CreateApiOtlpTelemetryTransportOptions;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly inFlightExports = new Set<Promise<boolean>>();
  private context: TelemetrySessionContext | null = null;
  private stopped = true;
  private usingFallback = false;
  private cooldownUntil = 0;
  private readonly counters: Counters = {
    sent: 0,
    droppedOversize: 0,
    droppedNoSession: 0,
    droppedRateLimited: 0,
    droppedCollectorUnavailable: 0,
    droppedInvalid: 0,
  };

  constructor(options: CreateApiOtlpTelemetryTransportOptions) {
    this.options = options;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  start(context: TelemetrySessionContext): void {
    this.stopped = false;
    this.context = context;
    if (this.usingFallback) {
      this.options.fallback.start(context);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.drainPendingExports();
    this.context = null;
    if (this.usingFallback) {
      await this.options.fallback.stop();
    }
  }

  async flush(): Promise<void> {
    await this.drainPendingExports();
    if (this.usingFallback) {
      await this.options.fallback.flush();
    }
  }

  export(signal: RelayTelemetrySignal, body: Uint8Array): Promise<boolean> {
    const pending = this.runExport(signal, body).catch(() => false);
    this.inFlightExports.add(pending);
    pending
      .finally(() => this.inFlightExports.delete(pending))
      .catch(() => undefined);
    return pending;
  }

  getDiagnostics(): RelayTelemetryTransportDiagnostics {
    const own: RelayTelemetryTransportDiagnostics = {
      connected: false,
      hasSession: false,
      inCooldown: this.now() < this.cooldownUntil,
      warmUpQueueDepth: 0,
      ...this.counters,
    };
    if (!this.usingFallback) {
      return own;
    }
    const relay = this.options.fallback.getDiagnostics();
    return {
      ...relay,
      sent: relay.sent + own.sent,
      droppedOversize: relay.droppedOversize + own.droppedOversize,
      droppedNoSession: relay.droppedNoSession + own.droppedNoSession,
      droppedRateLimited: relay.droppedRateLimited + own.droppedRateLimited,
      droppedCollectorUnavailable:
        relay.droppedCollectorUnavailable + own.droppedCollectorUnavailable,
      droppedInvalid: relay.droppedInvalid + own.droppedInvalid,
    };
  }

  private async runExport(
    signal: RelayTelemetrySignal,
    body: Uint8Array
  ): Promise<boolean> {
    const context = this.context;
    if (this.stopped || !context) {
      return false;
    }
    if (this.usingFallback) {
      return this.options.fallback.export(signal, body);
    }
    if (body.byteLength > KEYLESS_TELEMETRY_MAX_BODY_BYTES) {
      this.counters.droppedOversize += 1;
      return false;
    }
    if (this.now() < this.cooldownUntil) {
      this.counters.droppedRateLimited += 1;
      return false;
    }

    let origin: string;
    try {
      origin = normalizeAndValidateOrigin(this.options.getApiOrigin());
    } catch {
      return this.exportThroughFallback(signal, body);
    }

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchFn(
        `${origin}${KEYLESS_TELEMETRY_API_ROUTE_PREFIX}${keylessTelemetrySignalPath(signal)}`,
        {
          method: "POST",
          headers: {
            ...buildDesktopClientAttributionHeaders({
              installationId: context.appInstallationId,
              clientVersion: context.serviceVersion,
            }),
            "content-type": KEYLESS_TELEMETRY_CONTENT_TYPE,
          },
          // A copy narrows the backing buffer to the ArrayBuffer fetch takes.
          body: new Uint8Array(body),
          signal: timeout,
        }
      );
    } catch {
      if (timeout.aborted) {
        // Sent but unanswered: the relay lane's no-ack case.
        this.applyCooldown(null);
        this.counters.droppedCollectorUnavailable += 1;
      } else {
        // Unreachable (offline, asleep): the relay lane's no-socket case.
        this.counters.droppedNoSession += 1;
      }
      return false;
    }
    response.body?.cancel().catch(() => undefined);
    return this.settle(response, signal, body);
  }

  private settle(
    response: Response,
    signal: RelayTelemetrySignal,
    body: Uint8Array
  ): Promise<boolean> | boolean {
    if (response.ok) {
      this.counters.sent += 1;
      return true;
    }
    if (response.status === HTTP_NOT_FOUND) {
      return this.exportThroughFallback(signal, body);
    }
    if (response.status === HTTP_TOO_MANY_REQUESTS) {
      this.applyCooldown(response.headers.get("retry-after"));
      this.counters.droppedRateLimited += 1;
      return false;
    }
    if (response.status >= HTTP_SERVER_ERROR_MIN) {
      this.applyCooldown(response.headers.get("retry-after"));
      this.counters.droppedCollectorUnavailable += 1;
      return false;
    }
    // 400 / 403 / 413: a client- or content-side refusal a retry won't fix.
    this.counters.droppedInvalid += 1;
    return false;
  }

  private exportThroughFallback(
    signal: RelayTelemetrySignal,
    body: Uint8Array
  ): Promise<boolean> {
    if (!this.usingFallback) {
      this.usingFallback = true;
      gatewayLog.debug(
        LOG_TAG,
        () => "keyless telemetry route not served; using the relay lane"
      );
      if (this.context && !this.stopped) {
        this.options.fallback.start(this.context);
      }
    }
    return this.options.fallback.export(signal, body);
  }

  private applyCooldown(retryAfter: string | null): void {
    this.cooldownUntil = laterCooldownDeadline(
      this.cooldownUntil,
      this.now(),
      Number(retryAfter)
    );
  }

  /** Let in-flight exports settle, capped so quit never waits on the network. */
  private async drainPendingExports(): Promise<void> {
    if (this.inFlightExports.size === 0) {
      return;
    }
    await Promise.race([
      Promise.allSettled([...this.inFlightExports]),
      new Promise<void>((resolve) => {
        setTimeout(
          resolve,
          this.options.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS
        ).unref?.();
      }),
    ]);
  }
}
