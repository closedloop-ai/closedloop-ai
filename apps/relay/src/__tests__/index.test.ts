import { request } from "node:http";
import {
  RelayDispatchDiagnosticReason,
  RelayDispatchReason,
} from "@repo/api/src/types/relay-dispatch";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createGatewayHarness } from "./gateway-harness.js";
import { reserveTestPort } from "./helpers/reserve-test-port.js";

const socketIoMocks = vi.hoisted(() => ({
  namespace: {
    use: vi.fn(),
    on: vi.fn(),
  },
}));

const TEST_PORT = await reserveTestPort(21_000, 1500);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

let baseUrl: string;
let stopRelay: (() => Promise<void>) | null = null;

// Mock socket.io to avoid starting a real Socket.IO server in tests
vi.mock("socket.io", () => {
  return {
    Server: class MockServer {
      // Engine.IO stub: index.ts attaches a `connection_error` listener to
      // `io.engine` at module load, so a Server double without one crashes on import.
      engine = { on: vi.fn() };
      of(namespace?: string) {
        if (namespace === "/desktop-gateway") {
          return socketIoMocks.namespace;
        }
        // Other namespaces (e.g. the keyless /telemetry ingress) get an
        // isolated no-op namespace so their handlers never pollute the
        // gateway mock this suite inspects.
        return { use() {}, on() {} };
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
}, 30_000);

afterAll(async () => {
  if (stopRelay) {
    await stopRelay();
  }
  process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
  await harness.cleanupRegisteredSockets();
  vi.unstubAllGlobals();
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

const harness = createGatewayHarness(socketIoMocks.namespace);
const { createMockRelaySocket, registerSocketTarget } = harness;

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
      diagnosticReason: string;
      reason: string;
    };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe(RelayDispatchReason.TargetNotConnected);
    expect(body.diagnosticReason).toBe(
      RelayDispatchDiagnosticReason.RegistryUnavailableInMemory
    );
  });

  it("emits desktop.command only to the socket registered for the requested targetId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const requestBody = JSON.parse(String(init.body)) as {
          event: string;
          payload?: { targetId?: string };
        };
        return new Response(
          JSON.stringify({
            targetId: requestBody.payload?.targetId,
            gatewaySessionId: `gateway-${requestBody.payload?.targetId}`,
            emit: [],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      })
    );
    const socketA = createMockRelaySocket("socket-a");
    const socketB = createMockRelaySocket("socket-b");
    await registerSocketTarget(socketA, "target-a");
    await registerSocketTarget(socketB, "target-b");

    const operation = { commandId: "cmd-1", operationId: "op-1" };
    const response = await requestJson(baseUrl, "/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: JSON.stringify({
        targetId: "target-a",
        operation,
      }),
    });
    const body = JSON.parse(response.body) as { delivered: boolean };

    expect(response.status).toBe(200);
    expect(body.delivered).toBe(true);
    expect(socketA.emit).toHaveBeenCalledWith("desktop.command", operation);
    expect(socketB.emit).not.toHaveBeenCalledWith(
      "desktop.command",
      expect.anything()
    );
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
