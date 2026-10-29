/**
 * ISS-11212: the three answers the legacy trace-comment routes give differently
 * once they run on the comment service. A non-staff `parsing_bug` create is
 * 403 (PLN-2121 decision 5); a staff `parsing_bug` create on a Branch is 403
 * (ISS-11212 requirement 9; operator ruling 2026-09-30); and a reply
 * `clientId` already used on another thread is 409 carrying the service's code
 * where it used to be a 500 (decision 8). The legacy GET keeps its oldest-200
 * cap (decision 10).
 */
import { randomUUID } from "node:crypto";
import {
  CommentSurface,
  CommentTargetType,
  TRACE_COMMENT_METADATA_KIND,
  TRACE_COMMENT_SCHEMA_VERSION,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import {
  COMMENT_ANCHOR_SCHEMA_VERSION,
  CommentAnchorState,
} from "@repo/api/src/types/comment-anchor";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", organizationId: "" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context: { params: Promise<unknown> }) =>
      handler(
        { user: { ...mocks.user }, clerkUserId: null },
        request,
        context.params
      ),
}));

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
  seedCommentTestOrg,
} from "@/__tests__/support/comments/comment-service.test-fixtures";
import { seedLegacyRouteFixture } from "@/__tests__/support/trace-comments/legacy-route.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { POST as sessionRepliesPost } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/replies/route";
import {
  GET as sessionCollectionGet,
  POST as sessionCollectionPost,
} from "@/app/agent-sessions/[id]/trace-comments/route";
import { POST as branchCollectionPost } from "@/app/branches/[id]/trace-comments/route";
import { TRACE_COMMENT_TARGET_THREAD_LIMIT } from "@/app/comments/service/trace-comment-thread-limit";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const ORIGIN = "http://localhost:3002";
const CAPPED_AT = new Date("2026-07-01T00:00:00.000Z");

const tracker = createCommittedTestOrganizationTracker();

describeIfDb("legacy trace-comment routes on the comment service", () => {
  let org: CommentTestOrg;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  function actAs(viewer: { organizationId: string; userId: string }) {
    mocks.user = { id: viewer.userId, organizationId: viewer.organizationId };
  }

  function post(
    handler: typeof sessionCollectionPost,
    params: Record<string, string>,
    body: unknown
  ) {
    return handler(
      new NextRequest(`${ORIGIN}/legacy`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve(params) }
    );
  }

  function createBody(row: number, extra: Record<string, unknown> = {}) {
    const { kind: _kind, ...anchor } = commentTraceAnchor(row);
    return { anchor, body: `root ${row}`, ...extra };
  }

  it("answers 403 to a parsing_bug create from a non-staff member, and stores nothing", async () => {
    actAs(org.author);
    const clientId = `legacy-bug-${org.organizationId}`;

    const response = await post(
      sessionCollectionPost,
      { id: org.session.artifactId },
      createBody(1, { kind: TraceCommentKind.ParsingBug, clientId })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Forbidden",
    });
    const stored = await withDb((db) =>
      db.commentThread.count({ where: { externalId: clientId } })
    );
    expect(stored).toBe(0);
  });

  // ISS-11212 requirement 9; operator ruling 2026-09-30.
  it("answers 403 to a staff parsing_bug create on a Branch, and stores nothing", async () => {
    const eligible = await seedLegacyRouteFixture(
      tracker,
      randomUUID().slice(0, 8)
    );
    mocks.user = eligible.staff;
    const clientId = `legacy-branch-bug-${eligible.organizationId}`;

    const response = await post(
      branchCollectionPost,
      { id: eligible.branchArtifactId },
      createBody(4, { kind: TraceCommentKind.ParsingBug, clientId })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Forbidden",
    });
    const stored = await withDb((db) =>
      db.commentThread.count({ where: { externalId: clientId } })
    );
    expect(stored).toBe(0);
  });

  it("answers 409 with the service's code to a reply clientId used on another thread", async () => {
    actAs(org.author);
    const params = (id: string) => ({
      id: org.session.artifactId,
      commentId: id,
    });
    const created = await Promise.all(
      [2, 3].map(async (row) => {
        const response = await post(
          sessionCollectionPost,
          { id: org.session.artifactId },
          createBody(row)
        );
        return ((await response.json()) as { data: { id: string } }).data.id;
      })
    );
    const [firstRoot, secondRoot] = created as [string, string];
    const clientId = `legacy-reply-${org.organizationId}`;

    const first = await post(sessionRepliesPost, params(firstRoot), {
      body: "reply",
      clientId,
    });
    const conflict = await post(sessionRepliesPost, params(secondRoot), {
      body: "reply",
      clientId,
    });

    expect(first.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      success: false,
      error: CommentErrorCode.ClientIdConflict,
      code: CommentErrorCode.ClientIdConflict,
    });
  });

  it("reads exactly the oldest threads up to the legacy cap (PLN-2121 decision 10)", async () => {
    const capped = await seedCommentTestOrg(tracker);
    await withDb(async (db) => {
      await db.commentThread.createMany({
        data: Array.from(
          { length: TRACE_COMMENT_TARGET_THREAD_LIMIT + 5 },
          (_, index) => ({
            organizationId: capped.organizationId,
            artifactId: capped.session.artifactId,
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
            anchorState: CommentAnchorState.Anchored,
            createdById: capped.author.userId,
            createdAt: new Date(CAPPED_AT.getTime() + index * 1000),
            externalId: `capped-${index}-${capped.organizationId}`,
          })
        ),
      });
      const threads = await db.commentThread.findMany({
        where: { organizationId: capped.organizationId },
        select: { id: true, createdAt: true },
      });
      await db.comment.createMany({
        data: threads.map((thread) => ({
          threadId: thread.id,
          authorId: capped.author.userId,
          body: {},
          bodyFormat: CommentBodyFormat.RichV1,
          plainText: String(
            (thread.createdAt.getTime() - CAPPED_AT.getTime()) / 1000
          ),
        })),
      });
    });
    actAs(capped.author);

    const response = await sessionCollectionGet(
      new NextRequest(`${ORIGIN}/legacy`),
      { params: Promise.resolve({ id: capped.session.artifactId }) }
    );
    const comments = ((await response.json()) as { data: { body: string }[] })
      .data;

    expect(comments.map((comment) => comment.body)).toEqual(
      Array.from({ length: TRACE_COMMENT_TARGET_THREAD_LIMIT }, (_, index) =>
        String(index)
      )
    );
  });
});
