import { describe, expect, it, vi } from "vitest";
import { createCodexStreamState, readCodexStream } from "../codex-stream";

function createReader(
  chunks: string[]
): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return stream.getReader();
}

describe("readCodexStream", () => {
  it("parses text events and calls setPending", async () => {
    const reader = createReader([
      '{"type":"text","content":"Hello"}\n',
      '{"type":"text","content":" world"}\n',
      '{"type":"done","content":"Hello world"}\n',
    ]);

    const state = createCodexStreamState();
    const setPending = vi.fn();
    const saveFinalMessage = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn();

    await readCodexStream(reader, state, {
      setPending,
      saveFinalMessage,
      onComplete,
    });

    expect(setPending).toHaveBeenCalled();
    expect(saveFinalMessage).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith("Hello world");
  });

  it("handles JSON split across chunks (buffered NDJSON)", async () => {
    // A single JSON object split across two chunks
    const reader = createReader([
      '{"type":"text","conte',
      'nt":"split"}\n{"type":"done"}\n',
    ]);

    const state = createCodexStreamState();
    const setPending = vi.fn();
    const saveFinalMessage = vi.fn().mockResolvedValue(undefined);

    await readCodexStream(reader, state, {
      setPending,
      saveFinalMessage,
    });

    expect(state.accumulated).toBe("split");
    expect(saveFinalMessage).toHaveBeenCalledOnce();
    expect(saveFinalMessage.mock.calls[0][0].content).toBe("split");
  });

  it("calls onError for error events", async () => {
    const reader = createReader([
      '{"type":"error","error":"Something went wrong"}\n',
      '{"type":"done"}\n',
    ]);

    const state = createCodexStreamState();
    const onError = vi.fn();

    await readCodexStream(reader, state, {
      setPending: vi.fn(),
      saveFinalMessage: vi.fn().mockResolvedValue(undefined),
      onError,
    });

    expect(onError).toHaveBeenCalledWith("Something went wrong");
  });

  it("calls onEmptyResponse when done with no text", async () => {
    const reader = createReader(['{"type":"done","exitCode":1}\n']);

    const state = createCodexStreamState();
    const onEmptyResponse = vi.fn();

    await readCodexStream(reader, state, {
      setPending: vi.fn(),
      saveFinalMessage: vi.fn().mockResolvedValue(undefined),
      onEmptyResponse,
    });

    expect(onEmptyResponse).toHaveBeenCalledWith(1);
  });

  it("calls onDoneEvent with the raw done event", async () => {
    const reader = createReader([
      '{"type":"text","content":"response"}\n',
      '{"type":"done","debateStatus":{"resolved":true}}\n',
    ]);

    const state = createCodexStreamState();
    const onDoneEvent = vi.fn();

    await readCodexStream(reader, state, {
      setPending: vi.fn(),
      saveFinalMessage: vi.fn().mockResolvedValue(undefined),
      onDoneEvent,
    });

    expect(onDoneEvent).toHaveBeenCalledOnce();
    expect(onDoneEvent.mock.calls[0][0]).toMatchObject({
      type: "done",
      debateStatus: { resolved: true },
    });
  });

  it("accumulates reasoning blocks", async () => {
    const reader = createReader([
      '{"type":"reasoning","content":"thinking..."}\n',
      '{"type":"text","content":"answer"}\n',
      '{"type":"done"}\n',
    ]);

    const state = createCodexStreamState();
    const saveFinalMessage = vi.fn().mockResolvedValue(undefined);

    await readCodexStream(reader, state, {
      setPending: vi.fn(),
      saveFinalMessage,
    });

    expect(state.reasoningBlocks).toHaveLength(1);
    expect(state.reasoningBlocks[0].thinking).toBe("thinking...");
    // Final message should include blocks
    expect(saveFinalMessage.mock.calls[0][0].blocks).toHaveLength(1);
  });

  it("provides mutable state for abort scenarios", async () => {
    // Simulate reading partial data (state should be readable after stream ends)
    const reader = createReader(['{"type":"text","content":"partial"}\n']);

    const state = createCodexStreamState();

    await readCodexStream(reader, state, {
      setPending: vi.fn(),
      saveFinalMessage: vi.fn().mockResolvedValue(undefined),
    });

    // After stream ends (even without a done event), state holds partial content
    expect(state.accumulated).toBe("partial");
    expect(state.receivedAnyText).toBe(true);
  });

  it("skips non-JSON lines gracefully", async () => {
    const reader = createReader([
      "not json\n",
      '{"type":"text","content":"valid"}\n',
      '{"type":"done"}\n',
    ]);

    const state = createCodexStreamState();
    const saveFinalMessage = vi.fn().mockResolvedValue(undefined);

    await readCodexStream(reader, state, {
      setPending: vi.fn(),
      saveFinalMessage,
    });

    expect(state.accumulated).toBe("valid");
  });
});
