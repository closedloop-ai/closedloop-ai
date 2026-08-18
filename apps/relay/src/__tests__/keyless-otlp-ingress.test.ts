import {
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  type KeylessTelemetryExportAck,
  type KeylessTelemetrySessionAck,
} from "@closedloop-ai/shared-platform/keyless-telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCollectorOrigin } from "../keyless-otlp-ingress";
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

/**
 * Bounded poll for an eventual condition, with an explicit timeout.
 *
 * A fixed `delay(n)` would be a wall-clock race: too short and the assertion
 * flakes under load, too long and the suite pays for it every run. This polls
 * until the condition holds and throws a named error if it never does, so the
 * failure says what did not happen rather than surfacing as a bare assertion
 * mismatch.
 */
async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${description}`
      );
    }
    await delay(5);
  }
}

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

  it("frees per-socket capacity by pruning swept ownedSessions entries on the next handshake", async () => {
    // Fill the 8-session per-socket cap, then let the sweep expire all sessions.
    // The per-socket ownedSessions Set still holds all 8 IDs. When the next
    // handshake fires the pruning loop (L511 arm0), each stale ID is removed and
    // capacity is freed — allowing a fresh session to be created.
    const h = await harness({ sessionTtlMs: 30, sweepIntervalMs: 25 });
    const c = await client(h.url);

    for (let i = 0; i < 8; i++) {
      await openSession(c, `install-${i}`);
    }

    // Wait for the sweep to expire all 8 sessions from the global sessions map.
    await waitUntil(
      () => h.handle.activeSessions() === 0,
      "the sweep to expire all 8 sessions"
    );
    expect(h.handle.activeSessions()).toBe(0);

    // A fresh handshake triggers the pruning loop: ownedSessions is cleared,
    // then the new session is accepted (capacity is no longer blocked).
    const freshId = await openSession(c, "install-fresh");
    expect(freshId).toBeTruthy();
  });
});

describe("keyless telemetry ingress — IP rate limit on export", () => {
  it("rate-limits an export via the IP limiter after the handshake exhausts the per-IP quota", async () => {
    // ipRateLimitPerMinute: 1 → the handshake uses the one allowed slot.
    // The subsequent export call hits the IP rate limit (L561 arm0).
    const h = await harness({ ipRateLimitPerMinute: 1 });
    const c = await client(h.url);
    const sessionId = await openSession(c);

    const result = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("rate_limited");
    }
    // No records forwarded to the collector when the IP limit fires.
    expect(h.records).toHaveLength(0);
  });
});

describe("keyless telemetry ingress — export without ack callback", () => {
  it("processes the export and forwards to the collector when the client sends no ack callback", async () => {
    // emitNoAck fires the export event without an ack callback, so the server
    // receives callback=undefined. ack(undefined, response) is a no-op (L337 arm1).
    // The export still reaches the collector because handleExport runs regardless.
    const h = await harness();
    const c = await client(h.url);
    const sessionId = await openSession(c);

    c.emitNoAck(KEYLESS_TELEMETRY_EXPORT_EVENT, exportEnvelope(sessionId));

    // Allow the async export path to complete.
    await waitUntil(
      () => h.records.length === 1,
      "the no-ack export to reach the collector"
    );

    expect(h.records).toHaveLength(1);
    expect(h.records[0].path).toBe("/v1/traces");
  });
});

describe("keyless telemetry ingress — export with no sessionId", () => {
  it("rejects an export whose sessionId field is not a string (extractSessionId returns null)", async () => {
    // A non-string sessionId fails the Zod safeParse (L178 arm1 = safeParse false).
    // extractSessionId returns null → !sessionId is true (L566 arm0) → invalid_request.
    const h = await harness();
    const c = await client(h.url);
    await openSession(c);

    const ack = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope("valid-but-unused", { sessionId: 42 })
    );

    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("invalid_request");
    }
    expect(h.records).toHaveLength(0);
  });
});

describe("keyless telemetry ingress — proxyToCollector non-Error rejection", () => {
  it("maps a non-Error fetchImpl rejection to collector_unavailable", async () => {
    // When the fetchImpl throws a non-Error (e.g. a plain string), the catch
    // branch that reads error.name falls to the undefined path (L292 arm1).
    // The function still returns { accepted: false, reason: "collector_unavailable" }.
    const h = await harness({
      fetchImpl: () => Promise.reject("non-error-string-rejection"),
    });
    const c = await client(h.url);
    const sessionId = await openSession(c);

    const result = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("collector_unavailable");
    }
  });
});

describe("resolveCollectorOrigin — isPrivateOrLoopbackHost branch coverage", () => {
  it("blocks a malformed IPv4 with an octet above 255 in production mode", () => {
    // octets.some(o => o > 255) → true (L209 arm0) → isPrivateOrLoopbackHost returns true
    // → resolveCollectorOrigin rejects the URL → { ok: false }
    const result = resolveCollectorOrigin({
      collectorUrl: "http://256.0.0.1:4317/",
      isProduction: true,
      allowPrivateCollector: false,
    });
    expect(result.ok).toBe(false);
  });

  it("allows a public IPv4 that is not private or link-local in production mode", () => {
    // 8.8.8.8 passes all private/loopback checks; the link-local check
    // (a===169 && b===254) is false (L222 arm1) → isPrivateOrLoopbackHost returns false
    // → resolveCollectorOrigin permits the URL in production.
    const result = resolveCollectorOrigin({
      collectorUrl: "http://8.8.8.8:4317/",
      isProduction: true,
      allowPrivateCollector: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.origin).toBe("http://8.8.8.8:4317");
    }
  });
});
