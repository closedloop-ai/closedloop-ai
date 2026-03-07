import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TEST_PORT = 19_876;
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://localhost:19877";
const ORIGINAL_ENV = { ...process.env };

let baseUrl: string;

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

  await import("../index");
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  baseUrl = `http://localhost:${TEST_PORT}`;
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.connectedWorkers).toBe("number");
  });
});

describe("POST /dispatch", () => {
  it("rejects requests without internal secret", async () => {
    const response = await fetch(`${baseUrl}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: "t1", operation: {} }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects requests with wrong internal secret", async () => {
    const response = await fetch(`${baseUrl}/dispatch`, {
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
    const response = await fetch(`${baseUrl}/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: "not-json",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("rejects payload without targetId", async () => {
    const response = await fetch(`${baseUrl}/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: JSON.stringify({ operation: {} }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Missing targetId");
  });

  it("returns delivered=false when no worker connected", async () => {
    const response = await fetch(`${baseUrl}/dispatch`, {
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
    const body = await response.json();
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("target_not_connected");
  });
});

describe("unknown routes", () => {
  it("returns 404 for unknown paths", async () => {
    const response = await fetch(`${baseUrl}/unknown`);
    expect(response.status).toBe(404);
  });

  it("returns 404 for wrong method on /dispatch", async () => {
    const response = await fetch(`${baseUrl}/dispatch`);
    expect(response.status).toBe(404);
  });
});
