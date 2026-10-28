import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
} from "@repo/api/src/types/comment";
import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sessionTraceAnchor,
  storedSessionTraceThreadColumns,
} from "@/__tests__/support/trace-comments/trace-comment-thread.test-fixtures";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import { mockWithDbAll } from "@/__tests__/utils/db-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: { SESSION: "SESSION", BRANCH: "BRANCH" },
  });
});
vi.mock("@/app/trace-comments/service", () => ({
  traceCommentsService: { list: vi.fn() },
}));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context: { params: Promise<unknown> }) =>
      handler(auth, request, context.params),
}));

import { TRACE_COMMENT_TARGET_THREAD_LIMIT } from "@/app/comments/service/trace-comment-thread-limit";
import { traceCommentsService } from "@/app/trace-comments/service";
import { GET } from "./[id]/trace-comments/route";
import { branchTraceCommentsService } from "./branch-trace-comments-service";

const branchId = "00000000-0000-7000-8000-000000000001";
const sessionIds = ["session-a", "session-b"];
let auth: AuthContext;
const artifactFindMany = vi.fn();
const branchFindFirst = vi.fn();
const branchThreads = vi.fn();
const eligibility = vi.fn();

describe("ISS-12282 branch trace comment collection route with real service", () => {
  beforeEach(() => {
    auth = createTestAuthContext();
    branchFindFirst.mockImplementation(
      ({ where }: Prisma.BranchDetailFindFirstArgs) => {
        const org = where?.artifact?.is?.organizationId;
        const matches = where?.artifactId === branchId;
        return Promise.resolve(
          matches && (org === undefined || org === "test-org-id")
            ? { artifactId: branchId }
            : null
        );
      }
    );
    eligibility.mockResolvedValue([{ id: branchId }]);
    branchThreads.mockResolvedValue([]);
    artifactFindMany.mockImplementation(
      ({ where }: Prisma.ArtifactFindManyArgs) =>
        Promise.resolve(
          where?.organizationId === "test-org-id"
            ? sessionIds.map((id) => ({
                id,
                sourceLinks: [
                  {
                    branchParticipation: BranchParticipationKind.Wrote,
                    metadata: null,
                  },
                ],
                commentThreads: [thread(id)],
              }))
            : []
        )
    );
    mockWithDbAll({
      branchDetail: { findFirst: branchFindFirst },
      artifact: { findMany: artifactFindMany },
      commentThread: { findMany: branchThreads },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: eligibility,
    });
  });

  it("returns both Sessions in one org-scoped batch, retaining each turn and reply", async () => {
    const response = await GET(
      request(),
      createMockRouteContext({ id: branchId })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({
      target: { id: sessionIds[0], type: CommentTargetType.Session },
      anchor: sessionTraceAnchor,
      replies: [{ body: "reply" }],
    });
    expect(artifactFindMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: {
          organizationId: "test-org-id",
          type: ArtifactType.Session,
          sourceLinks: {
            some: expect.objectContaining({
              organizationId: "test-org-id",
              targetId: { in: [branchId] },
            }),
          },
        },
        select: expect.objectContaining({
          commentThreads: expect.objectContaining({
            where: expect.objectContaining({
              organizationId: "test-org-id",
              metadata: {
                path: ["surface"],
                equals: CommentSurface.SessionDetail,
              },
            }),
            take: TRACE_COMMENT_TARGET_THREAD_LIMIT,
          }),
        }),
      })
    );
    expect(traceCommentsService.list).not.toHaveBeenCalled();
  });

  it("returns 404 for another organization's branch before reading its comments", async () => {
    auth.user.organizationId = "other-org";
    const response = await GET(
      request(),
      createMockRouteContext({ id: branchId })
    );
    expect(response.status).toBe(404);
    expect(artifactFindMany).not.toHaveBeenCalled();
    expect(branchThreads).not.toHaveBeenCalled();
  });

  it("does not expand a large branch membership into bind parameters", async () => {
    artifactFindMany.mockResolvedValue(
      Array.from({ length: 65_536 }, (_, index) => ({
        id: `session-${index}`,
        sourceLinks: [
          {
            branchParticipation: BranchParticipationKind.Wrote,
            metadata: null,
          },
        ],
        commentThreads: [],
      }))
    );
    const response = await GET(
      request(),
      createMockRouteContext({ id: branchId })
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([]);
    expect(artifactFindMany).toHaveBeenCalledOnce();
    const query = artifactFindMany.mock.calls[0]?.[0];
    expect(query.where.id).toBeUndefined();
    expect(query.where.sourceLinks.some.targetId).toEqual({ in: [branchId] });
  });

  it("excludes review-only participation using the trace membership rule", async () => {
    artifactFindMany.mockResolvedValue([
      {
        id: sessionIds[0],
        sourceLinks: [
          {
            branchParticipation: BranchParticipationKind.Reviewed,
            metadata: null,
          },
        ],
        commentThreads: [thread(sessionIds[0])],
      },
    ]);
    const response = await GET(
      request(),
      createMockRouteContext({ id: branchId })
    );
    expect((await response.json()).data).toEqual([]);
  });

  it("rechecks Branch eligibility after projection", async () => {
    eligibility
      .mockResolvedValueOnce([{ id: branchId }])
      .mockResolvedValueOnce([]);
    await expect(
      branchTraceCommentsService.list({
        organizationId: "test-org-id",
        userId: "test-user-id",
        branchId,
      })
    ).resolves.toBeNull();
  });

  it("preserves the legacy GET when the batch selector is omitted", async () => {
    vi.mocked(traceCommentsService.list).mockResolvedValue([]);
    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/branches/${branchId}/trace-comments`,
      }),
      createMockRouteContext({ id: branchId })
    );
    expect(response.status).toBe(200);
    expect(traceCommentsService.list).toHaveBeenCalledOnce();
    expect(artifactFindMany).not.toHaveBeenCalled();
  });

  it("rejects batch selectors outside the timeline instead of changing their meaning", async () => {
    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/branches/${branchId}/trace-comments?surface=branch_detail&includeSessions=true`,
      }),
      createMockRouteContext({ id: branchId })
    );
    expect(response.status).toBe(400);
    expect(artifactFindMany).not.toHaveBeenCalled();
  });
});

function request() {
  return createMockRequest({
    url: `http://localhost:3002/branches/${branchId}/trace-comments?surface=branch_timeline&includeSessions=true`,
  });
}

function thread(id: string) {
  const createdAt = new Date("2026-10-01T00:00:00Z");
  return {
    ...storedSessionTraceThreadColumns,
    id: `thread-${id}`,
    artifactId: id,
    organizationId: "test-org-id",
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    createdAt,
    updatedAt: createdAt,
    comments: ["root", "reply"].map((body) => ({
      id: `${id}-${body}`,
      authorId: "test-user-id",
      plainText: body,
      body,
      editedAt: null,
      createdAt,
      updatedAt: createdAt,
    })),
  };
}
