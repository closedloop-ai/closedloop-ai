/**
 * Behavioral tests for the chat NDJSON stream reader in
 * `apps/app/lib/chat/chat-utils.ts`.
 *
 * `readChatStream` is the production entry point that consumers (the chat
 * hooks) call; the per-event dispatcher and the error normalizer are private
 * to the module, so every branch here is driven through the real reader with
 * synthetic gateway payloads.
 *
 * The stream is a trust boundary — the NDJSON arrives from the desktop
 * gateway/relay over the wire and may be malformed, partial, or emitted by a
 * version-skewed peer — so unknown, missing, and non-JSON payloads are all
 * reachable input and are covered deliberately.
 */

import { describe, expect, it, vi } from "vitest";
import {
  readChatStream,
  type StreamEventHandlers,
} from "@/lib/chat/chat-utils";

const ENCODER = new TextEncoder();

/**
 * Build a reader over the given raw chunks, exactly as `response.body`
 * would hand them to production code (chunk boundaries need not align
 * with line boundaries).
 */
function readerFromChunks(
  chunks: string[]
): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  return {
    read: () => {
      if (index >= chunks.length) {
        return Promise.resolve({ done: true, value: undefined });
      }
      const value = ENCODER.encode(chunks[index]);
      index++;
      return Promise.resolve({ done: false, value });
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

/** Build a reader that emits each event object as one NDJSON line. */
function readerFromEvents(
  events: Record<string, unknown>[]
): ReadableStreamDefaultReader<Uint8Array> {
  return readerFromChunks(events.map((e) => `${JSON.stringify(e)}\n`));
}

function makeHandlers(
  overrides: Partial<StreamEventHandlers> = {}
): StreamEventHandlers {
  return {
    onText: vi.fn(),
    onError: vi.fn(),
    onComplete: vi.fn(),
    ...overrides,
  };
}

describe("readChatStream — text accumulation", () => {
  it("accumulates successive text events and reports each cumulative value", async () => {
    const onText = vi.fn();
    const handlers = makeHandlers({ onText });

    const result = await readChatStream(
      readerFromEvents([
        { type: "text", content: "Hello" },
        { type: "text", content: ", " },
        { type: "text", content: "world" },
      ]),
      handlers
    );

    expect(onText.mock.calls.map((c) => c[0])).toEqual([
      "Hello",
      "Hello, ",
      "Hello, world",
    ]);
    expect(result.accumulated).toBe("Hello, world");
  });

  it("continues accumulating from initialContent when resuming a stream", async () => {
    const onText = vi.fn();

    const result = await readChatStream(
      readerFromEvents([{ type: "text", content: " and more" }]),
      makeHandlers({ onText }),
      { initialContent: "resumed" }
    );

    expect(onText).toHaveBeenCalledWith("resumed and more");
    expect(result.accumulated).toBe("resumed and more");
  });

  it("does not emit text for an empty content string", async () => {
    const onText = vi.fn();

    const result = await readChatStream(
      readerFromEvents([{ type: "text", content: "" }]),
      makeHandlers({ onText })
    );

    expect(onText).not.toHaveBeenCalled();
    expect(result.accumulated).toBe("");
  });

  it("reassembles a JSON event split across chunk boundaries", async () => {
    const onText = vi.fn();

    await readChatStream(
      readerFromChunks(['{"type":"text","con', 'tent":"split"}\n']),
      makeHandlers({ onText })
    );

    expect(onText).toHaveBeenCalledWith("split");
  });

  it("dispatches a trailing line that has no newline terminator", async () => {
    const onText = vi.fn();

    await readChatStream(
      readerFromChunks(['{"type":"text","content":"unterminated"}']),
      makeHandlers({ onText })
    );

    expect(onText).toHaveBeenCalledWith("unterminated");
  });
});

describe("readChatStream — pid status events", () => {
  it("reports the pid when the event carries one and a handler is supplied", async () => {
    const onPid = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "status", pid: 4321 }]),
      makeHandlers({ onPid })
    );

    expect(onPid).toHaveBeenCalledWith(4321);
  });

  it("does not report a pid for a status event that omits it", async () => {
    const onPid = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "status", status: "running" }]),
      makeHandlers({ onPid })
    );

    expect(onPid).not.toHaveBeenCalled();
  });

  it("completes normally when a pid arrives but no onPid handler is registered", async () => {
    const onComplete = vi.fn();

    const result = await readChatStream(
      readerFromEvents([{ type: "status", pid: 99 }, { type: "done" }]),
      makeHandlers({ onComplete })
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(true);
  });
});

describe("readChatStream — tool events", () => {
  it("reports a tool_use with its name, input and id", async () => {
    const onToolUse = vi.fn();

    await readChatStream(
      readerFromEvents([
        {
          type: "tool_use",
          name: "Read",
          id: "toolu_1",
          input: { file_path: "/a.ts" },
        },
      ]),
      makeHandlers({ onToolUse })
    );

    expect(onToolUse).toHaveBeenCalledWith({
      name: "Read",
      input: { file_path: "/a.ts" },
      id: "toolu_1",
    });
  });

  it("ignores a tool_use missing its name", async () => {
    const onToolUse = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "tool_use", id: "toolu_1", input: {} }]),
      makeHandlers({ onToolUse })
    );

    expect(onToolUse).not.toHaveBeenCalled();
  });

  it("ignores a tool_use missing its id", async () => {
    const onToolUse = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "tool_use", name: "Read", input: {} }]),
      makeHandlers({ onToolUse })
    );

    expect(onToolUse).not.toHaveBeenCalled();
  });

  it("completes normally when a tool_use arrives with no onToolUse handler", async () => {
    const onComplete = vi.fn();

    await readChatStream(
      readerFromEvents([
        { type: "tool_use", name: "Read", id: "t1" },
        { type: "result" },
      ]),
      makeHandlers({ onComplete })
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("defaults is_error to false when the gateway omits the flag", async () => {
    const onToolResult = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "tool_result", id: "toolu_1", content: "ok" }]),
      makeHandlers({ onToolResult })
    );

    expect(onToolResult).toHaveBeenCalledWith({
      id: "toolu_1",
      content: "ok",
      is_error: false,
    });
  });

  it("preserves an explicit is_error flag", async () => {
    const onToolResult = vi.fn();

    await readChatStream(
      readerFromEvents([
        { type: "tool_result", id: "toolu_2", content: "boom", is_error: true },
      ]),
      makeHandlers({ onToolResult })
    );

    expect(onToolResult).toHaveBeenCalledWith({
      id: "toolu_2",
      content: "boom",
      is_error: true,
    });
  });

  it("formats structured tool_result content into display text", async () => {
    const onToolResult = vi.fn();

    await readChatStream(
      readerFromEvents([
        {
          type: "tool_result",
          id: "toolu_3",
          content: ["first", { nested: true }],
        },
      ]),
      makeHandlers({ onToolResult })
    );

    expect(onToolResult).toHaveBeenCalledWith({
      id: "toolu_3",
      content: `first\n${JSON.stringify({ nested: true }, null, 2)}`,
      is_error: false,
    });
  });

  it("ignores a tool_result missing its id", async () => {
    const onToolResult = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "tool_result", content: "orphan" }]),
      makeHandlers({ onToolResult })
    );

    expect(onToolResult).not.toHaveBeenCalled();
  });
});

describe("readChatStream — thinking and reasoning events", () => {
  it("reports thinking content", async () => {
    const onThinking = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "thinking", content: "pondering" }]),
      makeHandlers({ onThinking })
    );

    expect(onThinking).toHaveBeenCalledWith("pondering");
  });

  it("routes reasoning events to the same thinking handler", async () => {
    const onThinking = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "reasoning", content: "deducing" }]),
      makeHandlers({ onThinking })
    );

    expect(onThinking).toHaveBeenCalledWith("deducing");
  });

  it("ignores a thinking event with no content", async () => {
    const onThinking = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "thinking" }]),
      makeHandlers({ onThinking })
    );

    expect(onThinking).not.toHaveBeenCalled();
  });

  it("ignores a reasoning event with no content", async () => {
    const onThinking = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "reasoning" }]),
      makeHandlers({ onThinking })
    );

    expect(onThinking).not.toHaveBeenCalled();
  });

  it("completes normally when thinking arrives with no onThinking handler", async () => {
    const onComplete = vi.fn();

    await readChatStream(
      readerFromEvents([
        { type: "thinking", content: "x" },
        { type: "reasoning", content: "y" },
        { type: "done" },
      ]),
      makeHandlers({ onComplete })
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("readChatStream — learnings and usage events", () => {
  it("signals learnings only when the status is triggered", async () => {
    const onLearnings = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "learnings", status: "triggered" }]),
      makeHandlers({ onLearnings })
    );

    expect(onLearnings).toHaveBeenCalledTimes(1);
  });

  it("does not signal learnings for a non-triggered status", async () => {
    const onLearnings = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "learnings", status: "skipped" }]),
      makeHandlers({ onLearnings })
    );

    expect(onLearnings).not.toHaveBeenCalled();
  });

  it("reports a context percentage", async () => {
    const onUsage = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "usage", contextPercent: 42 }]),
      makeHandlers({ onUsage })
    );

    expect(onUsage).toHaveBeenCalledWith(42);
  });

  it("reports a zero context percentage rather than treating it as absent", async () => {
    const onUsage = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "usage", contextPercent: 0 }]),
      makeHandlers({ onUsage })
    );

    expect(onUsage).toHaveBeenCalledWith(0);
  });

  it("ignores a usage event with no context percentage", async () => {
    const onUsage = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "usage" }]),
      makeHandlers({ onUsage })
    );

    expect(onUsage).not.toHaveBeenCalled();
  });

  it("completes normally when learnings and usage arrive with no handlers", async () => {
    const onComplete = vi.fn();

    await readChatStream(
      readerFromEvents([
        { type: "learnings", status: "triggered" },
        { type: "usage", contextPercent: 10 },
        { type: "done" },
      ]),
      makeHandlers({ onComplete })
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("readChatStream — error classification", () => {
  it("surfaces a plain error with its structured phase, code and provider", async () => {
    const onError = vi.fn();

    const result = await readChatStream(
      readerFromEvents([
        {
          type: "error",
          phase: "spawn",
          code: "ENOENT",
          boundProvider: "claude",
          message: "provider missing",
        },
      ]),
      makeHandlers({ onError })
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "spawn",
        code: "ENOENT",
        boundProvider: "claude",
        message: "provider missing",
      })
    );
    expect(result.terminalError).toBe(false);
  });

  it("falls back to the legacy error string when no message field is present", async () => {
    const onError = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "error", error: "legacy failure" }]),
      makeHandlers({ onError })
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "legacy failure" })
    );
  });

  it("falls back to a generic message when neither message nor error is present", async () => {
    const onError = vi.fn();

    await readChatStream(
      readerFromEvents([{ type: "error" }]),
      makeHandlers({ onError })
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Unknown error" })
    );
  });

  it("prefers the message field over the legacy error field", async () => {
    const onError = vi.fn();

    await readChatStream(
      readerFromEvents([
        { type: "error", message: "structured", error: "legacy" },
      ]),
      makeHandlers({ onError })
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "structured" })
    );
  });

  it("drops an unrecognised phase rather than passing it through", async () => {
    const onError = vi.fn();

    await readChatStream(
      readerFromEvents([
        { type: "error", phase: "teleport", message: "odd phase" },
      ]),
      makeHandlers({ onError })
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ phase: undefined, message: "odd phase" })
    );
  });

  it("marks a terminal error, reports it, and uses the command-failed fallback", async () => {
    const onError = vi.fn();

    const result = await readChatStream(
      readerFromEvents([{ type: "error", terminal: true }]),
      makeHandlers({ onError })
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Command failed" })
    );
    expect(result.terminalError).toBe(true);
  });

  it("suppresses a relay transport error instead of surfacing it to the user", async () => {
    const onError = vi.fn();

    const result = await readChatStream(
      readerFromEvents([
        { type: "error", relay: true, error: "socket hang up" },
      ]),
      makeHandlers({ onError })
    );

    expect(onError).not.toHaveBeenCalled();
    expect(result.lastRelayError).toBe("socket hang up");
    expect(result.terminalError).toBe(false);
  });

  it("records a default relay message when the relay error carries no text", async () => {
    const result = await readChatStream(
      readerFromEvents([{ type: "error", relay: true }]),
      makeHandlers()
    );

    expect(result.lastRelayError).toBe("Relay connection lost");
  });

  it("keeps streaming text after a suppressed relay error", async () => {
    const onText = vi.fn();

    const result = await readChatStream(
      readerFromEvents([
        { type: "text", content: "before" },
        { type: "error", relay: true, error: "blip" },
        { type: "text", content: "-after" },
      ]),
      makeHandlers({ onText })
    );

    expect(onText).toHaveBeenLastCalledWith("before-after");
    expect(result.lastRelayError).toBe("blip");
  });
});

describe("readChatStream — completion and relay metadata", () => {
  it("completes on a result event", async () => {
    const onComplete = vi.fn();

    const result = await readChatStream(
      readerFromEvents([{ type: "result" }]),
      makeHandlers({ onComplete })
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(true);
  });

  it("completes on a done event", async () => {
    const onComplete = vi.fn();

    const result = await readChatStream(
      readerFromEvents([{ type: "done" }]),
      makeHandlers({ onComplete })
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(true);
  });

  it("reports an incomplete stream when no terminal event arrives", async () => {
    const onComplete = vi.fn();

    const result = await readChatStream(
      readerFromEvents([{ type: "text", content: "cut off" }]),
      makeHandlers({ onComplete })
    );

    expect(onComplete).not.toHaveBeenCalled();
    expect(result.completed).toBe(false);
  });

  it("captures the relay commandId for reconnection", async () => {
    const result = await readChatStream(
      readerFromEvents([
        { type: "relay_meta", commandId: "cmd-7" },
        { type: "done" },
      ]),
      makeHandlers()
    );

    expect(result.commandId).toBe("cmd-7");
  });

  it("ignores a relay_meta event carrying no commandId", async () => {
    const result = await readChatStream(
      readerFromEvents([{ type: "relay_meta" }, { type: "done" }]),
      makeHandlers()
    );

    expect(result.commandId).toBeUndefined();
  });

  it("tracks the highest sequence number seen for resume", async () => {
    const result = await readChatStream(
      readerFromEvents([
        { type: "text", content: "a", _seq: 1 },
        { type: "text", content: "b", _seq: 2 },
        { type: "done", _seq: 3 },
      ]),
      makeHandlers()
    );

    expect(result.lastSeq).toBe(3);
  });

  it("leaves the sequence number unset when the stream carries none", async () => {
    const result = await readChatStream(
      readerFromEvents([{ type: "done" }]),
      makeHandlers()
    );

    expect(result.lastSeq).toBeUndefined();
  });
});

describe("readChatStream — malformed and unknown wire input", () => {
  it("skips a non-JSON line without aborting the stream", async () => {
    const onText = vi.fn();
    const onComplete = vi.fn();

    const result = await readChatStream(
      readerFromChunks([
        'not json at all\n{"type":"text","content":"survived"}\n{"type":"done"}\n',
      ]),
      makeHandlers({ onText, onComplete })
    );

    expect(onText).toHaveBeenCalledWith("survived");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(true);
  });

  it("ignores an unknown event type emitted by a newer peer", async () => {
    const onText = vi.fn();
    const onError = vi.fn();
    const onComplete = vi.fn();

    const result = await readChatStream(
      readerFromEvents([
        { type: "some_future_event", payload: { anything: 1 } },
        { type: "done" },
      ]),
      makeHandlers({ onText, onError, onComplete })
    );

    expect(onText).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.completed).toBe(true);
  });

  it("forwards every parsed event to the raw observer before dispatch", async () => {
    const onEvent = vi.fn();

    await readChatStream(
      readerFromChunks([
        '{"type":"text","content":"hi"}\nnot json\n{"type":"done"}\n',
      ]),
      makeHandlers({ onEvent })
    );

    expect(onEvent.mock.calls.map((c) => c[0])).toEqual([
      { type: "text", content: "hi" },
      { type: "done" },
    ]);
  });

  it("returns empty results for a stream that yields no lines", async () => {
    const onText = vi.fn();
    const onComplete = vi.fn();

    const result = await readChatStream(
      readerFromChunks([]),
      makeHandlers({ onText, onComplete })
    );

    expect(onText).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(result).toEqual({
      accumulated: "",
      commandId: undefined,
      lastSeq: undefined,
      completed: false,
      terminalError: false,
      lastRelayError: undefined,
    });
  });
});
