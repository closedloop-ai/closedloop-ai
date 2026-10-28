/**
 * ISS-11212 (PLN-2121 Step 5, acceptance criterion 4): the unified comment
 * routes against a real database, with only the auth wrapper stubbed. Each
 * source policy's allowed and denied actions answer through the route,
 * including the staff-only `parsing_bug` kind and the org session-sync policy,
 * and another org's artifact, thread or comment is `not_found`.
 */
import { randomUUID } from "node:crypto";
import { CommentSurface, TraceCommentKind } from "@repo/api/src/types/comment";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  viewer: { organizationId: "", userId: "" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params: unknown }) =>
      handler(
        {
          user: {
            id: auth.viewer.userId,
            organizationId: auth.viewer.organizationId,
          },
          clerkUserId: null,
        },
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
import {
  type LegacyRouteFixture,
  seedLegacyRouteFixture,
} from "@/__tests__/support/trace-comments/legacy-route.test-fixtures";
import {
  createMockRequest,
  createMockRouteContext,
} from "@/__tests__/utils/auth-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { GET as legacySessionCommentsRoute } from "@/app/agent-sessions/[id]/trace-comments/route";
import { GET as listArtifactCommentsRoute } from "@/app/artifacts/[id]/comments/route";
import { POST as createThreadRoute } from "@/app/artifacts/[id]/comments/threads/route";
import {
  DELETE as deleteCommentRoute,
  PATCH as editCommentRoute,
} from "@/app/comments/[commentId]/route";
import type { CommentViewer } from "@/app/comments/service/comment-capabilities";
import { POST as reopenThreadRoute } from "@/app/comments/threads/[threadId]/reopen/route";
import { POST as replyRoute } from "@/app/comments/threads/[threadId]/replies/route";
import { POST as resolveThreadRoute } from "@/app/comments/threads/[threadId]/resolve/route";
import { POST as retrySyncThreadRoute } from "@/app/comments/threads/[threadId]/retry-sync/route";
import { GET as getThreadRoute } from "@/app/comments/threads/[threadId]/route";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();
const BASE = "http://localhost:3002/api";
let clientCounter = 0;

type RouteHandler = (request: never, context: never) => Promise<Response>;

async function call(
  as: CommentViewer,
  handler: RouteHandler,
  input: {
    path: string;
    params: Record<string, string>;
    method?: string;
    body?: unknown;
  }
): Promise<{ status: number; body: { data?: unknown; code?: string } }> {
  auth.viewer = as;
  const response = await handler(
    createMockRequest({
      url: `${BASE}${input.path}`,
      method: input.method ?? "GET",
      body: input.body,
    }) as never,
    createMockRouteContext(input.params) as never
  );
  return { status: response.status, body: await response.json() };
}

function openThread(
  as: CommentViewer,
  artifactId: string,
  kind?: TraceCommentKind
) {
  clientCounter += 1;
  return call(as, createThreadRoute, {
    path: `/artifacts/${artifactId}/comments/threads`,
    params: { id: artifactId },
    method: "POST",
    body: {
      anchor: commentTraceAnchor(clientCounter),
      body: "root",
      clientId: `routes-${clientCounter}-${artifactId}`,
      ...(kind ? { kind } : {}),
    },
  });
}

async function seededThread(
  as: CommentViewer,
  artifactId: string
): Promise<CommentThreadDto> {
  const created = await openThread(as, artifactId);
  if (created.status !== 200) {
    throw new Error(`seed thread failed: ${JSON.stringify(created.body)}`);
  }
  return created.body.data as CommentThreadDto;
}

const denied = { status: 403, code: CommentErrorCode.CapabilityDenied };
const notFound = { status: 404, code: CommentErrorCode.NotFound };
const served = { status: 200, code: undefined };

function outcome(response: { status: number; body: { code?: string } }) {
  return { status: response.status, code: response.body.code };
}

describeIfDb("unified comment routes: two-org scoping", () => {
  let orgA: CommentTestOrg;
  let orgB: CommentTestOrg;
  let foreign: CommentThreadDto;

  beforeAll(async () => {
    orgA = await seedCommentTestOrg(tracker);
    orgB = await seedCommentTestOrg(tracker);
    foreign = await seededThread(orgB.author, orgB.session.artifactId);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it("answers not_found to every route addressed at another org's records", async () => {
    const viewer = orgA.author;
    const threadParams = { threadId: foreign.id };
    const commentId = foreign.comments[0]?.id as string;
    const responses = await Promise.all([
      call(viewer, listArtifactCommentsRoute, {
        path: `/artifacts/${orgB.session.artifactId}/comments`,
        params: { id: orgB.session.artifactId },
      }),
      openThread(viewer, orgB.session.artifactId),
      call(viewer, getThreadRoute, {
        path: `/comments/threads/${foreign.id}`,
        params: threadParams,
      }),
      call(viewer, replyRoute, {
        path: `/comments/threads/${foreign.id}/replies`,
        params: threadParams,
        method: "POST",
        body: { body: "reply", clientId: `foreign-${foreign.id}` },
      }),
      call(viewer, resolveThreadRoute, {
        path: `/comments/threads/${foreign.id}/resolve`,
        params: threadParams,
        method: "POST",
      }),
      call(viewer, retrySyncThreadRoute, {
        path: `/comments/threads/${foreign.id}/retry-sync`,
        params: threadParams,
        method: "POST",
      }),
      call(viewer, editCommentRoute, {
        path: `/comments/${commentId}`,
        params: { commentId },
        method: "PATCH",
        body: { body: "edited", expectedRevision: 0 },
      }),
      call(viewer, deleteCommentRoute, {
        path: `/comments/${commentId}`,
        params: { commentId },
        method: "DELETE",
      }),
    ]);

    expect(responses.map(outcome)).toEqual(responses.map(() => notFound));
    const stored = await withDb((db) =>
      db.comment.findMany({
        where: { threadId: foreign.id },
        select: { plainText: true, deletedAt: true },
      })
    );
    expect(stored).toEqual([{ plainText: "root", deletedAt: null }]);
  });
});

describeIfDb("unified comment routes: source policies", () => {
  let org: CommentTestOrg;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it("opens a parsing_bug thread on a Session for staff only, and on a Branch for no one", async () => {
    const staffSession = await openThread(
      org.staff,
      org.session.artifactId,
      TraceCommentKind.ParsingBug
    );
    const memberSession = await openThread(
      org.author,
      org.session.artifactId,
      TraceCommentKind.ParsingBug
    );
    const staffBranch = await openThread(
      org.staff,
      org.branch.artifactId,
      TraceCommentKind.ParsingBug
    );

    expect(staffSession.status).toBe(200);
    expect(outcome(memberSession)).toEqual(denied);
    expect(outcome(staffBranch)).toEqual(denied);
  });

  it("keeps edit, delete and retry-sync to the author, and refuses a stale edit with 409", async () => {
    const thread = await seededThread(org.author, org.session.artifactId);
    const commentId = thread.comments[0]?.id as string;
    const commentParams = {
      path: `/comments/${commentId}`,
      params: { commentId },
    };
    const retry = {
      path: `/comments/threads/${thread.id}/retry-sync`,
      params: { threadId: thread.id },
      method: "POST",
    };

    const otherEdit = await call(org.other, editCommentRoute, {
      ...commentParams,
      method: "PATCH",
      body: { body: "not mine", expectedRevision: 0 },
    });
    const otherDelete = await call(org.other, deleteCommentRoute, {
      ...commentParams,
      method: "DELETE",
    });
    const otherRetry = await call(org.other, retrySyncThreadRoute, retry);
    const ownEdit = await call(org.author, editCommentRoute, {
      ...commentParams,
      method: "PATCH",
      body: { body: "mine", expectedRevision: 0 },
    });
    const staleEdit = await call(org.author, editCommentRoute, {
      ...commentParams,
      method: "PATCH",
      body: { body: "stale", expectedRevision: 0 },
    });
    const ownRetry = await call(org.author, retrySyncThreadRoute, retry);

    expect([otherEdit, otherDelete, otherRetry].map(outcome)).toEqual([
      denied,
      denied,
      denied,
    ]);
    expect(ownEdit.status).toBe(200);
    expect(outcome(staleEdit)).toEqual({
      status: 409,
      code: CommentErrorCode.StaleRevision,
    });
    expect(ownRetry.status).toBe(200);
    const stored = await withDb((db) =>
      db.comment.findUniqueOrThrow({
        where: { id: commentId },
        select: { plainText: true },
      })
    );
    expect(stored.plainText).toBe("mine");
  });

  it("resolves and reopens a Session thread for any member, and refuses both on a Branch thread", async () => {
    const toggle = async (
      viewer: CommentViewer,
      thread: { id: string }
    ): Promise<Awaited<ReturnType<typeof call>>[]> => {
      const responses: Awaited<ReturnType<typeof call>>[] = [];
      for (const [route, action] of [
        [resolveThreadRoute, "resolve"],
        [reopenThreadRoute, "reopen"],
      ] as const) {
        responses.push(
          await call(viewer, route, {
            path: `/comments/threads/${thread.id}/${action}`,
            params: { threadId: thread.id },
            method: "POST",
          })
        );
      }
      return responses;
    };

    const session = await toggle(
      org.other,
      await seededThread(org.author, org.session.artifactId)
    );
    const branch = await toggle(
      org.author,
      await seededThread(org.author, org.branch.artifactId)
    );

    expect(session.map((response) => response.status)).toEqual([200, 200]);
    expect(branch.map(outcome)).toEqual([denied, denied]);
  });

  it("lists a Session addressed by the desktop's external session id", async () => {
    const thread = await seededThread(org.author, org.session.artifactId);
    const { externalSessionId } = await withDb((db) =>
      db.sessionDetail.findUniqueOrThrow({
        where: { artifactId: org.session.artifactId },
        select: { externalSessionId: true },
      })
    );

    const listed = await call(org.author, listArtifactCommentsRoute, {
      path: `/artifacts/${externalSessionId}/comments?limit=100`,
      params: { id: externalSessionId as string },
    });

    expect(listed.status).toBe(200);
    const page = listed.body.data as { threads: CommentThreadDto[] };
    expect(page.threads.map((listedThread) => listedThread.id)).toContain(
      thread.id
    );
    expect(
      page.threads.every(
        (listedThread) => listedThread.artifactId === org.session.artifactId
      )
    ).toBe(true);
  });
});

describeIfDb("unified comment routes: a deleted Branch", () => {
  let org: CommentTestOrg;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  // ISS-11589 ruling (2026-10-12): "We want deleted branches, in the list and in
  // the metrics card. Active branches is the only exception." Operator ruling
  // 2026-10-14 (ISS-12421 session): comment writes on a deleted Branch are allowed.
  it("serves a write on a deleted Branch, as its read does", async () => {
    const thread = await seededThread(org.author, org.branch.artifactId);
    await withDb((db) =>
      db.branchDetail.update({
        where: { artifactId: org.branch.artifactId },
        data: { deletedAt: new Date() },
        select: { artifactId: true },
      })
    );

    const responses = [
      await openThread(org.author, org.branch.artifactId),
      await call(org.author, replyRoute, {
        path: `/comments/threads/${thread.id}/replies`,
        params: { threadId: thread.id },
        method: "POST",
        body: { body: "reply", clientId: `deleted-${thread.id}` },
      }),
      await call(org.author, listArtifactCommentsRoute, {
        path: `/artifacts/${org.branch.artifactId}/comments`,
        params: { id: org.branch.artifactId },
      }),
    ];

    expect(responses.map(outcome)).toEqual([served, served, served]);
    const stored = await withDb((db) =>
      db.commentThread.count({ where: { artifactId: org.branch.artifactId } })
    );
    expect(stored).toBe(2);
  });
});

describeIfDb("unified comment routes: listing on the session surface", () => {
  let fixture: LegacyRouteFixture;
  let viewer: CommentViewer;
  let documentArtifactId: string;

  beforeAll(async () => {
    fixture = await seedLegacyRouteFixture(tracker, randomUUID().slice(0, 8));
    viewer = {
      organizationId: fixture.organizationId,
      userId: fixture.staff.id,
    };
    const document = await withDb((db) =>
      db.artifact.create({
        data: {
          organizationId: fixture.organizationId,
          type: ArtifactType.DOCUMENT,
          name: "not a session",
          status: DocumentStatus.Draft,
        },
        select: { id: true },
      })
    );
    documentArtifactId = document.id;
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it("answers not_found to a Branch or Document id, as the legacy session route does", async () => {
    const ids = [fixture.branchArtifactId, documentArtifactId];
    const unified = await Promise.all(
      ids.map((id) =>
        call(viewer, listArtifactCommentsRoute, {
          path: `/artifacts/${id}/comments?surface=${CommentSurface.SessionDetail}`,
          params: { id },
        })
      )
    );
    const legacy = await Promise.all(
      ids.map((id) =>
        call(viewer, legacySessionCommentsRoute, {
          path: `/agent-sessions/${id}/trace-comments`,
          params: { id },
        })
      )
    );

    expect(unified.map(outcome)).toEqual([notFound, notFound]);
    expect(legacy.map((response) => response.status)).toEqual([404, 404]);
  });

  it("still lists the Branch's threads off the session surface", async () => {
    const thread = await seededThread(viewer, fixture.branchArtifactId);

    const listed = await call(viewer, listArtifactCommentsRoute, {
      path: `/artifacts/${fixture.branchArtifactId}/comments`,
      params: { id: fixture.branchArtifactId },
    });

    expect(listed.status).toBe(200);
    const page = listed.body.data as { threads: CommentThreadDto[] };
    expect(page.threads.map((listedThread) => listedThread.id)).toEqual([
      thread.id,
    ]);
  });
});
