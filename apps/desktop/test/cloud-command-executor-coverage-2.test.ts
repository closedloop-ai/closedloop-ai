/**
 * @file cloud-command-executor-coverage-2.test.ts
 * @description ISS-10514 — `CloudCommandExecutor` paths that depend on what the
 * gateway answers: stream line mapping and terminal detection, bodyless and
 * untyped responses, empty error bodies, and query/body serialization.
 *
 * Driven through the real loopback gateway in `cloud-command-executor-harness`,
 * no `fetch` mock, so the assertions hold against the bytes actually sent.
 */
import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudCommandExecutor } from "../src/main/cloud/cloud-command-executor.js";
import {
  type DesktopCommandEvent,
  PROTOCOL_VERSION,
} from "../src/main/cloud/cloud-protocol.js";
import { Observability } from "../src/main/telemetry/observability.js";
import {
  closeGateway,
  countDone,
  createExecutor,
  type GatewayHandler,
  type StreamEvent,
  startGateway,
  waitFor,
} from "./cloud-command-executor-harness.js";

const NDJSON = "application/x-ndjson";

type CapturedRequest = {
  url: string;
  contentType: string | undefined;
  body: string;
};

Observability.initNoOp();

let executor: CloudCommandExecutor | null = null;

afterEach(async () => {
  executor?.dispose();
  executor = null;
  vi.restoreAllMocks();
  Observability.reset();
  Observability.initNoOp();
  await closeGateway();
});

function command(
  commandId: string,
  overrides: Partial<DesktopCommandEvent> = {}
): DesktopCommandEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `${commandId}-message`,
    timestamp: "2026-09-17T00:00:00.000Z",
    commandId,
    operationId: "git_action",
    method: "POST",
    path: "/api/gateway/git",
    ...overrides,
  };
}

async function runToTerminal(
  commandToRun: DesktopCommandEvent,
  isTerminal: (events: StreamEvent[]) => boolean
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);
  executor.enqueue(commandToRun);
  await waitFor(() => isTerminal(events));
  await waitFor(() => executor?.getStats().activeCommands === 0);
  return events;
}

async function streamGateway(payload: string): Promise<void> {
  await startGateway(
    syncHandler((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", NDJSON);
      response.end(payload);
    })
  );
}

async function captureGateway(): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  await startGateway(
    syncHandler((request, response, body) => {
      captured.push({
        url: request.url ?? "",
        contentType: request.headers["content-type"],
        body,
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end("{}");
    })
  );
  return captured;
}

function syncHandler(
  respond: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    body: string
  ) => void
): GatewayHandler {
  return (request, response, body) => {
    respond(request, response, body);
    return Promise.resolve();
  };
}

function runningStatus(commandId: string): StreamEvent {
  return {
    commandId,
    sequence: 1,
    eventType: "status",
    data: { type: "status", status: "running", operationId: "git_action" },
  };
}

describe("stream line mapping", () => {
  it("maps each line type, skips blanks, and ends on a trailing terminal result", async () => {
    await streamGateway(
      [
        '{"type":"status","phase":"clone"}',
        "",
        "   ",
        '{"type":"error","terminal":false,"error":"retrying"}',
        '{"type":5}',
        "plain text line",
        '{"type":"result","terminal":true,"value":1}',
      ].join("\n")
    );

    const events = await runToTerminal(command("map-1"), (seen) =>
      seen.some((event) => event.eventType === "result")
    );

    expect(events).toEqual([
      runningStatus("map-1"),
      {
        commandId: "map-1",
        sequence: 2,
        eventType: "status",
        data: { type: "status", phase: "clone" },
      },
      {
        commandId: "map-1",
        sequence: 3,
        eventType: "error",
        data: { type: "error", terminal: false, error: "retrying" },
      },
      {
        commandId: "map-1",
        sequence: 4,
        eventType: "chunk",
        data: { type: 5 },
      },
      {
        commandId: "map-1",
        sequence: 5,
        eventType: "chunk",
        data: { type: "text", content: "plain text line" },
      },
      {
        commandId: "map-1",
        sequence: 6,
        eventType: "result",
        data: { type: "result", terminal: true, value: 1 },
      },
    ]);
  });

  it("drops lines that follow a terminal done in the same stream", async () => {
    const completed = vi.spyOn(Observability, "commandCompleted");
    await streamGateway(
      '{"type":"done","cancelled":true}\n{"type":"status","late":true}\n'
    );

    const events = await runToTerminal(
      command("late-1"),
      (seen) => countDone(seen, "late-1") === 1
    );

    expect(events).toEqual([
      runningStatus("late-1"),
      {
        commandId: "late-1",
        sequence: 2,
        eventType: "done",
        data: { type: "done", cancelled: true },
      },
    ]);
    expect(completed).not.toHaveBeenCalled();
  });

  it("ends on a terminal error line without appending done or completing", async () => {
    const completed = vi.spyOn(Observability, "commandCompleted");
    await streamGateway('{"type":"error","terminal":true,"error":"boom"}\n');

    const events = await runToTerminal(command("fail-1"), (seen) =>
      seen.some((event) => event.eventType === "error")
    );

    expect(events).toEqual([
      runningStatus("fail-1"),
      {
        commandId: "fail-1",
        sequence: 2,
        eventType: "error",
        data: { type: "error", terminal: true, error: "boom" },
      },
    ]);
    expect(completed).not.toHaveBeenCalled();
  });

  it("appends done when a stream ends without a terminal line, ignoring trailing whitespace", async () => {
    const completed = vi.spyOn(Observability, "commandCompleted");
    await streamGateway('{"type":"chunk","content":"a"}\n   ');

    const events = await runToTerminal(
      command("open-1"),
      (seen) => countDone(seen, "open-1") === 1
    );

    expect(events.slice(1)).toEqual([
      {
        commandId: "open-1",
        sequence: 2,
        eventType: "chunk",
        data: { type: "chunk", content: "a" },
      },
      {
        commandId: "open-1",
        sequence: 3,
        eventType: "done",
        data: { type: "done" },
      },
    ]);
    // pins current behavior; looks odd because a stream that ends without a
    // terminal line is closed by consumeStreamResponse, which marks it terminal
    // before execute() reaches its commandCompleted call, so no completion
    // telemetry is recorded for it.
    expect(completed).not.toHaveBeenCalled();
  });

  it("completes a bodyless stream response through the executor's own done", async () => {
    const completed = vi.spyOn(Observability, "commandCompleted");
    await startGateway(
      syncHandler((_request, response) => {
        response.statusCode = 204;
        response.setHeader("content-type", "text/event-stream");
        response.end();
      })
    );

    const events = await runToTerminal(
      command("empty-1"),
      (seen) => countDone(seen, "empty-1") === 1
    );

    expect(events).toEqual([
      runningStatus("empty-1"),
      {
        commandId: "empty-1",
        sequence: 2,
        eventType: "done",
        data: { type: "done" },
      },
    ]);
    expect(completed).toHaveBeenCalledWith(
      "empty-1",
      "git_action",
      expect.any(Number)
    );
  });
});

describe("non-streaming responses", () => {
  it("returns the text body of a response with no content-type", async () => {
    await startGateway(
      syncHandler((_request, response) => {
        response.statusCode = 200;
        response.removeHeader("content-type");
        response.end("plain body");
      })
    );

    const events = await runToTerminal(
      command("text-1"),
      (seen) => countDone(seen, "text-1") === 1
    );

    expect(events.slice(1)).toEqual([
      {
        commandId: "text-1",
        sequence: 2,
        eventType: "result",
        data: {
          type: "result",
          statusCode: 200,
          success: true,
          data: "plain body",
        },
      },
      {
        commandId: "text-1",
        sequence: 3,
        eventType: "done",
        data: { type: "done" },
      },
    ]);
  });

  it("fails with a bare status message when the error body is empty", async () => {
    await startGateway(
      syncHandler((_request, response) => {
        response.statusCode = 502;
        response.end();
      })
    );

    const events = await runToTerminal(command("bad-1"), (seen) =>
      seen.some((event) => event.eventType === "error")
    );

    expect(events.slice(1)).toEqual([
      {
        commandId: "bad-1",
        sequence: 2,
        eventType: "error",
        data: { type: "error", terminal: true, error: "gateway returned 502" },
      },
    ]);
  });

  it("appends the error body to the failure message", async () => {
    await startGateway(
      syncHandler((_request, response) => {
        response.statusCode = 500;
        response.end("nope");
      })
    );

    const events = await runToTerminal(command("bad-2"), (seen) =>
      seen.some((event) => event.eventType === "error")
    );

    expect(events.slice(1)).toEqual([
      {
        commandId: "bad-2",
        sequence: 2,
        eventType: "error",
        data: {
          type: "error",
          terminal: true,
          error: "gateway returned 500: nope",
        },
      },
    ]);
  });
});

describe("request serialization", () => {
  it("defaults an object body to a JSON content-type and parses a JSON response", async () => {
    const captured = await captureGateway();

    const events = await runToTerminal(
      command("body-4", { body: { repoPath: "/repo/a" } }),
      (seen) => countDone(seen, "body-4") === 1
    );

    expect(captured).toEqual([
      {
        url: "/api/gateway/git",
        contentType: "application/json",
        body: '{"repoPath":"/repo/a"}',
      },
    ]);
    expect(events[1]).toEqual({
      commandId: "body-4",
      sequence: 2,
      eventType: "result",
      data: { type: "result", statusCode: 200, success: true, data: {} },
    });
  });

  it("sends no query string when the command has no query, and repeats array values", async () => {
    const captured = await captureGateway();

    await runToTerminal(
      command("query-1", { method: "GET" }),
      (seen) => countDone(seen, "query-1") === 1
    );
    executor?.dispose();
    await runToTerminal(
      command("query-2", {
        method: "GET",
        query: { tag: ["a", "b"], single: "x" },
      }),
      (seen) => countDone(seen, "query-2") === 1
    );

    expect(captured.map((request) => request.url)).toEqual([
      "/api/gateway/git",
      "/api/gateway/git?tag=a&tag=b&single=x",
    ]);
  });

  it("sends no body for a POST whose body is undefined", async () => {
    const captured = await captureGateway();

    await runToTerminal(
      command("body-1"),
      (seen) => countDone(seen, "body-1") === 1
    );

    expect(captured).toEqual([
      { url: "/api/gateway/git", contentType: undefined, body: "" },
    ]);
  });

  it("forwards a string body verbatim without forcing a JSON content-type", async () => {
    const captured = await captureGateway();

    await runToTerminal(
      command("body-2", { body: "raw=1&b=2" }),
      (seen) => countDone(seen, "body-2") === 1
    );

    // The executor sets no content-type for a string body; fetch supplies its
    // default for a string BodyInit.
    expect(captured).toEqual([
      {
        url: "/api/gateway/git",
        contentType: "text/plain;charset=UTF-8",
        body: "raw=1&b=2",
      },
    ]);
  });

  it("keeps a caller content-type on a JSON-serialized object body", async () => {
    const captured = await captureGateway();

    await runToTerminal(
      command("body-3", {
        method: "PUT",
        headers: { "content-type": "application/vnd.test+json" },
        body: { repoPath: "/repo/a" },
      }),
      (seen) => countDone(seen, "body-3") === 1
    );

    expect(captured).toEqual([
      {
        url: "/api/gateway/git",
        contentType: "application/vnd.test+json",
        body: '{"repoPath":"/repo/a"}',
      },
    ]);
  });
});
