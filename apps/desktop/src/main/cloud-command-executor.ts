import { URL } from "node:url";
import { COMMAND_SIGNING_REJECTION_REASONS } from "../shared/contracts.js";
import type {
  CommandEventRecord,
  DesktopCancelEvent,
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  DesktopCommandStreamAckEvent,
  DesktopCommandStreamEvent,
  ProtocolEnvelope,
} from "./cloud-protocol.js";
import type { CommandSignatureVerifier } from "./command-signature-verifier.js";
import { gatewayLog } from "./gateway-logger.js";
import { Observability } from "./observability.js";

const COMMAND_RETENTION_MS = 10 * 60_000;
const MAX_RETAINED_TERMINAL_COMMANDS = 200;

export type CloudCommandExecutorOptions = {
  getGatewayPort: () => number;
  getGatewayAuthToken: () => string;
  maxInFlightCommands: number;
  sendCommandAck: (
    event: Omit<DesktopCommandAckEvent, keyof EnvelopeFields>
  ) => void;
  sendCommandEvent: (
    event: Omit<DesktopCommandStreamEvent, keyof EnvelopeFields>
  ) => void;
  onQueueStatsChange?: (stats: {
    activeCommands: number;
    queueDepth: number;
  }) => void;
  commandSignatureVerifier?: CommandSignatureVerifier;
  isCommandSigningEnforced?: () => boolean;
  prepareCommandForExecution?: (
    command: DesktopCommandEvent
  ) => Promise<DesktopCommandEvent>;
};

export class CloudCommandExecutor {
  private readonly options: CloudCommandExecutorOptions;
  private readonly queue: DesktopCommandEvent[] = [];
  private readonly inFlightByCommandId = new Map<string, RunningCommand>();
  private readonly lockOwners = new Map<string, string>();
  private readonly trackedByCommandId = new Map<string, TrackedCommand>();
  private connected = false;
  private disposed = false;
  private lastEmittedStats: {
    activeCommands: number;
    queueDepth: number;
  } | null = null;

  constructor(options: CloudCommandExecutorOptions) {
    this.options = options;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected) {
      this.schedule();
    }
  }

  enqueue(command: DesktopCommandEvent): void {
    this.pruneTerminalCommands();

    const existing = this.trackedByCommandId.get(command.commandId);
    if (existing) {
      this.options.sendCommandAck({
        commandId: command.commandId,
        accepted: true,
        state: "accepted",
      });
      if (existing.state === "terminal") {
        this.replayBuffered(command.commandId, 0);
      }
      return;
    }

    const signatureBodyOverride = getSignatureBodyOverride(command);
    if (this.options.isCommandSigningEnforced?.()) {
      const verification = this.options.commandSignatureVerifier?.verify(
        command,
        signatureBodyOverride
      ) ?? {
        ok: false as const,
        reason: COMMAND_SIGNING_REJECTION_REASONS.noKeysAuthorized,
      };
      if (!verification.ok) {
        gatewayLog.warn(
          "command-executor",
          `Rejected command ${command.commandId}: ${verification.reason}`
        );
        this.options.sendCommandAck({
          commandId: command.commandId,
          accepted: false,
          state: "failed",
          reason: verification.reason,
        });
        return;
      }
    } else if (
      command.signature ||
      command.signaturePayload ||
      command.publicKeyFingerprint
    ) {
      gatewayLog.debug(
        "command-executor",
        `Ignoring command signature fields for ${command.commandId}; server support is disabled`
      );
    }

    const validationError = validateCommand(command);
    if (validationError) {
      gatewayLog.warn(
        "command-executor",
        `Rejected command ${command.commandId}: ${validationError}`
      );
      this.options.sendCommandAck({
        commandId: command.commandId,
        accepted: false,
        state: "failed",
        reason: validationError,
      });
      return;
    }

    gatewayLog.debug(
      "command-executor",
      `Enqueued command ${command.commandId}: ${command.method} ${command.path}`
    );
    const tracked: TrackedCommand = {
      command,
      state: "queued",
      enqueuedAt: Date.now(),
      lastEmittedSequence: 0,
      buffered: {
        lastAckedSequence: 0,
        events: [],
      },
    };
    this.trackedByCommandId.set(command.commandId, tracked);
    this.queue.push(command);
    this.options.sendCommandAck({
      commandId: command.commandId,
      accepted: true,
      state: "accepted",
    });
    Observability.commandInitiated(command.commandId, command.operationId);
    this.schedule();
  }

  cancel(cancelEvent: DesktopCancelEvent): void {
    const queuedIndex = this.queue.findIndex(
      (item) => item.commandId === cancelEvent.commandId
    );
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.emitTrackedEvent(cancelEvent.commandId, "done", {
        type: "done",
        cancelled: true,
        reason: cancelEvent.reason ?? "cancelled",
      });
      this.markTerminal(cancelEvent.commandId, "cancelled");
      this.notifyQueueStats();
      return;
    }

    const running = this.inFlightByCommandId.get(cancelEvent.commandId);
    if (!running) {
      return;
    }

    running.cancelRequested = true;
    running.cancelReason = cancelEvent.reason ?? "cancelled";
    running.abortController.abort("cancelled");
  }

  acknowledge(ackEvent: DesktopCommandStreamAckEvent): void {
    const tracked = this.trackedByCommandId.get(ackEvent.commandId);
    if (!tracked) {
      return;
    }
    tracked.buffered.lastAckedSequence = Math.max(
      tracked.buffered.lastAckedSequence,
      ackEvent.sequence
    );
    if (tracked.state === "terminal") {
      return;
    }
    tracked.buffered.events = tracked.buffered.events.filter(
      (event) => event.sequence > tracked.buffered.lastAckedSequence
    );
  }

  replayFrom(resumeFromSequence: Record<string, number>): void {
    for (const [commandId, fromSequence] of Object.entries(
      resumeFromSequence
    )) {
      this.replayBuffered(
        commandId,
        Number.isFinite(fromSequence) ? Math.trunc(fromSequence) : 0
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const running of this.inFlightByCommandId.values()) {
      if (running.timeout) {
        clearTimeout(running.timeout);
      }
      running.abortController.abort("shutdown");
    }
    this.queue.length = 0;
    this.inFlightByCommandId.clear();
    this.lockOwners.clear();
    this.trackedByCommandId.clear();
    // Intentionally do not call notifyQueueStats() here: dispose() runs during
    // app shutdown after Observability has already been torn down, and the
    // app-level debounce has already been cancelled. Emitting a final {0,0}
    // would re-arm that debounce timer and cause a telemetry call after
    // Observability.shutdown() has returned.
  }

  getStats(): { activeCommands: number; queueDepth: number } {
    return {
      activeCommands: this.inFlightByCommandId.size,
      queueDepth: this.queue.length,
    };
  }

  private schedule(): void {
    if (!this.connected) {
      return;
    }
    while (
      this.inFlightByCommandId.size <
      Math.max(1, this.options.maxInFlightCommands)
    ) {
      const nextIndex = this.queue.findIndex((candidate) => {
        const lockKey = deriveLockKey(candidate);
        if (!lockKey) {
          return true;
        }
        return !this.lockOwners.has(lockKey);
      });
      if (nextIndex < 0) {
        break;
      }

      const next = this.queue.splice(nextIndex, 1)[0];
      void this.execute(next);
    }
    this.notifyQueueStats();
  }

  private async execute(command: DesktopCommandEvent): Promise<void> {
    const tracked = this.trackedByCommandId.get(command.commandId);
    if (!tracked) {
      return;
    }
    tracked.state = "running";
    gatewayLog.debug(
      "command-executor",
      `Executing command ${command.commandId}: ${command.method} ${command.path}`
    );

    const lockKey = deriveLockKey(command);
    if (lockKey) {
      this.lockOwners.set(lockKey, command.commandId);
    }

    const abortController = new AbortController();
    const running: RunningCommand = {
      lockKey,
      abortController,
      cancelRequested: false,
    };
    if (typeof command.timeoutMs === "number" && command.timeoutMs > 0) {
      running.timeout = setTimeout(() => {
        running.timedOut = true;
        abortController.abort("timeout");
      }, command.timeoutMs);
    }
    this.inFlightByCommandId.set(command.commandId, running);
    this.notifyQueueStats();

    this.emitTrackedEvent(command.commandId, "status", {
      type: "status",
      status: "running",
      operationId: command.operationId,
    });
    Observability.commandStarted(command.commandId, command.operationId);

    try {
      const preparedCommand = this.options.prepareCommandForExecution
        ? await this.options.prepareCommandForExecution(command)
        : command;
      await this.executeViaGateway(preparedCommand, abortController.signal);
      if (!isTerminalState(tracked.terminalState)) {
        this.emitTrackedEvent(command.commandId, "done", { type: "done" });
        Observability.commandCompleted(
          command.commandId,
          command.operationId,
          Date.now() - tracked.enqueuedAt
        );
        this.markTerminal(command.commandId, "done");
      }
    } catch (error) {
      if (this.disposed) {
        this.markTerminal(command.commandId, "failed");
        return;
      }

      if (running.cancelRequested) {
        this.emitTrackedEvent(command.commandId, "done", {
          type: "done",
          cancelled: true,
          reason: running.cancelReason ?? "cancelled",
        });
        gatewayLog.debug(
          "command-executor",
          `Command ${command.commandId} cancelled`
        );
        Observability.commandCancelled(command.commandId, command.operationId);
        this.markTerminal(command.commandId, "cancelled");
      } else if (running.timedOut) {
        this.emitTrackedEvent(command.commandId, "error", {
          type: "error",
          terminal: true,
          code: "timeout",
          error: "command timed out",
        });
        gatewayLog.error(
          "command-executor",
          `Command ${command.commandId} timed out`
        );
        Observability.commandTimedOut(command.commandId, command.operationId);
        this.markTerminal(command.commandId, "failed");
      } else {
        const msg =
          error instanceof Error ? error.message : "unknown command failure";
        this.emitTrackedEvent(command.commandId, "error", {
          type: "error",
          terminal: true,
          error: msg,
        });
        gatewayLog.error(
          "command-executor",
          `Command ${command.commandId} failed: ${msg}`
        );
        Observability.commandFailed(
          command.commandId,
          command.operationId,
          msg
        );
        this.markTerminal(command.commandId, "failed");
      }
    } finally {
      if (running.timeout) {
        clearTimeout(running.timeout);
      }
      this.inFlightByCommandId.delete(command.commandId);
      if (lockKey) {
        this.lockOwners.delete(lockKey);
      }
      this.schedule();
    }
  }

  private async executeViaGateway(
    command: DesktopCommandEvent,
    signal: AbortSignal
  ): Promise<void> {
    const port = this.options.getGatewayPort();
    const requestUrl = new URL(command.path, `http://127.0.0.1:${port}`);
    applyQuery(requestUrl, command.query);

    const headers = new Headers(command.headers);
    headers.set("x-desktop-gateway-token", this.options.getGatewayAuthToken());
    headers.set("x-desktop-source", "cloud-socket");
    if (isValidUuid(command.commandId)) {
      headers.set("x-desktop-command-id", command.commandId);
    }
    if (isSafeHeaderValue(command.operationId)) {
      headers.set("x-desktop-operation-id", command.operationId);
    }
    if (command.requiresApproval) {
      headers.set("x-desktop-force-approval", "1");
      if (command.approvalReason) {
        headers.set("x-desktop-approval-reason", command.approvalReason);
      }
    }

    const method = command.method.toUpperCase();
    const body = serializeBody(command.body, headers, method);

    gatewayLog.debug(
      "command-executor",
      `Gateway fetch: ${method} ${requestUrl.pathname}`
    );
    const response = await fetch(requestUrl, {
      method,
      headers,
      body,
      signal,
    });
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    const isStream =
      contentType.includes("text/event-stream") ||
      contentType.includes("application/x-ndjson");

    if (!(response.ok || isStream)) {
      const message = await safeReadBodyAsText(response);
      gatewayLog.error(
        "command-executor",
        `Gateway returned ${response.status} for ${method} ${requestUrl.pathname}: ${message}`
      );
      throw new Error(
        `gateway returned ${response.status}${message ? `: ${message}` : ""}`
      );
    }

    if (isStream) {
      await this.consumeStreamResponse(command.commandId, response);
      return;
    }

    const payload = await parseNonStreamingBody(response);
    this.emitTrackedEvent(command.commandId, "result", {
      type: "result",
      statusCode: response.status,
      success: response.ok,
      data: payload,
    });
    this.emitTrackedEvent(command.commandId, "done", { type: "done" });
    this.markTerminal(command.commandId, "done");
  }

  private async consumeStreamResponse(
    commandId: string,
    response: Response
  ): Promise<void> {
    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let emittedTerminal = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (this.processStreamLine(commandId, trimmed)) {
          emittedTerminal = true;
        }
      }
    }

    const trailing = buffer.trim();
    if (trailing && this.processStreamLine(commandId, trailing)) {
      emittedTerminal = true;
    }

    if (!emittedTerminal) {
      this.emitTrackedEvent(commandId, "done", { type: "done" });
      this.markTerminal(commandId, "done");
    }
  }

  /** Emit a mapped stream line event. Returns true if the event was terminal. */
  private processStreamLine(commandId: string, line: string): boolean {
    const mapped = mapGatewayLineToCommandEvent(line);
    this.emitTrackedEvent(commandId, mapped.eventType, mapped.data);
    if (isTerminalEvent(mapped.eventType, mapped.data)) {
      this.markTerminal(
        commandId,
        resolveTerminalState(mapped.eventType, mapped.data)
      );
      return true;
    }
    return false;
  }

  private emitTrackedEvent(
    commandId: string,
    eventType: DesktopCommandStreamEvent["eventType"],
    data: unknown
  ): void {
    const tracked = this.trackedByCommandId.get(commandId);
    if (!tracked) {
      return;
    }
    if (tracked.state === "terminal") {
      return;
    }

    const sequence = tracked.lastEmittedSequence + 1;
    tracked.lastEmittedSequence = sequence;
    const record: CommandEventRecord = {
      sequence,
      eventType,
      data,
    };
    tracked.buffered.events.push(record);
    this.options.sendCommandEvent({
      commandId,
      sequence,
      eventType,
      data,
    });
  }

  private markTerminal(commandId: string, state: TerminalCommandState): void {
    const tracked = this.trackedByCommandId.get(commandId);
    if (!tracked || tracked.state === "terminal") {
      return;
    }
    tracked.state = "terminal";
    tracked.terminalState = state;
    tracked.completedAt = Date.now();
  }

  private replayBuffered(commandId: string, fromSequence: number): void {
    const tracked = this.trackedByCommandId.get(commandId);
    if (!tracked) {
      return;
    }
    for (const event of tracked.buffered.events) {
      if (event.sequence <= fromSequence) {
        continue;
      }
      this.options.sendCommandEvent({
        commandId,
        sequence: event.sequence,
        eventType: event.eventType,
        data: event.data,
      });
    }
  }

  private notifyQueueStats(): void {
    const stats = this.getStats();
    // Skip the callback when neither counter changed. schedule() is called on
    // every setConnected(true) and every execute() boundary, so without this
    // guard an idle reconnect would emit a spurious 0/0 telemetry event that
    // does not correspond to a real queue mutation.
    if (
      this.lastEmittedStats &&
      this.lastEmittedStats.activeCommands === stats.activeCommands &&
      this.lastEmittedStats.queueDepth === stats.queueDepth
    ) {
      return;
    }
    this.lastEmittedStats = stats;
    this.options.onQueueStatsChange?.(stats);
  }

  private pruneTerminalCommands(): void {
    const now = Date.now();
    const terminalEntries = [...this.trackedByCommandId.entries()].filter(
      ([, tracked]) => tracked.state === "terminal"
    );

    for (const [commandId, tracked] of terminalEntries) {
      if (!tracked.completedAt) {
        continue;
      }
      if (now - tracked.completedAt > COMMAND_RETENTION_MS) {
        this.trackedByCommandId.delete(commandId);
      }
    }

    const remainingTerminal = [...this.trackedByCommandId.entries()]
      .filter(([, tracked]) => tracked.state === "terminal")
      .sort(
        (a, b) =>
          (a[1].completedAt ?? Number.MAX_SAFE_INTEGER) -
          (b[1].completedAt ?? Number.MAX_SAFE_INTEGER)
      );
    while (remainingTerminal.length > MAX_RETAINED_TERMINAL_COMMANDS) {
      const [commandId] = remainingTerminal.shift() as [string, TrackedCommand];
      this.trackedByCommandId.delete(commandId);
    }
  }
}

type EnvelopeFields = ProtocolEnvelope;

type BufferedCommandEvents = {
  lastAckedSequence: number;
  events: CommandEventRecord[];
};

type TerminalCommandState = "done" | "failed" | "cancelled";

type TrackedCommand = {
  command: DesktopCommandEvent;
  state: "queued" | "running" | "terminal";
  terminalState?: TerminalCommandState;
  completedAt?: number;
  enqueuedAt: number;
  lastEmittedSequence: number;
  buffered: BufferedCommandEvents;
};

type RunningCommand = {
  lockKey: string | null;
  abortController: AbortController;
  cancelRequested: boolean;
  cancelReason?: string;
  timedOut?: boolean;
  timeout?: NodeJS.Timeout;
};

function validateCommand(command: DesktopCommandEvent): string | null {
  if (!command.commandId.trim()) {
    return "commandId is required";
  }
  if (!SUPPORTED_HTTP_METHODS.has(command.method.toUpperCase())) {
    return "unsupported method";
  }
  if (!command.path.startsWith("/api/gateway/")) {
    return "path must start with /api/gateway/";
  }
  return null;
}

const SUPPORTED_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

function deriveLockKey(command: DesktopCommandEvent): string | null {
  if (command.lockKey?.trim()) {
    return command.lockKey.trim();
  }

  const body = asRecord(command.body);
  const scopedPath =
    asNonEmptyString(body.repoPath) ??
    asNonEmptyString(body.worktreePath) ??
    asNonEmptyString(body.workDir) ??
    asNonEmptyString(body.runDir) ??
    asNonEmptyString(body.path);
  if (!scopedPath) {
    return null;
  }
  return `${command.operationId}:${scopedPath}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function getSignatureBodyOverride(command: DesktopCommandEvent): unknown {
  if (
    command.path === "/api/gateway/symphony/loop" ||
    command.path === "/api/gateway/symphony/loop/kill"
  ) {
    const body = asRecord(command.body);
    if (body.userIntent !== undefined) {
      return body.userIntent;
    }
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim();
}

function applyQuery(url: URL, query: DesktopCommandEvent["query"]): void {
  if (!query) {
    return;
  }
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
      continue;
    }
    url.searchParams.set(key, value);
  }
}

function serializeBody(
  body: unknown,
  headers: Headers,
  method: string
): string | undefined {
  if (method === "GET") {
    return undefined;
  }
  if (body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return JSON.stringify(body);
}

async function safeReadBodyAsText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function parseNonStreamingBody(response: Response): Promise<unknown> {
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return await safeReadBodyAsText(response);
}

function mapGatewayLineToCommandEvent(line: string): {
  eventType: DesktopCommandStreamEvent["eventType"];
  data: unknown;
} {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "status") {
      return { eventType: "status", data: parsed };
    }
    if (type === "error") {
      return { eventType: "error", data: parsed };
    }
    if (type === "result") {
      return { eventType: "result", data: parsed };
    }
    if (type === "done") {
      return { eventType: "done", data: parsed };
    }
    return { eventType: "chunk", data: parsed };
  } catch {
    return {
      eventType: "chunk",
      data: {
        type: "text",
        content: line,
      },
    };
  }
}

function isTerminalEvent(
  eventType: DesktopCommandStreamEvent["eventType"],
  data: unknown
): boolean {
  if (eventType === "done") {
    return true;
  }
  if (eventType !== "error" && eventType !== "result") {
    return false;
  }
  const record = asRecord(data);
  return record.terminal === true;
}

function resolveTerminalState(
  eventType: DesktopCommandStreamEvent["eventType"],
  data: unknown
): TerminalCommandState {
  if (eventType === "done") {
    const record = asRecord(data);
    return record.cancelled === true ? "cancelled" : "done";
  }
  if (eventType === "result") {
    return "done";
  }
  return "failed";
}

function isTerminalState(state: TerminalCommandState | undefined): boolean {
  return state !== undefined;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/** Allow any non-empty printable ASCII string without CRLF (header injection guard). */
const SAFE_HEADER_VALUE_REGEX = /^[\x20-\x7e]+$/;

function isSafeHeaderValue(value: string): boolean {
  return SAFE_HEADER_VALUE_REGEX.test(value);
}
