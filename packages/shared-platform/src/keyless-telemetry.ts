/**
 * Keyless telemetry-only relay session contract (FEA-1989 / PRD-481 C1).
 *
 * Surface-neutral, framework-agnostic constants + Zod schemas + pure
 * validation helpers for the unauthenticated, telemetry-only relay session.
 * Produced by the relay (C1) and consumed by the desktop keyless exporter
 * (C5 / FEA-1993) — so it lives in the published `@closedloop-ai/shared-platform`
 * package, never depends on `@repo/api`, and carries no Node/Next/browser
 * globals.
 *
 * Transport model: the client connects to the relay's dedicated Socket.IO
 * `/telemetry` namespace, creates a short-lived session, then emits OTLP
 * protobuf wrapped in a relay telemetry event. The relay forwards the body
 * **opaque** (it does not decode protobuf); payload-content validation is owned
 * by the downstream OTel Collector (C2 / FEA-1990). This contract therefore
 * treats the envelope `body` as opaque bytes and only validates the envelope
 * shape.
 *
 * Connection topology is the client's choice and does not affect this contract:
 * the namespace can be multiplexed over an existing relay connection OR carried
 * on a dedicated connection to the same relay origin. The desktop keyless
 * exporter (C5 / FEA-1993) uses a dedicated, isolated `/telemetry` connection so
 * telemetry uptime is independent of the authenticated `/desktop-gateway`
 * client's reconnect/PoP lifecycle. Either topology preserves PRD-481's egress
 * invariant — all telemetry is relay-mediated to a single destination (the
 * relay), never a direct desktop→Collector egress.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Namespace + event names
// ---------------------------------------------------------------------------

/**
 * Dedicated Socket.IO namespace for keyless telemetry, separate from the
 * authenticated `/desktop-gateway` namespace. The client may multiplex it over
 * an existing relay connection or use a dedicated connection to the same relay
 * origin (see the transport-model note above); both keep egress relay-mediated
 * to a single destination, honoring PRD-481's invariant.
 */
export const KEYLESS_TELEMETRY_NAMESPACE = "/telemetry";

/** Handshake event: client → relay, creates a short-lived telemetry session. */
export const KEYLESS_TELEMETRY_HANDSHAKE_EVENT = "telemetry.session.create";

/** Export event: client → relay, carries one OTLP protobuf export. */
export const KEYLESS_TELEMETRY_EXPORT_EVENT = "telemetry.otlp.export";

/** The only content type the relay accepts for the opaque OTLP body. */
export const KEYLESS_TELEMETRY_CONTENT_TYPE = "application/x-protobuf";

// ---------------------------------------------------------------------------
// Session / security constants
// ---------------------------------------------------------------------------

/** Session lifetime before a client must re-handshake. */
export const KEYLESS_TELEMETRY_SESSION_TTL_MS = 5 * 60 * 1000;

/** Hard cap on a single OTLP export body (raw bytes). */
export const KEYLESS_TELEMETRY_MAX_BODY_BYTES = 512 * 1024;

/** Process-wide ceiling on concurrent live keyless sessions (DoS guard). */
export const KEYLESS_TELEMETRY_MAX_ACTIVE_SESSIONS = 10_000;

/** Per-session export rate limit (events/minute). */
export const KEYLESS_TELEMETRY_SESSION_RATE_LIMIT_PER_MINUTE = 120;

/** Per-`appInstallationId` export rate limit (events/minute). */
export const KEYLESS_TELEMETRY_INSTALLATION_RATE_LIMIT_PER_MINUTE = 300;

/** Per-IP rate limit, applied to both handshakes and exports (events/minute). */
export const KEYLESS_TELEMETRY_IP_RATE_LIMIT_PER_MINUTE = 600;

/** Bounded timeout for the relay → collector proxy fetch. */
export const KEYLESS_TELEMETRY_COLLECTOR_TIMEOUT_MS = 5000;

/** Cap on captured collector error/diagnostic bytes (never forwarded to clients). */
export const KEYLESS_TELEMETRY_COLLECTOR_DIAGNOSTIC_MAX_BYTES = 1024;

/** Retry-after hint (seconds) returned with retryable `collector_unavailable`. */
export const KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS = 30;

// ---------------------------------------------------------------------------
// OTLP signal kinds (const object, not an enum). Values mirror the desktop
// receiver's `OtlpExportKind` so the same payloads classify identically.
// ---------------------------------------------------------------------------

export const KeylessTelemetrySignal = {
  Traces: "traces",
  Metrics: "metrics",
  Logs: "logs",
} as const;

export type KeylessTelemetrySignal =
  (typeof KeylessTelemetrySignal)[keyof typeof KeylessTelemetrySignal];

const ACCEPTED_SIGNALS: readonly KeylessTelemetrySignal[] = [
  KeylessTelemetrySignal.Traces,
  KeylessTelemetrySignal.Metrics,
  KeylessTelemetrySignal.Logs,
];

export function isKeylessTelemetrySignal(
  value: unknown
): value is KeylessTelemetrySignal {
  return (
    typeof value === "string" &&
    ACCEPTED_SIGNALS.includes(value as KeylessTelemetrySignal)
  );
}

/**
 * The OTLP/HTTP collector path for a signal (`/v1/traces`, `/v1/metrics`,
 * `/v1/logs`). The relay appends this to its fixed `RELAY_OTLP_COLLECTOR_URL`
 * origin; the value is constrained to this allowlist and never client-derived.
 */
export function keylessTelemetrySignalPath(
  signal: KeylessTelemetrySignal
): string {
  return `/v1/${signal}`;
}

// ---------------------------------------------------------------------------
// Closed rejection reasons (const object, not an enum).
// ---------------------------------------------------------------------------

export const KeylessTelemetryRejectionReason = {
  /** Malformed handshake or envelope shape. */
  InvalidRequest: "invalid_request",
  /** Missing, unknown, or expired session token. */
  InvalidSession: "invalid_session",
  /** Per-session / per-install / per-IP rate limit hit. */
  RateLimited: "rate_limited",
  /** Concurrent live-session ceiling reached. */
  AtCapacity: "at_capacity",
  /** Body exceeds the max size. */
  PayloadTooLarge: "payload_too_large",
  /** `signal` not one of traces/metrics/logs. */
  UnsupportedSignal: "unsupported_signal",
  /** Content type is not `application/x-protobuf`. */
  InvalidContentType: "invalid_content_type",
  /** Collector did not respond within the bounded timeout. */
  RequestTimeout: "request_timeout",
  /** Collector unconfigured / network failure / 5xx. */
  CollectorUnavailable: "collector_unavailable",
  /** Collector rejected the payload (4xx) — content policy lives there. */
  OtlpRejected: "otlp_rejected",
} as const;

export type KeylessTelemetryRejectionReason =
  (typeof KeylessTelemetryRejectionReason)[keyof typeof KeylessTelemetryRejectionReason];

// ---------------------------------------------------------------------------
// Schemas — handshake request/response and export envelope/ack.
// ---------------------------------------------------------------------------

/**
 * Handshake request. `appInstallationId` carries the OTel `app.installation.id`
 * (PRD-479 `node_uuid`) — the anonymous, self-asserted per-install identity used
 * for rate-limit attribution only. Optional fields are omitted when absent
 * (never serialized as `null`). Unknown fields are rejected.
 */
export const keylessTelemetrySessionRequestSchema = z
  .object({
    appInstallationId: z.string().min(1).max(256),
    serviceVersion: z.string().min(1).max(128).optional(),
    deploymentEnvironmentName: z.string().min(1).max(128).optional(),
  })
  .strict();

export type KeylessTelemetrySessionRequest = z.infer<
  typeof keylessTelemetrySessionRequestSchema
>;

/** Handshake ack. Discriminated on `accepted`. */
export type KeylessTelemetrySessionAck =
  | {
      accepted: true;
      sessionId: string;
      exportEvent: typeof KEYLESS_TELEMETRY_EXPORT_EVENT;
      acceptedSignals: readonly KeylessTelemetrySignal[];
      maxBodyBytes: number;
      ttlMs: number;
    }
  | { accepted: false; reason: KeylessTelemetryRejectionReason };

/**
 * Export envelope. `body` is opaque OTLP protobuf bytes — the relay never
 * decodes it. Over Socket.IO this arrives as a Buffer (a `Uint8Array`).
 */
export const keylessTelemetryEnvelopeSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    signal: z.string().min(1).max(32),
    contentType: z.string().min(1).max(128),
    body: z.instanceof(Uint8Array),
  })
  .strict();

export type KeylessTelemetryEnvelope = {
  sessionId: string;
  signal: KeylessTelemetrySignal;
  contentType: string;
  body: Uint8Array;
};

/** Export ack. Discriminated on `accepted`. */
export type KeylessTelemetryExportAck =
  | { accepted: true }
  | {
      accepted: false;
      reason: KeylessTelemetryRejectionReason;
      retryAfterSeconds?: number;
    };

// ---------------------------------------------------------------------------
// Pure validation helpers. Return discriminated results carrying the precise
// closed rejection reason, so the relay can map straight to an ack.
// ---------------------------------------------------------------------------

export type KeylessTelemetrySessionValidation =
  | { ok: true; request: KeylessTelemetrySessionRequest }
  | { ok: false; reason: KeylessTelemetryRejectionReason };

export function validateKeylessTelemetrySessionRequest(
  value: unknown
): KeylessTelemetrySessionValidation {
  const parsed = keylessTelemetrySessionRequestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: KeylessTelemetryRejectionReason.InvalidRequest,
    };
  }
  return { ok: true, request: parsed.data };
}

export type KeylessTelemetryEnvelopeValidation =
  | { ok: true; envelope: KeylessTelemetryEnvelope }
  | { ok: false; reason: KeylessTelemetryRejectionReason };

/**
 * Validate the export envelope WITHOUT decoding the OTLP body. Checks shape,
 * content type, signal kind, and body byte length — in that order — returning
 * the precise closed reason. The body is returned untouched (opaque) for the
 * relay to forward as-is.
 */
export function validateKeylessTelemetryEnvelope(
  value: unknown,
  maxBodyBytes: number = KEYLESS_TELEMETRY_MAX_BODY_BYTES
): KeylessTelemetryEnvelopeValidation {
  const parsed = keylessTelemetryEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: KeylessTelemetryRejectionReason.InvalidRequest,
    };
  }
  const { sessionId, signal, contentType, body } = parsed.data;

  if (contentType !== KEYLESS_TELEMETRY_CONTENT_TYPE) {
    return {
      ok: false,
      reason: KeylessTelemetryRejectionReason.InvalidContentType,
    };
  }
  if (!isKeylessTelemetrySignal(signal)) {
    return {
      ok: false,
      reason: KeylessTelemetryRejectionReason.UnsupportedSignal,
    };
  }
  if (body.byteLength > maxBodyBytes) {
    return {
      ok: false,
      reason: KeylessTelemetryRejectionReason.PayloadTooLarge,
    };
  }

  return {
    ok: true,
    envelope: { sessionId, signal, contentType, body },
  };
}
