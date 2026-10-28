import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "../target-registry.js";
import { reserveTestPort } from "./helpers/reserve-test-port.js";

// `flush` and `debug` are stubbed even though this file drives neither:
// @repo/observability/shutdown calls log.flush(), and it is reachable from the
// relay entrypoint this suite imports, so a partial double fails as a TypeError
// rather than an assertion the moment a case reaches it.
vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

const { log } = await import("@repo/observability/log");
const logInfo = vi.mocked(log.info);

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
      // Engine.IO stub: index.ts attaches a `connection_error` listener to
      // `io.engine` at module load, so a Server double without one crashes on import.
      engine = { on: vi.fn() };
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
  const peerDispatchModule = await import("../peer-dispatch");
  await relayModule.startRelayServer("127.0.0.1");
  stopRelay = relayModule.stopRelayServer;
  isAllowedPeerInstance = peerDispatchModule.isAllowedPeerInstance;

  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
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
    // ISS-8673: the arrival record is the receiving half of the sender's
    // not-delivered count, so traffic the CIDR gate refuses must stay out of
    // it — a record emitted before this gate would put rejected probes in the
    // stream that comparison is read from, and the sibling suite's
    // secret-rejection case cannot see that, because it never reaches here.
    logInfo.mockClear();

    const response = await post(
      "/internal/dispatch",
      {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      JSON.stringify({ targetId: "t1", operation: {} })
    );
    expect(response.status).toBe(403);
    expect(logInfo).not.toHaveBeenCalledWith(
      "Internal dispatch received",
      expect.anything()
    );
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
