import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  ThreadStatus,
  TRACE_COMMENT_MENTIONS_MAX,
  type TraceComment,
  TraceCommentKind,
  type TraceCommentReply,
  TraceCommentSurface,
  type TraceTextAnchor,
  traceCommentMentionsSchema,
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
} from "../src/main/trace-comments/shared-trace-comments-store.js";
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

  test("persists @-mentions on a local create and surfaces them for cloud sync (FEA-3490)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();

    const created = await createLocalTraceComment(
      prisma,
      target,
      {
        anchor: makeAnchor(),
        body: "cc the team",
        mentions: ["user-2", "user-2", "user-3"],
      },
      identity
    );
    // De-duplicated on write; returned on the created comment.
    assert.deepEqual(created.mentions, ["user-2", "user-3"]);

    const [listed] = await listLocalTraceComments(prisma, target, identity);
    assert.deepEqual(listed.mentions, ["user-2", "user-3"]);

    const pending = await listPendingLocalTraceCommentOperations(
      prisma,
      target,
      identity
    );
    const createOp = pending.find((op) => op.operation === "create");
    assert.ok(createOp, "expected a pending create op");
    // The pending op carries the mentions so the cloud POST can forward them.
    assert.deepEqual(createOp.comment.mentions, ["user-2", "user-3"]);
  });

  test("persists a parsing-bug classification and carries it on the pending create op (FEA-4171)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();

    const created = await createLocalTraceComment(
      prisma,
      target,
      {
        anchor: makeAnchor(),
        body: "The tool output was parsed as raw text; expected JSON.",
        kind: TraceCommentKind.ParsingBug,
      },
      identity
    );
    assert.equal(created.kind, TraceCommentKind.ParsingBug);

    const [listed] = await listLocalTraceComments(prisma, target, identity);
    assert.equal(listed.kind, TraceCommentKind.ParsingBug);

    const pending = await listPendingLocalTraceCommentOperations(
      prisma,
      target,
      identity
    );
    const createOp = pending.find((op) => op.operation === "create");
    assert.ok(createOp, "expected a pending create op");
    // The pending op carries the classification so the cloud POST forwards it
    // to the golden-candidate pipeline.
    assert.equal(createOp.comment.kind, TraceCommentKind.ParsingBug);
  });

  test("persists the classification of a cloud-originated parsing-bug comment (FEA-4171)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();

    await upsertCloudTraceComments(
      prisma,
      target,
      [
        makeCloudComment({
          id: "cloud-parsing-bug-1",
          kind: TraceCommentKind.ParsingBug,
        }),
      ],
      identity
    );

    const [listed] = await listLocalTraceComments(prisma, target, identity);
    assert.equal(listed.kind, TraceCommentKind.ParsingBug);
  });

  test("defaults an unclassified comment to Comment (FEA-4171)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();

    const created = await createLocalTraceComment(
      prisma,
      target,
      { anchor: makeAnchor(), body: "Just a normal note" },
      identity
    );
    assert.equal(created.kind, TraceCommentKind.Comment);

    const [listed] = await listLocalTraceComments(prisma, target, identity);
    assert.equal(listed.kind, TraceCommentKind.Comment);
  });

  test("preserves a local parsing-bug flag when a version-skewed cloud echo omits kind (FEA-4171)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();
    const anchor = makeAnchor();
    const body = "Old server strips the kind field on echo.";

    // A new client flags a comment as a parsing bug locally...
    await createLocalTraceComment(
      prisma,
      target,
      { anchor, body, kind: TraceCommentKind.ParsingBug },
      identity
    );

    // ...but a version-skewed older API returns the comment back without a
    // `kind` field. Reconcile must NOT clobber the local ParsingBug flag.
    const oldServerEcho = makeCloudComment({
      id: "cloud-echo-no-kind",
      anchor,
      body,
    });
    Reflect.deleteProperty(oldServerEcho, "kind");
    await upsertCloudTraceComments(prisma, target, [oldServerEcho], identity);

    const [listed] = await listLocalTraceComments(prisma, target, identity);
    assert.equal(listed.kind, TraceCommentKind.ParsingBug);
  });

  test("caps >50 distinct @-mentions on create to the shared cloud max, matching cloud ranking (FEA-3531)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();

    // More distinct candidates than the cloud transport schema permits. Padded
    // ids keep insertion order stable and unambiguous for the ranking check.
    const overCap = Array.from(
      { length: TRACE_COMMENT_MENTIONS_MAX + 7 },
      (_unused, index) => `user-${String(index).padStart(3, "0")}`
    );
    // Cloud rejects the raw over-cap list outright (400) — the desktop-side
    // regression that wedged such comments in a `local_pending` retry loop.
    assert.equal(
      traceCommentMentionsSchema.safeParse(overCap).success,
      false,
      "sanity: an uncapped >50 list must fail the cloud schema"
    );

    const created = await createLocalTraceComment(
      prisma,
      target,
      { anchor: makeAnchor(), body: "cc everyone", mentions: overCap },
      identity
    );

    // Capped to exactly the shared max, retaining the leading ids in insertion
    // order — the same dedup-then-cap set the cloud schema keeps.
    const expected = overCap.slice(0, TRACE_COMMENT_MENTIONS_MAX);
    assert.equal(created.mentions.length, TRACE_COMMENT_MENTIONS_MAX);
    assert.deepEqual(created.mentions, expected);

    const [listed] = await listLocalTraceComments(prisma, target, identity);
    assert.deepEqual(listed.mentions, expected);

    // Cross-surface parity: the capped list now passes the cloud schema, so the
    // sync POST no longer 400s. The retained set matches cloud's own dedup+cap.
    const cloudParsed = traceCommentMentionsSchema.parse(created.mentions);
    assert.deepEqual(cloudParsed, expected);

    // The pending create op carries the capped list to the cloud POST.
    const pending = await listPendingLocalTraceCommentOperations(
      prisma,
      target,
      identity
    );
    const createOp = pending.find((op) => op.operation === "create");
    assert.ok(createOp, "expected a pending create op");
    assert.deepEqual(createOp.comment.mentions, expected);
  });

  test("degrades a malformed non-array mentions field on create to an empty list (FEA-3518)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();

    // A malformed IPC payload (e.g. a string) must not crash the create with
    // `mentions.filter is not a function`; it degrades to no mentions.
    const created = await createLocalTraceComment(
      prisma,
      target,
      {
        anchor: makeAnchor(),
        body: "cc the team",
        mentions: "user-2" as unknown as string[],
      },
      identity
    );
    assert.deepEqual(created.mentions, []);

    const [listed] = await listLocalTraceComments(prisma, target, identity);
    assert.deepEqual(listed.mentions, []);
  });

  test("retains existing @-mentions on a body-only local edit (FEA-3490)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();

    const created = await createLocalTraceComment(
      prisma,
      target,
      { anchor: makeAnchor(), body: "cc @user-2", mentions: ["user-2"] },
      identity
    );

    // Body-only edit (mentions omitted) must keep the existing mentions.
    const edited = await updateLocalTraceComment(
      prisma,
      target,
      created.id,
      { body: "cc @user-2 (typo fixed)" },
      identity
    );
    assert.deepEqual(edited.mentions, ["user-2"]);

    // An explicit empty list clears them.
    const cleared = await updateLocalTraceComment(
      prisma,
      target,
      created.id,
      { body: "never mind", mentions: [] },
      identity
    );
    assert.deepEqual(cleared.mentions, []);
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

  test("batches a mixed cloud list: adopts a matching offline local and inserts new cloud comments without duplicating (FEA-3521)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();

    // An offline local create that the cloud list will later echo back.
    await createLocalTraceComment(
      prisma,
      target,
      { anchor: makeAnchor(), body: "Shared offline body" },
      identity
    );

    await upsertCloudTraceComments(
      prisma,
      target,
      [
        // Same body + anchor as the offline local: must adopt that row, not
        // insert a duplicate.
        makeCloudComment({
          body: "Shared offline body",
          id: "cloud-adopted",
        }),
        // A brand-new cloud comment inserted alongside in the same batch.
        makeCloudComment({
          anchor: makeAnchor(),
          body: "Fresh cloud comment",
          id: "cloud-fresh",
        }),
      ],
      identity
    );

    const comments = await listLocalTraceComments(prisma, target, identity);
    assert.deepEqual(comments.map((comment) => comment.body).sort(), [
      "Fresh cloud comment",
      "Shared offline body",
    ]);
    // The offline local was adopted (now cloud-backed), so nothing is left
    // pending for upload.
    const pending = await listPendingLocalTraceCommentOperations(
      prisma,
      target,
      identity
    );
    assert.equal(pending.length, 0);
  });

  test("skips a pending local edit when the same comment appears in the batched cloud list (FEA-3521)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();
    const cloudComment = makeCloudComment({
      body: "Original cloud body",
      id: "cloud-editable",
    });

    await upsertCloudTraceComments(prisma, target, [cloudComment], identity);
    await updateLocalTraceComment(
      prisma,
      target,
      cloudComment.id,
      { body: "Edited locally, not yet uploaded" },
      identity
    );

    // A subsequent reconcile that still carries the stale cloud body must not
    // clobber the unsynced local edit.
    await upsertCloudTraceComments(
      prisma,
      target,
      [makeCloudComment({ body: "Original cloud body", id: "cloud-editable" })],
      identity
    );

    const comments = await listLocalTraceComments(prisma, target, identity);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].body, "Edited locally, not yet uploaded");
  });

  test("collapses two same-id entries in one batched cloud list into a single last-occurrence-wins row (FEA-3521)", async () => {
    const { prisma } = await openStore();
    const target = { type: "session" as const, id: "session-1" };
    const identity = makeIdentity();

    // The same cloud id appears twice in one reconcile. The first occurrence
    // inserts the row and registers it in existingByCloudId mid-loop; the
    // second must re-resolve to that freshly-inserted row and UPDATE it rather
    // than attempting a duplicate INSERT (which would collide on the primary
    // key). This mirrors the old re-SELECT-per-comment path: the later
    // occurrence is the authoritative cloud state, so its body/replies win and
    // the earlier synced cloud reply — absent from the latest list — is treated
    // as removed (only pending-local replies survive a merge).
    await upsertCloudTraceComments(
      prisma,
      target,
      [
        makeCloudComment({
          body: "First cloud body",
          id: "cloud-dup",
          replies: [makeCloudReply({ body: "First reply", id: "reply-a" })],
        }),
        makeCloudComment({
          body: "Second cloud body",
          id: "cloud-dup",
          replies: [makeCloudReply({ body: "Second reply", id: "reply-b" })],
        }),
      ],
      identity
    );

    const comments = await listLocalTraceComments(prisma, target, identity);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].id, "cloud-dup");
    assert.equal(comments[0].body, "Second cloud body");
    assert.deepEqual(
      comments[0].replies?.map((reply) => reply.body),
      ["Second reply"]
    );
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
    kind: TraceCommentKind.Comment,
    replies: [],
    status: ThreadStatus.Open,
    surface: TraceCommentSurface.SessionDetail,
    target: { type: "session", id: "session-1" },
    threadId: "cloud-thread-1",
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeCloudReply(
  overrides: Partial<TraceCommentReply> = {}
): TraceCommentReply {
  const createdAt = "2026-06-26T12:00:00.000Z";
  return {
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Test User",
    body: "Cloud reply",
    canDelete: true,
    canEdit: true,
    createdAt,
    editedAt: null,
    id: "cloud-reply-1",
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
