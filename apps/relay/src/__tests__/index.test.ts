import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TEST_PORT = 20_000 + Math.floor(Math.random() * 10_000);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

let baseUrl: string;
let stopRelay: (() => Promise<void>) | null = null;

// Mock socket.io to avoid starting a real Socket.IO server in tests
vi.mock("socket.io", () => {
  const mockNamespace = {
    use: vi.fn(),
    on: vi.fn(),
  };
  return {
    Server: class MockServer {
      of() {
        return mockNamespace;
      }
    },
  };
});

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.RELAY_PORT = String(TEST_PORT);
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  process.env.NO_PROXY = "127.0.0.1,localhost";
  process.env.no_proxy = "127.0.0.1,localhost";
  process.env.HTTP_PROXY = "";
  process.env.HTTPS_PROXY = "";
  process.env.http_proxy = "";
  process.env.https_proxy = "";

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

type TestRequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

type TestResponse = {
  status: number;
  ok: boolean;
  body: string;
};

function requestJson(
  url: string,
  path: string,
  options: TestRequestOptions = {}
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${url}${path}`,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            body,
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", reject);

    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

describe("GET /health", () => {
  it("returns ok status", async () => {
    const response = await requestJson(baseUrl, "/health");
    const body = JSON.parse(response.body) as {
      status: string;
      uptime: number;
      connectedWorkers: number;
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.connectedWorkers).toBe("number");
  });
});

describe("POST /dispatch", () => {
  it("rejects requests without internal secret", async () => {
    const response = await requestJson(baseUrl, "/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: "t1", operation: {} }),
    });

    expect(response.status).toBe(401);
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects requests with wrong internal secret", async () => {
    const response = await requestJson(baseUrl, "/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": "wrong-secret",
      },
      body: JSON.stringify({ targetId: "t1", operation: {} }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects invalid JSON", async () => {
    const response = await requestJson(baseUrl, "/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: "not-json",
    });

    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toBe("Invalid JSON");
  });

  it("rejects payload without targetId", async () => {
    const response = await requestJson(baseUrl, "/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: JSON.stringify({ operation: {} }),
    });

    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toBe("Missing targetId");
  });

  it("returns delivered=false when no worker connected", async () => {
    const response = await requestJson(baseUrl, "/dispatch", {
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

describe("unknown routes", () => {
  it("returns 404 for unknown paths", async () => {
    const response = await requestJson(baseUrl, "/unknown");
    expect(response.status).toBe(404);
  });

  it("returns 404 for wrong method on /dispatch", async () => {
    const response = await requestJson(baseUrl, "/dispatch");
    expect(response.status).toBe(404);
  });
});
