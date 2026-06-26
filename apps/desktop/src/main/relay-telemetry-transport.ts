/**
 * Keyless telemetry transport (FEA-1993 / PRD-481 C5).
 *
 * Owns a dedicated, UNAUTHENTICATED Socket.IO connection to the relay's
 * `/telemetry` namespace and ships OTLP protobuf bodies over it. It is fully
 * independent of `CloudSocketService` (`./cloud-socket.ts`): a second, isolated
 * WebSocket to the **same relay origin** — never a direct desktop→Collector
 * egress (the relay forwards the opaque body to the Collector). This keeps the
 * gateway's auth/PoP/command path untouched while still routing all telemetry
 * through the operator-controlled relay.
 *
 * Lifecycle: the desktop OTel runtime (FEA-1983) calls `start(context)` with
 * the resolved resource identity, the SDK's exporters call `export(...)`, and
 * `stop()` tears the connection down. Everything here is best-effort and
 * crash-safe — every failure path is swallowed so telemetry can never affect
 * app behavior (mirrors the runtime's exception-emit discipline and the
 * desktop "optional capture must not crash its owner" rule).
 */

import {
  KEYLESS_TELEMETRY_CONTENT_TYPE,
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  KEYLESS_TELEMETRY_NAMESPACE,
  KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
  KEYLESS_TELEMETRY_SESSION_TTL_MS,
  type KeylessTelemetryExportAck,
  KeylessTelemetryRejectionReason,
  type KeylessTelemetrySessionAck,
  type KeylessTelemetrySignal,
} from "@repo/shared-platform/keyless-telemetry";
import { io } from "socket.io-client";
import { gatewayLog } from "./gateway-logger.js";
import { normalizeAndValidateOrigin } from "./origin-policy.js";

const LOG_TAG = "telemetry-relay";

/** Default bound for handshake/export acks before we give up on a request. */
const DEFAULT_ACK_TIMEOUT_MS = 5000;
/** Re-handshake this long before the server TTL actually elapses. */
const SESSION_RENEW_MARGIN_MS = 30_000;
/** Bounded warm-up buffer for exports issued before the session is ready. */
const DEFAULT_WARM_UP_QUEUE_LIMIT = 8;
/**
 * Grace window for stop() to let in-flight exports (e.g. the final
 * `app.lifecycle` shutdown event) reach the relay before the socket is torn
 * down. Bounded so a degraded relay can never delay app quit by more than this.
 */
const DEFAULT_SHUTDOWN_DRAIN_MS = 1500;

/** OTLP signal kind carried by an export, mirrors the relay contract. */
export type RelayTelemetrySignal = KeylessTelemetrySignal;

/** Self-asserted resource identity sent in the keyless handshake. */
export type TelemetrySessionContext = {
  appInstallationId: string;
  serviceVersion?: string;
  deploymentEnvironmentName?: string;
};

/**
 * Narrow surface the OTel runtime depends on. Keeping it minimal lets the
 * runtime accept a stub in tests and keeps the exporter↔transport seam tiny.
 */
export type DesktopTelemetryTransport = {
  start: (context: TelemetrySessionContext) => void;
  /**
   * Bounded-drain in-flight exports, then disconnect. Returns a promise the
   * runtime awaits so the final shutdown batch has a chance to reach the relay;
   * the drain is time-capped so quit is never blocked on a degraded relay.
   */
  stop: () => void | Promise<void>;
  export: (signal: RelayTelemetrySignal, body: Uint8Array) => Promise<boolean>;
};

/** The subset of a Socket.IO client socket this transport actually uses. */
export type TelemetrySocketLike = {
  readonly connected: boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  emit: (event: string, ...args: unknown[]) => unknown;
  disconnect: () => unknown;
  removeAllListeners: () => unknown;
};

export type TelemetryConnectFn = (url: string) => TelemetrySocketLike;

export type RelayTelemetryTransportDiagnostics = {
  connected: boolean;
  hasSession: boolean;
  inCooldown: boolean;
  warmUpQueueDepth: number;
  sent: number;
  droppedOversize: number;
  droppedNoSession: number;
  droppedRateLimited: number;
  droppedCollectorUnavailable: number;
  droppedInvalid: number;
};

/**
 * The transport plus a read-only health accessor. The OTel runtime only needs
 * {@link DesktopTelemetryTransport}; `getDiagnostics` exposes the bounded
 * send/drop counters for support bundles and tests (drops are otherwise silent
 * best-effort).
 */
export type RelayTelemetryTransportHandle = DesktopTelemetryTransport & {
  getDiagnostics: () => RelayTelemetryTransportDiagnostics;
};

export type CreateRelayTelemetryTransportOptions = {
  getRelayOrigin: () => string;
  /** Injectable for tests; defaults to a websocket-only socket.io connection. */
  connectFn?: TelemetryConnectFn;
  /** Injectable clock for deterministic TTL/cooldown tests. */
  now?: () => number;
  /** Injectable timer for deterministic ack-timeout tests. */
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  ackTimeoutMs?: number;
  warmUpQueueLimit?: number;
  /** Grace window for stop() to drain in-flight exports before disconnecting. */
  shutdownDrainMs?: number;
  log?: { warn: (message: string) => void; debug: (message: string) => void };
};

type ActiveSession = {
  sessionId: string;
  maxBodyBytes: number;
  /** Local time after which the session is treated as stale (renew margin applied). */
  renewAt: number;
};

type WarmUpEntry = { signal: RelayTelemetrySignal; body: Uint8Array };

type Counters = {
  sent: number;
  droppedOversize: number;
  droppedNoSession: number;
  droppedRateLimited: number;
  droppedCollectorUnavailable: number;
  droppedInvalid: number;
};

export function createRelayTelemetryTransport(
  options: CreateRelayTelemetryTransportOptions
): RelayTelemetryTransportHandle {
  return new RelayTelemetryTransport(options);
}

class RelayTelemetryTransport implements DesktopTelemetryTransport {
  private readonly options: CreateRelayTelemetryTransportOptions;
  private readonly connectFn: TelemetryConnectFn;
  private readonly now: () => number;
  private readonly ackTimeoutMs: number;
  private readonly warmUpQueueLimit: number;
  private readonly shutdownDrainMs: number;
  /** In-flight export() chains, awaited (time-capped) by stop() before teardown. */
  private readonly inFlightExports = new Set<Promise<boolean>>();
  private readonly log: {
    warn: (message: string) => void;
    debug: (message: string) => void;
  };

  private socket: TelemetrySocketLike | null = null;
  private context: TelemetrySessionContext | null = null;
  private session: ActiveSession | null = null;
  private handshakeInFlight: Promise<ActiveSession | null> | null = null;
  private cooldownUntil = 0;
  private stopped = true;
  private readonly warmUpQueue: WarmUpEntry[] = [];
  private readonly counters: Counters = {
    sent: 0,
    droppedOversize: 0,
    droppedNoSession: 0,
    droppedRateLimited: 0,
    droppedCollectorUnavailable: 0,
    droppedInvalid: 0,
  };

  constructor(options: CreateRelayTelemetryTransportOptions) {
    this.options = options;
    this.connectFn = options.connectFn ?? defaultConnectFn;
    this.now = options.now ?? Date.now;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.warmUpQueueLimit =
      options.warmUpQueueLimit ?? DEFAULT_WARM_UP_QUEUE_LIMIT;
    this.shutdownDrainMs = options.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
    this.log = options.log ?? {
      warn: (message) => gatewayLog.warn(LOG_TAG, message),
      debug: (message) => gatewayLog.debug(LOG_TAG, () => message),
    };
  }

  start(context: TelemetrySessionContext): void {
    try {
      this.stopped = false;
      this.context = context;
      this.disconnectSocket();
      this.session = null;
      this.handshakeInFlight = null;

      let origin: string;
      try {
        origin = normalizeAndValidateOrigin(this.options.getRelayOrigin());
      } catch (error) {
        this.log.warn(
          `keyless telemetry disabled: invalid relay origin (${describeError(error)})`
        );
        return;
      }

      const socket = this.connectFn(`${origin}${KEYLESS_TELEMETRY_NAMESPACE}`);
      this.socket = socket;
      socket.on("connect", () => {
        // A fresh engine connection invalidates any prior session.
        this.session = null;
        this.ensureSession().catch(() => undefined);
      });
      socket.on("disconnect", () => {
        this.session = null;
        this.handshakeInFlight = null;
      });
    } catch (error) {
      this.log.warn(`keyless telemetry start failed: ${describeError(error)}`);
    }
  }

  async stop(): Promise<void> {
    // Stop accepting new exports, then give the in-flight ones (e.g. the final
    // app.lifecycle shutdown event the SDK just flushed) a bounded window to
    // reach the relay before we disconnect. The drain is time-capped so a slow
    // or unreachable relay can never block app quit.
    this.stopped = true;
    this.warmUpQueue.length = 0;
    await this.drainInFlightExports();
    this.session = null;
    this.handshakeInFlight = null;
    this.context = null;
    this.disconnectSocket();
  }

  export(signal: RelayTelemetrySignal, body: Uint8Array): Promise<boolean> {
    // Track the whole export chain so stop() can drain in-flight sends. Added
    // synchronously here (before the first await) so a send started by the SDK's
    // final shutdown flush is visible to a stop() that runs right after.
    const pending = this.runExport(signal, body);
    this.inFlightExports.add(pending);
    pending
      .finally(() => this.inFlightExports.delete(pending))
      .catch(() => {
        // finally() re-raises runExport's settlement; runExport never rejects, so
        // this catch only satisfies the no-floating-promise lint.
      });
    return pending;
  }

  private async runExport(
    signal: RelayTelemetrySignal,
    body: Uint8Array
  ): Promise<boolean> {
    try {
      if (this.stopped) {
        return false;
      }
      if (body.byteLength > this.maxBodyBytes()) {
        this.counters.droppedOversize += 1;
        return false;
      }
      if (this.now() < this.cooldownUntil) {
        this.counters.droppedRateLimited += 1;
        return false;
      }

      const session = await this.ensureSession();
      if (!session) {
        this.enqueueWarmUp(signal, body);
        this.counters.droppedNoSession += 1;
        return false;
      }
      return await this.sendNow(signal, body, session);
    } catch (error) {
      this.log.debug(`keyless telemetry export error: ${describeError(error)}`);
      return false;
    }
  }

  getDiagnostics(): RelayTelemetryTransportDiagnostics {
    return {
      connected: this.socket?.connected ?? false,
      hasSession: this.session !== null,
      inCooldown: this.now() < this.cooldownUntil,
      warmUpQueueDepth: this.warmUpQueue.length,
      ...this.counters,
    };
  }

  private maxBodyBytes(): number {
    return this.session?.maxBodyBytes ?? KEYLESS_TELEMETRY_MAX_BODY_BYTES;
  }

  /**
   * Returns a live session, performing (or awaiting an in-flight) handshake
   * when needed. Returns null when the socket is not connected or the relay
   * declines — callers treat that as "drop / warm-up", never an error.
   */
  private ensureSession(): Promise<ActiveSession | null> {
    if (this.session && this.now() < this.session.renewAt) {
      return Promise.resolve(this.session);
    }
    if (this.handshakeInFlight) {
      return this.handshakeInFlight;
    }
    const socket = this.socket;
    if (!(socket?.connected && this.context)) {
      return Promise.resolve(null);
    }

    const handshake = this.performHandshake(socket, this.context).finally(
      () => {
        this.handshakeInFlight = null;
      }
    );
    this.handshakeInFlight = handshake;
    return handshake;
  }

  private async performHandshake(
    socket: TelemetrySocketLike,
    context: TelemetrySessionContext
  ): Promise<ActiveSession | null> {
    const request: Record<string, string> = {
      appInstallationId: context.appInstallationId,
    };
    if (context.serviceVersion) {
      request.serviceVersion = context.serviceVersion;
    }
    if (context.deploymentEnvironmentName) {
      request.deploymentEnvironmentName = context.deploymentEnvironmentName;
    }

    const ack = await this.emitWithAck<KeylessTelemetrySessionAck>(
      socket,
      KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
      request
    );
    // Async-continuation guard: if stop() ran or the socket was superseded
    // while the handshake ack was in flight, do not resurrect a session or
    // flush the warm-up queue (desktop "must not restart after shutdown" rule).
    if (this.stopped || this.socket !== socket) {
      return null;
    }
    if (ack?.accepted !== true) {
      if (ack?.accepted === false) {
        this.log.debug(`keyless telemetry handshake rejected: ${ack.reason}`);
      }
      return null;
    }

    const ttlMs = Number.isFinite(ack.ttlMs)
      ? ack.ttlMs
      : KEYLESS_TELEMETRY_SESSION_TTL_MS;
    const maxBodyBytes =
      Number.isFinite(ack.maxBodyBytes) && ack.maxBodyBytes > 0
        ? ack.maxBodyBytes
        : KEYLESS_TELEMETRY_MAX_BODY_BYTES;
    // Renew a little early so an export never races the server-side expiry.
    const margin = Math.min(SESSION_RENEW_MARGIN_MS, Math.floor(ttlMs / 2));
    const session: ActiveSession = {
      sessionId: ack.sessionId,
      maxBodyBytes,
      renewAt: this.now() + ttlMs - margin,
    };
    this.session = session;
    this.flushWarmUpQueue(session);
    return session;
  }

  private async sendNow(
    signal: RelayTelemetrySignal,
    body: Uint8Array,
    session: ActiveSession,
    allowRehandshake = true
  ): Promise<boolean> {
    const socket = this.socket;
    if (!socket?.connected) {
      this.enqueueWarmUp(signal, body);
      this.counters.droppedNoSession += 1;
      return false;
    }
    // Re-check against the session-negotiated limit, not just the pre-session
    // default in export(): a warm-up body enqueued before the handshake (or a
    // session that negotiated a smaller cap) could otherwise be sent doomed.
    if (body.byteLength > session.maxBodyBytes) {
      this.counters.droppedOversize += 1;
      return false;
    }

    const ack = await this.emitWithAck<KeylessTelemetryExportAck>(
      socket,
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      {
        sessionId: session.sessionId,
        signal,
        contentType: KEYLESS_TELEMETRY_CONTENT_TYPE,
        body,
      }
    );

    if (ack?.accepted === true) {
      this.counters.sent += 1;
      return true;
    }
    if (!ack) {
      // No ack within the timeout — treat like a transient collector stall.
      this.applyCooldown(KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS);
      this.counters.droppedCollectorUnavailable += 1;
      return false;
    }
    return this.handleRejection(ack, signal, body, allowRehandshake);
  }

  private async handleRejection(
    ack: Extract<KeylessTelemetryExportAck, { accepted: false }>,
    signal: RelayTelemetrySignal,
    body: Uint8Array,
    allowRehandshake: boolean
  ): Promise<boolean> {
    switch (ack.reason) {
      case KeylessTelemetryRejectionReason.InvalidSession: {
        this.session = null;
        if (!allowRehandshake) {
          this.counters.droppedNoSession += 1;
          return false;
        }
        const session = await this.ensureSession();
        if (!session) {
          this.counters.droppedNoSession += 1;
          return false;
        }
        // Retry exactly once on a fresh session to avoid handshake loops.
        return this.sendNow(signal, body, session, false);
      }
      case KeylessTelemetryRejectionReason.RateLimited:
      case KeylessTelemetryRejectionReason.AtCapacity: {
        this.applyCooldown(
          ack.retryAfterSeconds ?? KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS
        );
        this.counters.droppedRateLimited += 1;
        return false;
      }
      case KeylessTelemetryRejectionReason.CollectorUnavailable:
      case KeylessTelemetryRejectionReason.RequestTimeout: {
        this.applyCooldown(
          ack.retryAfterSeconds ?? KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS
        );
        this.counters.droppedCollectorUnavailable += 1;
        return false;
      }
      default: {
        // PayloadTooLarge / UnsupportedSignal / InvalidContentType /
        // InvalidRequest / OtlpRejected — client- or content-side problems a
        // retry won't fix. Drop and account for it.
        this.counters.droppedInvalid += 1;
        this.log.debug(`keyless telemetry export rejected: ${ack.reason}`);
        return false;
      }
    }
  }

  private emitWithAck<T>(
    socket: TelemetrySocketLike,
    event: string,
    payload: unknown
  ): Promise<T | null> {
    const setTimeoutFn = this.options.setTimeoutFn ?? globalSetTimeout;
    const clearTimeoutFn = this.options.clearTimeoutFn ?? globalClearTimeout;
    return new Promise<T | null>((resolve) => {
      let settled = false;
      const timer = setTimeoutFn(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(null);
      }, this.ackTimeoutMs);

      socket.emit(event, payload, (response: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeoutFn(timer);
        resolve(response as T);
      });
    });
  }

  private enqueueWarmUp(signal: RelayTelemetrySignal, body: Uint8Array): void {
    if (this.warmUpQueueLimit <= 0) {
      return;
    }
    while (this.warmUpQueue.length >= this.warmUpQueueLimit) {
      this.warmUpQueue.shift();
    }
    this.warmUpQueue.push({ signal, body });
  }

  private flushWarmUpQueue(session: ActiveSession): void {
    if (this.warmUpQueue.length === 0) {
      return;
    }
    const pending = this.warmUpQueue.splice(0, this.warmUpQueue.length);
    for (const entry of pending) {
      // Fire-and-forget. sendNow CAN re-enqueue an entry if the socket drops
      // mid-flush, but that cannot loop unboundedly: re-enqueue is bounded by
      // warmUpQueueLimit (oldest-dropped), and the only send retry path
      // (invalid_session) is guarded by allowRehandshake.
      this.sendNow(entry.signal, entry.body, session).catch(() => undefined);
    }
  }

  private applyCooldown(retryAfterSeconds: number): void {
    const seconds =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds
        : KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS;
    this.cooldownUntil = this.now() + seconds * 1000;
  }

  private async drainInFlightExports(): Promise<void> {
    if (this.inFlightExports.size === 0) {
      return;
    }
    const settleAll = Promise.allSettled([...this.inFlightExports]).then(
      () => undefined
    );
    // Whichever finishes first: all sends settle, or the bounded grace elapses.
    await Promise.race([settleAll, this.delay(this.shutdownDrainMs)]);
  }

  private delay(ms: number): Promise<void> {
    const setTimeoutFn = this.options.setTimeoutFn ?? globalSetTimeout;
    return new Promise((resolve) => {
      setTimeoutFn(() => resolve(), ms);
    });
  }

  private disconnectSocket(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.socket = null;
    try {
      socket.removeAllListeners();
      socket.disconnect();
    } catch (error) {
      this.log.debug(
        `keyless telemetry socket teardown error: ${describeError(error)}`
      );
    }
  }
}

const globalSetTimeout = (callback: () => void, ms: number): unknown =>
  setTimeout(callback, ms);

const globalClearTimeout = (handle: unknown): void => {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};

function defaultConnectFn(url: string): TelemetrySocketLike {
  return io(url, {
    transports: ["websocket"],
    reconnection: true,
  }) as unknown as TelemetrySocketLike;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
