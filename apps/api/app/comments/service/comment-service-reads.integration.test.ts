/**
 * ISS-11212 (PLN-2121 Step 3): the unified reads and the internal reanchor
 * command against a real database: one thread by id, the list's surface and
 * status filters, an artifact type no source serves, and stored anchors the
 * DTO cannot or need not read.
 */
import {
  CommentSurface,
  CommentTargetType,
  ThreadSource,
  ThreadStatus,
  TRACE_COMMENT_METADATA_KIND,
  TRACE_COMMENT_SCHEMA_VERSION,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import {
  COMMENT_ANCHOR_SCHEMA_VERSION,
  CommentAnchorState,
} from "@repo/api/src/types/comment-anchor";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  artifactCommentsResponseSchema,
  CommentBodyFormat,
  type CommentThreadDto,
  commentThreadDtoSchema,
} from "@repo/api/src/types/comment-thread-dto";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
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

vi.mock("@/app/comments/comment-data-invalid", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/app/comments/comment-data-invalid")
    >();
  return { ...actual, reportCommentDataInvalid: vi.fn() };
});

import {
  type CommentTestOrg,
  commentTraceAnchor,
  seedCommentTestOrg,
} from "@/__tests__/support/comments/comment-service.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import {
  CommentDataInvalidReason,
  reportCommentDataInvalid,
} from "@/app/comments/comment-data-invalid";
import { commentsService } from "@/app/comments/service";
import { createCommentLiveState } from "./comment-capabilities";
import { presentCommentThreadDto } from "./comment-read";
import { resolveCommentTarget } from "./comment-target";
import { resetReportedTraceAnchorFailures } from "./trace-comment-anchor-json";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();
let row = 0;

describeIfDb("comment service: reads and reanchor", () => {
  let org: CommentTestOrg;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
  });

  beforeEach(() => {
    resetReportedTraceAnchorFailures();
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  async function openThread(): Promise<CommentThreadDto> {
    row += 1;
    const result = await commentsService.createThread({
      viewer: org.author,
      target: org.session,
      anchor: commentTraceAnchor(row),
      body: `root ${row}`,
      clientId: null,
      present: presentCommentThreadDto({
        viewer: org.author,
        target: org.session,
        liveState: createCommentLiveState(org.author),
      }),
    });
    if (!result.ok) {
      throw new Error(`seed thread failed: ${result.error}`);
    }
    return result.value;
  }

  function storeThread(anchor: Prisma.InputJsonObject | null): Promise<string> {
    return withDb(async (db) => {
      const thread = await db.commentThread.create({
        data: {
          organizationId: org.organizationId,
          artifactId: org.session.artifactId,
          source: ThreadSource.Native,
          metadata: {
            kind: TRACE_COMMENT_METADATA_KIND,
            schemaVersion: TRACE_COMMENT_SCHEMA_VERSION,
            targetType: CommentTargetType.Session,
            surface: CommentSurface.SessionDetail,
          },
          ...(anchor === null ? {} : { anchor }),
          createdById: org.author.userId,
          comments: {
            create: {
              authorId: org.author.userId,
              body: {},
              bodyFormat: CommentBodyFormat.RichV1,
              plainText: "stored",
            },
          },
        },
        select: { id: true },
      });
      return thread.id;
    });
  }

  async function listIds(filters: {
    surface?: CommentSurface;
    status?: ThreadStatus;
  }): Promise<string[]> {
    const result = await commentsService.listArtifactComments({
      viewer: org.author,
      artifactId: org.session.artifactId,
      ...filters,
    });
    return result.ok ? result.value.threads.map((thread) => thread.id) : [];
  }

  it("reads one thread by id with the viewer's own permissions", async () => {
    const thread = await openThread();

    const asAuthor = await commentsService.getThread({
      viewer: org.author,
      threadId: thread.id,
    });
    const asOther = await commentsService.getThread({
      viewer: org.other,
      threadId: thread.id,
    });

    expect(asAuthor).toEqual({ ok: true, value: thread });
    expect(asOther.ok && asOther.value.permissions.canEdit).toBe(false);
    expect(asOther.ok && asOther.value.comments[0]?.body).toBe(
      thread.comments[0]?.body
    );
  });

  it("maps reactions, and leaves out an attachment whose upload is pending or that has nothing to download (PLN-2187 T-2.1)", async () => {
    const thread = await openThread();
    const commentId = thread.comments[0]?.id as string;
    await withDb(async (db) => {
      await db.commentReaction.createMany({
        data: [
          {
            commentId,
            userId: org.other.userId,
            emoji: "+1",
            createdAt: new Date("2026-10-01T00:00:01.000Z"),
          },
          {
            commentId,
            userId: org.author.userId,
            emoji: "+1",
            createdAt: new Date("2026-10-01T00:00:02.000Z"),
          },
        ],
      });
      await db.commentAttachment.createMany({
        data: [
          {
            commentId,
            name: "synced.png",
            url: "https://files.example.test/synced.png",
            createdAt: new Date("2026-10-01T00:00:01.000Z"),
          },
          {
            commentId,
            name: "lost.png",
            createdAt: new Date("2026-10-01T00:00:01.500Z"),
          },
          {
            commentId,
            name: "uploaded.png",
            bucket: "bucket",
            key: "comment-attachments/uploaded",
            uploadedAt: new Date("2026-10-01T00:00:03.000Z"),
            createdAt: new Date("2026-10-01T00:00:02.000Z"),
          },
          {
            commentId,
            name: "pending.png",
            bucket: "bucket",
            key: "comment-attachments/pending",
            createdAt: new Date("2026-10-01T00:00:03.000Z"),
          },
        ],
      });
    });

    const read = await commentsService.getThread({
      viewer: org.other,
      threadId: thread.id,
    });

    const [comment] = read.ok ? read.value.comments : [];
    expect(comment?.reactions).toEqual([
      {
        emoji: "+1",
        userIds: [org.other.userId, org.author.userId],
        viewerReacted: true,
      },
    ]);
    expect(comment?.attachments?.map((attachment) => attachment.name)).toEqual([
      "synced.png",
      "uploaded.png",
    ]);
  });

  it("filters the list by surface and by status", async () => {
    const open = await openThread();
    const resolved = await openThread();
    await withDb((db) =>
      db.commentThread.update({
        where: { id: resolved.id },
        data: { status: ThreadStatus.Resolved },
        select: { id: true },
      })
    );

    const openIds = await listIds({ status: ThreadStatus.Open });
    const resolvedIds = await listIds({ status: ThreadStatus.Resolved });

    expect(openIds).toContain(open.id);
    expect(openIds).not.toContain(resolved.id);
    expect(resolvedIds).toEqual([resolved.id]);
    await expect(
      listIds({ surface: CommentSurface.BranchTimeline })
    ).resolves.toEqual([]);
    await expect(
      listIds({ surface: CommentSurface.SessionDetail })
    ).resolves.toEqual(expect.arrayContaining([open.id, resolved.id]));
  });

  it("answers artifact_type_not_supported for an artifact no source serves", async () => {
    // Documents resolve since PLN-2187 T-2.6; a Deployment carries no comments.
    const deployment = await withDb((db) =>
      db.artifact.create({
        data: {
          organizationId: org.organizationId,
          type: ArtifactType.DEPLOYMENT,
          name: "a deployment",
          status: DocumentStatus.Draft,
        },
        select: { id: true },
      })
    );
    const unsupported = {
      ok: false,
      error: CommentErrorCode.ArtifactTypeNotSupported,
    };

    await expect(
      resolveCommentTarget({
        organizationId: org.organizationId,
        artifactId: deployment.id,
      })
    ).resolves.toEqual(unsupported);
    await expect(
      commentsService.listArtifactComments({
        viewer: org.author,
        artifactId: deployment.id,
      })
    ).resolves.toEqual(unsupported);
  });

  it("leaves out and reports a thread whose stored anchor it cannot read, and keeps and reports one not yet backfilled", async () => {
    const unreadable = await storeThread({
      v: COMMENT_ANCHOR_SCHEMA_VERSION + 1,
      ...commentTraceAnchor(0),
    });
    const unbackfilled = await storeThread(null);

    const result = await commentsService.listArtifactComments({
      viewer: org.author,
      artifactId: org.session.artifactId,
    });

    const threads = result.ok ? result.value.threads : [];
    expect(threads.map((thread) => thread.id)).not.toContain(unreadable);
    expect(threads.find((thread) => thread.id === unbackfilled)?.anchor).toBe(
      null
    );
    expect(reportCommentDataInvalid).toHaveBeenCalledWith({
      reason: CommentDataInvalidReason.AnchorUnparseable,
      organizationId: org.organizationId,
      threadId: unreadable,
    });
    expect(reportCommentDataInvalid).toHaveBeenCalledWith({
      reason: CommentDataInvalidReason.AnchorMissing,
      organizationId: org.organizationId,
      threadId: unbackfilled,
    });
  });

  it("reanchors a thread: replaces its anchor and placement and bumps its revision", async () => {
    const thread = await openThread();
    const moved = commentTraceAnchor(500);

    const result = await commentsService.reanchor({
      organizationId: org.organizationId,
      threadId: thread.id,
      anchor: moved,
      anchorState: CommentAnchorState.Moved,
      liveState: createCommentLiveState(org.author),
    });
    const reread = await commentsService.getThread({
      viewer: org.author,
      threadId: thread.id,
    });

    expect(result).toEqual({ ok: true, value: { threadId: thread.id } });
    expect(reread.ok && reread.value).toMatchObject({
      anchor: moved,
      anchorState: CommentAnchorState.Moved,
      revision: thread.revision + 1,
    });
  });
});

/** PLN-2162 M1: what a client reads off the list, across two orgs. */
describeIfDb("comment service: the list's client contract", () => {
  let orgA: CommentTestOrg;
  let orgB: CommentTestOrg;

  beforeAll(async () => {
    orgA = await seedCommentTestOrg(tracker);
    orgB = await seedCommentTestOrg(tracker);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  async function list(viewer: CommentTestOrg["author"], artifactId: string) {
    const result = await commentsService.listArtifactComments({
      viewer,
      artifactId,
    });
    if (!result.ok) {
      throw new Error(`list failed: ${result.error}`);
    }
    return result.value;
  }

  /** The route serializes the service's value as JSON. */
  function overTheWire<T>(value: T): unknown {
    return JSON.parse(JSON.stringify(value));
  }

  it("names the artifact of a Session addressed by its external session id, with no thread to read it from", async () => {
    const { externalSessionId } = await withDb((db) =>
      db.sessionDetail.findUniqueOrThrow({
        where: { artifactId: orgB.session.artifactId },
        select: { externalSessionId: true },
      })
    );

    const page = await list(orgB.author, externalSessionId ?? "");

    expect(page.threads).toEqual([]);
    expect(page.artifactId).toBe(orgB.session.artifactId);
  });

  it("round-trips the list and one thread through the client schemas", async () => {
    const created = await commentsService.createThread({
      viewer: orgA.author,
      target: orgA.session,
      anchor: commentTraceAnchor(900),
      body: "round trip",
      clientId: null,
      present: presentCommentThreadDto({
        viewer: orgA.author,
        target: orgA.session,
        liveState: createCommentLiveState(orgA.author),
      }),
    });
    if (!created.ok) {
      throw new Error(`seed thread failed: ${created.error}`);
    }
    const page = overTheWire(await list(orgA.author, orgA.session.artifactId));
    const thread = await commentsService.getThread({
      viewer: orgA.author,
      threadId: created.value.id,
    });

    expect(artifactCommentsResponseSchema.parse(page)).toEqual(page);
    expect(
      commentThreadDtoSchema.parse(overTheWire(thread.ok && thread.value))
    ).toEqual(overTheWire(created.value));
  });

  it("offers parsing_bug on a Session to its staff viewer only, in each of two orgs", async () => {
    const kinds = async (
      viewer: CommentTestOrg["author"],
      artifactId: string
    ) => (await list(viewer, artifactId)).capabilities.commentKinds;

    for (const org of [orgA, orgB]) {
      await expect(kinds(org.staff, org.session.artifactId)).resolves.toEqual([
        TraceCommentKind.Comment,
        TraceCommentKind.ParsingBug,
      ]);
      await expect(kinds(org.author, org.session.artifactId)).resolves.toEqual([
        TraceCommentKind.Comment,
      ]);
      await expect(kinds(org.staff, org.branch.artifactId)).resolves.toEqual([
        TraceCommentKind.Comment,
      ]);
    }
  });
});
