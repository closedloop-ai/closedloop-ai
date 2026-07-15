import {
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
  type KeylessTelemetryExportAck,
  type KeylessTelemetrySessionAck,
} from "@closedloop-ai/shared-platform/keyless-telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { deriveClientIp } from "../keyless-otlp-ingress";
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

function exportEnvelope(sessionId: string) {
  return {
    sessionId,
    signal: "traces",
    contentType: PROTOBUF,
    body: new Uint8Array([1, 2, 3, 4]),
  };
}

async function openSession(c: KeylessClient, installId = "install-1") {
  const ack = await c.emit<KeylessTelemetrySessionAck>(
    KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
    { appInstallationId: installId }
  );
  if (!ack.accepted) {
    throw new Error(`handshake rejected: ${ack.reason}`);
  }
  return ack.sessionId;
}

/**
 * A collector `fetch` stub gated on a manually-released promise, so a test can
 * pin requests "in flight" deterministically (no real network, no timers).
 */
function makeGatedFetch() {
  let calls = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    calls: () => calls,
    release: () => release(),
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return {
        ok: true,
        status: 200,
        text: async () => "",
        body: null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// deriveClientIp — trusted-proxy X-Forwarded-For tier (FEA-1994 T3)
// ---------------------------------------------------------------------------

describe("deriveClientIp", () => {
  const handshake = (address: string, xff?: string | string[]) => ({
    address,
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  });

  it("uses the immediate peer when hops <= 0", () => {
    expect(deriveClientIp(handshake("9.9.9.9", "1.1.1.1"), 0)).toBe("9.9.9.9");
  });

  it("returns the rightmost XFF entry for a single trusted proxy (the ALB)", () => {
    expect(deriveClientIp(handshake("10.0.0.5", "203.0.113.7"), 1)).toBe(
      "203.0.113.7"
    );
  });

  it("returns the originating client across multiple trusted hops", () => {
    expect(
      deriveClientIp(handshake("10.0.0.5", "203.0.113.7, 70.0.0.1"), 2)
    ).toBe("203.0.113.7");
  });

  it("trims whitespace and ignores empty entries", () => {
    expect(
      deriveClientIp(handshake("10.0.0.5", " 203.0.113.7 , 70.0.0.1 "), 1)
    ).toBe("70.0.0.1");
  });

  it("falls back to the peer when XFF has fewer entries than trusted hops (anti-spoof)", () => {
    expect(deriveClientIp(handshake("10.0.0.5", "203.0.113.7"), 2)).toBe(
      "10.0.0.5"
    );
  });

  it("falls back to the peer when XFF is absent", () => {
    expect(deriveClientIp(handshake("10.0.0.5"), 1)).toBe("10.0.0.5");
  });

  it("joins a string[] XFF header before taking the trusted hop", () => {
    expect(
      deriveClientIp(handshake("10.0.0.5", ["203.0.113.7", "70.0.0.1"]), 1)
    ).toBe("70.0.0.1");
  });

  it("returns 'unknown' when there is no address and no usable XFF", () => {
    expect(deriveClientIp({ address: "", headers: {} }, 0)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Connection-budget fence (FEA-1994 T2)
// ---------------------------------------------------------------------------

describe("keyless telemetry — connection cap", () => {
  it("rejects connections past the cap and frees the slot on disconnect", async () => {
    const h = await harness({ maxConnections: 1 });
    const c1 = await client(h.url);
    await delay(30);
    expect(h.handle.activeConnections()).toBe(1);

    // A second connection must not add to the live count: the server admits the
    // socket then immediately disconnects it (or refuses the namespace).
    const c2 = await connectClient(h.url).catch(() => null);
    await delay(60);
    expect(h.handle.activeConnections()).toBe(1);
    if (c2) {
      expect(c2.socket.connected).toBe(false);
      c2.disconnect();
    }

    // Releasing the first frees the slot.
    c1.disconnect();
    await delay(60);
    expect(h.handle.activeConnections()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Back-pressure: bounded in-flight collector concurrency (FEA-1994 T1)
// ---------------------------------------------------------------------------

describe("keyless telemetry — back-pressure", () => {
  it("load-sheds past the in-flight ceiling and reclaims slots on completion", async () => {
    const gated = makeGatedFetch();
    const h = await harness(
      {
        collectorUrl: "http://collector.test",
        fetchImpl: gated.fetchImpl,
        maxInflightExports: 2,
      },
      { withCollector: false }
    );
    const c = await client(h.url);
    const sessionId = await openSession(c);

    // Occupy both in-flight slots — these stay pending on the gated fetch.
    const p1 = c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    const p2 = c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    await delay(40);
    expect(h.handle.inFlightExports()).toBe(2);
    expect(gated.calls()).toBe(2);

    // A third export is shed immediately: retryable, and NO new collector call.
    const shed = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    expect(shed.accepted).toBe(false);
    if (!shed.accepted) {
      expect(shed.reason).toBe("rate_limited");
      expect(shed.retryAfterSeconds ?? 0).toBeGreaterThan(0);
    }
    expect(gated.calls()).toBe(2);
    expect(h.handle.inFlightExports()).toBe(2);

    // Release the gate: the two pending exports complete and free their slots.
    gated.release();
    const [a1, a2] = await Promise.all([p1, p2]);
    expect(a1.accepted).toBe(true);
    expect(a2.accepted).toBe(true);
    expect(h.handle.inFlightExports()).toBe(0);

    // A later export now succeeds against a reclaimed slot.
    const ok = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      exportEnvelope(sessionId)
    );
    expect(ok.accepted).toBe(true);
    expect(gated.calls()).toBe(3);
  });
});
