/**
 * Unit tests for the native-comment @-mention body helpers (FEA-3490):
 *   - textBody: builds the ProseMirror-style doc for a plain-text native
 *     comment, optionally persisting an org-scoped mentions list as a sibling
 *     doc key.
 *   - extractBodyMentions: reads that mentions list back off a stored body doc.
 *   - extractLiveblocksBodyMentions / extractCommentMentions: read the user
 *     mentions of a stored `LIVEBLOCKS_V1` body, and pick the reader by
 *     `bodyFormat` (PLN-2187 T-2.1).
 *
 * These are pure functions with no DB access. They live in the lightweight
 * `../mention-body` module (not `../service`) so this test and the comment
 * commands can import them without pulling in service.ts's
 * `@repo/database`/`@repo/collaboration` runtime dependencies — hence no mocks.
 * Together the two helpers form the write/read round-trip that the comment
 * commands (`../service/comment-commands.ts`) depend on to persist and surface
 * mentions on native comments.
 */
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { describe, expect, it } from "vitest";
import {
  extractBodyMentions,
  extractCommentMentions,
  extractLiveblocksBodyMentions,
  textBody,
} from "../mention-body";

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

describe("extractLiveblocksBodyMentions (PLN-2187 T-2.1)", () => {
  it("collects each mentioned user once, in order, across paragraphs", () => {
    const body = {
      version: 1,
      content: [
        {
          type: "paragraph",
          children: [
            { type: "mention", kind: "user", id: "bob" },
            { text: " and " },
            { type: "mention", kind: "user", id: "alice" },
          ],
        },
        {
          type: "paragraph",
          children: [
            { type: "mention", kind: "user", id: "bob" },
            { type: "mention", kind: "user", id: "erin" },
          ],
        },
      ],
    };

    expect(extractLiveblocksBodyMentions(body)).toEqual([
      "bob",
      "alice",
      "erin",
    ]);
  });

  it("reads a mention without a kind as a user's and skips a group mention", () => {
    const body = {
      version: 1,
      content: [
        {
          type: "paragraph",
          children: [
            { type: "mention", id: "carol" },
            { type: "mention", kind: "group", id: "engineering" },
          ],
        },
      ],
    };

    expect(extractLiveblocksBodyMentions(body)).toEqual(["carol"]);
  });

  it.each([
    ["a missing body", null],
    ["a native body", { type: "doc", content: [], mentions: ["dave"] }],
    ["a block without children", { version: 1, content: [{ type: "x" }] }],
  ])("returns no mentions for %s", (_label, body) => {
    expect(extractLiveblocksBodyMentions(body)).toEqual([]);
  });
});

describe("extractCommentMentions", () => {
  const liveblocksBody = {
    version: 1,
    content: [
      { type: "paragraph", children: [{ type: "mention", id: "frank" }] },
    ],
  };
  const nativeBody = textBody("hi", ["grace"]);

  it("reads a LIVEBLOCKS_V1 body as Liveblocks and any other format as native", () => {
    expect(
      extractCommentMentions(liveblocksBody, CommentBodyFormat.LiveblocksV1)
    ).toEqual(["frank"]);
    expect(
      extractCommentMentions(nativeBody, CommentBodyFormat.LiveblocksV1)
    ).toEqual([]);
    expect(
      extractCommentMentions(nativeBody, CommentBodyFormat.RichV1)
    ).toEqual(["grace"]);
    expect(
      extractCommentMentions(liveblocksBody, CommentBodyFormat.RichV1)
    ).toEqual([]);
  });
});
