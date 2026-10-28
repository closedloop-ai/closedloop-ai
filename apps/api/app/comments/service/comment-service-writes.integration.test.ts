/**
 * ISS-11212 (PLN-2121, acceptance criteria 3 and 5): revisions, client
 * idempotency and paging against a real database.
 */
import {
  CommentSurface,
  CommentTargetType,
  ThreadSource,
  TRACE_COMMENT_METADATA_KIND,
  TRACE_COMMENT_SCHEMA_VERSION,
} from "@repo/api/src/types/comment";
import { COMMENT_ANCHOR_SCHEMA_VERSION } from "@repo/api/src/types/comment-anchor";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  CommentBodyFormat,
  type CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** Runs once inside an edit's transaction, after its lookup and before its UPDATE. */
const mentionReads = vi.hoisted(() => ({
  beforeRead: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("./trace-comment-mentions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./trace-comment-mentions")>();
  return {
    ...actual,
    readPersistedCommentMentions: async (
      ...args: Parameters<typeof actual.readPersistedCommentMentions>
    ) => {
      const hook = mentionReads.beforeRead;
      mentionReads.beforeRead = undefined;
      await hook?.();
      return actual.readPersistedCommentMentions(...args);
    },
  };
});

vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));

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
  backendPid,
  type CommentTestOrg,
  commentTraceAnchor,
  onOwnConnection,
  seedCommentTestOrg,
} from "@/__tests__/support/comments/comment-service.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { commentsService } from "@/app/comments/service";
import {
  type CommentViewer,
  createCommentLiveState,
} from "./comment-capabilities";
import {
  COMMENT_LIST_MAX_LIMIT,
  decodeCommentListCursor,
  presentCommentThreadDto,
} from "./comment-read";
import type { CommentTarget } from "./comment-target";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();
const PAGED_THREADS = 205;
const PAGED_AT = new Date("2026-08-01T00:00:00.000Z");

function presenter(viewer: CommentViewer, target: CommentTarget) {
  return presentCommentThreadDto({
    viewer,
    target,
    liveState: createCommentLiveState(viewer),
  });
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: string }
): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error}`);
  }
  return result.value;
}

function threadRevision(threadId: string): Promise<number> {
  return withDb(async (db) => {
    const row = await db.commentThread.findUniqueOrThrow({
      where: { id: threadId },
      select: { revision: true },
    });
    return row.revision;
  });
}

describeIfDb("comment service: revisions and client ids", () => {
  let org: CommentTestOrg;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  function createThread(clientId: string) {
    return commentsService.createThread({
      viewer: org.author,
      target: org.session,
      anchor: commentTraceAnchor(1),
      body: "root",
      clientId,
      present: presenter(org.author, org.session),
    });
  }

  function reply(thread: CommentThreadDto, clientId: string) {
    return commentsService.reply({
      viewer: org.other,
      target: org.session,
      thread: { threadId: thread.id },
      body: "reply",
      clientId,
      present: presenter(org.other, org.session),
    });
  }

  it("replays a thread clientId onto the original thread with no second row", async () => {
    const clientId = `thread-${org.organizationId}`;
    const first = unwrap(await createThread(clientId));
    const replay = unwrap(await createThread(clientId));

    expect(replay).toEqual(first);
    expect(first.revision).toBe(0);
    const rows = await withDb((db) =>
      db.commentThread.count({
        where: { organizationId: org.organizationId, externalId: clientId },
      })
    );
    expect(rows).toBe(1);
  });

  it("replays a reply clientId onto the original reply, and refuses it on another thread", async () => {
    const thread = unwrap(
      await createThread(`reply-host-${org.organizationId}`)
    );
    const other = unwrap(
      await createThread(`reply-other-${org.organizationId}`)
    );
    const clientId = `reply-${org.organizationId}`;

    const first = unwrap(await reply(thread, clientId));
    const replay = unwrap(await reply(thread, clientId));
    const conflict = await reply(other, clientId);

    expect(replay).toEqual(first);
    expect(first.revision).toBe(1);
    expect(conflict).toEqual({
      ok: false,
      error: CommentErrorCode.ClientIdConflict,
    });
    const replies = await withDb((db) =>
      db.comment.findMany({
        where: { externalId: clientId },
        select: { threadId: true },
      })
    );
    expect(replies).toEqual([{ threadId: thread.id }]);
    await expect(threadRevision(other.id)).resolves.toBe(0);
  });

  it("edits against the expected revision and refuses a stale one without writing", async () => {
    const thread = unwrap(await createThread(`edit-${org.organizationId}`));
    const rootId = thread.comments[0]?.id as string;
    const edit = (body: string, expectedRevision: number) =>
      commentsService.editComment({
        viewer: org.author,
        target: org.session,
        commentId: rootId,
        body,
        expectedRevision,
        present: presenter(org.author, org.session),
      });

    const edited = unwrap(await edit("first edit", 0));
    const stale = await edit("stale edit", 0);

    expect(edited.revision).toBe(1);
    expect(edited.comments[0]).toMatchObject({
      body: "first edit",
      revision: 1,
      bodyFormat: CommentBodyFormat.RichV1,
    });
    expect(stale).toEqual({ ok: false, error: CommentErrorCode.StaleRevision });
    const stored = await withDb((db) =>
      db.comment.findUniqueOrThrow({
        where: { id: rootId },
        select: { plainText: true, revision: true },
      })
    );
    expect(stored).toEqual({ plainText: "first edit", revision: 1 });
    await expect(threadRevision(thread.id)).resolves.toBe(1);
  });

  it("refuses an edit whose revision moves after its read, keeping the other writer's body", async () => {
    const thread = unwrap(await createThread(`race-${org.organizationId}`));
    const rootId = thread.comments[0]?.id as string;
    // A second writer commits between this edit's read of revision 0 and its
    // UPDATE, on its own connection, as a concurrent request would.
    const concurrent = onOwnConnection(async (db) => {
      await db.comment.update({
        where: { id: rootId },
        data: { plainText: "concurrent edit", revision: { increment: 1 } },
        select: { id: true },
      });
      return backendPid(db);
    });
    const pids: { edit?: number; concurrent?: number } = {};
    mentionReads.beforeRead = async () => {
      pids.edit = await withDb(backendPid);
      pids.concurrent = await concurrent.run();
    };

    const raced = await commentsService
      .editComment({
        viewer: org.author,
        target: org.session,
        commentId: rootId,
        body: "raced edit",
        expectedRevision: 0,
        present: presenter(org.author, org.session),
      })
      .finally(() => {
        mentionReads.beforeRead = undefined;
      });

    expect(pids.concurrent).toBeGreaterThan(0);
    expect(pids.concurrent).not.toBe(pids.edit);
    expect(raced).toEqual({ ok: false, error: CommentErrorCode.StaleRevision });
    const stored = await withDb((db) =>
      db.comment.findUniqueOrThrow({
        where: { id: rootId },
        select: { plainText: true, revision: true },
      })
    );
    expect(stored).toEqual({ plainText: "concurrent edit", revision: 1 });
    await expect(threadRevision(thread.id)).resolves.toBe(0);
  });

  it("bumps every soft-deleted comment and the thread once on a root delete", async () => {
    const thread = unwrap(await createThread(`delete-${org.organizationId}`));
    unwrap(await reply(thread, `delete-reply-${org.organizationId}`));

    const deleted = await commentsService.deleteComment({
      viewer: org.author,
      target: org.session,
      commentId: thread.comments[0]?.id as string,
    });

    expect(deleted).toEqual({ ok: true, value: { deleted: true } });
    const comments = await withDb((db) =>
      db.comment.findMany({
        where: { threadId: thread.id },
        select: { revision: true, deletedAt: true },
      })
    );
    expect(comments).toHaveLength(2);
    for (const comment of comments) {
      expect(comment.revision).toBe(1);
      expect(comment.deletedAt).toBeInstanceOf(Date);
    }
    await expect(threadRevision(thread.id)).resolves.toBe(2);
  });
});

describeIfDb("comment service: the artifact list pages past 200", () => {
  let org: CommentTestOrg;
  let expectedIds: string[];

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
    expectedIds = await seedPagedThreads(org);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  async function page(cursor: string | null, limit?: number) {
    const after = cursor ? decodeCommentListCursor(cursor) : null;
    return unwrap(
      await commentsService.listArtifactComments({
        viewer: org.author,
        artifactId: org.session.artifactId,
        ...(after ? { after } : {}),
        ...(limit === undefined ? {} : { limit }),
      })
    );
  }

  it(`returns all ${PAGED_THREADS} threads across pages of 100, in order, once each`, async () => {
    const seen: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | null = null;
    do {
      const result = await page(cursor, COMMENT_LIST_MAX_LIMIT);
      pageSizes.push(result.threads.length);
      seen.push(...result.threads.map((thread) => thread.id));
      cursor = result.nextCursor;
    } while (cursor);

    expect(pageSizes).toEqual([100, 100, 5]);
    expect(seen).toEqual(expectedIds);
    expect(new Set(seen).size).toBe(PAGED_THREADS);
  });

  it("clamps a limit of 0 up to 1 and a limit of 1,000 down to 100", async () => {
    const smallest = await page(null, 0);
    const largest = await page(null, 1000);

    expect(smallest.threads.map((thread) => thread.id)).toEqual(
      expectedIds.slice(0, 1)
    );
    expect(smallest.nextCursor).not.toBeNull();
    expect(largest.threads).toHaveLength(COMMENT_LIST_MAX_LIMIT);
  });

  it("leaves trace threads out of the document threads read", async () => {
    await withDb((db) =>
      db.commentThread.create({
        data: {
          organizationId: org.organizationId,
          artifactId: org.session.artifactId,
          source: ThreadSource.Liveblocks,
          externalId: `liveblocks-${org.organizationId}`,
          comments: {
            create: {
              authorId: org.author.userId,
              body: {},
              bodyFormat: CommentBodyFormat.LiveblocksV1,
              plainText: "document comment",
            },
          },
        },
        select: { id: true },
      })
    );

    const threads = await commentsService.findThreadsByDocument(
      org.organizationId,
      org.session.artifactId
    );

    expect(threads.map((thread) => thread.externalId)).toEqual([
      `liveblocks-${org.organizationId}`,
    ]);
  });
});

/**
 * Threads written straight to the table. Indices 150-204 share one `createdAt`,
 * so the tie runs across the page-2/page-3 boundary and the `id` tiebreak
 * decides order within it and across the cursor. Returns the ids in list order.
 */
async function seedPagedThreads(org: CommentTestOrg): Promise<string[]> {
  return await withDb(async (db) => {
    await db.commentThread.createMany({
      data: Array.from({ length: PAGED_THREADS }, (_, index) => ({
        organizationId: org.organizationId,
        artifactId: org.session.artifactId,
        source: ThreadSource.Native,
        metadata: {
          kind: TRACE_COMMENT_METADATA_KIND,
          schemaVersion: TRACE_COMMENT_SCHEMA_VERSION,
          targetType: CommentTargetType.Session,
          surface: CommentSurface.SessionDetail,
        },
        anchor: {
          v: COMMENT_ANCHOR_SCHEMA_VERSION,
          ...commentTraceAnchor(index),
        },
        createdById: org.author.userId,
        createdAt: new Date(PAGED_AT.getTime() + Math.min(index, 150) * 1000),
        externalId: `paged-${index}-${org.organizationId}`,
      })),
    });
    const threads = await db.commentThread.findMany({
      where: {
        organizationId: org.organizationId,
        source: ThreadSource.Native,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    await db.comment.createMany({
      data: threads.map((thread) => ({
        threadId: thread.id,
        authorId: org.author.userId,
        body: {},
        bodyFormat: CommentBodyFormat.RichV1,
        plainText: "paged",
      })),
    });
    return threads.map((thread) => thread.id);
  });
}
