import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedHandler, RouteContext } from "@/lib/auth/with-auth";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  userId: "a490b1bf-97bd-42e1-86fa-e084e88b4e9a",
  organizationId: "ec03ac4a-c784-413c-8b7b-0156e666024f",
  insights: vi.fn(),
}));

vi.mock("../auth", async () => {
  const { createTestAuthContext } = await import(
    "@/__tests__/utils/auth-helpers"
  );
  return {
    withSessionMeshAuth:
      (handler: AuthenticatedHandler<unknown>) =>
      (request: NextRequest, context: RouteContext) => {
        const auth = createTestAuthContext();
        return handler(
          {
            ...auth,
            user: {
              ...auth.user,
              id: mocks.userId,
              organizationId: mocks.organizationId,
            },
          },
          request,
          context.params
        );
      },
  };
});
vi.mock("../service", () => ({
  sessionMeshService: { insights: mocks.insights },
}));

const now = new Date("2026-09-25T12:00:00.000Z");
const selectedUserId = "e50f426f-edbc-42c7-a7ba-dfbe0394cdf1";
const dayMs = 86_400_000;
function request(query = "") {
  return GET(
    new NextRequest(
      `https://api.example.test/session-mesh/insights${query ? `?${query}` : ""}`
    ),
    { params: Promise.resolve({}) }
  );
}

// Auth and service are mocked here: these tests prove query validation and
// forwarding only. Real-database suites own user/organization isolation.
describe("Session Mesh Insights route query forwarding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.insights.mockResolvedValue({ report: "service response" });
  });
  afterEach(() => vi.useRealTimers());

  it("defaults to the current user and the last 30 days", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(mocks.insights).toHaveBeenCalledExactlyOnceWith(
      mocks.organizationId,
      {
        from: new Date(now.getTime() - 30 * dayMs),
        to: now,
      },
      mocks.userId
    );
    expect(await response.json()).toEqual({
      success: true,
      data: { report: "service response" },
    });
  });

  it("forwards org scope without a user filter", async () => {
    expect((await request("scope=org")).status).toBe(200);
    expect(mocks.insights).toHaveBeenCalledWith(
      mocks.organizationId,
      expect.any(Object),
      undefined
    );
  });

  it.each(["", "scope=me&"])(
    "forwards a selected UUID within me scope (%s)",
    async (prefix) => {
      expect((await request(`${prefix}userId=${selectedUserId}`)).status).toBe(
        200
      );
      expect(mocks.insights).toHaveBeenCalledWith(
        mocks.organizationId,
        expect.any(Object),
        selectedUserId
      );
    }
  );

  it.each([
    ["7", 7],
    ["30", 30],
    ["90", 90],
    ["all", 90],
  ] as const)(
    "forwards period %s as a retained %i-day window",
    async (period, days) => {
      expect((await request(`period=${period}`)).status).toBe(200);
      expect(mocks.insights).toHaveBeenCalledWith(
        mocks.organizationId,
        {
          from: new Date(now.getTime() - days * dayMs),
          to: now,
        },
        mocks.userId
      );
    }
  );

  it("forwards explicit from/to boundaries unchanged", async () => {
    const from = "2026-09-20T04:00:00.000Z";
    const to = "2026-09-24T08:00:00.000Z";
    expect(
      (
        await request(
          new URLSearchParams({ scope: "org", from, to }).toString()
        )
      ).status
    ).toBe(200);
    expect(mocks.insights).toHaveBeenCalledWith(
      mocks.organizationId,
      { from: new Date(from), to: new Date(to) },
      undefined
    );
  });

  it("anchors a selected period to an explicit to boundary", async () => {
    const to = new Date("2026-09-24T08:00:00.000Z");
    expect(
      (
        await request(
          new URLSearchParams({ period: "7", to: to.toISOString() }).toString()
        )
      ).status
    ).toBe(200);
    expect(mocks.insights).toHaveBeenCalledWith(
      mocks.organizationId,
      { from: new Date(to.getTime() - 7 * dayMs), to },
      mocks.userId
    );
  });

  it.each([
    "scope=team",
    "scope=",
    "scope=unknown",
    `scope=org&userId=${selectedUserId}`,
    "userId=not-a-uuid",
    "userId=",
    "period=14",
    "period=0",
    "period=month",
    "period=",
    "period=-7",
    "unknownFilter=value",
    "teamId=abc",
    "from=not-a-date",
    "to=not-a-date",
    "from=2026-01-01T00%3A00%3A00.000Z",
    "from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-23T00%3A00%3A00.000Z",
  ])(
    "rejects invalid filters before calling the service: %s",
    async (query) => {
      const response = await request(query);
      expect(response.status).toBe(400);
      expect(mocks.insights).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ success: false });
    }
  );
});
