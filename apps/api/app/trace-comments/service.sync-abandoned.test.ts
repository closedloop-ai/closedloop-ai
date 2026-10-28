/**
 * ISS-10382: the cloud half of the trace-comment dead-letter lifecycle.
 *
 * Its own file rather than an addition to `service.test.ts`, which is on the
 * shrink-only `noExcessiveLinesPerFile` grandfather list in `biome.jsonc`.
 *
 * Scope note (operator ruling 2026-09-21): the cloud stands alone. It has no
 * queue, no pending operation and no held replies — `apps/api` stores a reply on
 * receipt inside the same transaction — so "re-pend" here is exactly the row's
 * move from `ABANDONED` back to `PENDING` (PLN-2121 `retrySync`), and there is
 * no release step to assert.
 *
 * ISS-11212: the marker is stored on the thread's DESKTOP / INBOUND
 * `CommentSyncState` row.
 */
import { CommentTargetType, ThreadStatus } from "@repo/api/src/types/comment";
import {
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
} from "@repo/api/src/types/comment-thread-dto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/app/comments/service/comment-thread-signal",
  async (importOriginal) => {
    const { createCommentThreadSignalMockModule } = await import(
      "../../__tests__/fixtures/mock-modules"
    );
    return createCommentThreadSignalMockModule(importOriginal);
  }
);

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: { SESSION: "SESSION", BRANCH: "BRANCH" },
  });
});

vi.mock("@/app/comments/service/trace-comment-search-index", () => ({
  indexTraceCommentAfterCommit: vi.fn(),
  removeTraceCommentAfterCommit: vi.fn(),
}));

import { getMockWithDb } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

const mockWithDb = getMockWithDb();

const ARTIFACT_ID = "session-artifact-1";
const THREAD_ID = "thread-1";
const ROOT_ID = "comment-1";
const REPLY_ID = "comment-2";
const OTHER_THREAD_ID = "thread-2";
const OTHER_ROOT_ID = "comment-9";
const AUTHOR_ID = "user-1";
const createdAt = new Date("2026-09-16T10:00:00.000Z");

const anchor = {
  traceId: "trace:session-1:0",
  turnId: "turn:session-1:0",
  row: 0,
  selectedText: "quote target",
  sourceText: "A trace quote target row",
  startOffset: 8,
  endOffset: 20,
  sessionId: "session-1",
  actor: { name: "codex", human: null },
};

/**
 * Spelled out as a literal rather than imported from the schema it is checked
 * against. A fixture built from the very const it polices stays green when a
 * member is deleted; the duplication IS the test.
 */
const storedMetadata = {
  kind: "trace_comment",
  schemaVersion: 1,
  targetType: CommentTargetType.Session,
  surface: "session_detail",
};

const storedAnchor = { v: 1, kind: "trace", ...anchor };

const target = {
  type: CommentTargetType.Session,
  id: ARTIFACT_ID,
} as const;

/** The same thread as {@link storedMetadata}, anchored on a Branch surface. */
const branchMetadata = {
  ...storedMetadata,
  targetType: CommentTargetType.Branch,
  surface: "branch_detail",
};

function comment(id: string, authorId = AUTHOR_ID) {
  return {
    id,
    authorId,
    plainText: id === ROOT_ID ? "Root note" : "A queued reply",
    body: null,
    editedAt: null,
    createdAt:
      id === ROOT_ID ? createdAt : new Date("2026-09-16T10:05:00.000Z"),
    updatedAt:
      id === ROOT_ID ? createdAt : new Date("2026-09-16T10:05:00.000Z"),
  };
}

/**
 * Wires the whole path: target resolution, the author-scoped editable lookup,
 * the metadata read, the marker write, and the refreshed list read.
 *
 * `storedOnThread` is what the thread's metadata column holds BEFORE the call,
 * so a test can anchor the thread on a Branch surface instead of a Session.
 */
function mockThread(options: {
  comments?: ReturnType<typeof comment>[];
  storedOnThread?: Record<string, unknown>;
  /** The thread's DESKTOP / INBOUND sync-state row before the call, if any. */
  syncState?: CommentSyncStatus;
  /** The bystander thread's sync-state row. */
  bystander?: {
    syncState?: CommentSyncStatus;
  };
  branchEligible?: boolean;
}) {
  const comments = options.comments ?? [comment(ROOT_ID)];
  const stored = options.storedOnThread ?? storedMetadata;
  const threadUpdate = vi.fn().mockResolvedValue({ id: THREAD_ID });
  const commentUpdate = vi.fn().mockResolvedValue({ id: ROOT_ID });
  // The list read reflects the writes, the way a real transaction would.
  let current: Record<string, unknown> = stored;
  let currentSyncState = options.syncState;
  const syncStateUpsert = vi
    .fn()
    .mockImplementation((args: { update: { state: CommentSyncStatus } }) => {
      currentSyncState = args.update.state;
      return { id: "sync-state-1" };
    });
  // The conditional moves: a row matches only when its state satisfies the
  // `where`, and `createMany` writes a row only while there is none.
  const syncStateUpdateMany = vi
    .fn()
    .mockImplementation(
      (args: {
        where: { state: CommentSyncStatus | { not: CommentSyncStatus } };
        data: { state: CommentSyncStatus };
      }) => {
        const wanted = args.where.state;
        const matches =
          currentSyncState !== undefined &&
          (typeof wanted === "string"
            ? currentSyncState === wanted
            : currentSyncState !== wanted.not);
        if (!matches) {
          return { count: 0 };
        }
        currentSyncState = args.data.state;
        return { count: 1 };
      }
    );
  const syncStateCreateMany = vi
    .fn()
    .mockImplementation((args: { data: { state: CommentSyncStatus } }) => {
      if (currentSyncState) {
        return { count: 0 };
      }
      currentSyncState = args.data.state;
      return { count: 1 };
    });
  const revisionBump = vi.fn();
  const syncStates = (state: CommentSyncStatus | undefined) =>
    state ? [{ state }] : [];

  // `$queryRaw` backs both the branch artifact lookup and
  // `branchHasCloudEligibility`; an empty result is how each spells "no".
  const queryRaw = vi
    .fn()
    .mockResolvedValue(
      options.branchEligible === false ? [] : [{ id: ARTIFACT_ID }]
    );

  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue({ artifactId: ARTIFACT_ID }),
      },
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue({ artifactId: ARTIFACT_ID }),
      },
      $queryRaw: queryRaw,
    })
  );

  const threadRow = {
    id: THREAD_ID,
    organizationId: "org-1",
    anchor: storedAnchor,
    artifactId: ARTIFACT_ID,
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    createdAt,
    updatedAt: createdAt,
    comments,
  };

  mockWithDb.tx.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback({
      commentThread: {
        findFirst: vi.fn().mockImplementation(() => ({
          ...threadRow,
          metadata: current,
          syncStates: syncStates(currentSyncState),
        })),
        findUnique: vi.fn().mockImplementation(() => ({ metadata: current })),
        update: vi
          .fn()
          .mockImplementation(
            (args: {
              data: { metadata?: Record<string, unknown>; revision?: unknown };
            }) => {
              // ISS-11212: a command also bumps the thread's revision, which
              // writes no metadata; the two are recorded apart.
              if (args.data.metadata !== undefined) {
                current = args.data.metadata;
                threadUpdate(args);
              }
              if (args.data.revision !== undefined) {
                revisionBump(args);
              }
              return { id: THREAD_ID };
            }
          ),
        findMany: vi.fn().mockImplementation(() => [
          {
            ...threadRow,
            metadata: current,
            syncStates: syncStates(currentSyncState),
          },
          // A SECOND, untouched thread on the same surface. Without it
          // "answers with the target's refreshed collection" is indistinguishable
          // from "answers with only the comment you retried" — which would blank
          // every other comment on the surface the moment anyone retried one.
          {
            ...threadRow,
            id: OTHER_THREAD_ID,
            metadata: storedMetadata,
            syncStates: syncStates(options.bystander?.syncState),
            comments: [comment(OTHER_ROOT_ID)],
          },
        ]),
      },
      commentSyncState: {
        upsert: syncStateUpsert,
        updateMany: syncStateUpdateMany,
        createMany: syncStateCreateMany,
      },
      comment: {
        findUnique: vi.fn().mockResolvedValue({ body: null }),
        update: commentUpdate,
      },
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue({ artifactId: ARTIFACT_ID }),
      },
      $queryRaw: queryRaw,
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: AUTHOR_ID,
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
            avatarUrl: null,
          },
        ]),
      },
    })
  );

  return {
    commentUpdate,
    revisionBump,
    syncStateCreateMany,
    syncStateUpdateMany,
    syncStateUpsert,
    threadUpdate,
  };
}

const DESKTOP_INBOUND = {
  threadId: THREAD_ID,
  provider: CommentSyncProvider.Desktop,
  direction: CommentSyncDirection.Inbound,
};

const RETRIED = { state: CommentSyncStatus.Pending, attempts: 0 };

/** A retry's move of an ABANDONED row to `PENDING`, its attempts reset. */
const syncStateRetry = {
  where: { ...DESKTOP_INBOUND, state: CommentSyncStatus.Abandoned },
  data: RETRIED,
};

/** The upsert of the thread's DESKTOP / INBOUND row to `state`. */
function syncStateWrite(state: CommentSyncStatus) {
  const data = { state };
  return {
    where: {
      threadId_provider_direction: {
        threadId: THREAD_ID,
        provider: CommentSyncProvider.Desktop,
        direction: CommentSyncDirection.Inbound,
      },
    },
    create: {
      organizationId: "org-1",
      threadId: THREAD_ID,
      provider: CommentSyncProvider.Desktop,
      direction: CommentSyncDirection.Inbound,
      ...data,
    },
    update: data,
    select: { id: true },
  };
}

const input = {
  organizationId: "org-1",
  userId: AUTHOR_ID,
  target,
  commentId: ROOT_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("traceCommentsService.markSyncAbandoned (ISS-10382, AC1)", () => {
  it("makes the comment representable as abandoned through the API", async () => {
    const { syncStateCreateMany, syncStateUpsert, threadUpdate } = mockThread(
      {}
    );

    const result = await traceCommentsService.markSyncAbandoned(input);

    expect(result.ok).toBe(true);
    // ISS-11212: the marker is the thread's sync-state row, not a metadata key.
    expect(syncStateCreateMany).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        ...DESKTOP_INBOUND,
        state: CommentSyncStatus.Abandoned,
      },
      skipDuplicates: true,
    });
    expect(syncStateUpsert).not.toHaveBeenCalled();
    expect(threadUpdate).not.toHaveBeenCalled();
    // ...and the SERVED comment carries it, which is what a shell reads.
    expect(result.ok && result.value[0]?.syncAbandoned).toBe(true);
  });

  it("leaves an already ABANDONED comment's revision alone when it is re-reported", async () => {
    const { revisionBump } = mockThread({
      syncState: CommentSyncStatus.Abandoned,
    });

    const result = await traceCommentsService.markSyncAbandoned(input);

    expect(result.ok && result.value[0]?.syncAbandoned).toBe(true);
    expect(revisionBump).not.toHaveBeenCalled();
  });

  it("does not disturb the comment's body or edit stamp", async () => {
    // The marker is a delivery fact, not an edit. The desktop retry deliberately
    // leaves `updated_at` alone for the same reason.
    mockThread({});

    const result = await traceCommentsService.markSyncAbandoned(input);

    expect(result.ok && result.value[0]?.body).toBe("Root note");
    expect(result.ok && result.value[0]?.editedAt).toBeNull();
  });
});

describe("traceCommentsService.retrySync (ISS-10382, AC2/AC3)", () => {
  it("re-pends the dead letter: ABANDONED becomes PENDING with its attempts reset", async () => {
    const { revisionBump, syncStateUpdateMany, syncStateUpsert } = mockThread({
      syncState: CommentSyncStatus.Abandoned,
    });

    const result = await traceCommentsService.retrySync(input);

    expect(result.ok).toBe(true);
    expect(syncStateUpdateMany).toHaveBeenCalledTimes(1);
    expect(syncStateUpdateMany).toHaveBeenCalledWith(syncStateRetry);
    expect(syncStateUpsert).not.toHaveBeenCalled();
    expect(revisionBump).toHaveBeenCalledTimes(1);
    expect(result.ok && "syncAbandoned" in (result.value[0] ?? {})).toBe(false);
  });

  it("returns the refreshed collection so the rail can re-render from one round trip", async () => {
    mockThread({
      comments: [comment(ROOT_ID), comment(REPLY_ID)],
      syncState: CommentSyncStatus.Abandoned,
    });

    const result = await traceCommentsService.retrySync(input);

    if (!result.ok) {
      throw new Error("expected retrySync to succeed");
    }
    // The WHOLE surface comes back, not just the row that was retried.
    expect(result.value.map((entry) => entry.id)).toEqual([
      ROOT_ID,
      OTHER_ROOT_ID,
    ]);
    // ...and only the retried row lost its marker; the bystander is untouched.
    expect(result.value[0]?.syncAbandoned).toBeUndefined();
    expect(result.value[1]?.syncAbandoned).toBeUndefined();
    // The replies ride along on the refreshed root, never dropped by the retry.
    expect(result.value[0]?.replies?.map((reply) => reply.id)).toEqual([
      REPLY_ID,
    ]);
  });

  it("is a successful no-op on a row that was never dead-lettered", async () => {
    const {
      revisionBump,
      syncStateCreateMany,
      syncStateUpdateMany,
      syncStateUpsert,
      threadUpdate,
    } = mockThread({});

    const result = await traceCommentsService.retrySync(input);

    expect(result.ok).toBe(true);
    // Nothing is dead-lettered, so there is nothing to re-pend.
    expect(syncStateUpsert).not.toHaveBeenCalled();
    expect(syncStateUpdateMany).not.toHaveBeenCalled();
    expect(syncStateCreateMany).not.toHaveBeenCalled();
    // The metadata bytes are not rewritten.
    expect(threadUpdate).not.toHaveBeenCalled();
    // ...and the thread did not change, so its revision does not move.
    expect(revisionBump).not.toHaveBeenCalled();
  });
});

describe("a bystander's dead letter is read from its sync-state row (ISS-11212)", () => {
  it("reports a comment whose marker lives in the table", async () => {
    mockThread({
      bystander: { syncState: CommentSyncStatus.Abandoned },
    });

    const result = await traceCommentsService.retrySync(input);

    expect(result.ok && result.value[1]?.syncAbandoned).toBe(true);
  });
});

describe("a branch answer clears the same bar its GET does", () => {
  it("refuses a branch that is not cloud-eligible instead of serving its collection", async () => {
    // The response IS the collection, so a POST that skipped the eligibility
    // gate would hand back every comment on a surface whose GET 404s.
    const { syncStateUpsert, threadUpdate } = mockThread({
      branchEligible: false,
      storedOnThread: branchMetadata,
    });

    await expect(
      traceCommentsService.retrySync({
        ...input,
        target: { type: CommentTargetType.Branch, id: ARTIFACT_ID },
      })
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    // AND nothing was written. `withDb.tx` is `db.$transaction`, which commits a
    // callback that RETURNS — only a throw unwinds it — so a gate that ran after
    // the write would leave the marker persisted on a thread whose surface the
    // same response says does not exist.
    expect(syncStateUpsert).not.toHaveBeenCalled();
    expect(threadUpdate).not.toHaveBeenCalled();
  });

  it("still answers for an eligible branch", async () => {
    // The positive control: without it the arm above is satisfied by a branch
    // path that is simply broken.
    mockThread({ branchEligible: true, storedOnThread: branchMetadata });

    const result = await traceCommentsService.retrySync({
      ...input,
      target: { type: CommentTargetType.Branch, id: ARTIFACT_ID },
    });

    expect(result.ok).toBe(true);
  });
});

describe("the recovery door belongs to the author, and to the root", () => {
  it("refuses a viewer who did not write the comment", async () => {
    // A reader who can SEE a thread must not be able to clear somebody else's
    // terminal state, nor dead-letter their comment.
    mockThread({ comments: [comment(ROOT_ID, "someone-else")] });

    await expect(traceCommentsService.retrySync(input)).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    await expect(
      traceCommentsService.markSyncAbandoned(input)
    ).resolves.toEqual({ ok: false, reason: "forbidden" });
  });

  it("refuses a REPLY id rather than silently answering 200 to a no-op", async () => {
    // The item budget is charged per root row and no reply ever carries a dead
    // letter, so a reply id is not_found — not a success whose retry did nothing.
    const { syncStateUpsert, threadUpdate } = mockThread({
      comments: [comment(ROOT_ID), comment(REPLY_ID)],
    });

    await expect(
      traceCommentsService.retrySync({ ...input, commentId: REPLY_ID })
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(syncStateUpsert).not.toHaveBeenCalled();
    expect(threadUpdate).not.toHaveBeenCalled();
  });
});

describe("a successful edit retires the marker it made stale", () => {
  it("clears the dead letter when the author's next update lands", async () => {
    // The marker is a fact about the LAST delivery attempt. An update that
    // reached the cloud is evidence that fact is stale, so the badge must not go
    // on asserting a failure until someone clicks Retry on a comment with
    // nothing left to retry.
    const { commentUpdate, syncStateUpsert } = mockThread({
      syncState: CommentSyncStatus.Abandoned,
    });

    const result = await traceCommentsService.update({
      ...input,
      update: { body: "Edited after the dead letter" },
    });

    expect(result.ok).toBe(true);
    expect(commentUpdate).toHaveBeenCalledTimes(1);
    // The wire row first, because that is what the badge reads.
    expect(result.ok && result.value.syncAbandoned).toBeUndefined();
    expect(syncStateUpsert).toHaveBeenCalledWith(
      syncStateWrite(CommentSyncStatus.Synced)
    );
  });

  it("settles a retried (PENDING) row SYNCED when its redelivered root edit lands", async () => {
    const { syncStateUpsert } = mockThread({
      syncState: CommentSyncStatus.Pending,
    });

    const result = await traceCommentsService.update({
      ...input,
      update: { body: "Redelivered after Retry" },
    });

    expect(result.ok).toBe(true);
    expect(syncStateUpsert).toHaveBeenCalledWith(
      syncStateWrite(CommentSyncStatus.Synced)
    );
  });

  it("writes nothing for an edit of an already SYNCED row", async () => {
    const { syncStateUpsert } = mockThread({
      syncState: CommentSyncStatus.Synced,
    });

    const result = await traceCommentsService.update({
      ...input,
      update: { body: "An ordinary edit" },
    });

    expect(result.ok).toBe(true);
    expect(syncStateUpsert).not.toHaveBeenCalled();
  });

  it("leaves an ordinary edit's sync state and metadata untouched", async () => {
    // Conditional on the marker actually being set: an edit of a row that never
    // dead-lettered has no reason to write either.
    const { commentUpdate, syncStateUpsert, threadUpdate } = mockThread({});

    const result = await traceCommentsService.update({
      ...input,
      update: { body: "An ordinary edit" },
    });

    expect(result.ok).toBe(true);
    expect(commentUpdate).toHaveBeenCalledTimes(1);
    expect(syncStateUpsert).not.toHaveBeenCalled();
    expect(threadUpdate).not.toHaveBeenCalled();
  });

  it("does not clear the root's marker when a REPLY is edited", async () => {
    // The budget is charged per ROOT row, so a reply's edit is no evidence at all
    // about the root's delivery.
    const { syncStateUpsert, threadUpdate } = mockThread({
      comments: [comment(ROOT_ID), comment(REPLY_ID)],
      syncState: CommentSyncStatus.Abandoned,
    });

    const result = await traceCommentsService.update({
      ...input,
      commentId: REPLY_ID,
      update: { body: "Edited reply" },
    });

    expect(result.ok).toBe(true);
    expect(syncStateUpsert).not.toHaveBeenCalled();
    expect(threadUpdate).not.toHaveBeenCalled();
  });
});
