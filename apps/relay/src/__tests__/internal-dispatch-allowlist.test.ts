import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "../target-registry.js";
import { reserveTestPort } from "./helpers/reserve-test-port.js";

const TEST_PORT = await reserveTestPort(27_000, 1500);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

let baseUrl: string;
let stopRelay: (() => Promise<void>) | null = null;
let isAllowedPeerInstance: (info: InstanceInfo) => boolean;

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
  // A malformed entry ("/foo") plus a valid non-matching subnet. Loopback
  // (127.0.0.1) matches neither, so the request must be forbidden. The
  // malformed entry must NOT fail open and authorize every source IP.
  process.env.RELAY_INTERNAL_ALLOWED_IPS = "10.0.0.0/foo,192.168.0.0/16";

  const relayModule = await import("../index");
  await relayModule.startRelayServer("127.0.0.1");
  stopRelay = relayModule.stopRelayServer;
  isAllowedPeerInstance = relayModule.isAllowedPeerInstance;

  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}, 30_000);

afterAll(async () => {
  if (stopRelay) {
    await stopRelay();
  }
  process.env = { ...ORIGINAL_ENV };
});

function post(
  path: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${baseUrl}${path}`,
      { method: "POST", headers, timeout: 2000 },
      (res) => {
        res.on("data", () => {
          // drain
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("POST /internal/dispatch with a CIDR allowlist", () => {
  it("forbids a source IP that matches no allowlist entry", async () => {
    const response = await post(
      "/internal/dispatch",
      {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      JSON.stringify({ targetId: "t1", operation: {} })
    );
    expect(response.status).toBe(403);
  });
});

describe("isAllowedPeerInstance with RELAY_INTERNAL_ALLOWED_IPS set (L1948)", () => {
  // RELAY_INTERNAL_ALLOWED_IPS = "10.0.0.0/foo,192.168.0.0/16" is set in beforeAll.
  // When the allowlist is non-empty, isAllowedPeerInstance uses the CIDR branch
  // (L1948 arm0) instead of the RFC1918 fallback.

  it("allows a peer whose IP falls within a valid allowlist CIDR", () => {
    // 192.168.0.1 is in 192.168.0.0/16 (the second, valid CIDR entry).
    expect(
      isAllowedPeerInstance({
        privateIp: "192.168.0.1",
        port: TEST_PORT,
        startedAt: 0,
      })
    ).toBe(true);
  });

  it("rejects a peer whose IP matches only the malformed allowlist entry (fails closed)", () => {
    // "10.0.0.0/foo" is malformed → isAddressInCidr fails closed → false.
    // No valid CIDR in the allowlist matches 10.0.0.1 → rejected.
    expect(
      isAllowedPeerInstance({
        privateIp: "10.0.0.1",
        port: TEST_PORT,
        startedAt: 0,
      })
    ).toBe(false);
  });

  it("rejects a peer IP that is outside all allowlist CIDRs", () => {
    // 172.16.0.1 matches neither "10.0.0.0/foo" (malformed) nor "192.168.0.0/16".
    expect(
      isAllowedPeerInstance({
        privateIp: "172.16.0.1",
        port: TEST_PORT,
        startedAt: 0,
      })
    ).toBe(false);
  });
});
