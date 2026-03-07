import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
  },
}));

import { log } from "@repo/observability/log";
import {
  isStreamingEngineerRequest,
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

describe("isStreamingEngineerRequest", () => {
  it("identifies known streaming engineer endpoints", () => {
    expect(
      isStreamingEngineerRequest(
        "POST",
        "/api/engineer/symphony/chat/ENG-123?repo=%2Ftmp%2Frepo",
        null
      )
    ).toBe(true);

    expect(
      isStreamingEngineerRequest(
        "POST",
        "/api/engineer/codex/review/ENG-123",
        null
      )
    ).toBe(true);
  });

  it("does not classify non-streaming endpoints by default", () => {
    expect(
      isStreamingEngineerRequest("GET", "/api/engineer/health-check", null)
    ).toBe(false);
    expect(isStreamingEngineerRequest("POST", "/api/engineer/git", null)).toBe(
      false
    );
  });

  it("honors explicit event-stream accept header", () => {
    expect(
      isStreamingEngineerRequest(
        "POST",
        "/api/engineer/git",
        "application/json, text/event-stream"
      )
    ).toBe(true);
  });
});

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
    const stream = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/engineer/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(2000);
    const output = await outputPromise;

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://api.test/compute-targets/target-1/commands/cmd-1/events",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: {
          Authorization: "Bearer token-123",
        },
      })
    );
    expect(output).toBe(
      `${JSON.stringify({ content: "hello", type: "text" })}\n${JSON.stringify({ type: "done" })}\n`
    );
  });

  it("emits an error event when polling fails", async () => {
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
    const stream = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/engineer/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    expect(output).toBe(
      `${JSON.stringify({ type: "error", error: "Forbidden" })}\n`
    );
    expect(log.error).toHaveBeenCalledWith(
      "Relay command event polling failed",
      expect.objectContaining({
        targetId: "target-1",
        commandId: "cmd-2",
      })
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
    const stream = await client.streamOperation(
      "target-1",
      makeRelayRequest("/api/engineer/symphony/chat/ENG-123")
    );

    const outputPromise = readAllChunks(stream.getReader());
    await vi.advanceTimersByTimeAsync(1000);
    const output = await outputPromise;

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://api.test/internal/compute-targets/target-1/commands/cmd-3/events",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: {
          "x-internal-secret": "internal-secret",
        },
      })
    );
    expect(output).toBe(`${JSON.stringify({ type: "done" })}\n`);
  });
});
