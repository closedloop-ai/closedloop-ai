import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { InstanceInfo, TargetMetadata } from "../target-registry.js";

const TEST_PORT = 30_000 + Math.floor(Math.random() * 10_000);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

let baseUrl: string;
let stopRelay: (() => Promise<void>) | null = null;
let isAddressInCidr: (address: string, cidr: string) => boolean;
let isAllowedPeerInstance: (info: InstanceInfo) => boolean;
let isCurrentRegistryOwner: (
  registered: TargetMetadata | null,
  worker: { ownerToken?: string },
  instanceId: string
) => boolean;
let peerDispatchTimeoutMs: number;
let apiDispatchCallerTimeoutMs: number;
let parseDispatchPayload: (
  raw: string
) =>
  | { ok: true; payload: { targetId: string; operation: unknown } }
  | { ok: false; error: string };

vi.mock("socket.io", () => {
  const mockNamespace = { use: vi.fn(), on: vi.fn() };
  return {
    Server: class MockServer {
      of() {
        return mockNamespace;
      }
      close() {
        return Promise.resolve();
      }
    },
  };
});

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.RELAY_PORT = String(TEST_PORT);
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  // No RELAY_INTERNAL_ALLOWED_IPS — exercises the secret-only authorization path.

  const relayModule = await import("../index");
  await relayModule.startRelayServer("127.0.0.1");
  stopRelay = relayModule.stopRelayServer;
  isAddressInCidr = relayModule.isAddressInCidr;
  isAllowedPeerInstance = relayModule.isAllowedPeerInstance;
  isCurrentRegistryOwner = relayModule.isCurrentRegistryOwner;
  peerDispatchTimeoutMs = relayModule.PEER_DISPATCH_TIMEOUT_MS;
  apiDispatchCallerTimeoutMs = relayModule.API_DISPATCH_CALLER_TIMEOUT_MS;
  parseDispatchPayload = relayModule.parseDispatchPayload;

  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}, 30_000);

afterAll(async () => {
  if (stopRelay) {
    await stopRelay();
  }
  process.env = { ...ORIGINAL_ENV };
});

type TestResponse = { status: number; body: string };

function requestJson(
  path: string,
  options: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${baseUrl}${path}`,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

describe("isAddressInCidr", () => {
  it("matches an address inside the subnet", () => {
    expect(isAddressInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
  });

  it("rejects an address outside the subnet", () => {
    expect(isAddressInCidr("192.168.1.1", "10.0.0.0/8")).toBe(false);
  });

  it("treats /0 as matching all addresses", () => {
    expect(isAddressInCidr("203.0.113.5", "0.0.0.0/0")).toBe(true);
  });

  it("matches an exact /32 host and rejects its neighbour", () => {
    expect(isAddressInCidr("127.0.0.1", "127.0.0.1/32")).toBe(true);
    expect(isAddressInCidr("127.0.0.2", "127.0.0.1/32")).toBe(false);
  });

  it("fails closed on a non-numeric prefix length", () => {
    expect(isAddressInCidr("10.0.0.1", "10.0.0.0/foo")).toBe(false);
  });

  it("fails closed on a negative prefix length", () => {
    expect(isAddressInCidr("10.0.0.1", "10.0.0.0/-1")).toBe(false);
  });

  it("fails closed on a prefix length above 32", () => {
    expect(isAddressInCidr("10.0.0.1", "10.0.0.0/40")).toBe(false);
  });

  it("treats an entry without a slash as an exact host match", () => {
    expect(isAddressInCidr("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(isAddressInCidr("127.0.0.2", "127.0.0.1")).toBe(false);
  });

  it("strips the IPv4-mapped IPv6 prefix before matching", () => {
    expect(isAddressInCidr("::ffff:10.1.2.3", "10.0.0.0/8")).toBe(true);
  });
});

describe("parseDispatchPayload", () => {
  it("returns the payload for a valid body", () => {
    const result = parseDispatchPayload(
      JSON.stringify({ targetId: "t1", operation: { commandId: "c1" } })
    );
    expect(result).toEqual({
      ok: true,
      payload: { targetId: "t1", operation: { commandId: "c1" } },
    });
  });

  it("rejects invalid JSON", () => {
    expect(parseDispatchPayload("not-json")).toEqual({
      ok: false,
      error: "Invalid JSON",
    });
  });

  it("rejects a body missing targetId", () => {
    expect(parseDispatchPayload(JSON.stringify({ operation: {} }))).toEqual({
      ok: false,
      error: "Missing targetId",
    });
  });

  it("rejects a non-string targetId", () => {
    expect(parseDispatchPayload(JSON.stringify({ targetId: 42 }))).toEqual({
      ok: false,
      error: "Missing targetId",
    });
  });
});

describe("POST /internal/dispatch", () => {
  it("rejects requests without the internal secret", async () => {
    const response = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: "t1", operation: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects requests with a wrong internal secret", async () => {
    const response = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": "wrong-secret",
      },
      body: JSON.stringify({ targetId: "t1", operation: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects invalid JSON with 400", async () => {
    const response = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: "not-json",
    });
    expect(response.status).toBe(400);
    expect((JSON.parse(response.body) as { error: string }).error).toBe(
      "Invalid JSON"
    );
  });

  it("authorizes on a valid secret alone when no allowlist is set", async () => {
    const response = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: JSON.stringify({
        targetId: "target-not-connected",
        operation: { commandId: "cmd-1" },
      }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      delivered: boolean;
      reason: string;
    };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("target_not_connected");
  });
});

describe("isAllowedPeerInstance (cross-instance egress allowlist)", () => {
  // No RELAY_INTERNAL_ALLOWED_IPS in this suite, so the RFC1918 fallback applies.
  it("allows a private peer IP on the relay port", () => {
    expect(
      isAllowedPeerInstance({
        privateIp: "10.0.0.5",
        port: TEST_PORT,
        startedAt: 0,
      })
    ).toBe(true);
  });

  it("rejects a public peer IP (SSRF / secret exfiltration guard)", () => {
    expect(
      isAllowedPeerInstance({
        privateIp: "1.2.3.4",
        port: TEST_PORT,
        startedAt: 0,
      })
    ).toBe(false);
  });

  it("rejects a loopback peer IP", () => {
    expect(
      isAllowedPeerInstance({
        privateIp: "127.0.0.1",
        port: TEST_PORT,
        startedAt: 0,
      })
    ).toBe(false);
  });

  it("rejects an unexpected port even for a private IP", () => {
    expect(
      isAllowedPeerInstance({ privateIp: "10.0.0.5", port: 22, startedAt: 0 })
    ).toBe(false);
  });

  it("rejects a non-integer port", () => {
    expect(
      isAllowedPeerInstance({
        privateIp: "10.0.0.5",
        port: Number.NaN,
        startedAt: 0,
      })
    ).toBe(false);
  });
});

describe("isCurrentRegistryOwner (ownership source of truth)", () => {
  const base: Omit<TargetMetadata, "instanceId" | "ownerToken"> = {
    socketId: "sock-1",
    organizationId: "org-1",
    userId: "user-1",
    connectedAt: 0,
  };

  it("trusts the live local socket when the registry has no entry", () => {
    expect(
      isCurrentRegistryOwner(null, { ownerToken: "tok-1" }, "inst-a")
    ).toBe(true);
  });

  it("confirms ownership when instance and owner token match", () => {
    expect(
      isCurrentRegistryOwner(
        { ...base, instanceId: "inst-a", ownerToken: "tok-1" },
        { ownerToken: "tok-1" },
        "inst-a"
      )
    ).toBe(true);
  });

  it("rejects a stale local socket when the target re-registered on another instance", () => {
    expect(
      isCurrentRegistryOwner(
        { ...base, instanceId: "inst-b", ownerToken: "tok-2" },
        { ownerToken: "tok-1" },
        "inst-a"
      )
    ).toBe(false);
  });

  it("rejects a stale owner token on the same instance", () => {
    expect(
      isCurrentRegistryOwner(
        { ...base, instanceId: "inst-a", ownerToken: "tok-2" },
        { ownerToken: "tok-1" },
        "inst-a"
      )
    ).toBe(false);
  });
});

describe("peer dispatch timeout contract", () => {
  it("aborts the peer dispatch before the API caller's budget", () => {
    expect(apiDispatchCallerTimeoutMs).toBe(5000);
    expect(peerDispatchTimeoutMs).toBeLessThan(apiDispatchCallerTimeoutMs);
  });
});
