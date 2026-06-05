import { toast } from "sonner";
import { readNdjsonLines } from "@/lib/engineer/stream-utils";

export type StreamEventHandlers = {
  onSessionId?: (sessionId: string) => void;
  onReviewCommand?: (command: string) => void;
  onContextPercent?: (percent: number) => void;
  onCommandId?: (commandId: string) => void;
};

export type TerminalState = "done" | "terminal_error" | null;

export type StreamState = {
  accumulated: string;
  terminalState: TerminalState;
  terminalError?: string;
  commandId?: string;
  lastSeq?: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON events
export type StreamEvent = Record<string, any>;

function handleErrorEvent(event: StreamEvent, state: StreamState): void {
  if (event.terminal === true) {
    state.terminalState = "terminal_error";
    state.terminalError = event.error ?? event.content ?? undefined;
  } else if (event.relay === true) {
    console.log(
      `[stream-reader] Relay transport error (suppressed): ${event.error}`
    );
  } else {
    toast.error("Review error", {
      description: event.content ?? event.error,
    });
  }
}

/** Dispatch a single parsed stream event. Mutates `state` accumulation fields. */
export function dispatchReviewEvent(
  event: StreamEvent,
  state: StreamState,
  setOutput: (value: string) => void,
  handlers: StreamEventHandlers
): void {
  if (typeof event._seq === "number") {
    state.lastSeq = event._seq;
  }

  if (event.type === "relay_meta" && event.commandId) {
    state.commandId = event.commandId;
    handlers.onCommandId?.(event.commandId);
  } else if (event.type === "reviewCommand" && event.reviewCommand) {
    console.log(`[stream-reader] Review command: ${event.reviewCommand}`);
    handlers.onReviewCommand?.(event.reviewCommand);
  } else if (event.type === "sessionId" && event.sessionId) {
    console.log(`[stream-reader] Session ID: ${event.sessionId}`);
    handlers.onSessionId?.(event.sessionId);
  } else if (
    (event.type === "output" || event.type === "text") &&
    event.content
  ) {
    state.accumulated += event.content;
    setOutput(state.accumulated);
  } else if (event.type === "status" && event.sessionId) {
    console.log(`[stream-reader] Session ID (status): ${event.sessionId}`);
    handlers.onSessionId?.(event.sessionId);
  } else if (event.type === "usage" && event.contextPercent != null) {
    handlers.onContextPercent?.(event.contextPercent);
  } else if (event.type === "done") {
    console.log(`[stream-reader] Done event, exitCode=${event.exitCode}`);
    if (typeof event.exitCode === "number" && event.exitCode !== 0) {
      state.terminalState = "terminal_error";
      state.terminalError =
        event.error ??
        event.content ??
        `Review process exited with code ${event.exitCode}`;
    } else {
      state.terminalState = "done";
    }
  } else if (event.type === "error") {
    handleErrorEvent(event, state);
  }
}

export type StreamReviewResult = {
  text: string;
  terminalState: TerminalState;
  terminalError?: string;
  commandId?: string;
  lastSeq?: number;
};

export async function streamReviewOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  setOutput: (value: string) => void,
  onSessionId?: (sessionId: string) => void,
  onReviewCommand?: (command: string) => void,
  onContextPercent?: (percent: number) => void,
  initialState?: Partial<StreamState>
): Promise<StreamReviewResult> {
  const state: StreamState = {
    accumulated: initialState?.accumulated ?? "",
    terminalState: null,
    commandId: initialState?.commandId,
    lastSeq: initialState?.lastSeq,
  };
  const handlers: StreamEventHandlers = {
    onSessionId,
    onReviewCommand,
    onContextPercent,
  };

  for await (const line of readNdjsonLines(reader)) {
    try {
      const event = JSON.parse(line);
      dispatchReviewEvent(event, state, setOutput, handlers);
    } catch {
      // Not JSON — skip
    }
  }

  return {
    text: state.accumulated,
    terminalState: state.terminalState,
    terminalError: state.terminalError,
    commandId: state.commandId,
    lastSeq: state.lastSeq,
  };
}
