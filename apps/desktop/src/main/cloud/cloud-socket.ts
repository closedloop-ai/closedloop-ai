import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";
import { io, type Socket } from "socket.io-client";
import { CloudSocketError } from "../../shared/cloud-socket-error.js";
import {
  type DesktopPopHeaders,
  type DesktopPopSigner,
  RELAY_API_KEY_VERIFY_PATH,
} from "../auth/desktop-pop.js";
import {
  buildManagedDesktopPopHeaders,
  type DesktopPopUnavailableReporter,
} from "../auth/desktop-pop-sign-utils.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { ApiKeyProvenance } from "../settings/api-key-store.js";
import { normalizeAndValidateOrigin } from "../settings/origin-policy.js";
import {
  describeDesktopHelloNack,
  HELLO_REJECTED_WITHOUT_REASON_MESSAGE,
  helloNackReasonLogToken,
  SERVER_INITIATED_DISCONNECT_REASON,
  withReconnectPauseNotice,
} from "./cloud-hello-nack.js";
import type {
  CloudSocketStatus,
  CommandEventRecord,
  DesktopCancelEvent,
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  DesktopCommandStreamAckEvent,
  DesktopCommandStreamEvent,
  DesktopHelloAckEvent,
  DesktopHelloEvent,
  DesktopPresenceEvent,
  ProtocolEnvelope,
} from "./cloud-protocol.js";
import {
  asFiniteInteger,
  asNonEmptyString,
  asObject,
  createEnvelope,
  formatObjectKeysForLog,
  formatPrimitiveForLog,
  hashAllowedDirectories,
  looksLikeAuthError,
  parseDesktopCommand,
} from "./cloud-socket-payloads.js";

export type ApiKeyDiagnostic = "available" | "missing" | "undecryptable";

export type CloudSocketOptions = {
  getRelayOrigin: () => string;
  getApiKey: () => string | null;
  getApiKeyDiagnostic?: () => ApiKeyDiagnostic;
  getApiKeyProvenance?: () => ApiKeyProvenance | null;
  signDesktopRequest?: DesktopPopSigner;
  onDesktopPopUnavailable?: DesktopPopUnavailableReporter;
  getAllowedDirectories: () => string[];
  getCapabilities?: () => Record<string, unknown>;
  getMaxInFlightCommands: () => number;
  getGatewayId?: () => string | null;
  machineName: string;
  pluginVersion: string;
  desktopClientVersion: string;
  gatewayProtocolVersion: string;
  getEnabledOperations: () => string[];
  onStatusChange?: (status: CloudSocketStatus) => void;
  onHelloAck?: (event: DesktopHelloAckEvent) => void;
  onCommand?: (event: DesktopCommandEvent) => void;
  onCancel?: (event: DesktopCancelEvent) => void;
  onCommandEventAck?: (event: DesktopCommandStreamAckEvent) => void;
  onDisconnect?: (reason: string) => void;
};

export class CloudSocketService {
  private readonly options: CloudSocketOptions;
  private socket: Socket | null = null;
  private stopped = true;
  private targetId: string | null = null;
  private helloAckTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private awaitingHelloAck = false;
  // Consecutive `desktop.hello.ack` timeouts on the *current* socket. Resets
  // on every fresh `connect` event, on a successful `desktop.hello.ack`, and
  // on stop(). When this reaches MAX_HELLO_ACK_TIMEOUTS_PER_SOCKET we force a
  // full socket recycle instead of re-emitting hello on the (apparently dead
  // or relay-side-stuck) socket until the 60s recovery timer fires.
  private helloAckTimeoutCount = 0;
  private lastPresenceState: string | null = null;
  private hadSuccessfulConnection = false;
  private degradedSince: number | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  // The user-facing message from a `desktop.hello.nack` on the CURRENT socket.
  // The cloud emits the nack and then disconnects, so without this the generic
  // `disconnect` message would immediately overwrite the only text that names
  // the actual cause. Cleared on every fresh `connect`, so a later network drop
  // never inherits a stale rejection. See ISS-6126.
  private helloRejectionMessage: string | null = null;
  // Log-safe token for the most recent nack (for the disconnect log line), and
  // how many consecutive rejections have arrived. The count deliberately
  // ignores WHICH reason each one carried: the wire reason cannot distinguish a
  // stage timeout from a hard failure (see cloud-hello-nack.ts), and a real
  // cloud-side outage surfaces at a different failure point on each attempt, so
  // keying the back-off on reason identity would let an alternating outage flap
  // forever. Both survive a socket recycle, because the flap being counted is
  // nack → disconnect → reconnect → nack, which spans sockets.
  private lastHelloNackReason: string | null = null;
  private helloNackStreak = 0;
  private pendingReconnectDelayMs: number | null = null;

  constructor(options: CloudSocketOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.targetId = null;
    this.awaitingHelloAck = false;
    this.helloAckTimeoutCount = 0;
    this.clearHelloRejectionState();
    this.disconnectSocket();
    this.clearHelloAckTimer();
    this.clearReconnectTimer();

    const apiKey = this.options.getApiKey();
    if (!apiKey) {
      const diagnostic = this.options.getApiKeyDiagnostic?.() ?? "missing";
      const error =
        diagnostic === "undecryptable"
          ? CloudSocketError.DecryptionFailed
          : CloudSocketError.MissingApiKey;
      gatewayLog.warn("cloud-socket", error);
      this.notifyStatus({
        state: "degraded",
        error,
      });
      return;
    }

    let relayOrigin: string;
    try {
      relayOrigin = normalizeAndValidateOrigin(this.options.getRelayOrigin());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "invalid relay origin";
      this.notifyStatus({ state: "degraded", error: message });
      return;
    }

    this.notifyStatus({ state: "idle" });
    const relayValidationPopHeaders = await buildRelayValidationPopHeaders(
      this.options.getApiKeyProvenance?.() ?? "USER_CREATED",
      this.options.signDesktopRequest,
      this.options.onDesktopPopUnavailable
    );
    if (this.stopped) {
      return;
    }
    this.connect(apiKey, relayOrigin, relayValidationPopHeaders);
  }

  stop(): void {
    this.stopped = true;
    this.targetId = null;
    this.awaitingHelloAck = false;
    this.helloAckTimeoutCount = 0;
    this.lastPresenceState = null;
    this.hadSuccessfulConnection = false;
    this.degradedSince = null;
    this.clearHelloRejectionState();
    this.clearHelloAckTimer();
    this.clearReconnectTimer();
    this.clearRecoveryTimer();
    this.disconnectSocket();
  }

  restart(): void {
    this.stop();
    void this.start();
  }

  sendCommandAck(
    event: Omit<DesktopCommandAckEvent, keyof EnvelopeOnlyFields>
  ): void {
    this.emit("desktop.command.ack", event);
  }

  sendCommandEvent(
    event: Omit<DesktopCommandStreamEvent, keyof EnvelopeOnlyFields>
  ): void {
    this.emit("desktop.command.event", event);
  }

  sendPresence(
    event: Omit<DesktopPresenceEvent, keyof EnvelopeOnlyFields | "state"> & {
      state: DesktopPresenceEvent["state"];
    }
  ): void {
    if (event.state !== this.lastPresenceState) {
      gatewayLog.debug(
        "cloud-socket",
        `Sending presence: state=${event.state}`
      );
      this.lastPresenceState = event.state;
    }
    this.emit("desktop.presence", event);
  }

  replayEvents(
    commandId: string,
    events: readonly CommandEventRecord[],
    fromSequence: number
  ): void {
    for (const event of events) {
      if (event.sequence <= fromSequence) {
        continue;
      }
      this.sendCommandEvent({
        commandId,
        sequence: event.sequence,
        eventType: event.eventType,
        data: event.data,
      });
    }
  }

  private connect(
    apiKey: string,
    relayOrigin: string,
    relayValidationPopHeaders?: DesktopPopHeaders
  ): void {
    const socket = io(`${relayOrigin}/desktop-gateway`, {
      transports: ["websocket"],
      reconnection: false,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 10_000,
      autoConnect: false,
      auth: {
        apiKey,
      },
      ...(relayValidationPopHeaders
        ? { extraHeaders: relayValidationPopHeaders }
        : {}),
    });
    this.socket = socket;
    this.registerSocketHandlers(socket);
    socket.connect();
    this.startRecoveryTimer();
  }

  private registerSocketHandlers(socket: Socket): void {
    socket.on("connect", () => {
      if (this.stopped) {
        return;
      }
      this.clearReconnectTimer();
      gatewayLog.info(
        "cloud-socket",
        "Connected to relay, sending hello handshake"
      );
      this.awaitingHelloAck = true;
      this.helloAckTimeoutCount = 0;
      this.helloRejectionMessage = null;
      this.emitHello();
      this.scheduleHelloAckTimeout();
    });

    socket.on("connect_error", (error) => {
      if (this.stopped) {
        return;
      }
      this.awaitingHelloAck = false;
      this.clearHelloAckTimer();
      const message =
        error instanceof Error ? error.message : "connection failed";
      if (!this.hadSuccessfulConnection && looksLikeAuthError(error)) {
        gatewayLog.error("cloud-socket", "Authentication failed on connect");
        this.notifyStatus({
          state: "degraded",
          error: "Authentication failed -- verify your API key in Settings",
        });
      } else {
        gatewayLog.error("cloud-socket", `Connection error: ${message}`);
        this.notifyStatus({
          state: "degraded",
          error: `Cloud socket connection failed: ${message}`,
        });
      }
      this.degradedSince ??= Date.now();
      this.scheduleSocketReconnect(socket);
    });

    socket.on("disconnect", (reason) => {
      if (this.stopped) {
        return;
      }
      const disconnect = this.describeDisconnect(reason);
      gatewayLog.warn("cloud-socket", disconnect.logMessage);
      this.awaitingHelloAck = false;
      this.clearHelloAckTimer();
      this.notifyStatus({
        state: "degraded",
        error: disconnect.error,
      });
      this.degradedSince ??= Date.now();
      this.options.onDisconnect?.(reason);
      this.scheduleSocketReconnect(socket, this.takeReconnectDelayMs());
    });

    socket.on("desktop.hello.nack", (payload: unknown) => {
      this.handleHelloNack(payload);
    });

    socket.on("desktop.hello.ack", (payload: unknown) => {
      const event = asObject(payload);
      const ackEvent = parseDesktopHelloAck(payload);
      if (!ackEvent) {
        gatewayLog.warn(
          "cloud-socket",
          "hello.ack missing computeTargetId, ignoring"
        );
        return;
      }

      this.targetId = ackEvent.computeTargetId;
      this.awaitingHelloAck = false;
      this.helloAckTimeoutCount = 0;
      this.hadSuccessfulConnection = true;
      this.degradedSince = null;
      this.clearHelloRejectionState();
      this.clearHelloAckTimer();
      const rawServerCapabilities = asObject(event.serverCapabilities);
      const parsedServerCapabilities = parseServerCapabilities(
        event.serverCapabilities
      );
      const rawComputeTargetSigning =
        rawServerCapabilities.computeTargetSigning;
      const rawAgentSessionSync = rawServerCapabilities.agentSessionSync;
      gatewayLog.info(
        "cloud-socket",
        `Hello ack received, targetId=${ackEvent.computeTargetId}, serverCapabilityKeys=${formatObjectKeysForLog(rawServerCapabilities)}, computeTargetSigning=${formatPrimitiveForLog(rawComputeTargetSigning)}, parsedComputeTargetSigning=${parsedServerCapabilities?.computeTargetSigning === true}, agentSessionSync=${formatPrimitiveForLog(rawAgentSessionSync)}, parsedAgentSessionSync=${parsedServerCapabilities?.agentSessionSync === true}`
      );
      this.options.onHelloAck?.(ackEvent);
      this.notifyStatus({
        state: "online",
        targetId: ackEvent.computeTargetId,
      });
      this.sendPresence({
        state: "online",
      });
    });

    socket.on("desktop.command", (payload: unknown) => {
      const parsed = parseDesktopCommand(payload);
      if (!parsed) {
        const rawPath = asNonEmptyString(asObject(payload).path);
        if (rawPath?.startsWith("/api/engineer/")) {
          gatewayLog.warn(
            "cloud-socket",
            `Received legacy /api/engineer/ command (${rawPath}), ignoring — desktop only accepts /api/gateway/ commands`
          );
        } else {
          gatewayLog.warn(
            "cloud-socket",
            "Received unparseable desktop.command, ignoring"
          );
        }
        return;
      }
      gatewayLog.debug(
        "cloud-socket",
        `Command received: ${parsed.operationId} ${parsed.method} ${parsed.path} (commandId=${parsed.commandId})`
      );
      this.options.onCommand?.(parsed);
    });

    socket.on("desktop.cancel", (payload: unknown) => {
      const event = asObject(payload);
      const commandId = asNonEmptyString(event.commandId);
      if (!commandId) {
        return;
      }
      this.options.onCancel?.({
        ...createEnvelope(),
        commandId,
        reason: asNonEmptyString(event.reason) ?? undefined,
      });
    });

    socket.on("desktop.command.event.ack", (payload: unknown) => {
      const event = asObject(payload);
      const commandId = asNonEmptyString(event.commandId);
      const sequence = asFiniteInteger(event.sequence);
      if (!commandId || sequence === null) {
        return;
      }
      this.options.onCommandEventAck?.({
        ...createEnvelope(),
        commandId,
        sequence,
      });
    });
  }

  /**
   * Surfaces the cloud's typed hello rejection instead of discarding it.
   *
   * The cloud emits `desktop.hello.nack` with a reason and only then
   * disconnects, so before ISS-6126 every distinct failure collapsed into
   * Socket.IO's own "io server disconnect" string. The reason is recorded here
   * and re-asserted by the disconnect that immediately follows it.
   */
  private handleHelloNack(payload: unknown): void {
    if (this.stopped) {
      return;
    }
    // A nack is only meaningful for a handshake still in flight. Ignoring a
    // late, duplicated, or reordered one keeps a healthy `online` socket from
    // being knocked back to `degraded` by a frame about an already-settled
    // hello, and mirrors the same guard the hello-ack supervisor applies.
    if (!this.awaitingHelloAck) {
      gatewayLog.warn(
        "cloud-socket",
        "Ignoring desktop.hello.nack with no handshake in flight"
      );
      return;
    }
    const disposition = describeDesktopHelloNack(payload);
    this.clearHelloAckTimer();
    this.lastHelloNackReason = helloNackReasonLogToken(disposition);

    // The back-off is streak-based and reason-blind. A single nack is a blip
    // worth retrying at the normal cadence — every reason the cloud can send is
    // also what a 5s stage deadline produces, so a transient slowdown must not
    // be punished with a minute of silence. A run of them is the nack →
    // disconnect → reconnect → nack loop, which no cadence of ours will fix, so
    // it backs off far enough that the surfaced cause stays readable. This is
    // the only bound on an unrecognized reason from a newer cloud, which an
    // older build cannot interpret and must not hammer `desktop.hello` over.
    this.helloNackStreak += 1;
    const backingOff = this.helloNackStreak >= HELLO_NACK_BACKOFF_THRESHOLD;
    this.pendingReconnectDelayMs = backingOff
      ? HELLO_NACK_BACKOFF_DELAY_MS
      : null;
    const message = backingOff
      ? withReconnectPauseNotice(
          disposition.message,
          HELLO_NACK_BACKOFF_DELAY_MS
        )
      : disposition.message;

    this.helloRejectionMessage = message;
    this.awaitingHelloAck = false;
    gatewayLog.error(
      "cloud-socket",
      `Hello rejected by cloud: reason=${this.lastHelloNackReason}, recognized=${disposition.recognized}, reasonLength=${disposition.reasonLength}, consecutiveNacks=${this.helloNackStreak}, nextReconnectMs=${this.pendingReconnectDelayMs ?? RECONNECT_DELAY_MS}`
    );
    this.notifyStatus({ state: "degraded", error: message });
    this.degradedSince ??= Date.now();
  }

  /**
   * Chooses what a disconnect means to the user. Three cases, deliberately kept
   * distinct: the cloud told us why (keep that message rather than letting the
   * generic one overwrite it), the cloud closed us right after a hello without
   * telling us why (the gateway-conflict and unparseable-hello paths, otherwise
   * invisible), or an ordinary drop (unchanged legacy wording).
   */
  private describeDisconnect(reason: string): {
    error: string;
    logMessage: string;
  } {
    if (this.helloRejectionMessage) {
      return {
        error: this.helloRejectionMessage,
        logMessage: `Disconnected: ${reason} — after desktop.hello.nack (${this.lastHelloNackReason})`,
      };
    }
    if (
      this.awaitingHelloAck &&
      reason === SERVER_INITIATED_DISCONNECT_REASON
    ) {
      return {
        error: HELLO_REJECTED_WITHOUT_REASON_MESSAGE,
        logMessage: `Disconnected: ${reason} — cloud closed the connection after desktop.hello without sending desktop.hello.nack`,
      };
    }
    return {
      error: `Cloud socket disconnected: ${reason}`,
      logMessage: `Disconnected: ${reason}`,
    };
  }

  private takeReconnectDelayMs(): number {
    const delayMs = this.pendingReconnectDelayMs ?? RECONNECT_DELAY_MS;
    this.pendingReconnectDelayMs = null;
    return delayMs;
  }

  private clearHelloRejectionState(): void {
    this.helloRejectionMessage = null;
    this.lastHelloNackReason = null;
    this.helloNackStreak = 0;
    this.pendingReconnectDelayMs = null;
  }

  private emitHello(): void {
    const gatewayId = this.options.getGatewayId?.() ?? undefined;
    const hello: DesktopHelloEvent = {
      ...createEnvelope(),
      computeTargetId: this.targetId ?? undefined,
      gatewayId,
      ...(gatewayId
        ? { desktopSecurityUpgradeProtocolVersion: 1 as const }
        : {}),
      machineName: this.options.machineName,
      platform: process.platform,
      pluginVersion: this.options.pluginVersion,
      desktopClientVersion: this.options.desktopClientVersion,
      gatewayProtocolVersion: this.options.gatewayProtocolVersion,
      supportedOperations: this.options.getEnabledOperations(),
      maxInFlightCommands: Math.max(1, this.options.getMaxInFlightCommands()),
      allowedDirectoriesHash: hashAllowedDirectories(
        this.options.getAllowedDirectories()
      ),
      ...(this.options.getCapabilities
        ? { capabilities: this.options.getCapabilities() }
        : {}),
    };
    this.socket?.emit("desktop.hello", hello);
  }

  private emit(name: string, event: Record<string, unknown>): void {
    if (!this.socket?.connected) {
      return;
    }
    this.socket.emit(name, {
      ...createEnvelope(),
      ...event,
    });
  }

  private disconnectSocket(): void {
    if (!this.socket) {
      return;
    }
    this.awaitingHelloAck = false;
    this.clearHelloAckTimer();
    this.clearReconnectTimer();

    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
  }

  private scheduleSocketReconnect(
    socket: Socket,
    delayMs: number = RECONNECT_DELAY_MS
  ): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectSocket(socket);
    }, delayMs);
  }

  private async reconnectSocket(socket: Socket): Promise<void> {
    if (this.stopped || this.socket !== socket) {
      return;
    }
    await refreshRelayValidationPopHeadersForSocket(
      socket,
      this.options.getApiKeyProvenance?.() ?? "USER_CREATED",
      this.options.signDesktopRequest,
      this.options.onDesktopPopUnavailable
    );
    if (this.stopped || this.socket !== socket) {
      return;
    }
    socket.connect();
  }

  private scheduleHelloAckTimeout(): void {
    this.clearHelloAckTimer();
    this.helloAckTimer = setTimeout(() => {
      if (this.stopped || !this.awaitingHelloAck) {
        return;
      }
      const socket = this.socket;
      const consecutive = ++this.helloAckTimeoutCount;
      // Diagnostic context: when the relay is silently stuck we need enough
      // detail in the desktop log to discriminate "first hello hangs" from
      // "Nth hello hangs", and to correlate with a specific socket.id on
      // the server-side trace. Intentionally excludes PII (machineName,
      // allowedDirectoriesHash) — versions + IDs only.
      const targetIdLabel = this.targetId ?? "(none — first connect)";
      const gatewayId = this.options.getGatewayId?.() ?? "(none)";
      gatewayLog.warn(
        "cloud-socket",
        `Hello ack timeout (${consecutive}/${MAX_HELLO_ACK_TIMEOUTS_PER_SOCKET}) -- socketId=${socket?.id ?? "(no socket)"}, computeTargetId=${targetIdLabel}, gatewayId=${gatewayId}, desktopClientVersion=${this.options.desktopClientVersion}, gatewayProtocolVersion=${this.options.gatewayProtocolVersion}`
      );

      if (consecutive >= MAX_HELLO_ACK_TIMEOUTS_PER_SOCKET) {
        // Two consecutive timeouts on the same socket means re-emitting hello
        // is not going to help — the relay is either hung inside its hello
        // handler or our hello is being silently dropped. Recycle the socket
        // so we get a fresh socket.id on the server side and bypass any
        // per-socket stuck state.
        //
        // We do BOTH `socket.disconnect()` AND `scheduleSocketReconnect()`:
        //   - When socket.connected is true, disconnect() will fire our
        //     existing 'disconnect' listener which itself schedules a
        //     reconnect. scheduleSocketReconnect() is idempotent (the inner
        //     `if (this.reconnectTimer)` short-circuit), so the double call
        //     is harmless.
        //   - When socket.connected is false (transient half-open transport
        //     state, or the listener already fired without us noticing),
        //     disconnect() is a no-op and the listener won't fire again —
        //     so the explicit scheduleSocketReconnect() is the only thing
        //     guaranteeing recovery in ~20s instead of waiting the 60s
        //     RECOVERY_TIMEOUT_MS.
        gatewayLog.warn(
          "cloud-socket",
          `Forcing reconnect after ${consecutive} consecutive hello ack timeouts`
        );
        this.notifyStatus({
          state: "degraded",
          error: "Relay did not respond to handshake — reconnecting",
        });
        if (socket) {
          socket.disconnect();
          this.scheduleSocketReconnect(socket);
        } else {
          // Defensive: this.socket can be null only after stop() or before
          // start(), both of which short-circuited at the top of this
          // callback. A full restart() handles the otherwise-unreachable
          // case without leaving the service stuck.
          this.restart();
        }
        return;
      }

      this.notifyStatus({
        state: "degraded",
        error: "Relay did not respond to handshake — retrying",
      });
      if (socket?.connected) {
        this.emitHello();
        this.scheduleHelloAckTimeout();
      }
    }, HELLO_ACK_TIMEOUT_MS);
  }

  private clearHelloAckTimer(): void {
    if (!this.helloAckTimer) {
      return;
    }
    clearTimeout(this.helloAckTimer);
    this.helloAckTimer = null;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startRecoveryTimer(): void {
    this.clearRecoveryTimer();
    this.recoveryTimer = setInterval(() => {
      if (this.stopped || !this.degradedSince) {
        return;
      }
      const elapsed = Date.now() - this.degradedSince;
      if (elapsed >= RECOVERY_TIMEOUT_MS) {
        gatewayLog.warn(
          "cloud-socket",
          `Degraded for ${Math.round(elapsed / 1000)}s, forcing reconnect`
        );
        this.restart();
      }
    }, RECOVERY_CHECK_INTERVAL_MS);
  }

  private clearRecoveryTimer(): void {
    if (!this.recoveryTimer) {
      return;
    }
    clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private notifyStatus(status: CloudSocketStatus): void {
    this.options.onStatusChange?.(status);
  }
}

/**
 * Builds PoP headers for the relay's API-key verification request only when using a managed key.
 */
export async function buildRelayValidationPopHeaders(
  apiKeyProvenance: ApiKeyProvenance,
  signDesktopRequest?: DesktopPopSigner,
  onUnavailable?: DesktopPopUnavailableReporter
): Promise<DesktopPopHeaders | undefined> {
  return buildManagedDesktopPopHeaders({
    apiKeyProvenance,
    signDesktopRequest,
    request: {
      method: "POST",
      pathname: RELAY_API_KEY_VERIFY_PATH,
    },
    surface: RELAY_API_KEY_VERIFY_PATH,
    unavailableMessage:
      "PoP signing unavailable for relay validation; continuing bearer-only compatibility mode",
    onUnavailable,
  });
}

/**
 * Refreshes Socket.IO Engine extraHeaders before a manual reconnect attempt.
 */
export async function refreshRelayValidationPopHeadersForSocket(
  socket: Socket,
  apiKeyProvenance: ApiKeyProvenance,
  signDesktopRequest?: DesktopPopSigner,
  onUnavailable?: DesktopPopUnavailableReporter
): Promise<void> {
  const headers = await buildRelayValidationPopHeaders(
    apiKeyProvenance,
    signDesktopRequest,
    onUnavailable
  );
  if (headers) {
    socket.io.opts.extraHeaders = headers;
  } else {
    socket.io.opts.extraHeaders = undefined;
  }
}

type EnvelopeOnlyFields = ProtocolEnvelope;

const HELLO_ACK_TIMEOUT_MS = 10_000;
// After this many consecutive hello-ack timeouts on the same socket we force
// a full socket recycle. Two timeouts = ~20s of relay silence, which is well
// past the threshold where another hello on the same socket could reasonably
// succeed. The prior implementation re-emitted forever and relied on the 60s
// recovery timer to break the loop, leaving users in Disconnected for an extra
// 40s after the problem was already evident. See FEA-1404.
const MAX_HELLO_ACK_TIMEOUTS_PER_SOCKET = 2;
const RECONNECT_DELAY_MS = 1000;
// How many consecutive `desktop.hello.nack` frames it takes before the desktop
// stops reconnecting at the normal cadence, whatever reason they carried. Two
// fast attempts is enough for a transient cloud-side stage timeout to clear;
// a third in a row is the nack → disconnect → reconnect → nack loop. Applied
// reason-blind because the wire reason cannot tell a timeout from a hard
// failure, and because an unrecognized reason needs a bound too. See ISS-6126.
const HELLO_NACK_BACKOFF_THRESHOLD = 3;
// Long enough that the surfaced cause stays readable instead of being churned
// once a second, short enough that the desktop still self-heals unattended once
// the cloud-side failure clears.
const HELLO_NACK_BACKOFF_DELAY_MS = 60_000;
const RECOVERY_TIMEOUT_MS = 2 * 60_000;
const RECOVERY_CHECK_INTERVAL_MS = 30_000;

/**
 * Parses server-advertised Desktop capabilities. Only an explicit boolean true
 * enables command-signing enforcement; missing, false, or malformed values
 * preserve legacy unsigned command compatibility.
 */
export function parseServerCapabilities(
  value: unknown
): ComputeTargetServerCapabilities | undefined {
  const record = asObject(value);
  const parsed: ComputeTargetServerCapabilities = {};
  if (record.computeTargetSigning === true) {
    parsed.computeTargetSigning = true;
  }
  if (record.agentSessionSync === true) {
    parsed.agentSessionSync = true;
  }
  if (record.agentSessionSyncCompression === true) {
    parsed.agentSessionSyncCompression = true;
  }
  // ISS-4541: the server merges a multi-part activity-segment tiling additively.
  if (record.agentSessionSyncActivityChunking === true) {
    parsed.agentSessionSyncActivityChunking = true;
  }
  if (record.agentSessionSyncMonitoredActivity === true) {
    parsed.agentSessionSyncMonitoredActivity = true;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function parseDesktopHelloAck(
  payload: unknown
): DesktopHelloAckEvent | null {
  const event = asObject(payload);
  const computeTargetId = asNonEmptyString(event.computeTargetId);
  if (!computeTargetId) {
    return null;
  }
  const parsedServerCapabilities = parseServerCapabilities(
    event.serverCapabilities
  );

  return {
    ...createEnvelope(),
    computeTargetId,
    sessionId: asNonEmptyString(event.sessionId) ?? "",
    serverTime: asNonEmptyString(event.serverTime) ?? new Date().toISOString(),
    ...(parsedServerCapabilities
      ? { serverCapabilities: parsedServerCapabilities }
      : {}),
    resumeFromSequence:
      event.resumeFromSequence && typeof event.resumeFromSequence === "object"
        ? (event.resumeFromSequence as Record<string, number>)
        : undefined,
  };
}
