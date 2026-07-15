import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  ThreadStatus,
  type TraceComment,
  TraceCommentSurface,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import {
  createLocalTraceComment,
  createLocalTraceCommentReply,
  deleteLocalTraceComment,
  listLocalTraceComments,
  listPendingLocalTraceCommentOperations,
  type UserIdentity,
  updateLocalTraceComment,
  upsertCloudTraceComments,
} from "../src/main/shared-trace-comments-store.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const handles: OpenTestPrisma[] = [];
const NOT_EDITABLE_ERROR = /not found or not editable/i;

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
});

describe("shared trace comments store", () => {
  test("scopes durable comments by active profile, compute target, user, and organization", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identityA = makeIdentity({
      computeTargetId: "target-a",
      profileId: "profile-a",
      userId: "user-a",
    });
    const identityB = makeIdentity({
      computeTargetId: "target-b",
      profileId: "profile-b",
      userId: "user-b",
    });

    await createLocalTraceComment(
      prisma,
      target,
      { anchor: makeAnchor(), body: "Profile A local note" },
      identityA
    );

    assert.equal(
      (await listLocalTraceComments(prisma, target, identityA)).length,
      1
    );
    assert.equal(
      (await listLocalTraceComments(prisma, target, identityB)).length,
      0
    );

    await upsertCloudTraceComments(
      prisma,
      target,
      [
        makeCloudComment({
          authorId: "cloud-user",
          body: "Profile B cloud note",
          canDelete: true,
          canEdit: true,
        }),
      ],
      identityB
    );

    assert.deepEqual(
      (await listLocalTraceComments(prisma, target, identityA)).map(
        (comment) => comment.body
      ),
      ["Profile A local note"]
    );
    const profileBComments = await listLocalTraceComments(
      prisma,
      target,
      identityB
    );
    assert.deepEqual(
      profileBComments.map((comment) => comment.body),
      ["Profile B cloud note"]
    );
    assert.equal(profileBComments[0].canEdit, true);
    assert.equal(profileBComments[0].canDelete, true);
  });

  test("preserves synced cloud rows with pending local replies when cloud list omits the parent", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();
    const cloudComment = makeCloudComment({
      body: "Cloud parent",
      id: "cloud-comment-parent",
    });

    await upsertCloudTraceComments(prisma, target, [cloudComment], identity);
    await createLocalTraceCommentReply(
      prisma,
      target,
      cloudComment.id,
      { body: "Offline reply that still needs upload" },
      identity
    );

    await upsertCloudTraceComments(prisma, target, [], identity);

    const comments = await listLocalTraceComments(prisma, target, identity);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].id, cloudComment.id);
    assert.deepEqual(
      comments[0].replies?.map((reply) => reply.body),
      ["Offline reply that still needs upload"]
    );

    const pending = await listPendingLocalTraceCommentOperations(
      prisma,
      target,
      identity
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0].operation, "reply");
  });

  test("honors separate cloud edit and delete permissions for local mutations", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity({ userId: "current-user" });
    const cloudComment = makeCloudComment({
      authorId: "other-user",
      canDelete: true,
      canEdit: false,
      id: "delete-only-cloud-comment",
    });

    await upsertCloudTraceComments(prisma, target, [cloudComment], identity);

    await assert.rejects(
      () =>
        updateLocalTraceComment(
          prisma,
          target,
          cloudComment.id,
          { body: "Should not edit" },
          identity
        ),
      NOT_EDITABLE_ERROR
    );

    await deleteLocalTraceComment(prisma, target, cloudComment.id, identity);

    assert.equal(
      (await listLocalTraceComments(prisma, target, identity)).length,
      0
    );
  });

  test("treats malformed stored replies as an empty legacy reply list", async () => {
    const { db, prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();

    await db.query(
      `INSERT INTO "trace_comments" (
          "id",
          "thread_id",
          "target_type",
          "target_id",
          "artifact_id",
          "surface",
          "status",
          "anchor",
          "body",
          "author_id",
          "author_name",
          "profile_id",
          "sync_compute_target_id",
          "sync_user_id",
          "sync_organization_id",
          "replies",
          "sync_status",
          "created_at",
          "updated_at"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`,
      [
        "malformed-replies-comment",
        "malformed-replies-thread",
        target.type,
        target.id,
        target.id,
        TraceCommentSurface.SessionDetail,
        ThreadStatus.Open,
        JSON.stringify(makeAnchor()),
        "Legacy malformed replies",
        "user-1",
        "Test User",
        identity?.profileId,
        identity?.computeTargetId,
        identity?.userId,
        identity?.organizationId,
        "",
        "2026-06-26T12:00:00.000Z",
        "2026-06-26T12:00:00.000Z",
      ]
    );

    const [comment] = await listLocalTraceComments(prisma, target, identity);
    assert.equal(comment.body, "Legacy malformed replies");
    assert.deepEqual(comment.replies, []);
  });
});

async function openStore(): Promise<OpenTestPrisma> {
  const handle = await openTestPrisma();
  handles.push(handle);
  return handle;
}

function makeIdentity(
  overrides: Partial<NonNullable<UserIdentity>> = {}
): NonNullable<UserIdentity> {
  return {
    computeTargetId: "target-1",
    organizationId: "org-1",
    profileId: "profile-1",
    userId: "user-1",
    ...overrides,
  };
}

function makeCloudComment(overrides: Partial<TraceComment> = {}): TraceComment {
  const createdAt = "2026-06-26T12:00:00.000Z";
  return {
    anchor: makeAnchor(),
    artifactId: "session-artifact-1",
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Test User",
    body: "Cloud note",
    canDelete: true,
    canEdit: true,
    createdAt,
    editedAt: null,
    id: "cloud-comment-1",
    replies: [],
    status: ThreadStatus.Open,
    surface: TraceCommentSurface.SessionDetail,
    target: { type: "session", id: "session-1" },
    threadId: "cloud-thread-1",
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeAnchor(): TraceTextAnchor {
  return {
    actor: { human: null, name: "Codex" },
    endOffset: 15,
    row: 1,
    selectedText: "selected text",
    sessionId: "session-1",
    sourceText: "selected text in a trace row",
    startOffset: 0,
    traceId: "trace-1",
    turnId: "turn-1",
  };
}
