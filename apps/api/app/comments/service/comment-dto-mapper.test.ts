import {
  CommentSurface,
  CommentTargetType,
  ThreadSource,
  ThreadStatus,
  TRACE_COMMENT_METADATA_KIND,
  TRACE_COMMENT_SCHEMA_VERSION,
} from "@repo/api/src/types/comment";
import { toStoredCommentAnchor } from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import {
  COMMENT_SOURCE_POLICIES,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  Prisma: { JsonNull: Symbol("JsonNull") },
  withDb: vi.fn(),
}));

import { mapCommentThreadDto } from "./comment-dto-mapper";
import type { CommentThreadRow } from "./comment-thread-rows";

const VIEWER = "user-viewer";
const OTHER = "user-other";
const AT = new Date("2026-10-01T00:00:00.000Z");

const context = {
  viewerUserId: VIEWER,
  policyKey: CommentPolicyKey.NativeSession,
  capabilities: {
    createThread: true,
    reply: true,
    edit: true,
    delete: true,
    resolve: true,
    reopen: true,
    react: false,
    attach: false,
    mention: true,
    retrySync: false,
    linkOut: false,
    anchorKinds:
      COMMENT_SOURCE_POLICIES[CommentPolicyKey.NativeSession].anchorKinds,
    commentKinds: [],
  },
  authors: new Map(),
};

type CommentRow = CommentThreadRow["comments"][number];

function comment(over: Partial<CommentRow> = {}): CommentRow {
  return {
    id: "comment-1",
    authorId: VIEWER,
    plainText: "hello",
    body: { type: "doc", content: [] },
    bodyFormat: CommentBodyFormat.RichV1,
    revision: 0,
    editedAt: null,
    createdAt: AT,
    updatedAt: AT,
    reactions: [],
    attachments: [],
    ...over,
  };
}

function row(comments: CommentRow[]): CommentThreadRow {
  return {
    id: "thread-1",
    organizationId: "org-1",
    artifactId: "artifact-1",
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    metadata: {
      kind: TRACE_COMMENT_METADATA_KIND,
      schemaVersion: TRACE_COMMENT_SCHEMA_VERSION,
      targetType: CommentTargetType.Session,
      surface: CommentSurface.SessionDetail,
    },
    anchor: toStoredCommentAnchor({ kind: CommentAnchorKind.Artifact }),
    syncStates: [],
    createdAt: AT,
    updatedAt: AT,
    source: ThreadSource.Native,
    revision: 0,
    anchorState: null,
    comments,
  };
}

function mappedComments(comments: CommentRow[]) {
  return mapCommentThreadDto(row(comments), context)?.comments;
}

describe("mapCommentThreadDto reactions and attachments (PLN-2187 T-2.1)", () => {
  it("groups reactions by emoji in first-use order and marks the viewer's", () => {
    const [mapped] =
      mappedComments([
        comment({
          reactions: [
            { emoji: "+1", userId: OTHER },
            { emoji: "eyes", userId: OTHER },
            { emoji: "+1", userId: VIEWER },
          ],
        }),
      ]) ?? [];

    expect(mapped?.reactions).toEqual([
      { emoji: "+1", userIds: [OTHER, VIEWER], viewerReacted: true },
      { emoji: "eyes", userIds: [OTHER], viewerReacted: false },
    ]);
  });

  it("maps each attachment to its download path, keeping unknown size and type as null", () => {
    const [mapped] =
      mappedComments([
        comment({
          attachments: [
            { id: "att-1", name: "a.png", mimeType: "image/png", size: 10 },
            { id: "att-2", name: "b.bin", mimeType: null, size: null },
          ],
        }),
      ]) ?? [];

    expect(mapped?.attachments).toEqual([
      {
        id: "att-1",
        name: "a.png",
        mimeType: "image/png",
        size: 10,
        downloadPath: "/comments/attachments/att-1",
      },
      {
        id: "att-2",
        name: "b.bin",
        mimeType: null,
        size: null,
        downloadPath: "/comments/attachments/att-2",
      },
    ]);
  });

  it("reads mentions from a Liveblocks body's mention elements and a native body's list", () => {
    const [liveblocks, native] =
      mappedComments([
        comment({
          id: "comment-1",
          bodyFormat: CommentBodyFormat.LiveblocksV1,
          body: {
            version: 1,
            content: [
              {
                type: "paragraph",
                children: [{ type: "mention", kind: "user", id: OTHER }],
              },
            ],
          },
        }),
        comment({
          id: "comment-2",
          body: { type: "doc", content: [], mentions: [VIEWER] },
        }),
      ]) ?? [];

    expect(liveblocks?.mentions).toEqual([OTHER]);
    expect(native?.mentions).toEqual([VIEWER]);
  });
});
