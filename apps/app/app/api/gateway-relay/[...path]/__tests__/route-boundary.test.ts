// @vitest-environment node
/**
 * Behavioral tests for the gateway-relay route's trust boundary: caller
 * authentication, compute-target ownership/liveness validation, request-body
 * encoding, relay-response normalization, and the outer error boundary.
 *
 * Sibling of `route.test.ts`, which covers header denylisting and Branch View
 * local-content denial. Kept separate so neither file approaches the 1000-line
 * ceiling.
 *
 * Everything asserted here is reachable wire input: the compute-target list
 * comes from the API over HTTP, and the relay value comes from a
 * possibly-version-skewed Desktop peer, so malformed and partial payloads are
 * covered deliberately rather than assumed away by the types.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
const mockExecuteOperation = vi.hoisted(() => vi.fn());
const mockResumeStream = vi.hoisted(() => vi.fn());
const mockResolveResumeOptions = vi.hoisted(() => vi.fn());
const mockSetRefreshToken = vi.hoisted(() => vi.fn());
const mockStreamOperation = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());
const mockIsStreamingGatewayRequest = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());

vi.mock("@repo/auth/server", () => ({
  auth: mockAuth,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mockLogError,
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

const ONLINE_TARGET = {
  id: "target-1",
  isOnline: true,
  capabilities: {},
};

function createRelayRequest(options?: {
  targetId?: string | null;
  method?: string;
  body?: BodyInit;
  contentType?: string;
  path?: string;
}): Parameters<typeof GET>[0] {
  const url = new URL(
    `http://app.test/api/gateway-relay${options?.path ?? "/repos"}`
  );
  const requestHeaders = new Headers();
  if (options?.targetId !== null) {
    requestHeaders.set("x-compute-target", options?.targetId ?? "target-1");
  }
  if (options?.contentType) {
    requestHeaders.set("content-type", options.contentType);
  }
  const request = new Request(url, {
    method: options?.method ?? "GET",
    headers: requestHeaders,
    body: options?.body,
  });
  Object.defineProperty(request, "nextUrl", { value: url });
  return request as Parameters<typeof GET>[0];
}

function mockComputeTargetsOk(targets: Record<string, unknown>[]): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ success: true, data: targets }),
  });
}

/** The payload the route actually handed to the relay client. */
function relayPayloadSentToClient() {
  return mockExecuteOperation.mock.calls[0][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockAuth.mockResolvedValue({
    userId: "user_123",
    getToken: vi.fn().mockResolvedValue("auth-token"),
  });
  mockExecuteOperation.mockResolvedValue({
    value: { status: 200, body: { ok: true } },
  });
  mockResolveResumeOptions.mockResolvedValue({});
  mockIsStreamingGatewayRequest.mockReturnValue(false);
});

describe("gateway relay route — caller authentication", () => {
  it("rejects a request with no compute-target header before contacting the API", async () => {
    const response = await GET(createRelayRequest({ targetId: null }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing X-Compute-Target header",
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExecuteOperation).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: vi.fn() });

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockExecuteOperation).not.toHaveBeenCalled();
  });

  it("rejects a signed-in caller whose session yields no token", async () => {
    mockAuth.mockResolvedValue({
      userId: "user_123",
      getToken: vi.fn().mockResolvedValue(null),
    });

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockExecuteOperation).not.toHaveBeenCalled();
  });
});

describe("gateway relay route — compute-target ownership and liveness", () => {
  it("refuses to relay to a target the caller does not own", async () => {
    mockComputeTargetsOk([{ ...ONLINE_TARGET, id: "someone-elses" }]);

    const response = await GET(createRelayRequest({ targetId: "target-1" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Forbidden compute target",
    });
    expect(mockExecuteOperation).not.toHaveBeenCalled();
  });

  it("refuses to relay to an owned but offline target", async () => {
    mockComputeTargetsOk([{ ...ONLINE_TARGET, isOnline: false }]);

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Compute target offline",
    });
    expect(mockExecuteOperation).not.toHaveBeenCalled();
  });

  it("propagates the API's own error message and status when validation fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: vi
        .fn()
        .mockResolvedValue({ success: false, error: "Rate limited" }),
    });

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "Rate limited" });
  });

  it("falls back to a generic validation error when the failing API body is unreadable", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new Error("not json")),
    });

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to validate compute target",
    });
  });

  it("returns 502 when the API responds ok but reports failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ success: false, error: "nope" }),
    });

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to validate compute target",
    });
  });

  it("relays once the target is owned and online", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(200);
    expect(mockExecuteOperation).toHaveBeenCalledTimes(1);
    expect(mockExecuteOperation.mock.calls[0][0]).toBe("target-1");
  });
});

describe("gateway relay route — request body encoding", () => {
  it("sends no body for a GET", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);

    await GET(createRelayRequest({ method: "GET" }));

    expect(relayPayloadSentToClient().body).toEqual({ kind: "none" });
  });

  it("sends a parsed JSON body for an application/json POST", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);

    await POST(
      createRelayRequest({
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ path: "/repo", nested: [1, 2] }),
      })
    );

    expect(relayPayloadSentToClient().body).toEqual({
      kind: "json",
      value: { path: "/repo", nested: [1, 2] },
    });
  });

  it("rejects a malformed JSON body with 400 rather than forwarding it", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);

    const response = await POST(
      createRelayRequest({
        method: "POST",
        contentType: "application/json",
        body: "{ not valid json",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON body",
    });
    expect(mockExecuteOperation).not.toHaveBeenCalled();
  });

  it("sends no body for a POST with an empty payload", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);

    await POST(
      createRelayRequest({
        method: "POST",
        contentType: "application/json",
        body: "",
      })
    );

    expect(relayPayloadSentToClient().body).toEqual({ kind: "none" });
  });

  it("sends a text body verbatim for a text/* POST", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);

    await POST(
      createRelayRequest({
        method: "POST",
        contentType: "text/plain",
        body: "plain words",
      })
    );

    expect(relayPayloadSentToClient().body).toEqual({
      kind: "text",
      value: "plain words",
      contentType: "text/plain",
    });
  });

  it("sends a text body for a form-urlencoded POST", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);

    await POST(
      createRelayRequest({
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: "a=1&b=2",
      })
    );

    expect(relayPayloadSentToClient().body).toEqual({
      kind: "text",
      value: "a=1&b=2",
      contentType: "application/x-www-form-urlencoded",
    });
  });

  it("base64-encodes an opaque binary body", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);
    const bytes = new Uint8Array([0, 1, 250, 255]);

    await POST(
      createRelayRequest({
        method: "POST",
        contentType: "application/octet-stream",
        body: bytes,
      })
    );

    expect(relayPayloadSentToClient().body).toEqual({
      kind: "base64",
      value: Buffer.from(bytes).toString("base64"),
      contentType: "application/octet-stream",
    });
  });

  it("base64-encodes a body sent with no content type at all", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);

    // A Blob with an empty type produces a request carrying no content-type
    // header, which is the shape an older peer can still send.
    await POST(
      createRelayRequest({
        method: "POST",
        body: new Blob([new Uint8Array([7, 8])]),
      })
    );

    expect(relayPayloadSentToClient().body).toEqual({
      kind: "base64",
      value: Buffer.from(new Uint8Array([7, 8])).toString("base64"),
      contentType: null,
    });
  });
});

describe("gateway relay route — relay response normalization", () => {
  it("returns the relay status and JSON body from a { status, body } envelope", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);
    mockExecuteOperation.mockResolvedValue({
      value: { status: 201, body: { created: true } },
    });

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ created: true });
  });

  it("accepts the Electron { statusCode, data } envelope shape", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);
    mockExecuteOperation.mockResolvedValue({
      value: { statusCode: 404, data: { error: "missing" } },
    });

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "missing" });
  });

  it("passes a non-JSON string body through unwrapped", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);
    mockExecuteOperation.mockResolvedValue({
      value: {
        status: 200,
        body: "diff --git a/x b/x",
        headers: { "content-type": "text/plain" },
      },
    });

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("diff --git a/x b/x");
  });

  it("returns 502 rather than empty success when the envelope is missing", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);
    mockExecuteOperation.mockResolvedValue({
      value: { type: "done" },
    });

    const response = await GET(createRelayRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Relay response missing expected envelope",
    });
  });
});

describe("gateway relay route — error boundary", () => {
  it("maps an unexpected failure to a 502 without leaking internal detail", async () => {
    mockComputeTargetsOk([ONLINE_TARGET]);
    mockExecuteOperation.mockRejectedValue(
      new Error("connect ECONNREFUSED /var/secret/socket")
    );

    const response = await GET(createRelayRequest());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toEqual({ error: "Relay request failed" });
    expect(JSON.stringify(payload)).not.toContain("/var/secret/socket");
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });
});
