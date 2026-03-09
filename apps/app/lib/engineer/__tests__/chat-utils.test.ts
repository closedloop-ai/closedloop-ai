import { describe, expect, it, vi } from "vitest";
import {
  CHAT_SENTINEL,
  parseConferralMention,
  readChatStream,
  sanitizeHistoryForModel,
  stripAssistantProtocol,
} from "../chat-utils";
import { createReader } from "./test-helpers";

describe("CHAT_SENTINEL", () => {
  it("contains all expected sentinel values", () => {
    expect(CHAT_SENTINEL.DEBATE_STARTED).toBe("__debate_started__");
    expect(CHAT_SENTINEL.DEBATE_ENDED).toBe("__debate_ended__");
    expect(CHAT_SENTINEL.FORWARDED_TO_CLAUDE).toBe("__forwarded_to_claude__");
    expect(CHAT_SENTINEL.FORWARDED_TO_CODEX).toBe("__forwarded_to_codex__");
    expect(CHAT_SENTINEL.CLAUDE_CONFERRED_TO_CODEX).toBe(
      "__claude_conferred_to_codex__"
    );
    expect(CHAT_SENTINEL.CODEX_CONFERRED_TO_CLAUDE).toBe(
      "__codex_conferred_to_claude__"
    );
  });

  it("has unique values", () => {
    const values = Object.values(CHAT_SENTINEL);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("parseConferralMention", () => {
  it("detects @codex mention from Claude", () => {
    const content = "Here is my analysis.\n\n@codex Can you verify this type?";
    const result = parseConferralMention(content, "claude");
    expect(result).not.toBeNull();
    expect(result!.target).toBe("codex");
    expect(result!.prompt).toBe("Can you verify this type?");
    expect(result!.cleanContent).toBe("Here is my analysis.");
  });

  it("detects @claude mention from Codex", () => {
    const content = "My findings are solid.\n\n@claude What do you think?";
    const result = parseConferralMention(content, "codex");
    expect(result).not.toBeNull();
    expect(result!.target).toBe("claude");
    expect(result!.prompt).toBe("What do you think?");
  });

  it("returns null for self-reference (Claude mentioning @claude)", () => {
    const content = "Analysis complete.\n\n@claude This is my follow-up.";
    const result = parseConferralMention(content, "claude");
    expect(result).toBeNull();
  });

  it("returns null for self-reference (Codex mentioning @codex)", () => {
    const content = "Done.\n\n@codex Another question.";
    const result = parseConferralMention(content, "codex");
    expect(result).toBeNull();
  });

  it("returns null when no mention present", () => {
    const result = parseConferralMention(
      "Just a regular response with no mentions.",
      "claude"
    );
    expect(result).toBeNull();
  });

  it("ignores @codex inside fenced code blocks", () => {
    const content =
      "Here is the code:\n\n```\n@codex This is inside a code block\n```\n\nDone.";
    const result = parseConferralMention(content, "claude");
    expect(result).toBeNull();
  });

  it("requires at least 5 characters after the mention", () => {
    const content = "Analysis.\n\n@codex hi";
    const result = parseConferralMention(content, "claude");
    expect(result).toBeNull();
  });

  it("handles trailing whitespace in the prompt", () => {
    const content =
      "My analysis is complete.\n\n@codex Can you double-check the types?  ";
    const result = parseConferralMention(content, "claude");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("Can you double-check the types?");
  });

  it("detects mention after suggested-actions have been stripped", () => {
    // In the real flow, parseSuggestedActions runs first, stripping actions.
    // The @mention line should still be detected afterward.
    const content =
      'Analysis.\n\n@codex Can you verify the algorithm correctness?\n\n<suggested-actions><action label="OK">ok</action></suggested-actions>';
    // Simulate: strip actions first (parseConferralMention should still work)
    const withoutActions = content
      .replaceAll(/<suggested-actions>[\s\S]*?<\/suggested-actions>/g, "")
      .trim();
    const result = parseConferralMention(withoutActions, "claude");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("Can you verify the algorithm correctness?");
  });

  it("produces correct cleanContent with mention removed", () => {
    const content =
      "Here is my detailed analysis of the bug.\n\nThe issue is in the handler.\n\n@codex Can you verify the fix works with edge cases?";
    const result = parseConferralMention(content, "claude");
    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain("@codex");
    expect(result!.cleanContent).toContain(
      "Here is my detailed analysis of the bug."
    );
  });
});

describe("stripAssistantProtocol", () => {
  it("strips suggested actions from content", () => {
    const content =
      'Hello world.\n\n<suggested-actions><action label="OK">ok</action></suggested-actions>';
    const result = stripAssistantProtocol(content);
    expect(result).toBe("Hello world.");
  });

  it("strips context blocks from content", () => {
    const content =
      '<context source="ticket">Some data</context>\n\nHere is my response.';
    const result = stripAssistantProtocol(content);
    expect(result).toBe("Here is my response.");
  });

  it("strips learnings-used blocks from content", () => {
    const content =
      'Response text.\n\n<learnings-used>[{"id":"1","source":"test","category":"test","summary":"test"}]</learnings-used>';
    const result = stripAssistantProtocol(content);
    expect(result).toBe("Response text.");
  });

  it("strips conferral mentions from content", () => {
    const content = "My analysis.\n\n@codex Can you verify the types?";
    const result = stripAssistantProtocol(content);
    expect(result).not.toContain("@codex");
    expect(result).toContain("My analysis.");
  });

  it("handles content with no protocol blocks", () => {
    const content = "Just a plain response.";
    const result = stripAssistantProtocol(content);
    expect(result).toBe("Just a plain response.");
  });

  it("chains all stripping operations correctly", () => {
    const content = [
      '<context source="pr">data</context>',
      "Here is my analysis.",
      '<learnings-used>[{"id":"1","source":"s","category":"c","summary":"sum"}]</learnings-used>',
      "@codex Can you verify?",
      '<suggested-actions><action label="OK">ok</action></suggested-actions>',
    ].join("\n\n");
    const result = stripAssistantProtocol(content);
    expect(result).toBe("Here is my analysis.");
  });
});

describe("sanitizeHistoryForModel", () => {
  it("drops sentinel-only user messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "user", content: CHAT_SENTINEL.DEBATE_STARTED },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: CHAT_SENTINEL.FORWARDED_TO_CODEX },
      { role: "user", content: CHAT_SENTINEL.CLAUDE_CONFERRED_TO_CODEX },
    ];
    const result = sanitizeHistoryForModel(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Hello");
    expect(result[1].content).toBe("Hi there");
  });

  it("strips assistant protocol from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content:
          'Response.\n\n<suggested-actions><action label="OK">ok</action></suggested-actions>',
      },
    ];
    const result = sanitizeHistoryForModel(messages);
    expect(result[0].content).toBe("Response.");
  });

  it("preserves normal user messages", () => {
    const messages = [
      { role: "user", content: "Fix the bug in auth.ts" },
      { role: "assistant", content: "Done." },
    ];
    const result = sanitizeHistoryForModel(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Fix the bug in auth.ts");
  });

  it("handles empty array", () => {
    const result = sanitizeHistoryForModel([]);
    expect(result).toEqual([]);
  });

  it("preserves sender field", () => {
    const messages = [{ role: "assistant", content: "Hello", sender: "codex" }];
    const result = sanitizeHistoryForModel(messages);
    expect(result[0].sender).toBe("codex");
  });
});

describe("readChatStream", () => {
  it("forwards every raw event to onEvent before dispatch", async () => {
    const reader = createReader([
      '{"type":"text","content":"hello"}\n',
      '{"type":"usage","contextPercent":42}\n',
      '{"type":"done"}\n',
    ]);
    const onEvent = vi.fn();
    const onText = vi.fn();
    const onComplete = vi.fn();

    await readChatStream(reader, {
      onText,
      onError: vi.fn(),
      onComplete,
      onEvent,
    });

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      type: "text",
      content: "hello",
    });
    expect(onEvent.mock.calls[1][0]).toMatchObject({
      type: "usage",
      contextPercent: 42,
    });
    expect(onEvent.mock.calls[2][0]).toMatchObject({ type: "done" });
  });

  it("forwards worktree_resolved events via onEvent", async () => {
    const reader = createReader([
      '{"type":"worktree_resolved","effectiveDir":"/tmp/repo-TICKET-1"}\n',
      '{"type":"text","content":"working"}\n',
      '{"type":"done"}\n',
    ]);
    const onEvent = vi.fn();

    await readChatStream(reader, {
      onText: vi.fn(),
      onError: vi.fn(),
      onComplete: vi.fn(),
      onEvent,
    });

    // worktree_resolved is not a standard dispatch event, but onEvent should
    // receive it so consumers (useCommentChat) can update worktreePath.
    const worktreeEvent = onEvent.mock.calls.find(
      (args) =>
        (args[0] as Record<string, unknown>).type === "worktree_resolved"
    );
    expect(worktreeEvent).toBeDefined();
    expect(worktreeEvent![0].effectiveDir).toBe("/tmp/repo-TICKET-1");
  });

  it("accumulates text and calls onText with running total", async () => {
    const reader = createReader([
      '{"type":"text","content":"Hello"}\n',
      '{"type":"text","content":" world"}\n',
      '{"type":"done"}\n',
    ]);
    const onText = vi.fn();

    await readChatStream(reader, {
      onText,
      onError: vi.fn(),
      onComplete: vi.fn(),
    });

    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText.mock.calls[0][0]).toBe("Hello");
    expect(onText.mock.calls[1][0]).toBe("Hello world");
  });

  it("handles JSON split across chunks (NDJSON buffering)", async () => {
    // A JSON object split across two chunks — old chunk.split("\n") would fail
    const reader = createReader([
      '{"type":"text","con',
      'tent":"buffered"}\n{"type":"done"}\n',
    ]);
    const onText = vi.fn();
    const onComplete = vi.fn();

    await readChatStream(reader, {
      onText,
      onError: vi.fn(),
      onComplete,
    });

    expect(onText).toHaveBeenCalledWith("buffered");
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("dispatches tool_use and tool_result events", async () => {
    const reader = createReader([
      '{"type":"tool_use","name":"search","id":"t1","input":{"q":"test"}}\n',
      '{"type":"tool_result","id":"t1","content":"found","is_error":false}\n',
      '{"type":"done"}\n',
    ]);
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();

    await readChatStream(reader, {
      onText: vi.fn(),
      onError: vi.fn(),
      onComplete: vi.fn(),
      onToolUse,
      onToolResult,
    });

    expect(onToolUse).toHaveBeenCalledWith({
      name: "search",
      id: "t1",
      input: { q: "test" },
    });
    expect(onToolResult).toHaveBeenCalledWith({
      id: "t1",
      content: "found",
      is_error: false,
    });
  });

  it("dispatches thinking events", async () => {
    const reader = createReader([
      '{"type":"thinking","content":"reasoning..."}\n',
      '{"type":"text","content":"answer"}\n',
      '{"type":"done"}\n',
    ]);
    const onThinking = vi.fn();

    await readChatStream(reader, {
      onText: vi.fn(),
      onError: vi.fn(),
      onComplete: vi.fn(),
      onThinking,
    });

    expect(onThinking).toHaveBeenCalledWith("reasoning...");
  });

  it("dispatches error events", async () => {
    const reader = createReader([
      '{"type":"error","error":"context limit exceeded"}\n',
    ]);
    const onError = vi.fn();

    await readChatStream(reader, {
      onText: vi.fn(),
      onError,
      onComplete: vi.fn(),
    });

    expect(onError).toHaveBeenCalledWith("context limit exceeded");
  });

  it("dispatches usage events", async () => {
    const reader = createReader([
      '{"type":"usage","contextPercent":85}\n',
      '{"type":"done"}\n',
    ]);
    const onUsage = vi.fn();

    await readChatStream(reader, {
      onText: vi.fn(),
      onError: vi.fn(),
      onComplete: vi.fn(),
      onUsage,
    });

    expect(onUsage).toHaveBeenCalledWith(85);
  });

  it("dispatches pid events", async () => {
    const reader = createReader([
      '{"type":"status","pid":12345}\n',
      '{"type":"done"}\n',
    ]);
    const onPid = vi.fn();

    await readChatStream(reader, {
      onText: vi.fn(),
      onError: vi.fn(),
      onComplete: vi.fn(),
      onPid,
    });

    expect(onPid).toHaveBeenCalledWith(12_345);
  });

  it("dispatches learnings events", async () => {
    const reader = createReader([
      '{"type":"learnings","status":"triggered"}\n',
      '{"type":"done"}\n',
    ]);
    const onLearnings = vi.fn();

    await readChatStream(reader, {
      onText: vi.fn(),
      onError: vi.fn(),
      onComplete: vi.fn(),
      onLearnings,
    });

    expect(onLearnings).toHaveBeenCalledOnce();
  });

  it("skips non-JSON lines without error", async () => {
    const reader = createReader([
      "not json at all\n",
      '{"type":"text","content":"valid"}\n',
      '{"type":"done"}\n',
    ]);
    const onText = vi.fn();
    const onError = vi.fn();

    await readChatStream(reader, {
      onText,
      onError,
      onComplete: vi.fn(),
    });

    // onError should NOT be called for non-JSON lines — only for error events
    expect(onError).not.toHaveBeenCalled();
    expect(onText).toHaveBeenCalledWith("valid");
  });
});

describe("conferral integration", () => {
  it("parseConferralMention returns cleanContent suitable for context forwarding", () => {
    const accumulated =
      "I analyzed the types and found a mismatch in the handler.\n\nThe issue is that `userId` is `string | null` but the function expects `string`.\n\n@codex Can you verify this type inconsistency in auth.ts?";
    const mention = parseConferralMention(accumulated, "claude");

    expect(mention).not.toBeNull();
    expect(mention!.target).toBe("codex");
    expect(mention!.prompt).toBe(
      "Can you verify this type inconsistency in auth.ts?"
    );

    // cleanContent should contain the full reasoning without the @mention
    expect(mention!.cleanContent).toContain("analyzed the types");
    expect(mention!.cleanContent).toContain("userId");
    expect(mention!.cleanContent).not.toContain("@codex");
  });

  it("context can be wrapped for the target model", () => {
    const accumulated =
      "The handler looks correct.\n\n@claude What do you think about the error handling?";
    const mention = parseConferralMention(accumulated, "codex");

    expect(mention).not.toBeNull();

    // Simulate the wrapping that sendConferralToClaude does
    const wrappedPrompt = `Codex has asked for your input on the following:\n\n${mention!.prompt}\n\n<context source="codex-response">\n${mention!.cleanContent}\n</context>`;

    expect(wrappedPrompt).toContain(
      "What do you think about the error handling?"
    );
    expect(wrappedPrompt).toContain("The handler looks correct.");
    expect(wrappedPrompt).toContain('<context source="codex-response">');
    expect(wrappedPrompt).not.toContain("@claude");
  });

  it("stripAssistantProtocol removes conferral context blocks from forwarded responses", () => {
    // When Claude receives a conferral with context, and then responds,
    // the context block should be stripped from the display.
    const claudeResponse =
      'I agree with the analysis.\n\n<context source="codex-response">\nOriginal analysis here\n</context>\n\n<suggested-actions><action label="OK">ok</action></suggested-actions>';
    const stripped = stripAssistantProtocol(claudeResponse);

    expect(stripped).toBe("I agree with the analysis.");
    expect(stripped).not.toContain("context");
    expect(stripped).not.toContain("suggested-actions");
  });

  it("sanitizeHistoryForModel drops conferral sentinel messages", () => {
    const messages = [
      { role: "user", content: "Fix the bug" },
      { role: "assistant", content: "I found the issue.\n\n@codex Verify?" },
      { role: "user", content: CHAT_SENTINEL.CLAUDE_CONFERRED_TO_CODEX },
      { role: "assistant", content: "Verified.", sender: "codex" },
      { role: "user", content: CHAT_SENTINEL.CODEX_CONFERRED_TO_CLAUDE },
      { role: "assistant", content: "Great, applying fix." },
    ];
    const sanitized = sanitizeHistoryForModel(messages);

    // Sentinel user messages should be dropped
    expect(sanitized).toHaveLength(4);
    expect(
      sanitized.some(
        (m) => m.content === CHAT_SENTINEL.CLAUDE_CONFERRED_TO_CODEX
      )
    ).toBe(false);
    expect(
      sanitized.some(
        (m) => m.content === CHAT_SENTINEL.CODEX_CONFERRED_TO_CLAUDE
      )
    ).toBe(false);

    // Assistant messages should have protocol stripped
    expect(sanitized[1].content).not.toContain("@codex");
  });
});
