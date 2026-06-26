import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TEST_PORT = 40_000 + Math.floor(Math.random() * 10_000);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

let baseUrl: string;
let stopRelay: (() => Promise<void>) | null = null;

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
