/**
 * ISS-11212 (PLN-2121 `retrySync`): the dead-letter row's writes — the mark,
 * the re-pend, and the edit that settles it — against a real database,
 * including an edit that commits between the retry's read and its write.
 */
import {
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
} from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** Runs once inside a command's transaction, right after its comment lookup. */
const lookups = vi.hoisted(() => ({
  afterRead: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("./comment-command-lookup", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./comment-command-lookup")>();
  return {
    ...actual,
    findCommentOnTarget: async (
      ...args: Parameters<typeof actual.findCommentOnTarget>
    ) => {
      const found = await actual.findCommentOnTarget(...args);
      const hook = lookups.afterRead;
      lookups.afterRead = undefined;
      await hook?.();
      return found;
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
  type CommentTestOrg,
  commentTraceAnchor,
  onOwnConnection,
  seedCommentTestOrg,
} from "@/__tests__/support/comments/comment-service.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { commentsService } from "@/app/comments/service";
import { createCommentLiveState } from "./comment-capabilities";
import { presentCommentThreadDto } from "./comment-read";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();

const DESKTOP_INBOUND = {
  provider: CommentSyncProvider.Desktop,
  direction: CommentSyncDirection.Inbound,
};

describeIfDb("comment service: retrySync", () => {
  let org: CommentTestOrg;
  let row = 0;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  function present() {
    return presentCommentThreadDto({
      viewer: org.author,
      target: org.session,
      liveState: createCommentLiveState(org.author),
    });
  }

  /** A thread whose DESKTOP / INBOUND row is `state`, or has none. */
  async function seedThread(options: {
    state?: CommentSyncStatus;
  }): Promise<{ threadId: string; rootId: string }> {
    row += 1;
    const created = await commentsService.createThread({
      viewer: org.author,
      target: org.session,
      anchor: commentTraceAnchor(row),
      body: "root",
      clientId: null,
      present: present(),
    });
    if (!created.ok) {
      throw new Error(`expected a thread, got ${created.error}`);
    }
    const threadId = created.value.id;
    const rootId = created.value.comments[0]?.id as string;
    const state = options.state;
    if (state) {
      await withDb((db) =>
        db.commentSyncState.create({
          data: {
            organizationId: org.organizationId,
            threadId,
            ...DESKTOP_INBOUND,
            state,
            attempts: 3,
          },
          select: { id: true },
        })
      );
    }
    return { threadId, rootId };
  }

  function retry(rootId: string) {
    return commentsService.retrySync({
      viewer: org.author,
      target: org.session,
      comment: { commentId: rootId },
      present: present(),
    });
  }

  function markAbandoned(rootId: string) {
    return commentsService.markSyncAbandoned({
      viewer: org.author,
      target: org.session,
      comment: { commentId: rootId },
      present: present(),
    });
  }

  function edit(rootId: string) {
    return commentsService.editComment({
      viewer: org.author,
      target: org.session,
      commentId: rootId,
      body: "redelivered",
      present: present(),
    });
  }

  /** The author's edit, committed on its own connection once released. */
  function concurrentEdit(rootId: string) {
    return onOwnConnection(() =>
      commentsService.editComment({
        viewer: org.author,
        target: org.session,
        commentId: rootId,
        body: "edited while the retry was in flight",
        present: present(),
      })
    );
  }

  function stored(threadId: string) {
    return withDb(async (db) => {
      const thread = await db.commentThread.findUniqueOrThrow({
        where: { id: threadId },
        select: {
          revision: true,
          syncStates: {
            where: DESKTOP_INBOUND,
            select: { state: true, attempts: true },
          },
        },
      });
      return {
        revision: thread.revision,
        syncStates: thread.syncStates,
      };
    });
  }

  it("re-pends an ABANDONED row with its attempts reset, as one thread change", async () => {
    const { threadId, rootId } = await seedThread({
      state: CommentSyncStatus.Abandoned,
    });

    const retried = await retry(rootId);

    expect(retried.ok).toBe(true);
    await expect(stored(threadId)).resolves.toEqual({
      revision: 1,
      syncStates: [{ state: CommentSyncStatus.Pending, attempts: 0 }],
    });
  });

  it("changes nothing on a comment that was never dead-lettered, revision included", async () => {
    const { threadId, rootId } = await seedThread({});

    const retried = await retry(rootId);

    expect(retried.ok).toBe(true);
    await expect(stored(threadId)).resolves.toEqual({
      revision: 0,
      syncStates: [],
    });
  });

  it("leaves a dead letter an edit cleared after the retry's read SYNCED", async () => {
    const { threadId, rootId } = await seedThread({
      state: CommentSyncStatus.Abandoned,
    });
    const edit = concurrentEdit(rootId);
    let edited: { ok: boolean } | undefined;
    lookups.afterRead = async () => {
      edited = await edit.run();
    };

    const retried = await retry(rootId).finally(() => {
      lookups.afterRead = undefined;
    });

    expect(edited?.ok).toBe(true);
    expect(retried.ok).toBe(true);
    // The edit's own bump is the only one: the retry changed nothing.
    await expect(stored(threadId)).resolves.toEqual({
      revision: 1,
      syncStates: [{ state: CommentSyncStatus.Synced, attempts: 3 }],
    });
  });

  it("settles a retried comment SYNCED when its root edit lands", async () => {
    const { threadId, rootId } = await seedThread({
      state: CommentSyncStatus.Abandoned,
    });

    expect((await retry(rootId)).ok).toBe(true);
    expect((await edit(rootId)).ok).toBe(true);

    await expect(stored(threadId)).resolves.toEqual({
      revision: 2,
      syncStates: [{ state: CommentSyncStatus.Synced, attempts: 0 }],
    });
  });

  it("dead-letters a PENDING row as one thread change", async () => {
    const { threadId, rootId } = await seedThread({
      state: CommentSyncStatus.Pending,
    });

    expect((await markAbandoned(rootId)).ok).toBe(true);

    await expect(stored(threadId)).resolves.toEqual({
      revision: 1,
      syncStates: [{ state: CommentSyncStatus.Abandoned, attempts: 3 }],
    });
  });

  it("dead-letters a comment with no row by creating it", async () => {
    const { threadId, rootId } = await seedThread({});

    expect((await markAbandoned(rootId)).ok).toBe(true);

    await expect(stored(threadId)).resolves.toEqual({
      revision: 1,
      syncStates: [{ state: CommentSyncStatus.Abandoned, attempts: 0 }],
    });
  });

  it("changes nothing when a desktop re-reports an already ABANDONED comment, revision included", async () => {
    const { threadId, rootId } = await seedThread({
      state: CommentSyncStatus.Abandoned,
    });

    expect((await markAbandoned(rootId)).ok).toBe(true);
    expect((await markAbandoned(rootId)).ok).toBe(true);

    await expect(stored(threadId)).resolves.toEqual({
      revision: 0,
      syncStates: [{ state: CommentSyncStatus.Abandoned, attempts: 3 }],
    });
  });
});
