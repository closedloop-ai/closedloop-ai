/**
 * Unit tests for the FEA-3950 / FEA-4092 permission-guarded document-thread
 * mutations on commentsService: replyToDocumentThread (anyone with view access,
 * flat reply), resolveDocumentThread (PARTICIPANT-resolve — author OR any comment
 * author on the thread, enforced server-side), and reopenDocumentThreadAsAuthor
 * (author-only reopen). All DB and Liveblocks calls are mocked.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const {
  mockReplyToArtifactThread,
  mockMarkArtifactThreadResolved,
  mockMarkArtifactThreadUnresolved,
  mockDeleteArtifactComment,
} = vi.hoisted(() => ({
  mockReplyToArtifactThread: vi.fn(),
  mockMarkArtifactThreadResolved: vi.fn(),
  mockMarkArtifactThreadUnresolved: vi.fn(),
  mockDeleteArtifactComment: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const withDbFn = vi.fn();
  return {
    Prisma: { JsonNull: null },
    withDb: Object.assign(withDbFn, { tx: vi.fn() }),
  };
});

vi.mock("@repo/collaboration/server/room-management", () => ({
  createArtifactLevelThread: vi.fn(),
  createArtifactThread: vi.fn(),
  deleteArtifactThread: vi.fn(),
  deleteArtifactComment: mockDeleteArtifactComment,
  replyToArtifactThread: mockReplyToArtifactThread,
  markArtifactThreadResolved: mockMarkArtifactThreadResolved,
  markArtifactThreadUnresolved: mockMarkArtifactThreadUnresolved,
}));

import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { Status } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { commentsService } from "../service";

const mockWithDb = withDb as unknown as Mock;
const ORG = "org-1";
const ARTIFACT = "artifact-uuid";
const AUTHOR = "author-user";
const REPLIER = "replier-user";
const OTHER = "other-user";
const THREAD_EXTERNAL_ID = "th_live_1";

type ThreadRow = {
  externalId: string | null;
  roomId: string | null;
  artifactId: string | null;
  source: ThreadSource;
  createdById: string | null;
  comments: { authorId: string }[];
};

/**
 * Drive the `withDb((db) => db.commentThread.findUnique(...))` lookup in
 * `findDocumentThreadForMutation` to return `row` (or null for a miss). Also
 * stubs `db.artifact.findUnique` so the read-after-write provider fallback that
 * fires on a miss resolves deterministically: by default the artifact has no
 * slug, so `syncDocumentThreadFromProvider` bails (returns false) without
 * touching Liveblocks, and the mutation surfaces its own not_found.
 */
function stubThreadLookup(row: ThreadRow | null) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const artifactFindUnique = vi.fn().mockResolvedValue(null);
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      commentThread: { findUnique },
      artifact: { findUnique: artifactFindUnique },
    })
  );
  return findUnique;
}

function makeThreadRow(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    externalId: THREAD_EXTERNAL_ID,
    roomId: "room-1",
    artifactId: ARTIFACT,
    source: ThreadSource.Liveblocks,
    createdById: AUTHOR,
    comments: [{ authorId: AUTHOR }],
    ...overrides,
  };
}

describe("commentsService.replyToDocumentThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockReset();
  });

  it("creates a flat reply in Liveblocks and projects it (anyone with view access)", async () => {
    stubThreadLookup(makeThreadRow());
    mockReplyToArtifactThread.mockResolvedValue({ id: "cm_reply" });
    const upsertSpy = vi
      .spyOn(commentsService, "upsertCommentFromLiveblocks")
      .mockResolvedValue(null as never);

    // A non-author caller may still reply — comment permission is view-based.
    const result = await commentsService.replyToDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      OTHER,
      "A reply body"
    );

    expect(result).toEqual({
      ok: true,
      value: { threadId: THREAD_EXTERNAL_ID, commentId: "cm_reply" },
    });
    expect(mockReplyToArtifactThread).toHaveBeenCalledWith({
      roomId: "room-1",
      threadId: THREAD_EXTERNAL_ID,
      userId: OTHER,
      bodyText: "A reply body",
    });
    expect(upsertSpy).toHaveBeenCalledWith(ORG, THREAD_EXTERNAL_ID, {
      id: "cm_reply",
    });
    upsertSpy.mockRestore();
  });

  it("returns not_found and never touches Liveblocks when the thread is on another artifact (cross-doc)", async () => {
    stubThreadLookup(makeThreadRow({ artifactId: "different-artifact" }));

    const result = await commentsService.replyToDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      AUTHOR,
      "body"
    );

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mockReplyToArtifactThread).not.toHaveBeenCalled();
  });

  it("returns not_found for a non-Liveblocks (native) thread id", async () => {
    stubThreadLookup(makeThreadRow({ source: ThreadSource.Native }));

    const result = await commentsService.replyToDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      AUTHOR,
      "body"
    );

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mockReplyToArtifactThread).not.toHaveBeenCalled();
  });

  it("compensates the Liveblocks reply when the DB projection fails (no duplicate on retry)", async () => {
    stubThreadLookup(makeThreadRow());
    mockReplyToArtifactThread.mockResolvedValue({ id: "cm_reply" });
    mockDeleteArtifactComment.mockResolvedValue(undefined);
    const projectionError = new Error("projection boom");
    const upsertSpy = vi
      .spyOn(commentsService, "upsertCommentFromLiveblocks")
      .mockRejectedValue(projectionError);

    await expect(
      commentsService.replyToDocumentThread(
        ORG,
        ARTIFACT,
        THREAD_EXTERNAL_ID,
        AUTHOR,
        "A reply body"
      )
    ).rejects.toThrow("projection boom");

    // The just-created reply comment is deleted at Liveblocks so a client retry
    // cannot leave a duplicate visible reply.
    expect(mockDeleteArtifactComment).toHaveBeenCalledWith({
      roomId: "room-1",
      threadId: THREAD_EXTERNAL_ID,
      commentId: "cm_reply",
    });
    upsertSpy.mockRestore();
  });

  it("syncs from the provider and retries when the DB projection has not landed yet (read-after-write)", async () => {
    // First lookup misses (webhook projection not landed), sync succeeds, second
    // lookup returns the freshly projected row so the reply proceeds.
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeThreadRow());
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({
        commentThread: { findUnique },
        artifact: { findUnique: vi.fn() },
      })
    );
    const syncSpy = vi
      .spyOn(commentsService, "syncDocumentThreadFromProvider")
      .mockResolvedValue(true);
    mockReplyToArtifactThread.mockResolvedValue({ id: "cm_reply" });
    const upsertSpy = vi
      .spyOn(commentsService, "upsertCommentFromLiveblocks")
      .mockResolvedValue(null as never);

    const result = await commentsService.replyToDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      AUTHOR,
      "A reply body"
    );

    expect(syncSpy).toHaveBeenCalledWith(ORG, ARTIFACT, THREAD_EXTERNAL_ID);
    expect(result).toEqual({
      ok: true,
      value: { threadId: THREAD_EXTERNAL_ID, commentId: "cm_reply" },
    });
    syncSpy.mockRestore();
    upsertSpy.mockRestore();
  });

  it("returns not_found when the provider sync also finds nothing (genuine miss)", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({
        commentThread: { findUnique },
        artifact: { findUnique: vi.fn() },
      })
    );
    const syncSpy = vi
      .spyOn(commentsService, "syncDocumentThreadFromProvider")
      .mockResolvedValue(false);

    const result = await commentsService.replyToDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      AUTHOR,
      "A reply body"
    );

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mockReplyToArtifactThread).not.toHaveBeenCalled();
    syncSpy.mockRestore();
  });
});

describe("commentsService.resolveDocumentThread (participant-resolve)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockReset();
  });

  it("resolves in Liveblocks and projects when the caller authored the thread", async () => {
    stubThreadLookup(makeThreadRow({ createdById: AUTHOR }));
    mockMarkArtifactThreadResolved.mockResolvedValue({
      id: THREAD_EXTERNAL_ID,
    });
    const resolveSpy = vi
      .spyOn(commentsService, "resolveThread")
      .mockResolvedValue({
        kind: "transition",
        thread: {
          id: "db-1",
          status: ThreadStatus.Resolved,
          resolvedAt: new Date(),
          resolvedById: AUTHOR,
          metadata: null,
        },
      });

    const result = await commentsService.resolveDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      AUTHOR,
      new Date("2026-07-24T00:00:00.000Z")
    );

    expect(result).toEqual({
      ok: true,
      value: { status: ThreadStatus.Resolved },
    });
    expect(mockMarkArtifactThreadResolved).toHaveBeenCalledWith({
      roomId: "room-1",
      threadId: THREAD_EXTERNAL_ID,
      userId: AUTHOR,
    });
    expect(resolveSpy).toHaveBeenCalledWith(
      ORG,
      THREAD_EXTERNAL_ID,
      expect.any(Date),
      { resolvedById: AUTHOR }
    );
    resolveSpy.mockRestore();
  });

  it("resolves when a non-author participant (replier) resolves (FEA-4092)", async () => {
    // The author created the thread; REPLIER authored a later comment, so it is
    // a participant and may resolve even though it did not create the thread.
    stubThreadLookup(
      makeThreadRow({
        createdById: AUTHOR,
        comments: [{ authorId: AUTHOR }, { authorId: REPLIER }],
      })
    );
    mockMarkArtifactThreadResolved.mockResolvedValue({
      id: THREAD_EXTERNAL_ID,
    });
    const resolveSpy = vi
      .spyOn(commentsService, "resolveThread")
      .mockResolvedValue({
        kind: "transition",
        thread: {
          id: "db-1",
          status: ThreadStatus.Resolved,
          resolvedAt: new Date(),
          resolvedById: REPLIER,
          metadata: null,
        },
      });

    const result = await commentsService.resolveDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      REPLIER,
      new Date()
    );

    expect(result).toEqual({
      ok: true,
      value: { status: ThreadStatus.Resolved },
    });
    expect(mockMarkArtifactThreadResolved).toHaveBeenCalledWith({
      roomId: "room-1",
      threadId: THREAD_EXTERNAL_ID,
      userId: REPLIER,
    });
    expect(resolveSpy).toHaveBeenCalledWith(
      ORG,
      THREAD_EXTERNAL_ID,
      expect.any(Date),
      { resolvedById: REPLIER }
    );
    resolveSpy.mockRestore();
  });

  it("returns forbidden and never touches Liveblocks when a non-participant resolves", async () => {
    // OTHER neither created the thread nor authored any comment on it.
    stubThreadLookup(
      makeThreadRow({
        createdById: AUTHOR,
        comments: [{ authorId: AUTHOR }, { authorId: REPLIER }],
      })
    );
    const resolveSpy = vi.spyOn(commentsService, "resolveThread");

    const result = await commentsService.resolveDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      OTHER,
      new Date()
    );

    expect(result).toEqual({ ok: false, error: Status.Forbidden });
    expect(mockMarkArtifactThreadResolved).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
    resolveSpy.mockRestore();
  });

  it("re-syncs from the provider and permits a participant whose reply is only at Liveblocks (FEA-4092 projection-lag)", async () => {
    // First lookup finds the row but its DB projection is stale (only AUTHOR's
    // comment). REPLIER is not yet a projected participant, so the first guard
    // fails; the provider re-sync backfills REPLIER's comment, and the second
    // read permits the resolve instead of 403ing a real participant.
    const staleRow = makeThreadRow({
      createdById: AUTHOR,
      comments: [{ authorId: AUTHOR }],
    });
    const freshRow = makeThreadRow({
      createdById: AUTHOR,
      comments: [{ authorId: AUTHOR }, { authorId: REPLIER }],
    });
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(staleRow)
      .mockResolvedValueOnce(freshRow);
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({
        commentThread: { findUnique },
        artifact: { findUnique: vi.fn() },
      })
    );
    const syncSpy = vi
      .spyOn(commentsService, "syncDocumentThreadFromProvider")
      .mockResolvedValue(true);
    mockMarkArtifactThreadResolved.mockResolvedValue({
      id: THREAD_EXTERNAL_ID,
    });
    const resolveSpy = vi
      .spyOn(commentsService, "resolveThread")
      .mockResolvedValue({
        kind: "transition",
        thread: {
          id: "db-1",
          status: ThreadStatus.Resolved,
          resolvedAt: new Date(),
          resolvedById: REPLIER,
          metadata: null,
        },
      });

    const result = await commentsService.resolveDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      REPLIER,
      new Date()
    );

    expect(syncSpy).toHaveBeenCalledWith(ORG, ARTIFACT, THREAD_EXTERNAL_ID);
    expect(result).toEqual({
      ok: true,
      value: { status: ThreadStatus.Resolved },
    });
    expect(mockMarkArtifactThreadResolved).toHaveBeenCalled();
    syncSpy.mockRestore();
    resolveSpy.mockRestore();
  });

  it("still 403s a non-participant after a provider re-sync yields no new participant", async () => {
    // The row exists but OTHER never commented; the re-sync backfills nothing
    // relevant, so the guard still fails closed.
    const row = makeThreadRow({
      createdById: AUTHOR,
      comments: [{ authorId: AUTHOR }],
    });
    const findUnique = vi.fn().mockResolvedValue(row);
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({
        commentThread: { findUnique },
        artifact: { findUnique: vi.fn() },
      })
    );
    const syncSpy = vi
      .spyOn(commentsService, "syncDocumentThreadFromProvider")
      .mockResolvedValue(true);
    const resolveSpy = vi.spyOn(commentsService, "resolveThread");

    const result = await commentsService.resolveDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      OTHER,
      new Date()
    );

    expect(syncSpy).toHaveBeenCalledWith(ORG, ARTIFACT, THREAD_EXTERNAL_ID);
    expect(result).toEqual({ ok: false, error: Status.Forbidden });
    expect(mockMarkArtifactThreadResolved).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
    syncSpy.mockRestore();
    resolveSpy.mockRestore();
  });

  it("falls back to the first comment's author (a participant) when createdById is unset", async () => {
    stubThreadLookup(
      makeThreadRow({ createdById: null, comments: [{ authorId: AUTHOR }] })
    );
    mockMarkArtifactThreadResolved.mockResolvedValue({
      id: THREAD_EXTERNAL_ID,
    });
    const resolveSpy = vi
      .spyOn(commentsService, "resolveThread")
      .mockResolvedValue({
        kind: "transition",
        thread: {
          id: "db-1",
          status: ThreadStatus.Resolved,
          resolvedAt: new Date(),
          resolvedById: AUTHOR,
          metadata: null,
        },
      });

    const result = await commentsService.resolveDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      AUTHOR,
      new Date()
    );

    expect(result).toEqual({
      ok: true,
      value: { status: ThreadStatus.Resolved },
    });
    resolveSpy.mockRestore();
  });

  it("fails closed (forbidden) when no participant can be determined", async () => {
    stubThreadLookup(makeThreadRow({ createdById: null, comments: [] }));
    const resolveSpy = vi.spyOn(commentsService, "resolveThread");

    const result = await commentsService.resolveDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      AUTHOR,
      new Date()
    );

    expect(result).toEqual({ ok: false, error: Status.Forbidden });
    expect(mockMarkArtifactThreadResolved).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
    resolveSpy.mockRestore();
  });

  it("returns not_found for a thread the caller's org cannot see (two-org isolation)", async () => {
    // findUnique keyed on (organizationId, externalId) returns null for org B.
    stubThreadLookup(null);

    const result = await commentsService.resolveDocumentThread(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      AUTHOR,
      new Date()
    );

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mockMarkArtifactThreadResolved).not.toHaveBeenCalled();
  });
});

describe("commentsService.reopenDocumentThreadAsAuthor (author-only reopen)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockReset();
  });

  it("reopens in Liveblocks and projects when the caller authored the thread", async () => {
    stubThreadLookup(makeThreadRow({ createdById: AUTHOR }));
    mockMarkArtifactThreadUnresolved.mockResolvedValue({
      id: THREAD_EXTERNAL_ID,
    });
    const unresolveSpy = vi
      .spyOn(commentsService, "unresolveThread")
      .mockResolvedValue({
        kind: "transition",
        thread: {
          id: "db-1",
          status: ThreadStatus.Open,
          resolvedAt: null,
          resolvedById: null,
          metadata: null,
        },
      });

    const result = await commentsService.reopenDocumentThreadAsAuthor(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      AUTHOR
    );

    expect(result).toEqual({ ok: true, value: { status: ThreadStatus.Open } });
    expect(mockMarkArtifactThreadUnresolved).toHaveBeenCalledWith({
      roomId: "room-1",
      threadId: THREAD_EXTERNAL_ID,
      userId: AUTHOR,
    });
    unresolveSpy.mockRestore();
  });

  it("returns forbidden when a non-author (non-participant) reopens", async () => {
    stubThreadLookup(makeThreadRow({ createdById: AUTHOR }));
    const unresolveSpy = vi.spyOn(commentsService, "unresolveThread");

    const result = await commentsService.reopenDocumentThreadAsAuthor(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      OTHER
    );

    expect(result).toEqual({ ok: false, error: Status.Forbidden });
    expect(mockMarkArtifactThreadUnresolved).not.toHaveBeenCalled();
    expect(unresolveSpy).not.toHaveBeenCalled();
    unresolveSpy.mockRestore();
  });

  it("returns forbidden when a non-author PARTICIPANT (replier) reopens — reopen stays author-only (FEA-4092)", async () => {
    // REPLIER is a participant (authored a comment) and so MAY resolve, but reopen
    // is author-only: a non-author participant cannot reopen.
    stubThreadLookup(
      makeThreadRow({
        createdById: AUTHOR,
        comments: [{ authorId: AUTHOR }, { authorId: REPLIER }],
      })
    );
    const unresolveSpy = vi.spyOn(commentsService, "unresolveThread");

    const result = await commentsService.reopenDocumentThreadAsAuthor(
      ORG,
      ARTIFACT,
      THREAD_EXTERNAL_ID,
      REPLIER
    );

    expect(result).toEqual({ ok: false, error: Status.Forbidden });
    expect(mockMarkArtifactThreadUnresolved).not.toHaveBeenCalled();
    expect(unresolveSpy).not.toHaveBeenCalled();
    unresolveSpy.mockRestore();
  });
});
