import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { log } from "@repo/observability/log";
import {
  isStreamingGatewayRequest,
  RelayClient,
  type RelayHttpRequestPayload,
} from "@/lib/engineer/relay-client";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function readAllChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return output;
    }
    output += decoder.decode(value, { stream: true });
  }
}

function makeRelayRequest(path: string): RelayHttpRequestPayload {
  return {
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    body: { kind: "json", value: { message: "hello" } },
  };
}

function relayMeta(commandId: string): string {
  return `${JSON.stringify({ type: "relay_meta", commandId })}\n`;
}

describe("isStreamingGatewayRequest", () => {
  it("identifies known streaming engineer endpoints", () => {
    expect(
      isStreamingGatewayRequest(
        "POST",
        "/api/gateway/symphony/chat/ENG-123?repo=%2Ftmp%2Frepo",
        null
      )
    ).toBe(true);

    expect(
      isStreamingGatewayRequest(
        "POST",
        "/api/gateway/codex/review/ENG-123",
        null
      )
    ).toBe(true);
  });

  it("does not classify non-streaming endpoints by default", () => {
    expect(
      isStreamingGatewayRequest("GET", "/api/gateway/health-check", null)
    ).toBe(false);
    expect(isStreamingGatewayRequest("POST", "/api/gateway/git", null)).toBe(
      false
    );
  });

  it("classifies legacy engineer streaming endpoints after normalization", () => {
    expect(
      isStreamingGatewayRequest("POST", "/api/engineer/terminal-chat", null)
    ).toBe(true);
  });

  it("honors explicit event-stream accept header", () => {
    expect(
      isStreamingGatewayRequest(
        "POST",
        "/api/gateway/git",
        "application/json, text/event-stream"
      )
    ).toBe(true);
  });
});

describe("RelayClient.executeOperation preserves body fields", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("preserves provider field in JSON body through relay encoding", async () => {
    const fetchMock = vi.mocked(fetch);
    // createCommand response
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { commandId: "cmd-body-test", status: "queued" },
      })
    );
    // events stream returns a terminal result
    const sseBody = `data: ${JSON.stringify({
      commandId: "cmd-body-test",
      sequence: 1,
      eventType: "result",
      data: { statusCode: 200, body: { ok: true } },
      createdAt: "2026-03-11T00:00:00.000Z",
    })}\n\n`;
    fetchMock.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const client = new RelayClient("http://api.test", "token-123");
    await client.executeOperation("target-1", {
      method: "POST",
      path: "/api/gateway/symphony/chat/pr-42?repo=%2Ftmp%2Frepo",
      headers: { "content-type": "application/json" },
      body: {
        kind: "json",
        value: { message: "hello", provider: "claude" },
      },
    });

    // Verify the createCommand call includes the provider field in the body
    const createCall = fetchMock.mock.calls[0];
    const createBody = JSON.parse(createCall[1]?.body as string) as {
      body: { message: string; provider: string };
    };
    expect(createBody.body).toEqual({
      message: "hello",
      provider: "claude",
    });
  });

  it("accepts legacy engineer paths when creating relay commands", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { commandId: "cmd-legacy", status: "queued" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({
          commandId: "cmd-legacy",
          sequence: 1,
          eventType: "result",
          data: { statusCode: 200, body: { ok: true } },
          createdAt: "2026-03-11T00:00:00.000Z",
        })}\n\n`,
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      )
    );

    const client = new RelayClient("http://api.test", "token-123");
    await client.executeOperation("target-1", {
      method: "POST",
      path: "/api/engineer/symphony/chat/pr-42?repo=%2Ftmp%2Frepo",
      headers: { "content-type": "application/json" },
      body: {
        kind: "json",
        value: { message: "hello" },
      },
    });

    const createCall = fetchMock.mock.calls[0];
    const createBody = JSON.parse(createCall[1]?.body as string) as {
      path: string;
    };
    expect(createBody.path).toBe("/api/engineer/symphony/chat/pr-42");
  });
});

const KEEPALIVE = '{"type":"keepalive"}\n';

describe("RelayClient.streamOperation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns { stream, commandId } and emits relay_meta", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { commandId: "cmd-meta", status: "queued" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [
            {
              commandId: "cmd-meta",
              sequence: 1,
              eventType: "done",
              data: {},
              createdAt: "2026-03-06T12:00:00.000Z",
            },
          ],
        })
      );

    const client = new RelayClient("http://api.test", "token-123");
    const result = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/gateway/symphony/chat/ENG-123")
    );

    expect(result.commandId).toBe("cmd-meta");
    expect(result.stream).toBeInstanceOf(ReadableStream);

    const outputPromise = readAllChunks(result.stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    expect(output).toContain(KEEPALIVE);
    expect(output).toContain(relayMeta("cmd-meta"));
  });

  it("embeds _seq in forwarded events", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { commandId: "cmd-seq", status: "queued" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [
            {
              commandId: "cmd-seq",
              sequence: 1,
              eventType: "chunk",
              data: { content: "hello" },
              createdAt: "2026-03-06T12:00:00.000Z",
            },
            {
              commandId: "cmd-seq",
              sequence: 2,
              eventType: "done",
              data: {},
              createdAt: "2026-03-06T12:00:01.000Z",
            },
          ],
        })
      );

    const client = new RelayClient("http://api.test", "token-123");
    const { stream } = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/gateway/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    const lines = output.trim().split("\n");
    // Line 0: keepalive, Line 1: relay_meta, Line 2: chunk, Line 3: done
    const chunkLine = JSON.parse(lines[2]);
    expect(chunkLine._seq).toBe(1);
    const doneLine = JSON.parse(lines[3]);
    expect(doneLine._seq).toBe(2);
  });

  it("polls command events with no-store caching disabled", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { commandId: "cmd-1", status: "queued" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [
            {
              commandId: "cmd-1",
              sequence: 1,
              eventType: "chunk",
              data: { content: "hello" },
              createdAt: "2026-03-06T12:00:00.000Z",
            },
            {
              commandId: "cmd-1",
              sequence: 2,
              eventType: "done",
              data: {},
              createdAt: "2026-03-06T12:00:01.000Z",
            },
          ],
        })
      );

    const client = new RelayClient("http://api.test", "token-123");
    const { stream } = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/gateway/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(2000);
    const output = await outputPromise;

    // Poll URL now includes afterSequence=0
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://api.test/compute-targets/target-1/commands/cmd-1/events?afterSequence=0",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: {
          Authorization: "Bearer token-123",
        },
      })
    );
    expect(output).toContain(KEEPALIVE);
    expect(output).toContain(
      `${JSON.stringify({ content: "hello", type: "text", _seq: 1 })}\n`
    );
    expect(output).toContain(`${JSON.stringify({ type: "done", _seq: 2 })}\n`);
  });

  it("emits an error event with relay:true when polling fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { commandId: "cmd-2", status: "queued" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: "Forbidden",
          },
          { status: 403 }
        )
      );

    const client = new RelayClient("http://api.test", "token-123");
    const { stream } = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/gateway/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    expect(output).toContain(
      `${JSON.stringify({ type: "error", error: "Forbidden", relay: true })}\n`
    );
    expect(log.error).toHaveBeenCalledWith(
      "Relay command event polling failed",
      expect.objectContaining({
        targetId: "target-1",
        commandId: "cmd-2",
      })
    );
  });

  it("retries with refreshed token on 401", async () => {
    const fetchMock = vi.mocked(fetch);
    const refreshToken = vi.fn().mockResolvedValue("fresh-token");
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { commandId: "cmd-refresh", status: "queued" },
        })
      )
      // First poll returns 401
      .mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: "Token expired" },
          { status: 401 }
        )
      )
      // Retry with fresh token succeeds
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [
            {
              commandId: "cmd-refresh",
              sequence: 1,
              eventType: "done",
              data: {},
              createdAt: "2026-03-06T12:00:00.000Z",
            },
          ],
        })
      );

    const client = new RelayClient("http://api.test", "expired-token");
    client.setRefreshToken(refreshToken);
    const { stream } = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/gateway/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    expect(refreshToken).toHaveBeenCalledOnce();
    // Retry fetch uses the fresh token
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer fresh-token" },
      })
    );
    expect(output).toContain(`${JSON.stringify({ type: "done", _seq: 1 })}\n`);
  });

  it("emits error when refresh returns null", async () => {
    const fetchMock = vi.mocked(fetch);
    const refreshToken = vi.fn().mockResolvedValue(null);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { commandId: "cmd-null", status: "queued" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: "Token expired" },
          { status: 401 }
        )
      );

    const client = new RelayClient("http://api.test", "expired-token");
    client.setRefreshToken(refreshToken);
    const { stream } = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/gateway/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    expect(output).toContain(
      `${JSON.stringify({ type: "error", error: "Token expired", relay: true })}\n`
    );
  });

  it("emits error from retry response when retry fails", async () => {
    const fetchMock = vi.mocked(fetch);
    const refreshToken = vi.fn().mockResolvedValue("fresh-token");
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { commandId: "cmd-retry-fail", status: "queued" },
        })
      )
      // First poll returns 401
      .mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: "Token expired" },
          { status: 401 }
        )
      )
      // Retry also fails with 500
      .mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: "Internal server error" },
          { status: 500 }
        )
      );

    const client = new RelayClient("http://api.test", "expired-token");
    client.setRefreshToken(refreshToken);
    const { stream } = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/gateway/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    // Error should come from the retry response (500), not the original 401
    expect(output).toContain(
      `${JSON.stringify({ type: "error", error: "Internal server error", relay: true })}\n`
    );
  });

  it("emits error when refreshToken callback throws", async () => {
    const fetchMock = vi.mocked(fetch);
    const refreshToken = vi
      .fn()
      .mockRejectedValue(new Error("Clerk session expired"));
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { commandId: "cmd-throw", status: "queued" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: "Token expired" },
          { status: 401 }
        )
      );

    const client = new RelayClient("http://api.test", "expired-token");
    client.setRefreshToken(refreshToken);
    const { stream } = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/gateway/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    // Should emit the original 401 error, not the Clerk exception
    expect(output).toContain(
      `${JSON.stringify({ type: "error", error: "Token expired", relay: true })}\n`
    );
  });

  it("does not call refreshToken when internal secret is configured", async () => {
    const fetchMock = vi.mocked(fetch);
    const refreshToken = vi.fn().mockResolvedValue("fresh-token");
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { commandId: "cmd-internal", status: "queued" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: false, error: "Unauthorized" }, { status: 401 })
      );

    const client = new RelayClient(
      "http://api.test",
      "token-123",
      "internal-secret"
    );
    client.setRefreshToken(refreshToken);
    const { stream } = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/gateway/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    expect(refreshToken).not.toHaveBeenCalled();
    expect(output).toContain(
      `${JSON.stringify({ type: "error", error: "Unauthorized", relay: true })}\n`
    );
  });

  it("uses the internal events route when an internal secret is configured", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { commandId: "cmd-3", status: "queued" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [
            {
              commandId: "cmd-3",
              sequence: 1,
              eventType: "done",
              data: {},
              createdAt: "2026-03-06T12:00:00.000Z",
            },
          ],
        })
      );

    const client = new RelayClient(
      "http://api.test",
      "token-123",
      "internal-secret"
    );
    const { stream } = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/gateway/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://api.test/internal/compute-targets/target-1/commands/cmd-3/events?afterSequence=0",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: {
          "x-internal-secret": "internal-secret",
        },
      })
    );
    expect(output).toContain(`${JSON.stringify({ type: "done", _seq: 1 })}\n`);
  });
});

describe("RelayClient.executeOperation — recoverMissedResult", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function makeResultEvent(commandId: string, sequence: number) {
    return {
      commandId,
      sequence,
      eventType: "result",
      data: { statusCode: 200, body: { comments: [], prNumber: 1, prUrl: "" } },
      createdAt: "2026-03-11T00:00:00.000Z",
    };
  }

  function makeDoneEvent(commandId: string, sequence: number) {
    return {
      commandId,
      sequence,
      eventType: "done",
      data: {},
      createdAt: "2026-03-11T00:00:01.000Z",
    };
  }

  function sseStream(events: unknown[]): Response {
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  it("recovers result on first poll when done arrives without result via SSE", async () => {
    const fetchMock = vi.mocked(fetch);
    const cmdId = "cmd-recover-1";

    // 1. createCommand
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { commandId: cmdId, status: "queued" },
      })
    );
    // 2. SSE stream — only a bare "done", no result
    fetchMock.mockResolvedValueOnce(sseStream([makeDoneEvent(cmdId, 1)]));
    // 3. First poll fallback — result is available
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [makeResultEvent(cmdId, 1), makeDoneEvent(cmdId, 2)],
      })
    );

    const client = new RelayClient("http://api.test", "token-123");
    const resultPromise = client.executeOperation(
      "target-1",
      makeRelayRequest("/api/gateway/git/pr/comments")
    );
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.envelope).toEqual({
      status: 200,
      body: { comments: [], prNumber: 1, prUrl: "" },
    });
    // createCommand + SSE + 1 poll = 3 fetches
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers on second poll attempt when DB visibility is delayed", async () => {
    const fetchMock = vi.mocked(fetch);
    const cmdId = "cmd-recover-2";

    // 1. createCommand
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { commandId: cmdId, status: "queued" },
      })
    );
    // 2. SSE — bare done
    fetchMock.mockResolvedValueOnce(sseStream([makeDoneEvent(cmdId, 1)]));
    // 3. First poll — result not visible yet (only done)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [makeDoneEvent(cmdId, 1)] })
    );
    // 4. Second poll — result is now visible
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [makeResultEvent(cmdId, 1), makeDoneEvent(cmdId, 2)],
      })
    );

    const client = new RelayClient("http://api.test", "token-123");
    const resultPromise = client.executeOperation(
      "target-1",
      makeRelayRequest("/api/gateway/git/pr/comments")
    );
    // Tick through: SSE processing + first poll + 750ms delay + second poll
    await vi.advanceTimersByTimeAsync(800);
    const result = await resultPromise;

    expect(result.envelope).toEqual({
      status: 200,
      body: { comments: [], prNumber: 1, prUrl: "" },
    });
    // createCommand + SSE + 2 polls = 4 fetches
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("recovers on fourth poll attempt (max configured retry budget)", async () => {
    const fetchMock = vi.mocked(fetch);
    const cmdId = "cmd-recover-4";

    // 1. createCommand
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { commandId: cmdId, status: "queued" },
      })
    );
    // 2. SSE — bare done
    fetchMock.mockResolvedValueOnce(sseStream([makeDoneEvent(cmdId, 1)]));
    // 3-5. First three polls — no result
    for (let i = 0; i < 3; i++) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [makeDoneEvent(cmdId, 1)] })
      );
    }
    // 6. Fourth poll — result appears
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [makeResultEvent(cmdId, 1), makeDoneEvent(cmdId, 2)],
      })
    );

    const client = new RelayClient("http://api.test", "token-123");
    const resultPromise = client.executeOperation(
      "target-1",
      makeRelayRequest("/api/gateway/git/pr/comments")
    );
    // 3 × 750ms delays between attempts = 2250ms total budget
    await vi.advanceTimersByTimeAsync(2300);
    const result = await resultPromise;

    expect(result.envelope).toEqual({
      status: 200,
      body: { comments: [], prNumber: 1, prUrl: "" },
    });
    // createCommand + SSE + 4 polls = 6 fetches
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("falls through when all 4 poll attempts find no result", async () => {
    const fetchMock = vi.mocked(fetch);
    const cmdId = "cmd-exhaust";

    // 1. createCommand
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { commandId: cmdId, status: "queued" },
      })
    );
    // 2. SSE — bare done
    fetchMock.mockResolvedValueOnce(sseStream([makeDoneEvent(cmdId, 1)]));
    // 3-6. All four polls return only the done event
    for (let i = 0; i < 4; i++) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [makeDoneEvent(cmdId, 1)] })
      );
    }

    const client = new RelayClient("http://api.test", "token-123");
    const resultPromise = client.executeOperation(
      "target-1",
      makeRelayRequest("/api/gateway/git/pr/comments")
    );
    await vi.advanceTimersByTimeAsync(2300);
    const result = await resultPromise;

    // Falls through to the bare done event — no recovery possible
    expect(result.envelope).toBeNull();
    // createCommand + SSE + 4 polls = 6 fetches
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("continues retrying when intermediate poll throws a network error", async () => {
    const fetchMock = vi.mocked(fetch);
    const cmdId = "cmd-net-err";

    // 1. createCommand
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { commandId: cmdId, status: "queued" },
      })
    );
    // 2. SSE — bare done
    fetchMock.mockResolvedValueOnce(sseStream([makeDoneEvent(cmdId, 1)]));
    // 3. First poll — network error
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
    // 4. Second poll — succeeds with result
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [makeResultEvent(cmdId, 1), makeDoneEvent(cmdId, 2)],
      })
    );

    const client = new RelayClient("http://api.test", "token-123");
    const resultPromise = client.executeOperation(
      "target-1",
      makeRelayRequest("/api/gateway/git/pr/comments")
    );
    await vi.advanceTimersByTimeAsync(800);
    const result = await resultPromise;

    expect(result.envelope).toEqual({
      status: 200,
      body: { comments: [], prNumber: 1, prUrl: "" },
    });
  });

  it("recovers when SSE stream ends without any terminal event", async () => {
    const fetchMock = vi.mocked(fetch);
    const cmdId = "cmd-no-terminal";

    // 1. createCommand
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { commandId: cmdId, status: "queued" },
      })
    );
    // 2. SSE — stream ends immediately (empty body, no events at all)
    fetchMock.mockResolvedValueOnce(
      new Response("", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );
    // 3. First poll (from the post-loop fallback) — result available
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [makeResultEvent(cmdId, 1), makeDoneEvent(cmdId, 2)],
      })
    );

    const client = new RelayClient("http://api.test", "token-123");
    const resultPromise = client.executeOperation(
      "target-1",
      makeRelayRequest("/api/gateway/git/pr/comments")
    );
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.envelope).toEqual({
      status: 200,
      body: { comments: [], prNumber: 1, prUrl: "" },
    });
  });

  it("skips recovery and returns result directly when SSE delivers it", async () => {
    const fetchMock = vi.mocked(fetch);
    const cmdId = "cmd-normal";

    // 1. createCommand
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { commandId: cmdId, status: "queued" },
      })
    );
    // 2. SSE — result event arrives normally
    fetchMock.mockResolvedValueOnce(sseStream([makeResultEvent(cmdId, 1)]));

    const client = new RelayClient("http://api.test", "token-123");
    const resultPromise = client.executeOperation(
      "target-1",
      makeRelayRequest("/api/gateway/git/pr/comments")
    );
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.envelope).toEqual({
      status: 200,
      body: { comments: [], prNumber: 1, prUrl: "" },
    });
    // Only createCommand + SSE — no recovery polls
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("RelayClient.resumeStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("skips createCommand and polls from afterSequence", async () => {
    const fetchMock = vi.mocked(fetch);
    // No createCommand call — only poll
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [
          {
            commandId: "cmd-resume",
            sequence: 6,
            eventType: "chunk",
            data: { content: "continued" },
            createdAt: "2026-03-06T12:00:00.000Z",
          },
          {
            commandId: "cmd-resume",
            sequence: 7,
            eventType: "done",
            data: {},
            createdAt: "2026-03-06T12:00:01.000Z",
          },
        ],
      })
    );

    const client = new RelayClient("http://api.test", "token-123");
    const { stream, commandId } = await client.resumeStream(
      "target-1",
      "cmd-resume",
      5
    );

    expect(commandId).toBe("cmd-resume");

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    // Should include afterSequence=5 in the poll URL
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/compute-targets/target-1/commands/cmd-resume/events?afterSequence=5",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
      })
    );

    // Only 1 fetch call — no createCommand
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const lines = output.trim().split("\n");
    // keepalive + relay_meta + chunk + done
    expect(lines).toHaveLength(4);
    const chunkLine = JSON.parse(lines[2]);
    expect(chunkLine._seq).toBe(6);
    expect(chunkLine.content).toBe("continued");
  });
});
