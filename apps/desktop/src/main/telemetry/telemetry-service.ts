import { Buffer } from "node:buffer";
import {
  TELEMETRY_MAX_FIELD_BYTES,
  type TelemetryEventPayload,
} from "./telemetry-protocol.js";

/** Enriched event with schemaVersion and timestamp always populated by TelemetryService. */
export type EnrichedTelemetryEvent = TelemetryEventPayload & {
  schemaVersion: string;
  timestamp: string;
};

export type TelemetryServiceOptions = {
  sendTelemetry: (event: EnrichedTelemetryEvent) => void;
  /**
   * ISS-9743 — the commit this bundle was built from, already validated by
   * `resolveDesktopBuildCommit`. Absent when the process cannot resolve one, in
   * which case the trace key stays omitted rather than carrying a placeholder.
   */
  desktopBuildCommit?: string;
};

/**
 * Fire-and-forget telemetry emitter.
 *
 * TelemetryService wraps the raw sendTelemetry transport callback with:
 * - computeTargetId auto-injection into every event's trace context
 * - desktopBuildCommit auto-injection (ISS-9743), for the same reason: it is a
 *   per-process constant, so every category carries it rather than the handful
 *   whose call sites happen to build a trace
 * - logTail truncation to TELEMETRY_MAX_FIELD_BYTES (4 KiB)
 * - try/catch so emit() never throws regardless of callback behavior
 *
 * Used internally by the Observability facade — not imported directly
 * by call sites.
 */
export class TelemetryService {
  private readonly options: TelemetryServiceOptions;
  private readonly desktopBuildCommit: string | undefined;
  private computeTargetId: string | undefined;
  private gatewaySessionId: string | undefined;

  constructor(options: TelemetryServiceOptions) {
    this.options = options;
    this.desktopBuildCommit = options.desktopBuildCommit;
  }

  /**
   * Store the computeTargetId received from the relay hello-ack.
   * Subsequent emit() calls will inject this into trace.computeTargetId.
   */
  setTargetId(id: string): void {
    this.computeTargetId = id;
  }

  /**
   * Store the gateway session ID from the cloud socket connection.
   * Subsequent emit() calls will inject this into trace.gatewaySessionId.
   */
  setGatewaySessionId(id: string): void {
    this.gatewaySessionId = id;
  }

  /**
   * Emit a telemetry event. Never throws.
   *
   * - Injects computeTargetId into trace if one has been set via setTargetId()
   * - Truncates diagnostics.logTail to TELEMETRY_MAX_FIELD_BYTES if present
   * - All errors from the sendTelemetry callback are swallowed silently
   */
  emit(event: TelemetryEventPayload): void {
    try {
      const enrichedEvent = this.enrichEvent(event);
      this.options.sendTelemetry(enrichedEvent);
    } catch {
      // Swallow all errors per AC-006: TelemetryService never throws
    }
  }

  private enrichEvent(event: TelemetryEventPayload): EnrichedTelemetryEvent {
    let trace = event.trace;

    if (this.computeTargetId || this.gatewaySessionId) {
      trace = {
        ...event.trace,
        ...(this.computeTargetId
          ? { computeTargetId: this.computeTargetId }
          : {}),
        ...(this.gatewaySessionId
          ? { gatewaySessionId: this.gatewaySessionId }
          : {}),
      };
    }

    let diagnostics = event.diagnostics;
    if (diagnostics?.logTail) {
      diagnostics = {
        ...diagnostics,
        logTail: truncateToBytes(
          diagnostics.logTail,
          TELEMETRY_MAX_FIELD_BYTES
        ),
      };
    }
    if (diagnostics?.stderrTail) {
      diagnostics = {
        ...diagnostics,
        stderrTail: truncateToBytes(
          diagnostics.stderrTail,
          TELEMETRY_MAX_FIELD_BYTES
        ),
      };
    }

    // Pulled out of the spread rather than read from `trace` below — see the
    // note on the conditional. Named `resolved`, not `caller`: the block above
    // has already merged the SERVICE's session over the caller's, deliberately,
    // because the gateway session identifies this process rather than whoever
    // is emitting.
    const {
      gatewaySessionId: resolvedGatewaySessionId,
      // ISS-9743: destructured OUT for the same reason as gatewaySessionId — a
      // caller forwarding an absent value puts the key on the object, and a
      // conditional spread after it can add a key but cannot remove one.
      desktopBuildCommit: _callerBuildCommit,
      ...restTrace
    } = trace ?? {};
    const gatewaySessionId = resolvedGatewaySessionId ?? this.gatewaySessionId;

    return {
      ...event,
      schemaVersion: "1",
      timestamp: new Date().toISOString(),
      // ISS-7488: the caller's trace spreads FIRST and the three fields the
      // cloud schema requires are applied after it, so they always win. Every
      // member of `TelemetryTraceContext` is optional, and a caller that
      // forwards an absent value (`commandId: args.commandId`) puts the key on
      // the object holding `undefined` — spreading that last used to clobber
      // the default back off, and `trace.commandId: z.string()` then rejected
      // the WHOLE event as `telemetry.validation_failed`.
      trace: {
        ...restTrace,
        commandId: trace?.commandId ?? "",
        operationId: trace?.operationId ?? "",
        computeTargetId: trace?.computeTargetId ?? this.computeTargetId ?? "",
        // Conditional so an absent session stays OMITTED rather than carried as
        // an explicit `undefined` key (root AGENTS.md, Cross-Repo
        // Compatibility). `gatewaySessionId` is destructured OUT of the spread
        // above for that to actually hold: a caller forwarding an absent value
        // (`gatewaySessionId: args.sessionId`) puts the key on the object, and a
        // conditional spread AFTER it can add a key but cannot remove one — so
        // spreading the caller wholesale would leave the very
        // present-but-undefined key this branch exists to avoid. That is the
        // same defect ISS-7488 fixes for the three required fields, one field
        // over, and it is why this is a destructure and not another `??`.
        ...(gatewaySessionId ? { gatewaySessionId } : {}),
        // ISS-9743: the build identity describes THIS process, so the service's
        // value wins over a caller's — the same rule gatewaySessionId follows
        // one field above. Conditional so an unresolved commit stays omitted.
        ...(this.desktopBuildCommit
          ? { desktopBuildCommit: this.desktopBuildCommit }
          : {}),
      },
      diagnostics,
    };
  }
}

/**
 * Truncate a UTF-8 string to at most maxBytes bytes.
 * Splits on newline boundaries to avoid cutting mid-line where possible,
 * but falls back to raw byte truncation if the string is single-line.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) {
    return value;
  }
  // Take the last maxBytes bytes from the tail (most recent log lines)
  const tail = encoded.subarray(encoded.length - maxBytes);
  // The tail may start mid-codepoint or mid-line; drop up to the first newline
  const newlineIndex = tail.indexOf(0x0a); // 0x0a = '\n'
  const trimmed = newlineIndex >= 0 ? tail.subarray(newlineIndex + 1) : tail;
  return trimmed.toString("utf8");
}
