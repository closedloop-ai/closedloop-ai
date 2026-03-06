import { toast } from "sonner";
import { readNdjsonLines } from "@/lib/engineer/stream-utils";

export type StreamEventHandlers = {
  onSessionId?: (sessionId: string) => void;
  onReviewCommand?: (command: string) => void;
  onContextPercent?: (percent: number) => void;
};

export type StreamState = {
  accumulated: string;
  receivedDone: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON events
export type StreamEvent = Record<string, any>;

/** Dispatch a single parsed stream event. Mutates `state` accumulation fields. */
export function dispatchReviewEvent(
  event: StreamEvent,
  state: StreamState,
  setOutput: (value: string) => void,
  handlers: StreamEventHandlers
): void {
  if (event.type === "reviewCommand" && event.reviewCommand) {
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
    // Electron sends session ID as a "status" event
    console.log(`[stream-reader] Session ID (status): ${event.sessionId}`);
    handlers.onSessionId?.(event.sessionId);
  } else if (event.type === "usage" && event.contextPercent != null) {
    handlers.onContextPercent?.(event.contextPercent);
  } else if (event.type === "done") {
    console.log(`[stream-reader] Done event, exitCode=${event.exitCode}`);
    state.receivedDone = true;
  } else if (event.type === "error") {
    toast.error("Review error", {
      description: event.content ?? event.error,
    });
  }
}

export async function streamReviewOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  setOutput: (value: string) => void,
  onSessionId?: (sessionId: string) => void,
  onReviewCommand?: (command: string) => void,
  onContextPercent?: (percent: number) => void
): Promise<{ text: string; completed: boolean }> {
  const state: StreamState = { accumulated: "", receivedDone: false };
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

  return { text: state.accumulated, completed: state.receivedDone };
}
