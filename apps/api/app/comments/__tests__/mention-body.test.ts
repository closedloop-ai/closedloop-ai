/**
 * Unit tests for the native-comment @-mention body helpers (FEA-3490):
 *   - textBody: builds the ProseMirror-style doc for a plain-text native
 *     comment, optionally persisting an org-scoped mentions list as a sibling
 *     doc key.
 *   - extractBodyMentions: reads that mentions list back off a stored body doc.
 *
 * These are pure functions with no DB access. They live in the lightweight
 * `../mention-body` module (not `../service`) so this test and
 * trace-comments/service.ts can import them without pulling in service.ts's
 * `@repo/database`/`@repo/collaboration` runtime dependencies — hence no mocks.
 * Together the two helpers form the write/read round-trip that
 * trace-comments/service.ts depends on to persist and surface mentions on
 * native comments.
 */
import { describe, expect, it } from "vitest";
import { extractBodyMentions, textBody } from "../mention-body";

describe("textBody", () => {
  it("wraps text in a single paragraph doc with a text node", () => {
    expect(textBody("hello world")).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hello world" }],
        },
      ],
    });
  });

  it("emits an empty paragraph (no text node) for empty text", () => {
    expect(textBody("")).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    });
  });

  it("omits the mentions key when no mentions are supplied", () => {
    expect(textBody("hi")).not.toHaveProperty("mentions");
  });

  it("omits the mentions key when an empty mentions array is supplied", () => {
    const body = textBody("hi", []);
    expect(body).not.toHaveProperty("mentions");
  });

  it("persists a non-empty mentions list as a sibling doc key", () => {
    const body = textBody("hey @a @b", ["user_a", "user_b"]);
    expect(body).toMatchObject({
      type: "doc",
      mentions: ["user_a", "user_b"],
    });
  });

  it("copies the mentions array so later caller mutation does not leak in", () => {
    const mentions = ["user_a"];
    const body = textBody("hi", mentions) as { mentions: string[] };
    mentions.push("user_b");
    expect(body.mentions).toEqual(["user_a"]);
  });
});

describe("extractBodyMentions", () => {
  it("returns the persisted mentions written by textBody (round-trip)", () => {
    const body = textBody("hey @a @b", ["user_a", "user_b"]);
    expect(extractBodyMentions(body)).toEqual(["user_a", "user_b"]);
  });

  it("returns an empty array for a body with no mentions key", () => {
    expect(extractBodyMentions(textBody("plain"))).toEqual([]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "not-an-object"],
    ["a number", 42],
  ])("returns an empty array when body is %s", (_label, value) => {
    expect(extractBodyMentions(value)).toEqual([]);
  });

  it("returns an empty array when mentions is not an array", () => {
    expect(extractBodyMentions({ mentions: "user_a" })).toEqual([]);
    expect(extractBodyMentions({ mentions: { 0: "user_a" } })).toEqual([]);
  });

  it("drops non-string and empty-string entries", () => {
    expect(
      extractBodyMentions({
        mentions: ["user_a", "", 123, null, undefined, "user_b"],
      })
    ).toEqual(["user_a", "user_b"]);
  });

  it("returns an empty array for an empty mentions array", () => {
    expect(extractBodyMentions({ mentions: [] })).toEqual([]);
  });
});
