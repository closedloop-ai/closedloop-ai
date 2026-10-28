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

const branchHasCloudEligibility = vi.hoisted(() => vi.fn());
vi.mock("@/app/branches/cloud-branch-eligibility", () => ({
  branchHasCloudEligibility,
}));

import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import { mockWithDbCall } from "@/__tests__/utils/db-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let authContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(authContext, request, context.params),
}));

import { GET } from "./route";

const branchId = "11111111-1111-7111-8111-111111111111";
const eventId = "22222222-2222-7222-8222-222222222222";

function request(query = "") {
  return new NextRequest(
    `http://localhost/branches/${branchId}/activity${query}`
  );
}

function context(id = branchId) {
  return { params: Promise.resolve({ id }) };
}

function mockEventRead() {
  const findMany = vi.fn(
    async ({
      where,
    }: {
      where: { action: string; actorType: { in: string[] } };
    }) =>
      where.action === ArtifactActivityAction.FieldChange &&
      where.actorType.in.includes(ArtifactActivityActorType.Agent)
        ? [
            {
              id: eventId,
              action: ArtifactActivityAction.FieldChange,
              actorType: ArtifactActivityActorType.Agent,
              actorId: "key-owner-1",
              before: null,
              after: { field: "tag", value: "tag-1" },
              createdAt: new Date("2026-10-03T17:00:00.000Z"),
            },
          ]
        : []
  );
  // The stored-event feed also projects comment threads (ISS-11004). These
  // cases pin route gating and org scoping, not that projection, so the model
  // is present and empty; `stored-event-activity-feed.test.ts` owns its rows.
  mockWithDbCall({
    artifactActivityEvent: { findMany },
    commentThread: { findMany: vi.fn(async () => []) },
  });
  return findMany;
}

beforeEach(() => {
  vi.clearAllMocks();
  authContext = createTestAuthContext();
  branchHasCloudEligibility.mockResolvedValue(true);
});

describe("GET /branches/[id]/activity", () => {
  it("returns an actor-preserving page only after both Product gate checks", async () => {
    const findMany = mockEventRead();

    const response = await GET(request("?limit=1"), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([
      expect.objectContaining({
        id: `event:${eventId}`,
        actor: { kind: ActivityFeedActorKind.Agent, id: "key-owner-1" },
      }),
    ]);
    expect(branchHasCloudEligibility).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(branchHasCloudEligibility).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      authContext.user.organizationId,
      branchId
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: authContext.user.organizationId,
          artifactId: branchId,
        }),
      })
    );
  });

  it("returns 404 before the feed read for an ineligible or malformed Branch", async () => {
    const findMany = mockEventRead();
    branchHasCloudEligibility.mockResolvedValue(false);

    expect((await GET(request(), context())).status).toBe(404);
    expect((await GET(request(), context("not-a-uuid"))).status).toBe(404);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not release an assembled page if Product eligibility changes", async () => {
    const findMany = mockEventRead();
    branchHasCloudEligibility
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(branchHasCloudEligibility).toHaveBeenCalledTimes(2);
  });

  it("rejects a cursor from another feed source before reading events", async () => {
    const findMany = mockEventRead();
    const wrongSource = Buffer.from(
      `1791046800000:version:${eventId}`
    ).toString("base64url");

    expect(
      (await GET(request(`?cursor=${wrongSource}`), context())).status
    ).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });
});
