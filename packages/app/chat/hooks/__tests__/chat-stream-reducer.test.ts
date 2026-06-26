/**
 * Unit tests for chatStreamReducer — the pure reducer that drives the chat
 * streaming UI state machine.
 *
 * Covers every ChatStreamAction against initialChatStreamState, with focus on
 * the branches that the indirect use-chat-stream hook test does not exercise:
 * the block/updateToolResult id-match map (matching vs non-matching ids) and
 * the pendingMessage/set streamStartedAt-preservation branch.
 */

import type { ChatMessage } from "@repo/app/chat/lib/types";
import { describe, expect, it } from "vitest";
import {
  type ChatStreamState,
  chatStreamReducer,
  initialChatStreamState,
} from "../chat-stream-reducer";

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    role: "user",
    content: "hello",
    timestamp: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("chatStreamReducer", () => {
  it("send/start begins streaming and resets transient state", () => {
    const dirty: ChatStreamState = {
      ...initialChatStreamState,
      streamingContent: "stale",
      streamingBlocks: [{ type: "text", text: "stale" }],
      error: "previous error",
    };

    const next = chatStreamReducer(dirty, {
      type: "send/start",
      startedAt: "2026-06-22T01:00:00.000Z",
    });

    expect(next.isStreaming).toBe(true);
    expect(next.streamingContent).toBe("");
    expect(next.streamingBlocks).toEqual([]);
    expect(next.error).toBeNull();
    expect(next.streamStartedAt).toBe("2026-06-22T01:00:00.000Z");
  });

  it("send/finish clears streaming state and pending message", () => {
    const streaming: ChatStreamState = {
      ...initialChatStreamState,
      isStreaming: true,
      streamingContent: "partial",
      streamingBlocks: [{ type: "text", text: "partial" }],
      pendingUserMessage: makeMessage(),
      streamStartedAt: "2026-06-22T01:00:00.000Z",
    };

    const next = chatStreamReducer(streaming, { type: "send/finish" });

    expect(next.isStreaming).toBe(false);
    expect(next.streamingContent).toBe("");
    expect(next.streamingBlocks).toEqual([]);
    expect(next.pendingUserMessage).toBeNull();
    expect(next.streamStartedAt).toBe("");
  });

  it("text/update replaces the streaming content", () => {
    const next = chatStreamReducer(initialChatStreamState, {
      type: "text/update",
      content: "streamed text",
    });

    expect(next.streamingContent).toBe("streamed text");
  });

  it("block/addToolUse appends a tool_use block", () => {
    const next = chatStreamReducer(initialChatStreamState, {
      type: "block/addToolUse",
      tool: { id: "tool-1", name: "search", input: { q: "hi" } },
    });

    expect(next.streamingBlocks).toEqual([
      { type: "tool_use", id: "tool-1", name: "search", input: { q: "hi" } },
    ]);
  });

  it("block/updateToolResult updates the matching tool_use block in place", () => {
    const withTool: ChatStreamState = {
      ...initialChatStreamState,
      streamingBlocks: [
        { type: "tool_use", id: "tool-1", name: "search", input: {} },
        { type: "tool_use", id: "tool-2", name: "read", input: {} },
      ],
    };

    const next = chatStreamReducer(withTool, {
      type: "block/updateToolResult",
      result: { id: "tool-2", content: "done", is_error: false },
    });

    expect(next.streamingBlocks[0]).toEqual({
      type: "tool_use",
      id: "tool-1",
      name: "search",
      input: {},
    });
    expect(next.streamingBlocks[1]).toMatchObject({
      type: "tool_result",
      id: "tool-2",
      content: "done",
      is_error: false,
    });
  });

  it("block/updateToolResult passes state through when no block id matches", () => {
    const withTool: ChatStreamState = {
      ...initialChatStreamState,
      streamingBlocks: [
        { type: "tool_use", id: "tool-1", name: "search", input: {} },
      ],
    };

    const next = chatStreamReducer(withTool, {
      type: "block/updateToolResult",
      result: { id: "missing", content: "ignored", is_error: true },
    });

    expect(next.streamingBlocks).toEqual(withTool.streamingBlocks);
  });

  it("block/addThinking appends a thinking block", () => {
    const next = chatStreamReducer(initialChatStreamState, {
      type: "block/addThinking",
      id: "think-1",
      content: "reasoning",
    });

    expect(next.streamingBlocks).toEqual([
      { type: "thinking", id: "think-1", thinking: "reasoning" },
    ]);
  });

  it("error/set and error/clear toggle the error field", () => {
    const withError = chatStreamReducer(initialChatStreamState, {
      type: "error/set",
      message: "boom",
    });
    expect(withError.error).toBe("boom");

    const cleared = chatStreamReducer(withError, { type: "error/clear" });
    expect(cleared.error).toBeNull();
  });

  it("usage/set records the context percent", () => {
    const next = chatStreamReducer(initialChatStreamState, {
      type: "usage/set",
      percent: 42,
    });

    expect(next.contextPercent).toBe(42);
  });

  it("pendingMessage/set stamps streamStartedAt when becoming non-null from empty", () => {
    const message = makeMessage();

    const next = chatStreamReducer(initialChatStreamState, {
      type: "pendingMessage/set",
      message,
      now: "2026-06-22T02:00:00.000Z",
    });

    expect(next.pendingUserMessage).toBe(message);
    expect(next.streamStartedAt).toBe("2026-06-22T02:00:00.000Z");
  });

  it("pendingMessage/set preserves an existing streamStartedAt", () => {
    const seeded: ChatStreamState = {
      ...initialChatStreamState,
      streamStartedAt: "2026-06-22T01:00:00.000Z",
    };

    const next = chatStreamReducer(seeded, {
      type: "pendingMessage/set",
      message: makeMessage(),
      now: "2026-06-22T02:00:00.000Z",
    });

    expect(next.streamStartedAt).toBe("2026-06-22T01:00:00.000Z");
  });

  it("pendingMessage/set does not stamp streamStartedAt when clearing to null", () => {
    const seeded: ChatStreamState = {
      ...initialChatStreamState,
      pendingUserMessage: makeMessage(),
    };

    const next = chatStreamReducer(seeded, {
      type: "pendingMessage/set",
      message: null,
      now: "2026-06-22T02:00:00.000Z",
    });

    expect(next.pendingUserMessage).toBeNull();
    expect(next.streamStartedAt).toBe("");
  });

  it("returns the same state reference for an unknown action", () => {
    const next = chatStreamReducer(initialChatStreamState, {
      type: "unknown/action",
    } as unknown as Parameters<typeof chatStreamReducer>[1]);

    expect(next).toBe(initialChatStreamState);
  });
});
