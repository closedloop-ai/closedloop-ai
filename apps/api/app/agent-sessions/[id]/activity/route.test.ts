import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { ActivityFeedActorKind } from "@repo/api/src/types/artifact-activity-feed";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({ LinkType: { PRODUCES: "PRODUCES" } });
});

import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import { mockWithDbCall } from "@/__tests__/utils/db-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";
import { encodeTimeIdCursor } from "@/lib/time-id-cursor";

let authContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(authContext, request, context.params),
}));

import { GET } from "./route";

const sessionId = "11111111-1111-7111-8111-111111111111";
const otherId = "22222222-2222-7222-8222-222222222222";

function request(query = "") {
  return new NextRequest(
    `http://localhost/agent-sessions/${sessionId}/activity${query}`
  );
}

function context(id = sessionId) {
  return { params: Promise.resolve({ id }) };
}

function dbForSession(input: {
  organizationId: string;
  type?: ArtifactType;
  hasDetail?: boolean;
}) {
  const artifact = {
    id: sessionId,
    organizationId: input.organizationId,
    type: input.type ?? ArtifactType.Session,
    hasDetail: input.hasDetail ?? true,
  };
  const findFirst = vi.fn(
    async ({
      where,
    }: {
      where: {
        id?: string;
        organizationId?: string;
        type?: string;
        session?: { isNot: null };
      };
    }) =>
      (where.id === undefined || where.id === artifact.id) &&
      (where.organizationId === undefined ||
        where.organizationId === artifact.organizationId) &&
      (where.type === undefined || where.type === artifact.type) &&
      (where.session === undefined || artifact.hasDetail)
        ? { id: artifact.id }
        : null
  );
  const occurredAt = new Date("2026-10-03T17:00:00.000Z");
  const rows = [
    {
      id: otherId,
      organizationId: input.organizationId,
      artifactId: sessionId,
      action: ArtifactActivityAction.FieldChange,
      actorType: ArtifactActivityActorType.User,
      actorId: "actual-user",
      before: null,
      after: { field: "name", value: "new name" },
      createdAt: occurredAt,
    },
  ];
  const findMany = vi.fn(
    async ({
      where,
    }: {
      where: {
        organizationId: string;
        artifactId: string;
        action: string;
        actorType: { in: string[] };
      };
    }) =>
      rows.filter(
        (row) =>
          row.organizationId === where.organizationId &&
          row.artifactId === where.artifactId &&
          where.action === row.action &&
          where.actorType.in.includes(row.actorType)
      )
  );
  // Comment threads are projected into this feed too (ISS-11004); these cases
  // pin the route, so the model is present and empty. Its rows are covered by
  // `stored-event-activity-feed.test.ts`.
  mockWithDbCall({
    artifact: { findFirst },
    artifactActivityEvent: { findMany },
    commentThread: { findMany: vi.fn(async () => []) },
  });
  return { findFirst, findMany };
}

beforeEach(() => {
  vi.clearAllMocks();
  authContext = createTestAuthContext();
});

describe("GET /agent-sessions/[id]/activity", () => {
  it("returns the shared feed item for an org-owned Session detail", async () => {
    const db = dbForSession({
      organizationId: authContext.user.organizationId,
    });

    const response = await GET(request("?limit=1"), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([
      expect.objectContaining({
        id: `event:${otherId}`,
        actor: { kind: ActivityFeedActorKind.Human, id: "actual-user" },
      }),
    ]);
    expect(body.data.nextCursor).toBeNull();
    expect(db.findMany).toHaveBeenCalledTimes(3);
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: authContext.user.organizationId,
          artifactId: sessionId,
          action: ArtifactActivityAction.FieldChange,
        }),
      })
    );
  });

  it("returns 404 for another org, wrong type, missing detail or malformed id", async () => {
    const db = dbForSession({ organizationId: "other-org" });
    expect((await GET(request(), context())).status).toBe(404);
    expect(db.findMany).not.toHaveBeenCalled();

    dbForSession({
      organizationId: authContext.user.organizationId,
      type: ArtifactType.Branch,
    });
    expect((await GET(request(), context())).status).toBe(404);

    dbForSession({
      organizationId: authContext.user.organizationId,
      hasDetail: false,
    });
    expect((await GET(request(), context())).status).toBe(404);
    expect((await GET(request(), context("not-a-uuid"))).status).toBe(404);
  });

  it("rejects an invalid limit or foreign-source cursor before the feed query", async () => {
    const db = dbForSession({
      organizationId: authContext.user.organizationId,
    });
    expect((await GET(request("?limit=0"), context())).status).toBe(400);
    expect((await GET(request("?limit=101"), context())).status).toBe(400);
    expect((await GET(request("?cursor="), context())).status).toBe(400);
    const wrongSource = encodeTimeIdCursor(
      new Date("2026-10-03T17:00:00.000Z").getTime(),
      `version:${otherId}`
    );
    expect(
      (await GET(request(`?cursor=${wrongSource}`), context())).status
    ).toBe(400);
    expect(db.findMany).not.toHaveBeenCalled();
  });
});
