// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
const mockExecuteOperation = vi.hoisted(() => vi.fn());
const mockResumeStream = vi.hoisted(() => vi.fn());
const mockResolveResumeOptions = vi.hoisted(() => vi.fn());
const mockSetRefreshToken = vi.hoisted(() => vi.fn());
const mockStreamOperation = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());
const mockIsStreamingGatewayRequest = vi.hoisted(() => vi.fn());
const mockAfter = vi.hoisted(() => vi.fn());

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

// `after` defers work past the response; run it inline so the snapshot PUT is
// observable from the test body.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (callback: () => unknown) => {
      mockAfter(callback);
      return callback();
    },
  };
});

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
        resolveResumeOptions: mockResolveResumeOptions,
        resumeStream: mockResumeStream,
        setRefreshToken: mockSetRefreshToken,
        streamOperation: mockStreamOperation,
      };
    }),
    RelayRequestError,
    isStreamingGatewayRequest: mockIsStreamingGatewayRequest,
  };
});

const { GET, POST } = await import("../route");

function createRelayRequest(
  targetId: string,
  headers?: HeadersInit
): Parameters<typeof GET>[0] {
  const url = new URL(
    "http://app.test/api/gateway-relay/health-check?pluginAutoUpdate=1&expectedMcpUrl=https%3A%2F%2Fmcp.test%2Fmcp"
  );
  const requestHeaders = new Headers(headers);
  requestHeaders.set("x-compute-target", targetId);
  const request = new Request(url, {
    headers: requestHeaders,
  });
  Object.defineProperty(request, "nextUrl", {
    value: url,
  });
  return request as Parameters<typeof GET>[0];
}

function createRepairRequest(targetId: string): Parameters<typeof POST>[0] {
  const url = new URL("http://app.test/api/gateway-relay/health-check/repair");
  const requestHeaders = new Headers();
  requestHeaders.set("x-compute-target", targetId);
  const request = new Request(url, {
    method: "POST",
    headers: requestHeaders,
  });
  Object.defineProperty(request, "nextUrl", {
    value: url,
  });
  return request as Parameters<typeof POST>[0];
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
    mockResolveResumeOptions.mockResolvedValue({});
    mockResumeStream.mockReturnValue({
      commandId: "cmd-resume",
      stream: new ReadableStream(),
    });
    mockIsStreamingGatewayRequest.mockReturnValue(false);
  });

  it("strips plugin auto-update from shared health-check relay requests", async () => {
    mockComputeTargetsResponse({
      id: "target-shared",
      isOnline: true,
      ownerName: "Teammate",
      capabilities: {},
    });

    const request = createRelayRequest("target-shared");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockExecuteOperation).toHaveBeenCalledWith(
      "target-shared",
      expect.objectContaining({
        path: "/api/gateway/health-check?expectedMcpUrl=https%3A%2F%2Fmcp.test%2Fmcp",
      }),
      undefined,
      { signal: request.signal }
    );
  });

  it("rejects a Repair against a target somebody else owns", async () => {
    mockComputeTargetsResponse({
      id: "target-shared",
      isOnline: true,
      ownerName: "Teammate",
      capabilities: {},
    });

    const response = await POST(createRepairRequest("target-shared"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "Repair is only available on compute targets you own. Teammate owns this one.",
    });
    expect(mockExecuteOperation).not.toHaveBeenCalled();
  });

  it("relays a Repair to a target you own", async () => {
    mockComputeTargetsResponse({
      id: "target-owned",
      isOnline: true,
      capabilities: {},
    });

    const request = createRepairRequest("target-owned");
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockExecuteOperation).toHaveBeenCalledWith(
      "target-owned",
      expect.objectContaining({
        method: "POST",
        path: "/api/gateway/health-check/repair",
      }),
      undefined,
      { signal: request.signal }
    );
  });

  it("persists the re-checked result a Repair returns, not the stale snapshot", async () => {
    // Repair carries the fresh check NESTED under `result`. Persisting only the
    // exact GET path left every reload and every other client hydrating the
    // pre-repair snapshot (ISS-5389 review).
    mockComputeTargetsResponse({
      id: "target-owned",
      isOnline: true,
      capabilities: {},
    });
    const repairedCheck = {
      checks: [{ id: "claude-cli", label: "Claude CLI", passed: true }],
      allRequiredPassed: true,
    };
    mockExecuteOperation.mockResolvedValue({
      value: {
        status: 200,
        body: { steps: [], result: repairedCheck },
      },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ success: true, data: {} }),
    });

    await POST(createRepairRequest("target-owned"));

    const persistCall = mockFetch.mock.calls.find(
      ([url]) =>
        url === "http://api.test/compute-targets/target-owned/health-check"
    );

    expect(persistCall).toBeDefined();
    expect(persistCall?.[1]?.method).toBe("PUT");
    expect(JSON.parse(persistCall?.[1]?.body as string)).toMatchObject({
      result: repairedCheck,
      pluginAutoUpdateEnabled: true,
    });
  });

  it("persists nothing when a Repair answers without a nested result", async () => {
    // Version skew: an older gateway on the repair path. Storing a
    // half-understood shape would be worse than storing nothing.
    mockComputeTargetsResponse({
      id: "target-owned",
      isOnline: true,
      capabilities: {},
    });
    mockExecuteOperation.mockResolvedValue({
      value: { status: 200, body: { steps: [] } },
    });

    await POST(createRepairRequest("target-owned"));

    expect(
      mockFetch.mock.calls.some(
        ([url]) =>
          url === "http://api.test/compute-targets/target-owned/health-check"
      )
    ).toBe(false);
  });

  it("preserves plugin auto-update for owned health-check relay requests", async () => {
    mockComputeTargetsResponse({
      id: "target-owned",
      isOnline: true,
      capabilities: {},
    });

    const request = createRelayRequest("target-owned");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockExecuteOperation).toHaveBeenCalledWith(
      "target-owned",
      expect.objectContaining({
        path: "/api/gateway/health-check?pluginAutoUpdate=1&expectedMcpUrl=https%3A%2F%2Fmcp.test%2Fmcp",
      }),
      undefined,
      { signal: request.signal }
    );
  });

  it("strips client IP forwarding headers while preserving origin and custom headers", async () => {
    mockComputeTargetsResponse({
      id: "target-owned",
      isOnline: true,
      capabilities: {},
    });

    const request = createRelayRequest("target-owned", {
      Authorization: "Bearer app-token",
      Cookie: "session=app",
      "CF-Connecting-IP": "198.51.100.10",
      "Content-Length": "0",
      Forwarded: "for=198.51.100.11;proto=https",
      Host: "app.test",
      Origin: "https://app.test",
      "True-Client-IP": "198.51.100.12",
      "X-Client-IP": "198.51.100.13",
      "X-Command-Id": "cmd_123",
      "X-Command-Public-Key-Fingerprint": "fingerprint",
      "X-Command-Signature": "signature",
      "X-Command-Signature-Payload": "payload",
      "X-Custom-Relay": "keep-me",
      "X-Forwarded-For": "198.51.100.14, 10.0.0.1",
      "X-Real-IP": "198.51.100.15",
      "X-Relay-After-Sequence": "3",
      "X-Relay-Command-Id": "relay-command",
      "X-Vercel-Forwarded-For": "198.51.100.16",
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockExecuteOperation).toHaveBeenCalledWith(
      "target-owned",
      expect.objectContaining({
        headers: {
          origin: "https://app.test",
          "x-custom-relay": "keep-me",
        },
      }),
      {
        commandId: "cmd_123",
        publicKeyFingerprint: "fingerprint",
        signature: "signature",
        signaturePayload: "payload",
      },
      { signal: request.signal }
    );
  });

  it("denies direct Branch View local-content relay paths before command creation", async () => {
    mockComputeTargetsResponse({
      id: "target-owned",
      isOnline: true,
      capabilities: {},
    });
    const url = new URL(
      "http://app.test/api/gateway-relay/git/local-changes?repoPath=/repo"
    );
    const request = new Request(url, {
      headers: { "x-compute-target": "target-owned" },
    });
    Object.defineProperty(request, "nextUrl", { value: url });

    const response = await GET(request as Parameters<typeof GET>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "branch_view_authorization_required",
    });
    expect(mockExecuteOperation).not.toHaveBeenCalled();
    expect(mockStreamOperation).not.toHaveBeenCalled();
  });

  it("denies generic relay resume when stored local-content proof is invalid", async () => {
    mockIsStreamingGatewayRequest.mockReturnValue(true);
    mockComputeTargetsResponse({
      id: "target-owned",
      isOnline: true,
      capabilities: {},
    });
    mockResolveResumeOptions.mockRejectedValue(
      new (await import("@/lib/engineer/relay-client")).RelayRequestError(
        "branch_view_not_author",
        403
      )
    );

    const response = await GET(
      createRelayRequest("target-owned", {
        Accept: "text/event-stream",
        "X-Relay-Command-Id": "cmd-local",
        "X-Relay-After-Sequence": "4",
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "branch_view_not_author",
    });
    expect(mockResumeStream).not.toHaveBeenCalled();
  });

  it("denies generic relay resume when the stored command is local content", async () => {
    mockIsStreamingGatewayRequest.mockReturnValue(true);
    mockComputeTargetsResponse({
      id: "target-owned",
      isOnline: true,
      capabilities: {},
    });
    mockResolveResumeOptions.mockResolvedValue({ localContent: true });

    const response = await GET(
      createRelayRequest("target-owned", {
        Accept: "text/event-stream",
        "X-Relay-Command-Id": "cmd-local",
        "X-Relay-After-Sequence": "4",
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "branch_view_authorization_required",
    });
    expect(mockResolveResumeOptions).toHaveBeenCalledWith(
      "target-owned",
      "cmd-local"
    );
    expect(mockResumeStream).not.toHaveBeenCalled();
  });

  it("preserves generic relay resume for non-local commands", async () => {
    mockIsStreamingGatewayRequest.mockReturnValue(true);
    mockComputeTargetsResponse({
      id: "target-owned",
      isOnline: true,
      capabilities: {},
    });
    mockResolveResumeOptions.mockResolvedValue({});

    const response = await GET(
      createRelayRequest("target-owned", {
        Accept: "text/event-stream",
        "X-Relay-Command-Id": "cmd-generic",
        "X-Relay-After-Sequence": "4",
      })
    );

    expect(response.status).toBe(200);
    expect(mockResumeStream).toHaveBeenCalledWith(
      "target-owned",
      "cmd-generic",
      4,
      {}
    );
  });
});
