import { request } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const TEST_PORT = 50_000 + Math.floor(Math.random() * 10_000);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

const REMOTE_TARGET_ID = "remote-target";
const REMOTE_INSTANCE_ID = "other-instance";
const REMOTE_PRIVATE_IP = "10.0.0.5";
// Every relay task listens on the same port; the egress allowlist requires the
// peer port to equal this instance's RELAY_PORT, so mirror the test port here.
const REMOTE_PORT = TEST_PORT;

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

// Inject a registry that resolves the target to a different relay instance,
// forcing handleDispatch down the cross-instance proxy path.
vi.mock("../target-registry.js", () => {
  const remoteTarget = {
    instanceId: REMOTE_INSTANCE_ID,
    socketId: "sock-remote",
    ownerToken: "owner-token-remote",
    organizationId: "org-1",
    userId: "user-1",
    connectedAt: 0,
  };
  const remoteInstance = {
    privateIp: REMOTE_PRIVATE_IP,
    port: REMOTE_PORT,
    startedAt: 0,
  };
  class MockTargetRegistry {
    register() {
      return Promise.resolve();
    }
    lookup(targetId: string) {
      return Promise.resolve(
        targetId === REMOTE_TARGET_ID ? remoteTarget : null
      );
    }
    deregister() {
      return Promise.resolve(true);
    }
    refreshTtl() {
      return Promise.resolve(true);
    }
    deregisterAllByInstance() {
      return Promise.resolve(0);
    }
    registerInstance() {
      return Promise.resolve();
    }
    lookupInstance(instanceId: string) {
      return Promise.resolve(
        instanceId === REMOTE_INSTANCE_ID ? remoteInstance : null
      );
    }
    deregisterInstance() {
      return Promise.resolve();
    }
  }
  return {
    InMemoryTargetRegistry: MockTargetRegistry,
    RedisTargetRegistry: MockTargetRegistry,
  };
});

const fetchMock = vi.fn();

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.RELAY_PORT = String(TEST_PORT);
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  vi.stubGlobal("fetch", fetchMock);

  const relayModule = await import("../index");
  await relayModule.startRelayServer("127.0.0.1");
  stopRelay = relayModule.stopRelayServer;

  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}, 30_000);

beforeEach(() => {
  fetchMock.mockReset();
});

afterAll(async () => {
  if (stopRelay) {
    await stopRelay();
  }
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

function dispatch(targetId: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${baseUrl}/dispatch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": TEST_SECRET,
        },
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
    req.write(JSON.stringify({ targetId, operation: { commandId: "cmd-1" } }));
    req.end();
  });
}

describe("cross-instance dispatch proxying", () => {
  it("proxies to the owning instance and returns its result", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ delivered: true }),
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ delivered: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(calledUrl).toBe(
      `http://${REMOTE_PRIVATE_IP}:${REMOTE_PORT}/internal/dispatch`
    );
    expect(calledInit.headers["x-internal-secret"]).toBe(TEST_SECRET);
    expect(JSON.parse(calledInit.body).targetId).toBe(REMOTE_TARGET_ID);
  });

  it("falls back to target_not_connected when the peer is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: "target_not_connected",
    });
  });

  it("falls back to target_not_connected on a non-JSON peer response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error("Unexpected token < in JSON")),
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "target_not_connected"
    );
  });

  it("reports not-delivered on a non-2xx peer response with a JSON error body", async () => {
    // A peer 500/401/403 must not be forwarded verbatim with a 200; the API
    // caller only treats delivered === false as failure.
    const jsonSpy = vi.fn(() => Promise.resolve({ error: "internal" }));
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: jsonSpy,
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: "target_not_connected",
    });
  });

  it("reports not-delivered on a malformed 2xx peer response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ unexpected: "shape" }),
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: "target_not_connected",
    });
  });

  it("attaches an abort signal that times out before the API caller budget", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ delivered: true }),
    });

    await dispatch(REMOTE_TARGET_ID);

    const [, calledInit] = fetchMock.mock.calls[0] as [
      string,
      { signal?: AbortSignal },
    ];
    expect(calledInit.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports target_not_connected when no instance owns the target", async () => {
    const response = await dispatch("unknown-target");

    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "target_not_connected"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
