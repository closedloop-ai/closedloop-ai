// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
const mockExecuteOperation = vi.hoisted(() => vi.fn());
const mockResumeStream = vi.hoisted(() => vi.fn());
const mockSetRefreshToken = vi.hoisted(() => vi.fn());
const mockStreamOperation = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@repo/auth/server", () => ({
  auth: mockAuth,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/env", () => ({
  env: {
    INTERNAL_API_SECRET: "internal-secret",
  },
}));

vi.mock("@/lib/api-origin", () => ({
  resolveApiOrigin: () => "http://api.test",
}));

vi.mock("@/lib/engineer/relay-client", () => {
  class RelayRequestError extends Error {
    status: number;

    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }

  return {
    RelayClient: vi.fn(function RelayClient() {
      return {
        executeOperation: mockExecuteOperation,
        resumeStream: mockResumeStream,
        setRefreshToken: mockSetRefreshToken,
        streamOperation: mockStreamOperation,
      };
    }),
    RelayRequestError,
    isStreamingGatewayRequest: () => false,
  };
});

const { GET } = await import("../route");

function createRelayRequest(targetId: string): Parameters<typeof GET>[0] {
  const url = new URL(
    "http://app.test/api/gateway-relay/health-check?pluginAutoUpdate=1&expectedMcpUrl=https%3A%2F%2Fmcp.test%2Fmcp"
  );
  const request = new Request(url, {
    headers: {
      "x-compute-target": targetId,
    },
  });
  Object.defineProperty(request, "nextUrl", {
    value: url,
  });
  return request as Parameters<typeof GET>[0];
}

function mockComputeTargetsResponse(target: Record<string, unknown>): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      success: true,
      data: [target],
    }),
  });
}

describe("gateway relay route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockAuth.mockResolvedValue({
      userId: "user_123",
      getToken: vi.fn().mockResolvedValue("auth-token"),
    });
    mockExecuteOperation.mockResolvedValue({
      value: {
        status: 200,
        body: { ok: true },
      },
    });
  });

  it("strips plugin auto-update from shared health-check relay requests", async () => {
    mockComputeTargetsResponse({
      id: "target-shared",
      isOnline: true,
      ownerName: "Teammate",
      capabilities: {},
    });

    const response = await GET(createRelayRequest("target-shared"));

    expect(response.status).toBe(200);
    expect(mockExecuteOperation).toHaveBeenCalledWith(
      "target-shared",
      expect.objectContaining({
        path: "/api/gateway/health-check?expectedMcpUrl=https%3A%2F%2Fmcp.test%2Fmcp",
      }),
      undefined
    );
  });

  it("preserves plugin auto-update for owned health-check relay requests", async () => {
    mockComputeTargetsResponse({
      id: "target-owned",
      isOnline: true,
      capabilities: {},
    });

    const response = await GET(createRelayRequest("target-owned"));

    expect(response.status).toBe(200);
    expect(mockExecuteOperation).toHaveBeenCalledWith(
      "target-owned",
      expect.objectContaining({
        path: "/api/gateway/health-check?pluginAutoUpdate=1&expectedMcpUrl=https%3A%2F%2Fmcp.test%2Fmcp",
      }),
      undefined
    );
  });
});
