/**
 * PLN-2187 T-2.6 and T-2.7: Document targets on the unified comment requests,
 * against a real database. Writes need the org's switch and touch only
 * Postgres (AC-002); reads are ungated; threads the Liveblocks webhook sync
 * wrote stay readable, repliable and reactable on a Document and nowhere
 * else; document comments send no mention notification (Q-002) and are
 * indexed for search under the document.
 */
import { randomUUID } from "node:crypto";
import {
  CommentSurface,
  ThreadSource,
  ThreadStatus,
} from "@repo/api/src/types/comment";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  CommentBodyFormat,
  CommentReactionEmoji,
} from "@repo/api/src/types/comment-thread-dto";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { BUCKET, liveblocks, recordLiveblocks } = vi.hoisted(() => {
  const calls: string[] = [];
  /**
   * Replaces each named Liveblocks entry point of a module with one that
   * records the call and refuses it. A name the module no longer exports
   * fails here rather than leaving a path unwatched.
   */
  function recordLiveblocks<T extends object>(
    module: string,
    actual: T,
    names: readonly string[]
  ): T {
    const recorded = { ...actual };
    for (const name of names) {
      if (typeof Reflect.get(actual, name) !== "function") {
        throw new Error(`${module} no longer exports ${name}`);
      }
      Reflect.set(recorded, name, () => {
        calls.push(`${module}.${name}`);
        throw new Error(`Liveblocks reached through ${module}.${name}`);
      });
    }
    return recorded;
  }
  return {
    BUCKET: "document-comments-test-bucket",
    liveblocks: { calls },
    recordLiveblocks,
  };
});

// AC-002: apps/api has no `@liveblocks/node` dependency of its own, so every
// Liveblocks call it can make goes through these `@repo/collaboration`
// entry points. Each records itself, so a write that reached one fails here.
vi.mock("@repo/collaboration/server/webhook", async (importOriginal) =>
  recordLiveblocks("webhook", await importOriginal<object>(), [
    "createWebhookHandler",
    "getLiveblocksApiClient",
  ])
);
vi.mock(
  "@repo/collaboration/server/inbox-notifications",
  async (importOriginal) =>
    recordLiveblocks("inbox-notifications", await importOriginal<object>(), [
      "sendAssignmentNotification",
      "sendMentionNotification",
    ])
);
vi.mock("@repo/collaboration/server/room-management", async (importOriginal) =>
  recordLiveblocks("room-management", await importOriginal<object>(), [
    "broadcastRoomEvent",
    "createArtifactLevelThread",
    "createArtifactThread",
    "createRoom",
    "deleteArtifactComment",
    "deleteArtifactThread",
    "deleteRoom",
    "markArtifactThreadResolved",
    "markArtifactThreadUnresolved",
    "replyToArtifactThread",
    "resetRoom",
    "updateRoomMetadata",
  ])
);
vi.mock("@repo/collaboration/server/yjs-anchor", async (importOriginal) =>
  recordLiveblocks("yjs-anchor", await importOriginal<object>(), [
    "anchorThreadToText",
    "findAnchorText",
  ])
);
vi.mock("@repo/collaboration/server/auth", async (importOriginal) =>
  recordLiveblocks("auth", await importOriginal<object>(), ["authenticate"])
);

vi.mock("@repo/aws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/aws")>()),
  getSignedUploadUrl: vi.fn((key: string) =>
    Promise.resolve(`https://upload.test/${key}`)
  ),
  headAttachmentObject: vi.fn(() => Promise.resolve({ byteSize: 12 })),
  deleteObjects: vi.fn(() => Promise.resolve()),
}));

vi.mock("@repo/aws/keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/aws/keys")>();
  return {
    ...actual,
    keys: () => ({ ...actual.keys(), FILE_ATTACHMENTS_BUCKET: BUCKET }),
  };
});

vi.mock("@/lib/mention-notifications", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mention-notifications")>();
  return {
    dispatchMentionNotifications: vi.fn(actual.dispatchMentionNotifications),
  };
});

vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/feature-flags/server-feature-flag-evaluation")
    >()),
    evaluateServerFeatureFlagForOrganization: vi.fn(() =>
      Promise.resolve(false)
    ),
  })
);

vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/search/search-index-service")>();
  return {
    ...actual,
    searchIndexService: {
      ...actual.searchIndexService,
      indexAfterCommit: vi.fn(),
      removeAfterCommit: vi.fn(),
    },
  };
});

import {
  type CommentTestOrg,
  seedCommentTestOrg,
} from "@/__tests__/support/comments/comment-service.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { searchIndexService } from "@/app/search/search-index-service";
import { dispatchMentionNotifications } from "@/lib/mention-notifications";
import type { CommentViewer } from "./comment-capabilities";
import { listArtifactComments } from "./comment-read";
import { unifiedCommentRequests as requests } from "./unified-comment-requests";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();
const ARTIFACT_ANCHOR = { kind: CommentAnchorKind.Artifact } as const;

type DocumentOrg = CommentTestOrg & { documentId: string };

function unwrap<T, E>(
  result: { ok: true; value: T } | { ok: false; error: E }
): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${String(result.error)}`);
  }
  return result.value;
}

async function seedDocumentOrg(switched: boolean): Promise<DocumentOrg> {
  const org = await seedCommentTestOrg(tracker);
  const documentId = await withDb(async (db) => {
    if (switched) {
      await db.organization.update({
        where: { id: org.organizationId },
        data: { documentCommentsSwitchedAt: new Date() },
        select: { id: true },
      });
    }
    const document = await db.artifact.create({
      data: {
        organizationId: org.organizationId,
        type: ArtifactType.DOCUMENT,
        name: `document-${randomUUID().slice(0, 8)}`,
        status: DocumentStatus.Draft,
        createdById: org.author.userId,
      },
      select: { id: true },
    });
    return document.id;
  });
  return { ...org, documentId };
}

/** A thread as the Liveblocks webhook sync writes one: no typed anchor. */
function seedSyncedThread(org: DocumentOrg, artifactId: string) {
  return withDb((db) =>
    db.commentThread.create({
      data: {
        organizationId: org.organizationId,
        artifactId,
        source: ThreadSource.Liveblocks,
        externalId: `th_${randomUUID()}`,
        roomId: `room-${randomUUID()}`,
        status: ThreadStatus.Open,
        metadata: { version: 1 },
        createdById: org.author.userId,
        comments: {
          create: {
            authorId: org.author.userId,
            body: { version: 1, content: [] },
            bodyFormat: CommentBodyFormat.LiveblocksV1,
            plainText: "synced",
            externalId: `cm_${randomUUID()}`,
          },
        },
      },
      select: { id: true, comments: { select: { id: true } } },
    })
  );
}

function createOnDocument(
  org: DocumentOrg,
  viewer: CommentViewer,
  mentions: string[] = []
) {
  return requests.createArtifactCommentThread({
    viewer,
    artifactId: org.documentId,
    request: {
      anchor: ARTIFACT_ANCHOR,
      body: "on the document",
      mentions,
      clientId: randomUUID(),
    },
  });
}

describeIfDb("unified comment requests on Documents", () => {
  let switched: DocumentOrg;
  let unswitched: DocumentOrg;

  beforeAll(async () => {
    [switched, unswitched] = await Promise.all([
      seedDocumentOrg(true),
      seedDocumentOrg(false),
    ]);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  beforeEach(() => {
    liveblocks.calls.length = 0;
  });

  it("refuses a write on a Document of an org that has not switched, and writes nothing", async () => {
    const synced = await seedSyncedThread(unswitched, unswitched.documentId);

    const created = await createOnDocument(unswitched, unswitched.author);
    const replied = await requests.replyToCommentThread({
      viewer: unswitched.author,
      threadId: synced.id,
      request: { body: "reply", clientId: randomUUID() },
    });

    expect(created).toEqual({
      ok: false,
      error: CommentErrorCode.ArtifactTypeNotSupported,
    });
    expect(replied).toEqual({
      ok: false,
      error: CommentErrorCode.ArtifactTypeNotSupported,
    });
    const comments = await withDb((db) =>
      db.comment.count({
        where: { thread: { artifactId: unswitched.documentId } },
      })
    );
    expect(comments).toBe(1);
  });

  it("reads a Document's threads, synced ones included, whether or not its org has switched", async () => {
    const synced = await seedSyncedThread(unswitched, unswitched.documentId);

    const page = unwrap(
      await listArtifactComments({
        viewer: unswitched.author,
        artifactId: unswitched.documentId,
      })
    );

    const listed = page.threads.find((thread) => thread.id === synced.id);
    expect(listed).toMatchObject({
      source: ThreadSource.Liveblocks,
      surface: CommentSurface.DocumentDetail,
      anchor: null,
    });
  });

  it("lists a synced comment without the attachment the Liveblocks sync wrote, which has nothing to download", async () => {
    const synced = await seedSyncedThread(switched, switched.documentId);
    const commentId = synced.comments[0]?.id as string;
    await withDb((db) =>
      db.commentAttachment.create({
        data: {
          commentId,
          externalId: `at_${randomUUID()}`,
          name: "synced.png",
          url: null,
        },
        select: { id: true },
      })
    );

    const page = unwrap(
      await listArtifactComments({
        viewer: switched.author,
        artifactId: switched.documentId,
      })
    );

    const listed = page.threads.find((thread) => thread.id === synced.id);
    expect(listed?.comments.map((comment) => comment.id)).toEqual([commentId]);
    expect(listed?.comments[0]?.attachments).toEqual([]);
  });

  it("writes a Document thread's whole lifecycle to Postgres alone, sending no mention notification (AC-002, Q-002)", async () => {
    const thread = unwrap(
      await createOnDocument(switched, switched.author, [switched.other.userId])
    );
    const rootId = thread.comments[0]?.id as string;
    const replied = unwrap(
      await requests.replyToCommentThread({
        viewer: switched.other,
        threadId: thread.id,
        request: {
          body: "reply",
          mentions: [switched.author.userId],
          clientId: randomUUID(),
        },
      })
    );
    unwrap(
      await requests.editCommentById({
        viewer: switched.author,
        commentId: rootId,
        request: {
          body: "edited",
          mentions: [switched.other.userId],
          expectedRevision: 0,
        },
      })
    );
    const reaction = {
      viewer: switched.other,
      commentId: rootId,
      emoji: CommentReactionEmoji.ThumbsUp,
    };
    unwrap(await requests.addReactionByCommentId(reaction));
    unwrap(await requests.removeReactionByCommentId(reaction));
    const upload = unwrap(
      await requests.createCommentAttachmentUploadById({
        viewer: switched.author,
        commentId: rootId,
        request: { name: "notes.txt", mimeType: "text/plain", size: 12 },
      })
    );
    unwrap(
      await requests.completeCommentAttachmentUploadById({
        viewer: switched.author,
        attachmentId: upload.attachmentId,
      })
    );
    unwrap(
      await requests.resolveCommentThreadById({
        viewer: switched.other,
        threadId: thread.id,
      })
    );
    unwrap(
      await requests.reopenCommentThreadById({
        viewer: switched.author,
        threadId: thread.id,
      })
    );
    const replyId = replied.comments[1]?.id as string;
    unwrap(
      await requests.deleteCommentById({
        viewer: switched.other,
        commentId: replyId,
      })
    );

    expect(dispatchMentionNotifications).not.toHaveBeenCalled();
    expect(liveblocks.calls).toEqual([]);
  });

  it("replies to, reacts to, edits and resolves a synced Liveblocks thread on a Document", async () => {
    const synced = await seedSyncedThread(switched, switched.documentId);
    const syncedCommentId = synced.comments[0]?.id as string;

    const replied = unwrap(
      await requests.replyToCommentThread({
        viewer: switched.other,
        threadId: synced.id,
        request: { body: "reply to synced", clientId: randomUUID() },
      })
    );
    const reacted = unwrap(
      await requests.addReactionByCommentId({
        viewer: switched.other,
        commentId: syncedCommentId,
        emoji: CommentReactionEmoji.Hooray,
      })
    );
    const edited = unwrap(
      await requests.editCommentById({
        viewer: switched.author,
        commentId: syncedCommentId,
        request: { body: "edited synced", expectedRevision: 0 },
      })
    );
    const resolved = unwrap(
      await requests.resolveCommentThreadById({
        viewer: switched.other,
        threadId: synced.id,
      })
    );

    expect(replied.comments.map((comment) => comment.body)).toEqual([
      "synced",
      "reply to synced",
    ]);
    expect(reacted.comments[0]?.reactions).toEqual([
      expect.objectContaining({ emoji: CommentReactionEmoji.Hooray }),
    ]);
    expect(edited.comments[0]?.body).toBe("edited synced");
    expect(resolved.status).toBe(ThreadStatus.Resolved);
    expect(liveblocks.calls).toEqual([]);
  });

  it("serves a Liveblocks-sourced thread on a Document only, never on a Session", async () => {
    const synced = await seedSyncedThread(
      switched,
      switched.session.artifactId
    );

    const replied = await requests.replyToCommentThread({
      viewer: switched.author,
      threadId: synced.id,
      request: { body: "reply", clientId: randomUUID() },
    });

    expect(replied).toEqual({ ok: false, error: CommentErrorCode.NotFound });
  });

  it("indexes a Document comment for search under its document (T-2.7)", async () => {
    const thread = unwrap(await createOnDocument(switched, switched.author));

    expect(searchIndexService.indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: thread.comments[0]?.id,
        entitySubtype: ArtifactType.DOCUMENT,
        anchorEntityId: switched.documentId,
      })
    );
  });
});
