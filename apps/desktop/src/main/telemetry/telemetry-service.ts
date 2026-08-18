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
};

/**
 * Fire-and-forget telemetry emitter.
 *
 * TelemetryService wraps the raw sendTelemetry transport callback with:
 * - computeTargetId auto-injection into every event's trace context
 * - logTail truncation to TELEMETRY_MAX_FIELD_BYTES (4 KiB)
 * - try/catch so emit() never throws regardless of callback behavior
 *
 * Used internally by the Observability facade — not imported directly
 * by call sites.
 */
export class TelemetryService {
  private readonly options: TelemetryServiceOptions;
  private computeTargetId: string | undefined;
  private gatewaySessionId: string | undefined;

  constructor(options: TelemetryServiceOptions) {
    this.options = options;
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

    return {
      ...event,
      schemaVersion: "1",
      timestamp: new Date().toISOString(),
      trace: {
        commandId: "",
        operationId: "",
        computeTargetId: this.computeTargetId ?? "",
        ...(this.gatewaySessionId
          ? { gatewaySessionId: this.gatewaySessionId }
          : {}),
        ...trace,
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
