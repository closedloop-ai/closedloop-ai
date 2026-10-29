import { describe, expect, it } from "vitest";
import { CommentSurface, ThreadStatus, TraceCommentKind } from "../comment";
import { CommentAnchorKind } from "../comment-anchor-kind";
import {
  CommentReactionEmoji,
  commentApiPaths,
  commentReactionEmojiSchema,
  createCommentThreadRequestSchema,
  editCommentRequestSchema,
  listArtifactCommentsQuerySchema,
  replyToCommentThreadRequestSchema,
} from "../comment-thread-dto";

const CREATE = {
  anchor: { kind: CommentAnchorKind.Artifact },
  body: "Looks right",
  clientId: "local-1",
};

describe("createCommentThreadRequestSchema", () => {
  it("accepts a minimal create and keeps its fields", () => {
    expect(createCommentThreadRequestSchema.parse(CREATE)).toEqual(CREATE);
  });

  it("degrades an unknown kind to comment and de-duplicates mentions", () => {
    expect(
      createCommentThreadRequestSchema.parse({
        ...CREATE,
        kind: "future_kind",
        mentions: ["u1", "u1", "u2"],
        surface: CommentSurface.BranchTimeline,
      })
    ).toEqual({
      ...CREATE,
      kind: TraceCommentKind.Comment,
      mentions: ["u1", "u2"],
      surface: CommentSurface.BranchTimeline,
    });
  });

  it.each([
    ["no clientId", { anchor: CREATE.anchor, body: CREATE.body }],
    ["an invalid anchor", { ...CREATE, anchor: { kind: "content" } }],
    ["an empty body", { ...CREATE, body: "" }],
    ["an unknown surface", { ...CREATE, surface: "inbox" }],
  ])("rejects %s", (_label, value) => {
    expect(createCommentThreadRequestSchema.safeParse(value).success).toBe(
      false
    );
  });
});

describe("replyToCommentThreadRequestSchema", () => {
  it("requires a clientId", () => {
    expect(
      replyToCommentThreadRequestSchema.safeParse({ body: "ok" }).success
    ).toBe(false);
    expect(
      replyToCommentThreadRequestSchema.parse({ body: "ok", clientId: "c" })
    ).toEqual({ body: "ok", clientId: "c" });
  });
});

describe("editCommentRequestSchema", () => {
  it("accepts revision 0", () => {
    expect(
      editCommentRequestSchema.parse({ body: "b", expectedRevision: 0 })
    ).toEqual({ body: "b", expectedRevision: 0 });
  });

  it.each([
    ["no expectedRevision", { body: "b" }],
    ["a negative revision", { body: "b", expectedRevision: -1 }],
    ["a fractional revision", { body: "b", expectedRevision: 1.5 }],
    ["a string revision", { body: "b", expectedRevision: "2" }],
  ])("rejects %s", (_label, value) => {
    expect(editCommentRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe("commentApiPaths", () => {
  it.each([".", ".."])("refuses %j, which a URL would resolve away", (id) => {
    for (const build of Object.values(commentApiPaths)) {
      expect(() => build(id, "+1")).toThrow("is not a valid path segment");
    }
  });

  it("encodes any other id as one segment", () => {
    expect(commentApiPaths.artifactComments("a/../b")).toBe(
      "/artifacts/a%2F..%2Fb/comments"
    );
  });

  it("builds the reaction and attachment routes (PLN-2187 T-1.4)", () => {
    expect(commentApiPaths.commentReaction("c1", "👍")).toBe(
      "/comments/c1/reactions/%F0%9F%91%8D"
    );
    expect(commentApiPaths.commentAttachments("c1")).toBe(
      "/comments/c1/attachments"
    );
    expect(commentApiPaths.attachment("a1")).toBe("/comments/attachments/a1");
    expect(commentApiPaths.attachmentComplete("a1")).toBe(
      "/comments/attachments/a1/complete"
    );
  });

  it.each([".", ".."])("refuses the emoji %j as a segment", (emoji) => {
    expect(() => commentApiPaths.commentReaction("c1", emoji)).toThrow(
      "is not a valid path segment"
    );
  });
});

describe("commentReactionEmojiSchema", () => {
  it("accepts each of the eight reactions as itself", () => {
    for (const emoji of Object.values(CommentReactionEmoji)) {
      expect(commentReactionEmojiSchema.parse(emoji)).toBe(emoji);
    }
  });

  it("folds an emoji sent with or without VS16 into one reaction", () => {
    expect(commentReactionEmojiSchema.parse("❤")).toBe(
      CommentReactionEmoji.Heart
    );
    expect(commentReactionEmojiSchema.parse("\u{1F44D}️")).toBe(
      CommentReactionEmoji.ThumbsUp
    );
  });

  it.each([
    ["an empty emoji", ""],
    ["an emoji outside the set", "\u{1F984}"],
    ["a shortcode", "+1"],
    ["two reactions at once", "\u{1F44D}\u{1F44E}"],
  ])("rejects %s", (_label, value) => {
    expect(commentReactionEmojiSchema.safeParse(value).success).toBe(false);
  });
});

describe("listArtifactCommentsQuerySchema", () => {
  it("accepts every supported filter", () => {
    const query = {
      cursor: "opaque",
      status: ThreadStatus.Resolved,
      surface: CommentSurface.SessionDetail,
    };

    expect(listArtifactCommentsQuerySchema.parse(query)).toEqual(query);
  });

  it.each([
    ["an unsupported filter", { author: "me" }],
    ["a lowercase status", { status: "open" }],
    ["an empty cursor", { cursor: "" }],
  ])("rejects %s", (_label, value) => {
    expect(listArtifactCommentsQuerySchema.safeParse(value).success).toBe(
      false
    );
  });
});
