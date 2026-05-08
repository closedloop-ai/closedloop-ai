import type { CommentBody } from "@repo/collaboration/webhook";
import { describe, expect, it } from "vitest";
import { extractPlainText } from "../../app/comments/plain-text";

function makeBody(content: CommentBody["content"]): CommentBody {
  return { version: 1 as const, content };
}

describe("extractPlainText", () => {
  it("extracts simple text from a single paragraph", () => {
    const body = makeBody([
      { type: "paragraph", children: [{ text: "Hello world" }] },
    ]);
    expect(extractPlainText(body)).toBe("Hello world");
  });

  it("converts mention nodes to @{id}", () => {
    const body = makeBody([
      {
        type: "paragraph",
        children: [
          { text: "Hey " },
          { type: "mention", kind: "user", id: "user-123" },
          { text: " check this" },
        ],
      },
    ]);
    expect(extractPlainText(body)).toBe("Hey @user-123 check this");
  });

  it("joins multiple paragraphs with newlines", () => {
    const body = makeBody([
      { type: "paragraph", children: [{ text: "First paragraph" }] },
      { type: "paragraph", children: [{ text: "Second paragraph" }] },
    ]);
    expect(extractPlainText(body)).toBe("First paragraph\nSecond paragraph");
  });

  it("returns null for undefined body", () => {
    expect(extractPlainText(undefined)).toBeNull();
  });

  it("returns null for empty content array", () => {
    expect(extractPlainText(makeBody([]))).toBeNull();
  });

  it("handles paragraphs with no children", () => {
    const body = {
      version: 1 as const,
      content: [{ type: "paragraph" as const }],
    } as CommentBody;
    expect(extractPlainText(body)).toBeNull();
  });

  it("handles mixed text and mention children", () => {
    const body = makeBody([
      {
        type: "paragraph",
        children: [
          { type: "mention", kind: "user", id: "alice" },
          { text: " and " },
          { type: "mention", kind: "user", id: "bob" },
        ],
      },
    ]);
    expect(extractPlainText(body)).toBe("@alice and @bob");
  });
});
