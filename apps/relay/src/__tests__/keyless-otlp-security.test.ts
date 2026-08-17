import {
  DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
  type DesktopAgentSessionsAck,
} from "@repo/api/src/types/agent-session";
import {
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
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

async function openSession(
  c: KeylessClient,
  installId: string
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

describe("resolveCollectorOrigin — SSRF / open-proxy guard", () => {
  it("rejects empty, malformed, and non-http(s) URLs", () => {
    for (const collectorUrl of [
      undefined,
      null,
      "",
      "   ",
      "not a url",
      "ftp://collector.example.com",
      "file:///etc/passwd",
    ]) {
      expect(
        resolveCollectorOrigin({
          collectorUrl,
          allowPrivateCollector: false,
          isProduction: true,
        }).ok
      ).toBe(false);
    }
  });

  it("strips path/query/hash, keeping only the origin", () => {
    const result = resolveCollectorOrigin({
      collectorUrl: "https://otlp.example.com:4318/v1/traces?token=x#frag",
      allowPrivateCollector: false,
      isProduction: true,
    });
    expect(result).toEqual({
      ok: true,
      origin: "https://otlp.example.com:4318",
    });
  });

  it("rejects private/loopback collector hosts in production by default", () => {
    for (const collectorUrl of [
      "http://127.0.0.1:4318",
      "http://localhost:4318",
      "http://10.0.0.5",
      "http://172.16.0.1",
      "http://192.168.1.10",
      "http://169.254.169.254", // cloud metadata endpoint
    ]) {
      expect(
        resolveCollectorOrigin({
          collectorUrl,
          allowPrivateCollector: false,
          isProduction: true,
        }).ok
      ).toBe(false);
    }
  });

  it("rejects private IPv6 collector literals (URL.hostname keeps brackets)", () => {
    for (const collectorUrl of [
      "http://[::1]:4318", // loopback
      "http://[fe80::1]:4318", // link-local
      "http://[fc00::1]:4318", // ULA
      "http://[fd12:3456::1]:4318", // ULA
      "http://[::ffff:127.0.0.1]:4318", // IPv4-mapped loopback
    ]) {
      expect(
        resolveCollectorOrigin({
          collectorUrl,
          allowPrivateCollector: false,
          isProduction: true,
        }).ok
      ).toBe(false);
    }
  });

  it("does not false-flag hostnames that merely start with fc/fd/fe80", () => {
    // Regression: the IPv6 prefix checks must only apply to bracketed literals,
    // not to hostnames like "fcollector.internal" / "fd-relay.example.com".
    for (const collectorUrl of [
      "http://fcollector.internal",
      "http://fd-relay.example.com:4318",
      "http://fe80-host.example.com",
    ]) {
      expect(
        resolveCollectorOrigin({
          collectorUrl,
          allowPrivateCollector: false,
          isProduction: true,
        }).ok
      ).toBe(true);
    }
  });

  it("allows public IPv6 collector literals in production", () => {
    expect(
      resolveCollectorOrigin({
        collectorUrl: "http://[2606:4700:4700::1111]:4318",
        allowPrivateCollector: false,
        isProduction: true,
      })
    ).toEqual({ ok: true, origin: "http://[2606:4700:4700::1111]:4318" });
  });

  it("allows a private collector in production only with the explicit opt-in", () => {
    const cfg = {
      collectorUrl: "http://127.0.0.1:4318",
      isProduction: true,
    };
    expect(
      resolveCollectorOrigin({ ...cfg, allowPrivateCollector: false }).ok
    ).toBe(false);
    expect(
      resolveCollectorOrigin({ ...cfg, allowPrivateCollector: true })
    ).toEqual({
      ok: true,
      origin: "http://127.0.0.1:4318",
    });
  });

  it("allows private collectors outside production (local dev)", () => {
    expect(
      resolveCollectorOrigin({
        collectorUrl: "http://127.0.0.1:4318",
        allowPrivateCollector: false,
        isProduction: false,
      }).ok
    ).toBe(true);
  });

  it("allows public collector hosts in production", () => {
    expect(
      resolveCollectorOrigin({
        collectorUrl: "https://otlp.datadoghq.com",
        allowPrivateCollector: false,
        isProduction: true,
      })
    ).toEqual({ ok: true, origin: "https://otlp.datadoghq.com" });
  });
});

describe("keyless namespace isolation", () => {
  it("ignores DB-sync, command, dispatch, and arbitrary events (no collector, stays connected)", async () => {
    const h = await harness();
    const c = await client(h.url);
    await openSession(c, "install-x");

    // None of these have a listener on /telemetry — they must be inert.
    c.emitNoAck(DESKTOP_AGENT_SESSIONS_SOCKET_EVENT, { sessions: [] });
    c.emitNoAck("desktop.command.event", { commandId: "x" });
    c.emitNoAck("desktop.hello", { apiKey: "sk_live_x" });
    c.emitNoAck("_relay.validate", {});
    c.emitNoAck("telemetry.unknown", { body: new Uint8Array([1]) });
    await delay(50);

    expect(h.records).toHaveLength(0);
    expect(c.socket.connected).toBe(true);
  });

  it("does not ack DB-sync events (no DesktopAgentSessionsAck path reachable)", async () => {
    const h = await harness();
    const c = await client(h.url);
    let acked = false;
    await new Promise<void>((resolve) => {
      c.socket.emit(
        DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
        { sessions: [] },
        (_ack: DesktopAgentSessionsAck) => {
          acked = true;
        }
      );
      setTimeout(resolve, 50);
    });
    expect(acked).toBe(false);
  });
});

describe("keyless export — per-install limiting + collector error mapping", () => {
  it("applies the per-install rate limit across distinct sessions", async () => {
    const h = await harness({ installRateLimitPerMinute: 1 });
    const c = await client(h.url);
    const sessionA = await openSession(c, "install-shared");
    const sessionB = await openSession(c, "install-shared");

    const env = (sessionId: string) => ({
      sessionId,
      signal: "traces",
      contentType: PROTOBUF,
      body: new Uint8Array([1]),
    });

    const first = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      env(sessionA)
    );
    expect(first.accepted).toBe(true);

    // Different session, same install id → install limiter trips.
    const second = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      env(sessionB)
    );
    expect(second.accepted).toBe(false);
    if (!second.accepted) {
      expect(second.reason).toBe("rate_limited");
    }
    expect(h.records).toHaveLength(1);
  });

  it("maps a collector timeout to request_timeout (retryable)", async () => {
    const timeoutFetch = () =>
      Promise.reject(
        Object.assign(new Error("timed out"), { name: "TimeoutError" })
      );
    const h = await harness(
      {
        collectorUrl: "http://collector.internal",
        fetchImpl: timeoutFetch as never,
      },
      { withCollector: false }
    );
    const c = await client(h.url);
    const sessionId = await openSession(c, "install-1");
    const ack = await c.emit<KeylessTelemetryExportAck>(
      KEYLESS_TELEMETRY_EXPORT_EVENT,
      {
        sessionId,
        signal: "traces",
        contentType: PROTOBUF,
        body: new Uint8Array([1, 2, 3]),
      }
    );
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toBe("request_timeout");
      expect(ack.retryAfterSeconds).toBe(30);
    }
  });
});
