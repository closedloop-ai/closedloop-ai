/**
 * Unit tests for pure functions exported from apps/app/lib/chat/chat-utils.ts
 *
 * Covers: parseSuggestedActions, stripContextBlocks, extractContextBlocks,
 * parseDebateStatus, parseLearningsUsed, stripLearningsUsed,
 * parseConferralMention, stripProtocolMetadata, stripAssistantProtocol,
 * sanitizeHistoryForModel
 */

import { describe, expect, it } from "vitest";
import {
  CHAT_SENTINEL,
  extractContextBlocks,
  formatTime,
  parseConferralMention,
  parseDebateStatus,
  parseLearningsUsed,
  parseSuggestedActions,
  sanitizeHistoryForModel,
  stripAssistantProtocol,
  stripContextBlocks,
  stripLearningsUsed,
  stripProtocolMetadata,
} from "@/lib/chat/chat-utils";

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------

describe("formatTime", () => {
  it("returns malformed persisted timestamps as visible fallback text", () => {
    expect(formatTime("not-a-date")).toBe("not-a-date");
  });
});

// ---------------------------------------------------------------------------
// parseSuggestedActions
// ---------------------------------------------------------------------------

describe("parseSuggestedActions", () => {
  it("returns empty actions and original content when no block present", () => {
    const input = "Hello world";
    const result = parseSuggestedActions(input);
    expect(result.actions).toEqual([]);
    expect(result.contentWithoutActions).toBe("Hello world");
  });

  it("parses a single action with label and message", () => {
    const input =
      'Some text\n<suggested-actions><action label="Accept">accept it</action></suggested-actions>';
    const result = parseSuggestedActions(input);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      label: "Accept",
      message: "accept it",
    });
    expect(result.contentWithoutActions).toBe("Some text");
  });

  it("parses multiple actions from one block", () => {
    const block = [
      "<suggested-actions>",
      '<action label="Yes">yes please</action>',
      '<action label="No">no thanks</action>',
      "</suggested-actions>",
    ].join("");
    const result = parseSuggestedActions(block);
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0].label).toBe("Yes");
    expect(result.actions[1].label).toBe("No");
  });

  it("parses optional type attribute when present", () => {
    const input =
      '<suggested-actions><action label="Deploy" type="accept-changes">deploy now</action></suggested-actions>';
    const result = parseSuggestedActions(input);
    expect(result.actions[0].type).toBe("accept-changes");
  });

  it("omits type when attribute is absent", () => {
    const input =
      '<suggested-actions><action label="Ok">ok</action></suggested-actions>';
    const result = parseSuggestedActions(input);
    expect(result.actions[0].type).toBeUndefined();
  });

  it("trims whitespace from action message body", () => {
    const input =
      '<suggested-actions><action label="X">  trimmed  </action></suggested-actions>';
    const result = parseSuggestedActions(input);
    expect(result.actions[0].message).toBe("trimmed");
  });

  it("strips the action block from content and trims result", () => {
    const input =
      'Intro text\n<suggested-actions><action label="A">a</action></suggested-actions>\n';
    const result = parseSuggestedActions(input);
    expect(result.contentWithoutActions).toBe("Intro text");
  });
});

// ---------------------------------------------------------------------------
// stripContextBlocks
// ---------------------------------------------------------------------------

describe("stripContextBlocks", () => {
  it("returns unchanged content when no context block present", () => {
    expect(stripContextBlocks("Hello world")).toBe("Hello world");
  });

  it("strips a plain <context> block", () => {
    const input = "Prefix\n<context>hidden data</context>\nSuffix";
    // The block is replaced in-place; surrounding newlines are preserved and
    // only the outer .trim() fires (no intermediate whitespace collapse).
    expect(stripContextBlocks(input)).toBe("Prefix\n\nSuffix");
  });

  it("strips a context block with attributes", () => {
    const input =
      'Text\n<context source="review">some review</context>\nMore text';
    // The block is replaced in-place; surrounding newlines are preserved and
    // only the outer .trim() fires (no intermediate whitespace collapse).
    expect(stripContextBlocks(input)).toBe("Text\n\nMore text");
  });

  it("strips multiple context blocks from the same string", () => {
    const input =
      "A\n<context>first</context>\nB\n<context>second</context>\nC";
    // Each block removed leaves its surrounding newlines; result is trimmed.
    expect(stripContextBlocks(input)).toBe("A\n\nB\n\nC");
  });

  it("trims the resulting string", () => {
    const input = "\n<context>remove me</context>\n";
    expect(stripContextBlocks(input)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractContextBlocks
// ---------------------------------------------------------------------------

describe("extractContextBlocks", () => {
  it("returns empty blocks and unchanged content when none present", () => {
    const { blocks, remaining } = extractContextBlocks("plain text");
    expect(blocks).toEqual([]);
    expect(remaining).toBe("plain text");
  });

  it("extracts a context block with source attribute", () => {
    const input = '<context source="review">Review body</context>\nask me';
    const { blocks, remaining } = extractContextBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe("review");
    expect(blocks[0].title).toBe("Review");
    expect(blocks[0].body).toBe("Review body");
    expect(remaining).toBe("ask me");
  });

  it("extracts a context block with file attribute", () => {
    const input = '<context file="src/app.ts">file body</context>';
    const { blocks } = extractContextBlocks(input);
    expect(blocks[0].file).toBe("src/app.ts");
  });

  it("derives title from heading inside body when no source attribute", () => {
    const input = "<context>\n# My Heading\nsome body\n</context>";
    const { blocks } = extractContextBlocks(input);
    expect(blocks[0].title).toBe("My Heading");
  });

  it("defaults title to 'Context' when no source or heading", () => {
    const input = "<context>no heading here</context>";
    const { blocks } = extractContextBlocks(input);
    expect(blocks[0].title).toBe("Context");
  });

  it("assigns sequential ids starting from ctx-0", () => {
    const input = "<context>a</context>\n<context>b</context>";
    const { blocks } = extractContextBlocks(input);
    expect(blocks[0].id).toBe("ctx-0");
    expect(blocks[1].id).toBe("ctx-1");
  });

  it("removes all context blocks from the remaining text", () => {
    const input =
      "Hello\n<context>hidden</context>\nWorld\n<context>more</context>";
    const { remaining } = extractContextBlocks(input);
    // replaceAll removes the tag text; surrounding newlines remain; final .trim()
    expect(remaining).toBe("Hello\n\nWorld");
  });
});

// ---------------------------------------------------------------------------
// parseDebateStatus
// ---------------------------------------------------------------------------

describe("parseDebateStatus", () => {
  it("returns null status and original content when no block present", () => {
    const { cleanContent, status } = parseDebateStatus("no block here");
    expect(status).toBeNull();
    expect(cleanContent).toBe("no block here");
  });

  it("parses a valid debate-status JSON block", () => {
    const payload = JSON.stringify({
      pendingIssues: [{ id: "i1", summary: "Issue one" }],
      resolvedIssues: [],
    });
    const input = `Before\n<debate-status>${payload}</debate-status>\nAfter`;
    const { cleanContent, status } = parseDebateStatus(input);
    expect(status).not.toBeNull();
    expect(status?.pendingIssues).toHaveLength(1);
    expect(status?.pendingIssues[0].id).toBe("i1");
    // .replace removes the tag; surrounding newlines remain; .trim() fires at end
    expect(cleanContent).toBe("Before\n\nAfter");
  });

  it("returns null status for malformed JSON inside block", () => {
    const input = "<debate-status>not json</debate-status>";
    const { status, cleanContent } = parseDebateStatus(input);
    expect(status).toBeNull();
    expect(cleanContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseLearningsUsed
// ---------------------------------------------------------------------------

describe("parseLearningsUsed", () => {
  it("returns empty learnings and stripped content when no block present", () => {
    const { learnings, cleanContent } = parseLearningsUsed("plain text");
    expect(learnings).toEqual([]);
    expect(cleanContent).toBe("plain text");
  });

  it("parses learnings from a complete block and strips it from content", () => {
    const payload = JSON.stringify([
      {
        id: "l1",
        source: "user",
        category: "code",
        summary: "Always use const",
      },
    ]);
    const input = `Answer\n<learnings-used>${payload}</learnings-used>`;
    const { learnings, cleanContent } = parseLearningsUsed(input);
    expect(learnings).toHaveLength(1);
    expect(learnings[0].id).toBe("l1");
    expect(cleanContent).toBe("Answer");
  });

  it("returns empty array for non-array JSON inside block", () => {
    const input = '<learnings-used>{"not":"array"}</learnings-used>';
    const { learnings } = parseLearningsUsed(input);
    expect(learnings).toEqual([]);
  });

  it("returns empty array for malformed JSON inside block", () => {
    const input = "<learnings-used>invalid</learnings-used>";
    const { learnings } = parseLearningsUsed(input);
    expect(learnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// stripLearningsUsed
// ---------------------------------------------------------------------------

describe("stripLearningsUsed", () => {
  it("strips a complete learnings-used block", () => {
    const input =
      'Main content\n<learnings-used>[{"id":"l1"}]</learnings-used>';
    expect(stripLearningsUsed(input)).toBe("Main content");
  });

  it("strips an incomplete opening tag at end of string (mid-stream)", () => {
    const input = 'Main content\n<learnings-used>[{"id":';
    expect(stripLearningsUsed(input)).toBe("Main content");
  });

  it("returns unchanged text when no block present", () => {
    expect(stripLearningsUsed("nothing here")).toBe("nothing here");
  });
});

// ---------------------------------------------------------------------------
// parseConferralMention
// ---------------------------------------------------------------------------

describe("parseConferralMention", () => {
  it("returns null when no conferral mention present", () => {
    const result = parseConferralMention("Hello world", "claude");
    expect(result).toBeNull();
  });

  it("detects @codex mention at start of a line in Claude content", () => {
    const content = "Some analysis done.\n@codex Please implement the fix";
    const result = parseConferralMention(content, "claude");
    expect(result).not.toBeNull();
    expect(result?.target).toBe("codex");
    expect(result?.prompt).toBe("Please implement the fix");
  });

  it("detects @claude mention at start of a line in Codex content", () => {
    const content = "Implementation done.\n@claude Please review this approach";
    const result = parseConferralMention(content, "codex");
    expect(result).not.toBeNull();
    expect(result?.target).toBe("claude");
    expect(result?.prompt).toBe("Please review this approach");
  });

  it("returns null when the same provider is mentioned (no self-referral)", () => {
    // Claude content with @claude mention — no cross-referral
    const content = "Text\n@claude some message";
    const result = parseConferralMention(content, "claude");
    expect(result).toBeNull();
  });

  it("ignores @codex mention inside a fenced code block", () => {
    const content = "Text\n```\n@codex some code example\n```";
    const result = parseConferralMention(content, "claude");
    expect(result).toBeNull();
  });

  it("removes the @mention line from cleanContent", () => {
    const content = "Do something.\n@codex Take over please";
    const result = parseConferralMention(content, "claude");
    expect(result?.cleanContent).not.toContain("@codex");
  });
});

// ---------------------------------------------------------------------------
// stripProtocolMetadata
// ---------------------------------------------------------------------------

describe("stripProtocolMetadata", () => {
  it("strips context blocks from content", () => {
    const input = "Hi\n<context>hidden</context>\nbye";
    // Block removed in-place; surrounding newlines preserved; outer .trim() fires
    expect(stripProtocolMetadata(input)).toBe("Hi\n\nbye");
  });

  it("strips learnings-used blocks", () => {
    const input = 'Answer\n<learnings-used>[{"id":"l1"}]</learnings-used>';
    expect(stripProtocolMetadata(input)).toBe("Answer");
  });

  it("strips conferral mentions", () => {
    const input = "Analysis done.\n@codex Please implement";
    expect(stripProtocolMetadata(input)).not.toContain("@codex");
  });

  it("does NOT strip suggested-actions (that is stripAssistantProtocol's job)", () => {
    const input =
      'Answer\n<suggested-actions><action label="Ok">ok</action></suggested-actions>';
    const result = stripProtocolMetadata(input);
    // stripProtocolMetadata leaves suggested-actions intact
    expect(result).toContain("suggested-actions");
  });
});

// ---------------------------------------------------------------------------
// stripAssistantProtocol
// ---------------------------------------------------------------------------

describe("stripAssistantProtocol", () => {
  it("strips suggested-actions, context blocks, and learnings from content", () => {
    const input = [
      "Main answer",
      "<context>hidden</context>",
      '<learnings-used>[{"id":"l1"}]</learnings-used>',
      '<suggested-actions><action label="Ok">ok</action></suggested-actions>',
    ].join("\n");
    const result = stripAssistantProtocol(input);
    expect(result).toBe("Main answer");
    expect(result).not.toContain("suggested-actions");
    expect(result).not.toContain("context");
    expect(result).not.toContain("learnings-used");
  });
});

// ---------------------------------------------------------------------------
// sanitizeHistoryForModel
// ---------------------------------------------------------------------------

describe("sanitizeHistoryForModel", () => {
  it("filters out sentinel-only user messages", () => {
    const messages = [
      { role: "user", content: CHAT_SENTINEL.DEBATE_STARTED },
      { role: "user", content: "real question" },
    ];
    const result = sanitizeHistoryForModel(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("real question");
  });

  it("filters all sentinel values from user messages", () => {
    const sentinels = Object.values(CHAT_SENTINEL);
    const messages = sentinels.map((s) => ({ role: "user", content: s }));
    const result = sanitizeHistoryForModel(messages);
    expect(result).toHaveLength(0);
  });

  it("strips protocol metadata from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content:
          'Answer\n<suggested-actions><action label="Ok">ok</action></suggested-actions>',
      },
    ];
    const result = sanitizeHistoryForModel(messages);
    expect(result[0].content).toBe("Answer");
    expect(result[0].content).not.toContain("suggested-actions");
  });

  it("preserves non-sentinel user messages unchanged", () => {
    const messages = [{ role: "user", content: "What is the status?" }];
    const result = sanitizeHistoryForModel(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("What is the status?");
  });

  it("preserves sender field on messages", () => {
    const messages = [
      { role: "assistant", content: "Hi", sender: "claude" as const },
    ];
    const result = sanitizeHistoryForModel(messages);
    expect(result[0].sender).toBe("claude");
  });

  it("does not mutate the input array", () => {
    const messages = [
      { role: "user", content: CHAT_SENTINEL.DEBATE_STARTED },
      { role: "user", content: "keep me" },
    ];
    const copy = [...messages];
    sanitizeHistoryForModel(messages);
    expect(messages).toEqual(copy);
  });
});
