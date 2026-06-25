import { request } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const socketIoMocks = vi.hoisted(() => ({
  namespace: {
    use: vi.fn(),
    on: vi.fn(),
  },
}));

const TEST_PORT = 20_000 + Math.floor(Math.random() * 10_000);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

let baseUrl: string;
let stopRelay: (() => Promise<void>) | null = null;

// Mock socket.io to avoid starting a real Socket.IO server in tests
vi.mock("socket.io", () => {
  return {
    Server: class MockServer {
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
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}, 30_000);

afterAll(async () => {
  if (stopRelay) {
    await stopRelay();
  }
  process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
  for (const socket of registeredTestSockets) {
    await disconnectSocketTarget(socket);
  }
  registeredTestSockets.clear();
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

type MockRelaySocket = {
  id: string;
  data: {
    auth: {
      organizationId: string;
      userId: string;
    };
    pendingBuffer?: Array<{ event: string; args: unknown[] }>;
  };
  conn: { transport: { name: string } };
  connected: boolean;
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  handlers: Map<string, (...args: unknown[]) => Promise<void> | void>;
};

const registeredTestSockets = new Set<MockRelaySocket>();

function createMockRelaySocket(id: string): MockRelaySocket {
  const handlers = new Map<
    string,
    (...args: unknown[]) => Promise<void> | void
  >();
  return {
    id,
    data: {
      auth: {
        organizationId: "org-1",
        userId: "user-1",
      },
    },
    conn: { transport: { name: "websocket" } },
    connected: true,
    on: vi.fn(
      (
        event: string,
        handler: (...args: unknown[]) => Promise<void> | void
      ) => {
        handlers.set(event, handler);
      }
    ),
    emit: vi.fn(),
    disconnect: vi.fn(),
    handlers,
  };
}

function getConnectionHandler() {
  const call = socketIoMocks.namespace.on.mock.calls.find(
    ([event]) => event === "connection"
  );
  if (!call) {
    throw new Error("Expected relay connection handler to be registered");
  }
  return call[1] as (socket: MockRelaySocket) => void;
}

async function registerSocketTarget(socket: MockRelaySocket, targetId: string) {
  getConnectionHandler()(socket);
  const helloHandler = socket.handlers.get("desktop.hello");
  if (!helloHandler) {
    throw new Error("Expected desktop.hello handler to be registered");
  }
  await helloHandler({ targetId, pluginVersion: "test" });
  registeredTestSockets.add(socket);
}

async function disconnectSocketTarget(socket: MockRelaySocket) {
  const disconnectHandler = socket.handlers.get("disconnect");
  if (!disconnectHandler) {
    return;
  }
  socket.connected = false;
  await disconnectHandler("test_cleanup");
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
