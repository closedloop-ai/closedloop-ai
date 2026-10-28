import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
} from "@repo/api/src/types/artifact-activity-feed";
import { CommentSurface, CommentTargetType } from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  Prisma: { JsonNull: "JsonNull", DbNull: "DbNull" },
  LinkType: { PRODUCES: "PRODUCES" },
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { encodeTimeIdCursor } from "@/lib/time-id-cursor";
import {
  artifactActivityFeedService,
  isValidStoredEventCursor,
} from "../artifact-activity-feed-service";

const organizationId = "org-1";
const artifactId = "session-1";
const occurredAt = new Date("2026-10-03T17:00:00.000Z");

type StoredRow = {
  id: string;
  organizationId: string;
  artifactId: string;
  action: string;
  actorType: string;
  actorId: string | null;
  before: null;
  after: null;
  createdAt: Date;
};

function row(
  id: string,
  action: string,
  actorType: string,
  actorId: string | null,
  organization = organizationId
): StoredRow {
  return {
    id,
    organizationId: organization,
    artifactId,
    action,
    actorType,
    actorId,
    before: null,
    after: null,
    createdAt: occurredAt,
  };
}

function mockStoredRows(rows: readonly StoredRow[]) {
  const findMany = vi.fn(
    ({
      where,
      take,
    }: {
      where: {
        organizationId: string;
        artifactId: string;
        action?: string;
        actorType?: { in: string[] };
        AND?: Array<{
          OR?: Array<{
            createdAt: Date | { lt: Date };
            id?: { lt: string };
          }>;
        }>;
      };
      take: number;
    }) => {
      const cursorArms = where.AND?.[0]?.OR;
      const cursorTime = cursorArms?.[0]?.createdAt;
      const cursorId = cursorArms?.[1]?.id?.lt;
      return rows
        .filter((candidate) => {
          if (
            candidate.organizationId !== where.organizationId ||
            candidate.artifactId !== where.artifactId ||
            (where.action && where.action !== candidate.action) ||
            (where.actorType &&
              !where.actorType.in.includes(candidate.actorType))
          ) {
            return false;
          }
          if (!(cursorTime && cursorId && "lt" in cursorTime)) {
            return true;
          }
          return (
            candidate.createdAt < cursorTime.lt ||
            (candidate.createdAt.getTime() === cursorTime.lt.getTime() &&
              candidate.id < cursorId)
          );
        })
        .sort((a, b) => b.id.localeCompare(a.id))
        .slice(0, take);
    }
  );
  vi.mocked(withDb).mockImplementation(async (fn) =>
    fn({
      artifactActivityEvent: { findMany },
      // ISS-11004: the feed reads comment threads too, so the stub must offer
      // the table or every case fails on an undefined model rather than on its
      // own subject. Cases that care about comments install their own rows.
      commentThread: {
        findMany: vi.fn((query) => {
          lastCommentThreadQuery = query;
          // Prisma semantics: only a `comments` predicate excludes a thread
          // whose comments are all soft-deleted.
          return Promise.resolve(
            commentThreadRows.filter(
              (row) => !(query.where.comments && row.deleted)
            )
          );
        }),
      },
    } as never)
  );
  return findMany;
}

type CommentThreadRow = {
  deleted?: boolean;
  id: string;
  createdById: string | null;
  source: string;
  status: string;
  /** What a trace thread records its surface in; null for a non-trace thread. */
  metadata: unknown;
  createdAt: Date;
  comments: {
    authorId: string;
    githubProjection: {
      externalAuthor: { providerDetail: unknown } | null;
    } | null;
  }[];
};

/** The last comment-thread query the stub received. */
let lastCommentThreadQuery: unknown = null;

/** Comment threads the stubbed db returns; a case sets them when it cares. */
let commentThreadRows: CommentThreadRow[] = [];

function mockCommentThreads(rows: readonly CommentThreadRow[]) {
  commentThreadRows = [...rows];
}

function commentThread(
  id: string,
  createdById: string | null,
  createdAt = occurredAt,
  metadata: unknown = null
): CommentThreadRow {
  return {
    id,
    createdById,
    source: "NATIVE",
    status: "OPEN",
    metadata,
    createdAt,
    comments: [{ authorId: createdById ?? "author-1", githubProjection: null }],
  };
}

/** A GitHub-projected thread; GitHub never records `createdById`. */
function githubThread(
  id: string,
  authorId: string,
  actorType: string | undefined,
  createdAt = occurredAt
): CommentThreadRow {
  return {
    id,
    createdById: null,
    source: "GITHUB",
    status: "OPEN",
    metadata: null,
    createdAt,
    comments: [
      {
        authorId,
        githubProjection: {
          externalAuthor: {
            providerDetail: actorType === undefined ? null : { actorType },
          },
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  commentThreadRows = [];
  lastCommentThreadQuery = null;
});

describe("stored V1 edit activity feed", () => {
  it("keeps real actor kinds and excludes non-edit actions and other organizations", async () => {
    const findMany = mockStoredRows([
      row(
        "event-3",
        ArtifactActivityAction.FieldChange,
        ArtifactActivityActorType.User,
        "user-1"
      ),
      row(
        "event-2",
        ArtifactActivityAction.Assignment,
        ArtifactActivityActorType.Agent,
        "key-owner-1"
      ),
      row(
        "event-1",
        ArtifactActivityAction.StatusChange,
        ArtifactActivityActorType.System,
        null
      ),
      row(
        "retained",
        ArtifactActivityAction.MonitoredActivityRetained,
        ArtifactActivityActorType.System,
        null
      ),
      row(
        "other-org",
        ArtifactActivityAction.FieldChange,
        ArtifactActivityActorType.User,
        "user-2",
        "org-2"
      ),
    ]);

    const page = await artifactActivityFeedService.listStoredEventActivityFeed({
      organizationId,
      artifactId,
    });

    expect(page.items.map((item) => [item.id, item.actor])).toEqual([
      ["event:event-3", { kind: ActivityFeedActorKind.Human, id: "user-1" }],
      [
        "event:event-2",
        { kind: ActivityFeedActorKind.Agent, id: "key-owner-1" },
      ],
      ["event:event-1", { kind: ActivityFeedActorKind.System, id: null }],
    ]);
    expect(page.nextCursor).toBeNull();
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(
      findMany.mock.calls.map(([query]) => [
        query.where.action,
        query.where.actorType?.in,
      ])
    ).toEqual(
      [
        ArtifactActivityAction.StatusChange,
        ArtifactActivityAction.FieldChange,
        ArtifactActivityAction.Assignment,
      ].map((action) => [action, Object.values(ArtifactActivityActorType)])
    );
    expect(findMany.mock.calls.every(([query]) => query.take === 51)).toBe(
      true
    );
  });

  it("pages three same-time receipts with no skip or repeat", async () => {
    const ids = [
      "00000000-0000-7000-8000-000000000003",
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000001",
    ];
    mockStoredRows(
      ids.map((id, index) =>
        row(
          id,
          [
            ArtifactActivityAction.StatusChange,
            ArtifactActivityAction.FieldChange,
            ArtifactActivityAction.Assignment,
          ][index],
          ArtifactActivityActorType.User,
          "user-1"
        )
      )
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (const expectedId of ids) {
      const page =
        await artifactActivityFeedService.listStoredEventActivityFeed({
          organizationId,
          artifactId,
          cursor,
          limit: 1,
        });
      seen.push(...page.items.map((item) => item.id));
      expect(page.items.map((item) => item.id)).toEqual([
        `event:${expectedId}`,
      ]);
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(ids.map((id) => `event:${id}`));
    expect(cursor).toBeNull();
  });

  it("keeps a cursor when a host would hide an all-System page", async () => {
    const ids = [
      "00000000-0000-7000-8000-000000000003",
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000001",
    ];
    mockStoredRows([
      row(
        ids[0],
        ArtifactActivityAction.StatusChange,
        ArtifactActivityActorType.System,
        null
      ),
      row(
        ids[1],
        ArtifactActivityAction.StatusChange,
        ArtifactActivityActorType.System,
        null
      ),
      row(
        ids[2],
        ArtifactActivityAction.FieldChange,
        ArtifactActivityActorType.User,
        "user-1"
      ),
    ]);

    const first = await artifactActivityFeedService.listStoredEventActivityFeed(
      {
        organizationId,
        artifactId,
        limit: 2,
      }
    );
    expect(first.items.map((item) => item.actor.kind)).toEqual([
      ActivityFeedActorKind.System,
      ActivityFeedActorKind.System,
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second =
      await artifactActivityFeedService.listStoredEventActivityFeed({
        organizationId,
        artifactId,
        cursor: first.nextCursor,
        limit: 2,
      });
    expect(second.items.map((item) => item.actor.kind)).toEqual([
      ActivityFeedActorKind.Human,
    ]);
    expect(second.nextCursor).toBeNull();
  });

  /**
   * ISS-11004: comments are a feed source for every artifact type, so the
   * Session/Branch read returns them beside stored edits, newest first.
   */
  it("returns comment threads beside stored edits, newest first", async () => {
    const editedAt = new Date("2026-10-03T17:00:00.000Z");
    mockStoredRows([
      row(
        "00000000-0000-7000-8000-00000000000a",
        ArtifactActivityAction.FieldChange,
        ArtifactActivityActorType.User,
        "user-1"
      ),
    ]);
    mockCommentThreads([
      commentThread(
        "00000000-0000-7000-8000-0000000000bb",
        "user-2",
        new Date(editedAt.getTime() + 1000)
      ),
    ]);

    const page = await artifactActivityFeedService.listStoredEventActivityFeed({
      organizationId,
      artifactId,
    });

    expect(page.items.map((item) => item.source)).toEqual([
      ActivityFeedItemSource.Comment,
      ActivityFeedItemSource.Event,
    ]);
    const comment = page.items[0];
    expect(comment?.actor).toEqual({
      id: "user-2",
      kind: ActivityFeedActorKind.Human,
    });
    // The thread id is what a client needs to deep-link the comment. No
    // `surface` key at all on a thread that records none — omitted, never
    // null, so an older client reads it as absent (Cross-Repo Compatibility).
    expect(comment?.payload).toEqual({
      source: "NATIVE",
      status: "OPEN",
      threadId: "00000000-0000-7000-8000-0000000000bb",
    });
  });

  /**
   * ISS-10980: a Branch comment row sends the reader to the tab that holds the
   * comment, so the item has to say which surface the thread is on. Only
   * `metadata` records it.
   */
  it("carries the trace-comment surface a thread records", async () => {
    mockStoredRows([]);
    mockCommentThreads([
      commentThread(
        "00000000-0000-7000-8000-0000000000bb",
        "user-2",
        occurredAt,
        {
          kind: "trace_comment",
          schemaVersion: 1,
          surface: CommentSurface.BranchTimeline,
          targetType: CommentTargetType.Branch,
        }
      ),
    ]);

    const page = await artifactActivityFeedService.listStoredEventActivityFeed({
      organizationId,
      artifactId,
    });

    expect(page.items[0]?.payload).toEqual({
      source: "NATIVE",
      status: "OPEN",
      surface: CommentSurface.BranchTimeline,
      threadId: "00000000-0000-7000-8000-0000000000bb",
    });
  });

  /**
   * Metadata crosses no wire but it is a `Json` column, so a row can hold
   * anything. A shape the trace schema rejects states no surface rather than
   * leaking a half-parsed one.
   */
  it.each([
    ["metadata that is not trace metadata", { kind: "something_else" }],
    ["an unparseable surface", { kind: "trace_comment", surface: 7 }],
    ["a bare string", "nonsense"],
  ])("states no surface for %s", async (_label, metadata) => {
    mockStoredRows([]);
    mockCommentThreads([
      commentThread(
        "00000000-0000-7000-8000-0000000000bb",
        "user-2",
        occurredAt,
        metadata
      ),
    ]);

    const page = await artifactActivityFeedService.listStoredEventActivityFeed({
      organizationId,
      artifactId,
    });

    expect(page.items[0]?.payload).toEqual({
      source: "NATIVE",
      status: "OPEN",
      threadId: "00000000-0000-7000-8000-0000000000bb",
    });
  });

  it("projects a comment thread with no recorded author", async () => {
    mockStoredRows([]);
    mockCommentThreads([
      commentThread("00000000-0000-7000-8000-0000000000bb", null),
    ]);

    const page = await artifactActivityFeedService.listStoredEventActivityFeed({
      organizationId,
      artifactId,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.actor.id).toBeNull();
  });

  /**
   * Operator ruling on PR #8562 (2026-10-08): GitHub review threads stay in
   * Branch Activity, attributed to their GitHub author. Literal "Bot"/"User"
   * here: the stored actor type is GitHub's wire value, not ours.
   */
  it("attributes GitHub threads to their author, beside an unchanged native thread", async () => {
    mockStoredRows([]);
    const at = (minute: number) => new Date(`2026-10-03T17:0${minute}:00.000Z`);
    mockCommentThreads([
      githubThread(
        "00000000-0000-7000-8000-0000000000d3",
        "user-reviewer",
        "User",
        at(3)
      ),
      githubThread(
        "00000000-0000-7000-8000-0000000000d2",
        "user-bot",
        "Bot",
        at(2)
      ),
      commentThread(
        "00000000-0000-7000-8000-0000000000d1",
        "user-native",
        at(1)
      ),
      githubThread(
        "00000000-0000-7000-8000-0000000000d0",
        "user-unknown",
        undefined,
        at(0)
      ),
    ]);

    const page = await artifactActivityFeedService.listStoredEventActivityFeed({
      organizationId,
      artifactId,
    });

    expect(page.items.map((item) => item.actor)).toEqual([
      { kind: ActivityFeedActorKind.Human, id: "user-reviewer" },
      { kind: ActivityFeedActorKind.Agent, id: "user-bot" },
      { kind: ActivityFeedActorKind.Human, id: "user-native" },
      { kind: ActivityFeedActorKind.Human, id: null },
    ]);
  });

  it("reads the GitHub author's actor type in the caller's organization only", async () => {
    mockStoredRows([]);

    await artifactActivityFeedService.listStoredEventActivityFeed({
      organizationId,
      artifactId,
    });

    expect(lastCommentThreadQuery).toMatchObject({
      select: {
        comments: {
          where: { deletedAt: null },
          take: 1,
          select: {
            githubProjection: {
              select: { externalAuthor: { where: { organizationId } } },
            },
          },
        },
      },
    });
  });

  it("omits a thread whose comments were all soft-deleted", async () => {
    mockStoredRows([]);
    mockCommentThreads([
      {
        ...commentThread("00000000-0000-7000-8000-0000000000cc", "user-1"),
        deleted: true,
      },
      commentThread("00000000-0000-7000-8000-0000000000bb", "user-1"),
    ]);

    const page = await artifactActivityFeedService.listStoredEventActivityFeed({
      organizationId,
      artifactId,
    });

    expect(page.items.map((item) => item.id)).toEqual([
      "comment:00000000-0000-7000-8000-0000000000bb",
    ]);
  });

  it("accepts only canonical event cursors with a persisted UUID", () => {
    const id = "00000000-0000-7000-8000-000000000001";
    const valid = encodeTimeIdCursor(occurredAt.getTime(), `event:${id}`);
    expect(isValidStoredEventCursor(valid)).toBe(true);
    expect(
      isValidStoredEventCursor(
        encodeTimeIdCursor(occurredAt.getTime(), `version:${id}`)
      )
    ).toBe(false);
    expect(
      isValidStoredEventCursor(
        encodeTimeIdCursor(occurredAt.getTime(), "event:invalid")
      )
    ).toBe(false);
    expect(
      isValidStoredEventCursor(
        Buffer.from(`0${occurredAt.getTime()}:event:${id}`).toString(
          "base64url"
        )
      )
    ).toBe(false);
    expect(isValidStoredEventCursor("")).toBe(false);
  });

  /**
   * ISS-11004: a page whose last item is a comment mints a `comment:` cursor,
   * so the route's validator has to admit it — rejecting it would make Load
   * more fail exactly when the boundary row is a comment. `version:` stays
   * rejected: it is not a source this read has.
   */
  it("accepts a comment cursor, the other source this read can mint", () => {
    const id = "00000000-0000-7000-8000-0000000000bb";
    expect(
      isValidStoredEventCursor(
        encodeTimeIdCursor(occurredAt.getTime(), `comment:${id}`)
      )
    ).toBe(true);
    expect(
      isValidStoredEventCursor(
        encodeTimeIdCursor(occurredAt.getTime(), "comment:invalid")
      )
    ).toBe(false);
  });

  it("skips a newer stored actor without failing the page or claiming a human", async () => {
    mockStoredRows([
      row(
        "00000000-0000-7000-8000-000000000002",
        ArtifactActivityAction.FieldChange,
        "newer_actor_type",
        "not-a-known-person"
      ),
      row(
        "00000000-0000-7000-8000-000000000001",
        ArtifactActivityAction.FieldChange,
        ArtifactActivityActorType.User,
        "user-1"
      ),
    ]);

    const page = await artifactActivityFeedService.listStoredEventActivityFeed({
      organizationId,
      artifactId,
      limit: 1,
    });
    expect(page.items.map((item) => item.actor)).toEqual([
      { kind: ActivityFeedActorKind.Human, id: "user-1" },
    ]);
    expect(page.nextCursor).toBeNull();
  });
});
