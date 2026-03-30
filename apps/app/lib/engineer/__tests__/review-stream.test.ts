import { describe, expect, it, vi } from "vitest";
import {
  dispatchReviewEvent,
  type StreamEventHandlers,
  type StreamState,
  streamReviewOutput,
} from "../review-stream";
import { createReader } from "./test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

function makeState(overrides?: Partial<StreamState>): StreamState {
  return {
    accumulated: "",
    terminalState: null,
    ...overrides,
  };
}

function makeHandlers(
  overrides?: Partial<StreamEventHandlers>
): StreamEventHandlers {
  return {
    onSessionId: vi.fn(),
    onReviewCommand: vi.fn(),
    onContextPercent: vi.fn(),
    onCommandId: vi.fn(),
    ...overrides,
  };
}

describe("dispatchReviewEvent", () => {
  it("sets terminalState to 'done' on done event", () => {
    const state = makeState();
    dispatchReviewEvent(
      { type: "done", exitCode: 0 },
      state,
      vi.fn(),
      makeHandlers()
    );
    expect(state.terminalState).toBe("done");
  });

  it("sets terminalState to 'terminal_error' on done event with non-zero exitCode", () => {
    const state = makeState();
    dispatchReviewEvent(
      { type: "done", exitCode: 1 },
      state,
      vi.fn(),
      makeHandlers()
    );
    expect(state.terminalState).toBe("terminal_error");
    expect(state.terminalError).toContain("exited with code 1");
  });

  it("sets terminalState to 'terminal_error' on terminal error event", () => {
    const state = makeState();
    dispatchReviewEvent(
      { type: "error", terminal: true, error: "OOM killed" },
      state,
      vi.fn(),
      makeHandlers()
    );
    expect(state.terminalState).toBe("terminal_error");
    expect(state.terminalError).toBe("OOM killed");
  });

  it("preserves error content from terminal error event.content", () => {
    const state = makeState();
    dispatchReviewEvent(
      { type: "error", terminal: true, content: "Process crashed" },
      state,
      vi.fn(),
      makeHandlers()
    );
    expect(state.terminalError).toBe("Process crashed");
  });

  it("leaves terminalState null on relay transport error (no toast)", () => {
    const state = makeState();
    const setOutput = vi.fn();
    dispatchReviewEvent(
      { type: "error", relay: true, error: "Stream timed out" },
      state,
      setOutput,
      makeHandlers()
    );
    expect(state.terminalState).toBeNull();
  });

  it("captures commandId from relay_meta event", () => {
    const state = makeState();
    const handlers = makeHandlers();
    dispatchReviewEvent(
      { type: "relay_meta", commandId: "cmd-123" },
      state,
      vi.fn(),
      handlers
    );
    expect(state.commandId).toBe("cmd-123");
    expect(handlers.onCommandId).toHaveBeenCalledWith("cmd-123");
  });

  it("tracks _seq in state.lastSeq", () => {
    const state = makeState();
    dispatchReviewEvent(
      { type: "text", content: "hello", _seq: 5 },
      state,
      vi.fn(),
      makeHandlers()
    );
    expect(state.lastSeq).toBe(5);
  });

  it("accumulates text content", () => {
    const state = makeState();
    const setOutput = vi.fn();
    dispatchReviewEvent(
      { type: "text", content: "Hello " },
      state,
      setOutput,
      makeHandlers()
    );
    dispatchReviewEvent(
      { type: "output", content: "world" },
      state,
      setOutput,
      makeHandlers()
    );
    expect(state.accumulated).toBe("Hello world");
    expect(setOutput).toHaveBeenCalledTimes(2);
    expect(setOutput).toHaveBeenLastCalledWith("Hello world");
  });

  it("calls onSessionId for sessionId events", () => {
    const state = makeState();
    const handlers = makeHandlers();
    dispatchReviewEvent(
      { type: "sessionId", sessionId: "sid-1" },
      state,
      vi.fn(),
      handlers
    );
    expect(handlers.onSessionId).toHaveBeenCalledWith("sid-1");
  });

  it("calls onReviewCommand for reviewCommand events", () => {
    const state = makeState();
    const handlers = makeHandlers();
    dispatchReviewEvent(
      { type: "reviewCommand", reviewCommand: "codex review" },
      state,
      vi.fn(),
      handlers
    );
    expect(handlers.onReviewCommand).toHaveBeenCalledWith("codex review");
  });

  it("calls onContextPercent for usage events", () => {
    const state = makeState();
    const handlers = makeHandlers();
    dispatchReviewEvent(
      { type: "usage", contextPercent: 75 },
      state,
      vi.fn(),
      handlers
    );
    expect(handlers.onContextPercent).toHaveBeenCalledWith(75);
  });
});

describe("streamReviewOutput", () => {
  it("returns terminalState 'done' when stream ends with done event", async () => {
    const reader = createReader([
      '{"type":"text","content":"Review complete."}\n',
      '{"type":"done","exitCode":0}\n',
    ]);
    const result = await streamReviewOutput(reader, vi.fn());
    expect(result.terminalState).toBe("done");
    expect(result.text).toBe("Review complete.");
  });

  it("returns terminalState 'terminal_error' when done event has non-zero exitCode", async () => {
    const reader = createReader(['{"type":"done","exitCode":2}\n']);
    const result = await streamReviewOutput(reader, vi.fn());
    expect(result.terminalState).toBe("terminal_error");
    expect(result.terminalError).toContain("exited with code 2");
  });

  it("returns terminalState 'terminal_error' with error message", async () => {
    const reader = createReader([
      '{"type":"error","terminal":true,"error":"Process killed by OOM"}\n',
    ]);
    const result = await streamReviewOutput(reader, vi.fn());
    expect(result.terminalState).toBe("terminal_error");
    expect(result.terminalError).toBe("Process killed by OOM");
  });

  it("returns terminalState null when stream ends without terminal event", async () => {
    const reader = createReader([
      '{"type":"text","content":"partial"}\n',
      '{"type":"error","relay":true,"error":"Stream timed out"}\n',
    ]);
    const result = await streamReviewOutput(reader, vi.fn());
    expect(result.terminalState).toBeNull();
  });

  it("captures commandId from relay_meta", async () => {
    const reader = createReader([
      '{"type":"relay_meta","commandId":"cmd-abc"}\n',
      '{"type":"done"}\n',
    ]);
    const result = await streamReviewOutput(reader, vi.fn());
    expect(result.commandId).toBe("cmd-abc");
  });

  it("tracks lastSeq from _seq fields", async () => {
    const reader = createReader([
      '{"type":"text","content":"a","_seq":1}\n',
      '{"type":"text","content":"b","_seq":5}\n',
      '{"type":"done","_seq":6}\n',
    ]);
    const result = await streamReviewOutput(reader, vi.fn());
    expect(result.lastSeq).toBe(6);
  });

  it("resumes from initialState.accumulated", async () => {
    const reader = createReader([
      '{"type":"text","content":" continued"}\n',
      '{"type":"done"}\n',
    ]);
    const setOutput = vi.fn();
    const result = await streamReviewOutput(
      reader,
      setOutput,
      undefined,
      undefined,
      undefined,
      { accumulated: "prior text" }
    );
    expect(result.text).toBe("prior text continued");
    expect(setOutput).toHaveBeenCalledWith("prior text continued");
  });

  it("starts fresh when no initialState provided (regression)", async () => {
    const reader = createReader([
      '{"type":"text","content":"fresh"}\n',
      '{"type":"done"}\n',
    ]);
    const result = await streamReviewOutput(reader, vi.fn());
    expect(result.text).toBe("fresh");
  });

  it("preserves commandId and lastSeq from initialState", async () => {
    const reader = createReader(['{"type":"done"}\n']);
    const result = await streamReviewOutput(
      reader,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      { commandId: "cmd-prior", lastSeq: 10 }
    );
    expect(result.commandId).toBe("cmd-prior");
    expect(result.lastSeq).toBe(10);
  });
});
