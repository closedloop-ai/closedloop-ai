import { describe, expect, it } from "vitest";
import {
  isKeylessTelemetrySignal,
  KEYLESS_TELEMETRY_CONTENT_TYPE,
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  KEYLESS_TELEMETRY_NAMESPACE,
  KeylessTelemetryRejectionReason,
  KeylessTelemetrySignal,
  keylessTelemetrySignalPath,
  validateKeylessTelemetryEnvelope,
  validateKeylessTelemetrySessionRequest,
} from "../keyless-telemetry";

function bytes(n: number): Uint8Array {
  return new Uint8Array(n);
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-123",
    signal: KeylessTelemetrySignal.Traces,
    contentType: KEYLESS_TELEMETRY_CONTENT_TYPE,
    body: bytes(8),
    ...overrides,
  };
}

describe("keyless telemetry contract constants", () => {
  it("uses the dedicated telemetry namespace, separate from /desktop-gateway", () => {
    expect(KEYLESS_TELEMETRY_NAMESPACE).toBe("/telemetry");
    expect(KEYLESS_TELEMETRY_NAMESPACE).not.toBe("/desktop-gateway");
  });

  it("exposes stable handshake/export event names", () => {
    expect(KEYLESS_TELEMETRY_HANDSHAKE_EVENT).toBe("telemetry.session.create");
    expect(KEYLESS_TELEMETRY_EXPORT_EVENT).toBe("telemetry.otlp.export");
  });

  it("enumerates the closed rejection reasons", () => {
    expect(Object.values(KeylessTelemetryRejectionReason)).toEqual(
      expect.arrayContaining([
        "invalid_request",
        "invalid_session",
        "rate_limited",
        "at_capacity",
        "payload_too_large",
        "unsupported_signal",
        "invalid_content_type",
        "request_timeout",
        "collector_unavailable",
        "otlp_rejected",
      ])
    );
  });
});

describe("signal classification", () => {
  it("accepts the three OTLP signals and rejects anything else", () => {
    expect(isKeylessTelemetrySignal("traces")).toBe(true);
    expect(isKeylessTelemetrySignal("metrics")).toBe(true);
    expect(isKeylessTelemetrySignal("logs")).toBe(true);
    expect(isKeylessTelemetrySignal("profiles")).toBe(false);
    expect(isKeylessTelemetrySignal("")).toBe(false);
    expect(isKeylessTelemetrySignal(7)).toBe(false);
  });

  it("maps each signal to its /v1 collector path", () => {
    expect(keylessTelemetrySignalPath(KeylessTelemetrySignal.Traces)).toBe(
      "/v1/traces"
    );
    expect(keylessTelemetrySignalPath(KeylessTelemetrySignal.Metrics)).toBe(
      "/v1/metrics"
    );
    expect(keylessTelemetrySignalPath(KeylessTelemetrySignal.Logs)).toBe(
      "/v1/logs"
    );
  });
});

describe("validateKeylessTelemetrySessionRequest", () => {
  it("accepts a minimal request and omits absent optionals (never null)", () => {
    const result = validateKeylessTelemetrySessionRequest({
      appInstallationId: "install-abc",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.appInstallationId).toBe("install-abc");
      expect("serviceVersion" in result.request).toBe(false);
      expect("deploymentEnvironmentName" in result.request).toBe(false);
    }
  });

  it("accepts the optional attribution fields when present", () => {
    const result = validateKeylessTelemetrySessionRequest({
      appInstallationId: "install-abc",
      serviceVersion: "1.2.3",
      deploymentEnvironmentName: "production",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.serviceVersion).toBe("1.2.3");
    }
  });

  it("rejects unknown fields", () => {
    const result = validateKeylessTelemetrySessionRequest({
      appInstallationId: "install-abc",
      apiKey: "sk_live_should_not_be_here",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        KeylessTelemetryRejectionReason.InvalidRequest
      );
    }
  });

  it("rejects a missing/empty install id", () => {
    expect(validateKeylessTelemetrySessionRequest({}).ok).toBe(false);
    expect(
      validateKeylessTelemetrySessionRequest({ appInstallationId: "" }).ok
    ).toBe(false);
  });
});

describe("validateKeylessTelemetryEnvelope (opaque body, no decode)", () => {
  it("accepts a well-formed envelope and returns the body untouched", () => {
    const body = bytes(16);
    const result = validateKeylessTelemetryEnvelope(envelope({ body }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.signal).toBe("traces");
      expect(result.envelope.body).toBe(body);
    }
  });

  it("accepts metrics and logs signals", () => {
    for (const signal of ["metrics", "logs"] as const) {
      expect(validateKeylessTelemetryEnvelope(envelope({ signal })).ok).toBe(
        true
      );
    }
  });

  it("rejects a non-protobuf content type", () => {
    const result = validateKeylessTelemetryEnvelope(
      envelope({ contentType: "application/json" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        KeylessTelemetryRejectionReason.InvalidContentType
      );
    }
  });

  it("rejects an unsupported signal", () => {
    const result = validateKeylessTelemetryEnvelope(
      envelope({ signal: "profiles" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        KeylessTelemetryRejectionReason.UnsupportedSignal
      );
    }
  });

  it("rejects an oversized body", () => {
    const result = validateKeylessTelemetryEnvelope(
      envelope({ body: bytes(KEYLESS_TELEMETRY_MAX_BODY_BYTES + 1) })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        KeylessTelemetryRejectionReason.PayloadTooLarge
      );
    }
  });

  it("respects a caller-provided smaller max body size", () => {
    const result = validateKeylessTelemetryEnvelope(
      envelope({ body: bytes(64) }),
      32
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        KeylessTelemetryRejectionReason.PayloadTooLarge
      );
    }
  });

  it("rejects malformed envelopes (missing/!Uint8Array body, extra fields)", () => {
    const cases: unknown[] = [
      null,
      "nope",
      { ...envelope(), body: undefined },
      { ...envelope(), body: "not-bytes" },
      { ...envelope(), extra: true },
      { signal: "traces", contentType: KEYLESS_TELEMETRY_CONTENT_TYPE },
    ];
    for (const value of cases) {
      const result = validateKeylessTelemetryEnvelope(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(
          KeylessTelemetryRejectionReason.InvalidRequest
        );
      }
    }
  });

  it("checks content type before signal before size (deterministic ordering)", () => {
    // All three are wrong; content-type is reported first.
    const result = validateKeylessTelemetryEnvelope(
      envelope({
        contentType: "text/plain",
        signal: "nope",
        body: bytes(KEYLESS_TELEMETRY_MAX_BODY_BYTES + 1),
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        KeylessTelemetryRejectionReason.InvalidContentType
      );
    }
  });
});
