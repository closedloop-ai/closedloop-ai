import {
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  type KeylessTelemetryExportAck,
  type KeylessTelemetrySessionAck,
} from "@closedloop-ai/shared-platform/keyless-telemetry";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectClient,
  delay,
  type Harness,
  type KeylessClient,
  makeHarness,
} from "./keyless-harness";

const PROTOBUF = "application/x-protobuf";

const harnesses: Harness[] = [];
const clients: KeylessClient[] = [];

async function harness(
  ...args: Parameters<typeof makeHarness>
): Promise<Harness> {
  const h = await makeHarness(...args);
  harnesses.push(h);
  return h;
}

async function client(url: string): Promise<KeylessClient> {
  const c = await connectClient(url);
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) {
    c.disconnect();
  }
  for (const h of harnesses.splice(0)) {
    await h.close();
  }
});

function exportEnvelope(
  sessionId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    sessionId,
    signal: "traces",
    contentType: PROTOBUF,
    body: new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  };
}

async function openSession(
  c: KeylessClient,
  installId = "install-1"
): Promise<string> {
  const ack = await c.emit<KeylessTelemetrySessionAck>(
    KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
    { appInstallationId: installId }
  );
  if (!ack.accepted) {
    throw new Error(`handshake rejected: ${ack.reason}`);
  }
  return ack.sessionId;
}

describe("keyless telemetry ingress — handshake", () => {
  it("accepts a keyless handshake and returns a scoped session", async () => {
    const h = await harness();
    const c = await client(h.url);
    const ack = await c.emit<KeylessTelemetrySessionAck>(
      KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
      { appInstallationId: "install-1", serviceVersion: "1.0.0" }
    );
    expect(ack.accepted).toBe(true);
    if (ack.accepted) {
      expect(ack.sessionId).toBeTruthy();
      expect(ack.exportEvent).toBe(KEYLESS_TELEMETRY_EXPORT_EVENT);
      expect(ack.acceptedSignals).toEqual(["traces", "metrics", "logs"]);
      expect(ack.maxBodyBytes).toBe(KEYLESS_TELEMETRY_MAX_BODY_BYTES);
      expect(ack.ttlMs).toBeGreaterThan(0);
    }
  });

  it("rejects a handshake with unknown fields", async () => {
    const h = await harness();
    const c = await client(h.url);
    const ack = await c.emit<KeylessTelemetrySessionAck>(
      KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
      { appInstallationId: "install-1", apiKey: "sk_live_nope" }
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("invalid_request");
    }
  });

  it("rejects new sessions once at capacity", async () => {
    const h = await harness({ maxActiveSessions: 1 });
    const c = await client(h.url);
    expect((await openSession(c)).length).toBeGreaterThan(0);
    const ack = await c.emit<KeylessTelemetrySessionAck>(
      KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
      { appInstallationId: "install-2" }
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("at_capacity");
    }
  });

  it("rate-limits handshakes per IP", async () => {
    const h = await harness({ ipRateLimitPerMinute: 1 });
    const c = await client(h.url);
    await openSession(c);
    const ack = await c.emit<KeylessTelemetrySessionAck>(
      KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
      { appInstallationId: "install-2" }
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("rate_limited");
    }
  });
});

describe("keyless telemetry ingress — export proxy", () => {
  it("proxies valid traces/metrics/logs opaquely to /v1/{signal}", async () => {
    const h = await harness();
    const c = await client(h.url);
    const sessionId = await openSession(c);

    for (const signal of ["traces", "metrics", "logs"] as const) {
      const body = new Uint8Array([10, 20, 30, signal.length]);
      const ack = await c.emit<KeylessTelemetryExportAck>(
        KEYLESS_TELEMETRY_EXPORT_EVENT,
        exportEnvelope(sessionId, { signal, body })
      );
      expect(ack.accepted).toBe(true);
    }

    expect(h.records.map((r) => r.path)).toEqual([
      "/v1/traces",
      "/v1/metrics",
      "/v1/logs",
    ]);
    // Opaque body fidelity + content type preserved verbatim.
    expect(h.records[0].contentType).toBe(PROTOBUF);
    expect([...h.records[0].body]).toEqual([10, 20, 30, 6]);
  });

  it("preserves a non-trivial protobuf body byte-for-byte", async () => {
    const h = await harness();
    const c = await client(h.url);
    const sessionId = await openSession(c);
    const body = new Uint8Array(2048);
    for (let i = 0; i < body.length; i++) {
      body[i] = (i * 7 + 3) % 256;
    }
    const ack = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId, { body })
    );
    expect(ack.accepted).toBe(true);
    expect(h.records).toHaveLength(1);
    expect(Buffer.compare(h.records[0].body, Buffer.from(body))).toBe(0);
  });

  it("maps collector 4xx to otlp_rejected (no retry hint)", async () => {
    const h = await harness();
    h.setCollectorResponse({ status: 422, body: "bad otlp" });
    const c = await client(h.url);
    const sessionId = await openSession(c);
    const ack = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("otlp_rejected");
      expect(ack.retryAfterSeconds).toBeUndefined();
    }
  });

  it("maps collector 5xx to collector_unavailable (retryable)", async () => {
    const h = await harness();
    h.setCollectorResponse({ status: 503 });
    const c = await client(h.url);
    const sessionId = await openSession(c);
    const ack = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("collector_unavailable");
      expect(ack.retryAfterSeconds).toBe(30);
    }
  });

  it("maps a collector network failure to collector_unavailable", async () => {
    const h = await harness();
    h.setCollectorResponse({ status: 200, destroy: true });
    const c = await client(h.url);
    const sessionId = await openSession(c);
    const ack = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("collector_unavailable");
    }
  });
});

describe("keyless telemetry ingress — validation rejects before collector", () => {
  it("rejects export with an unknown/expired/missing session", async () => {
    const h = await harness();
    const c = await client(h.url);
    const ack = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope("does-not-exist")
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("invalid_session");
    }
    expect(h.records).toHaveLength(0);
  });

  it("expires sessions after the TTL (lazy expiry on access)", async () => {
    const h = await harness({ sessionTtlMs: 50, sweepIntervalMs: 1_000_000 });
    const c = await client(h.url);
    const sessionId = await openSession(c);
    await delay(250);
    const ack = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("invalid_session");
    }
    expect(h.records).toHaveLength(0);
  });

  it.each([
    ["invalid_content_type", { contentType: "application/json" }],
    ["unsupported_signal", { signal: "profiles" }],
    [
      "payload_too_large",
      { body: new Uint8Array(KEYLESS_TELEMETRY_MAX_BODY_BYTES + 1) },
    ],
    ["invalid_request", { body: undefined }],
  ])("rejects %s without calling the collector", async (reason, overrides) => {
    const h = await harness();
    const c = await client(h.url);
    const sessionId = await openSession(c);
    const ack = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId, overrides)
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe(reason);
    }
    expect(h.records).toHaveLength(0);
  });

  it("rate-limits exports per session", async () => {
    const h = await harness({ sessionRateLimitPerMinute: 1 });
    const c = await client(h.url);
    const sessionId = await openSession(c);
    const first = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    expect(first.accepted).toBe(true);
    const second = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    expect(second.accepted).toBe(false);
    if (!second.accepted) {
      expect(second.reason).toBe("rate_limited");
    }
    expect(h.records).toHaveLength(1);
  });

  it("fails closed with collector_unavailable when no collector is configured", async () => {
    const h = await harness({ collectorUrl: null }, { withCollector: false });
    const c = await client(h.url);
    const sessionId = await openSession(c);
    const ack = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("collector_unavailable");
      expect(ack.retryAfterSeconds).toBe(30);
    }
  });
});

describe("keyless telemetry ingress — session lifecycle / capacity", () => {
  it("frees a socket's sessions on disconnect (releases capacity)", async () => {
    const h = await harness({ maxActiveSessions: 1 });
    const c1 = await client(h.url);
    await openSession(c1);
    expect(h.handle.activeSessions()).toBe(1);

    // Second client is at capacity until c1 disconnects.
    const c2 = await client(h.url);
    const blocked = await c2.emit<KeylessTelemetrySessionAck>(
      KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
      { appInstallationId: "install-2" }
    );
    expect(blocked.accepted).toBe(false);

    c1.disconnect();
    await delay(100);
    expect(h.handle.activeSessions()).toBe(0);

    const allowed = await c2.emit<KeylessTelemetrySessionAck>(
      KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
      { appInstallationId: "install-2" }
    );
    expect(allowed.accepted).toBe(true);
  });

  it("evicts expired sessions via the sweep timer (no export needed)", async () => {
    const h = await harness({ sessionTtlMs: 30, sweepIntervalMs: 25 });
    const c = await client(h.url);
    await openSession(c);
    expect(h.handle.activeSessions()).toBe(1);
    await delay(150);
    expect(h.handle.activeSessions()).toBe(0);
  });

  it("caps concurrent sessions per socket connection", async () => {
    const h = await harness();
    const c = await client(h.url);
    // MAX_SESSIONS_PER_SOCKET is 8; the 9th on one socket is rejected.
    for (let i = 0; i < 8; i++) {
      expect((await openSession(c, `install-${i}`)).length).toBeGreaterThan(0);
    }
    const ninth = await c.emit<KeylessTelemetrySessionAck>(
      KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
      { appInstallationId: "install-9" }
    );
    expect(ninth.accepted).toBe(false);
    if (!ninth.accepted) {
      expect(ninth.reason).toBe("at_capacity");
    }
  });
});
