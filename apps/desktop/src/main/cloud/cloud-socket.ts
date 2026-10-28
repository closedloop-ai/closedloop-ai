import { AuthOutcome, AuthReason } from "@closedloop-ai/telemetry-contract/app";
import { io, type Socket } from "socket.io-client";
import {
  CloudSocketDegradedReason,
  CloudSocketError,
} from "../../shared/cloud-socket-error.js";
import type { DesktopPopHeaders } from "../auth/desktop-pop.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { normalizeAndValidateOrigin } from "../settings/origin-policy.js";
import { authReasonForHelloNack } from "./auth-failure-telemetry.js";
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
  DesktopCommandAckEvent,
  DesktopCommandStreamEvent,
  DesktopHelloEvent,
  DesktopPresenceEvent,
  ProtocolEnvelope,
} from "./cloud-protocol.js";
import {
  type DesktopAccountAdmission,
  isCloudSocketAccountAdmitted,
} from "./cloud-socket-account-admission.js";
import {
  parseDesktopHelloAck,
  parseServerCapabilities,
} from "./cloud-socket-hello-ack.js";
import { HelloGatewayIdTracker } from "./cloud-socket-hello-gateway.js";
import type { CloudSocketOptions } from "./cloud-socket-options.js";
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
import {
  buildRelayValidationPopHeaders,
  refreshRelayValidationPopHeadersForSocket,
} from "./cloud-socket-pop-headers.js";

export type {
  ApiKeyDiagnostic,
  CloudSocketOptions,
} from "./cloud-socket-options.js";

export class CloudSocketService {
  private readonly options: CloudSocketOptions;
  private socket: Socket | null = null;
  private accountAdmission: DesktopAccountAdmission | null = null;
  private startGeneration = 0;
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
  // How many `connect_error`s have arrived without a successful connect between
  // them. Cleared alongside `helloNackStreak`, because `restart()` is not only
  // the recovery timer's degraded-retry path: replacing or clearing the API key
  // and switching profile both reach it, and a streak earned by a dead
  // credential must not pace the first retry on its replacement (ISS-8142).
  //
  // The cost is that the recovery timer re-earns the fast cadence once per
  // two-minute cycle, so this bounds the loop rather than ending it. Bounding is
  // what the reported defect needs; scoping the streak to a connection identity
  // so it can survive a recovery restart without outliving a credential is a
  // separate change.
  private connectErrorStreak = 0;
  // ISS-11843: consecutive closes of a hello that was never answered — the
  // cloud dropping the socket after `desktop.hello` without sending any nack.
  // Neither streak above covers it: `helloNackStreak` counts frames that
  // arrived, `connectErrorStreak` connects that never opened. Survives a socket
  // recycle because the flap being counted (hello → close → reconnect → hello)
  // spans sockets. At the threshold the refusal is terminal (operator ruling,
  // ISS-11843): the service stops until something calls `start()` again.
  private helloRejectedWithoutReasonStreak = 0;
  private pendingReconnectDelayMs: number | null = null;
  private readonly helloGateway: HelloGatewayIdTracker;

  constructor(options: CloudSocketOptions) {
    this.options = options;
    this.helloGateway = new HelloGatewayIdTracker({
      getGatewayId: options.getGatewayId,
      resendHello: () => this.resendHelloForGatewayRefresh(),
    });
  }

  async start(): Promise<void> {
    const startGeneration = ++this.startGeneration;
    const accountAdmission = this.options.getAccountAdmission?.() ?? null;
    if (this.options.getAccountAdmission && !accountAdmission) {
      this.stop();
      this.notifyStatus({ state: "idle" });
      return;
    }
    this.accountAdmission = accountAdmission;
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
      // ISS-6334: an UNDECRYPTABLE stored key is a broken install that can
      // never pair. A merely missing key is not reported — that is the
      // not-yet-onboarded state, and reporting it would fire on every launch
      // before the user has done anything wrong.
      if (diagnostic === "undecryptable") {
        this.options.reportAuthFailure?.({
          outcome: AuthOutcome.PairingRejected,
          reason: AuthReason.CredentialUnreadable,
        });
      }
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
    if (!this.isStartCurrent(startGeneration, accountAdmission)) {
      return;
    }
    this.connect(apiKey, relayOrigin, relayValidationPopHeaders);
  }

  stop(): void {
    this.startGeneration += 1;
    this.stopped = true;
    this.accountAdmission = null;
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
    this.helloGateway.reset();
    this.disconnectSocket();
  }

  restart(): void {
    this.stop();
    void this.start();
  }

  /** The gatewayId the last hello declared, for checks that must agree with it. */
  getHelloGatewayId(): string | undefined {
    return this.helloGateway.getDeclared();
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
    if (!this.ensureAdmitted()) {
      return;
    }
    const socket = io(`${relayOrigin}/desktop-gateway`, {
      transports: ["websocket"],
      // This socket's PoP `extraHeaders` are transport-level, and
      // `refreshRelayValidationPopHeadersForSocket` rewrites them in place on
      // `socket.io.opts` before every manual reconnect — both assume the
      // gateway owns its Manager outright. Socket.IO's per-origin Manager cache
      // does not guarantee that, so declare it here instead of depending on
      // what some other namespace on this origin happens to pass (ISS-6494).
      forceNew: true,
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
      if (!this.ensureAdmitted()) {
        return;
      }
      this.clearReconnectTimer();
      gatewayLog.info(
        "cloud-socket",
        "Connected to relay, sending hello handshake"
      );
      this.connectErrorStreak = 0;
      this.awaitingHelloAck = true;
      this.helloAckTimeoutCount = 0;
      this.helloRejectionMessage = null;
      this.emitHello();
      this.scheduleHelloAckTimeout();
    });

    socket.on("connect_error", (error) => {
      if (!this.ensureAdmitted()) {
        return;
      }
      this.awaitingHelloAck = false;
      this.clearHelloAckTimer();
      const message =
        error instanceof Error ? error.message : "connection failed";
      const authShaped = looksLikeAuthError(error);
      if (authShaped) {
        // ISS-6334: the relay refused the credential outright, so `desktop.hello`
        // is never answered and `handleHelloNack` never runs.
        //
        // Reported on EVERY auth-shaped connect_error, not only on an install
        // that has never connected. `hadSuccessfulConnection` latches true for
        // the process lifetime, so a key revoked after one good hello would
        // otherwise fall to the generic branch and go unreported — and Pipe 2
        // is offline in exactly that state too, which is the invisibility this
        // signal exists to close.
        this.options.reportAuthFailure?.({
          outcome: AuthOutcome.PairingRejected,
          reason: AuthReason.RelayRejectedCredential,
        });
      }
      // The flag still gates the USER-FACING distinction: "check your API key"
      // is the right advice for an install that never paired, and misleading
      // for one whose credential worked until a moment ago.
      if (authShaped && !this.hadSuccessfulConnection) {
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
      // ISS-8142: Socket.IO's own retry is off, so this arm is the ONLY thing
      // re-arming a failed connect, and it used to do so at a flat 1s with no
      // cap — ~86,400 attempts/day against a credential that will never start
      // working. Cause-blind like the nack back-off: a revoked key and a relay
      // outage are indistinguishable here and both are answered by retrying
      // less often. Assigned ONLY on the backing-off branch, so a single
      // transport blip cannot downgrade a longer pause the nack arm set.
      this.connectErrorStreak += 1;
      if (this.connectErrorStreak >= CONNECT_ERROR_BACKOFF_THRESHOLD) {
        this.pendingReconnectDelayMs = CONNECT_ERROR_BACKOFF_DELAY_MS;
      }
      this.scheduleSocketReconnect(socket, this.takeReconnectDelayMs());
    });

    socket.on("disconnect", (reason) => {
      if (!this.ensureAdmitted()) {
        return;
      }
      const disconnect = this.describeDisconnect(reason);
      gatewayLog.warn("cloud-socket", disconnect.logMessage);
      // ISS-6334: the cloud closed the handshake without a nack — the gateway-id
      // conflict and unparseable-hello paths. Permanent, and otherwise invisible
      // from both ends. Reported here rather than in `describeDisconnect`, which
      // is a pure describer.
      let refused = false;
      if (disconnect.error === HELLO_REJECTED_WITHOUT_REASON_MESSAGE) {
        this.options.reportAuthFailure?.({
          outcome: AuthOutcome.PairingRejected,
          reason: AuthReason.NoRejectionReason,
        });
        this.helloRejectedWithoutReasonStreak += 1;
        refused =
          this.helloRejectedWithoutReasonStreak >=
          HELLO_REJECTED_WITHOUT_REASON_TERMINAL_THRESHOLD;
        gatewayLog.warn(
          "cloud-socket",
          `Hello closed without a nack: consecutive=${this.helloRejectedWithoutReasonStreak}, terminal=${refused}`
        );
      }
      this.awaitingHelloAck = false;
      this.clearHelloAckTimer();
      this.helloGateway.reset();
      if (refused) {
        this.options.onDisconnect?.(reason);
        this.enterHandshakeRefused();
        return;
      }
      this.notifyStatus({ state: "degraded", error: disconnect.error });
      this.degradedSince ??= Date.now();
      this.options.onDisconnect?.(reason);
      this.scheduleSocketReconnect(socket, this.takeReconnectDelayMs());
    });

    socket.on("desktop.hello.nack", (payload: unknown) => {
      if (!this.ensureAdmitted()) {
        return;
      }
      this.handleHelloNack(payload);
    });

    socket.on("desktop.hello.ack", (payload: unknown) => {
      if (!this.ensureAdmitted()) {
        return;
      }
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
      const rawAgentSessionSync = rawServerCapabilities.agentSessionSync;
      gatewayLog.info(
        "cloud-socket",
        `Hello ack received, targetId=${ackEvent.computeTargetId}, serverCapabilityKeys=${formatObjectKeysForLog(rawServerCapabilities)}, agentSessionSync=${formatPrimitiveForLog(rawAgentSessionSync)}, parsedAgentSessionSync=${parsedServerCapabilities?.agentSessionSync === true}`
      );
      this.helloGateway.onHelloAck();
      this.options.onHelloAck?.(ackEvent);
      this.notifyStatus({
        state: "online",
        targetId: ackEvent.computeTargetId,
        ...(ackEvent.mintingApiOrigin
          ? { mintingApiOrigin: ackEvent.mintingApiOrigin }
          : {}),
      });
      this.sendPresence({
        state: "online",
      });
    });

    socket.on("desktop.command", (payload: unknown) => {
      if (!this.ensureAdmitted()) {
        return;
      }
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
      if (!this.ensureAdmitted()) {
        return;
      }
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
      if (!this.ensureAdmitted()) {
        return;
      }
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
    if (!this.ensureAdmitted()) {
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
    // ISS-6334: the ONLY cloud-visible trace of this rejection. The reason is
    // taken from the already-narrowed disposition, never the raw wire string —
    // an unrecognized one is `null` there and reports as `unknown`.
    this.options.reportAuthFailure?.({
      outcome: AuthOutcome.PairingRejected,
      reason: authReasonForHelloNack(disposition.reason),
    });
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
    this.connectErrorStreak = 0;
    this.helloRejectedWithoutReasonStreak = 0;
    this.pendingReconnectDelayMs = null;
  }

  /**
   * ISS-11843: stop reconnecting and say so. `stop()` clears every timer, the
   * recovery restart included, so only a fresh `start()` (an account or
   * connection-settings change, or a relaunch) dials again.
   */
  private enterHandshakeRefused(): void {
    gatewayLog.error(
      "cloud-socket",
      "Handshake refused without a nack; not reconnecting until restarted"
    );
    this.stop();
    this.notifyStatus({
      state: "degraded",
      error: CloudSocketError.HandshakeRefused,
      reason: CloudSocketDegradedReason.HandshakeRefused,
    });
  }

  private emitHello(): void {
    if (!this.ensureAdmitted()) {
      return;
    }
    const gatewayId = this.helloGateway.resolveForHello();
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
    if (!(this.ensureAdmitted() && this.socket?.connected)) {
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
    if (this.reconnectTimer || !this.ensureAdmitted()) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectSocket(socket);
    }, delayMs);
  }

  private async reconnectSocket(socket: Socket): Promise<void> {
    if (!this.ensureAdmitted() || this.socket !== socket) {
      return;
    }
    await refreshRelayValidationPopHeadersForSocket(
      socket,
      this.options.getApiKeyProvenance?.() ?? "USER_CREATED",
      this.options.signDesktopRequest,
      this.options.onDesktopPopUnavailable
    );
    if (!this.ensureAdmitted() || this.socket !== socket) {
      return;
    }
    socket.connect();
  }

  private scheduleHelloAckTimeout(): void {
    this.clearHelloAckTimer();
    this.helloAckTimer = setTimeout(() => {
      if (!(this.ensureAdmitted() && this.awaitingHelloAck)) {
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

  private resendHelloForGatewayRefresh(): boolean {
    if (
      this.awaitingHelloAck ||
      !this.isCommandWorkIdle() ||
      !(this.ensureAdmitted() && this.socket?.connected)
    ) {
      return false;
    }
    gatewayLog.info(
      "cloud-socket",
      "Gateway id resolved after a hello that declared none; re-sending hello"
    );
    this.awaitingHelloAck = true;
    this.emitHello();
    this.scheduleHelloAckTimeout();
    return true;
  }

  private isCommandWorkIdle(): boolean {
    const stats = this.options.getCommandWorkStats?.();
    return stats?.activeCommands === 0 && stats.queueDepth === 0;
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
      if (!(this.ensureAdmitted() && this.degradedSince)) {
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

  private ensureAdmitted(): boolean {
    if (this.stopped) {
      return false;
    }
    if (
      isCloudSocketAccountAdmitted(
        this.accountAdmission,
        this.options.getAccountAdmission
      )
    ) {
      return true;
    }
    this.stop();
    this.notifyStatus({ state: "idle" });
    return false;
  }

  private isStartCurrent(
    generation: number,
    admission: DesktopAccountAdmission | null
  ): boolean {
    return (
      generation === this.startGeneration &&
      admission === this.accountAdmission &&
      isCloudSocketAccountAdmitted(admission, this.options.getAccountAdmission)
    );
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
// The `connect_error` equivalents (ISS-8142). Deliberately a separate pair from
// the nack constants above rather than a shared one: the two bound different
// failures — a refused credential or a dead transport here, a cloud that
// answered and said no there — and collapsing them would couple two policies
// that should be free to move apart. The values start matched because the
// question they answer is the same one: how long is long enough to stop
// hammering, while still self-healing unattended.
const CONNECT_ERROR_BACKOFF_THRESHOLD = 3;
const CONNECT_ERROR_BACKOFF_DELAY_MS = 60_000;
// ISS-11843: consecutive mute closes after which the refusal is terminal.
// Matched to the sibling thresholds: two fast attempts let a drain that lands
// inside the handshake window clear; a third in a row is the refusal loop.
const HELLO_REJECTED_WITHOUT_REASON_TERMINAL_THRESHOLD = 3;
const RECOVERY_TIMEOUT_MS = 2 * 60_000;
const RECOVERY_CHECK_INTERVAL_MS = 30_000;
