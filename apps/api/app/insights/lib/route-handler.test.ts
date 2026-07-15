import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { ApproverRole } from "@repo/api/src/types/user";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  isAgentMonitoringEnabledForUser: vi.fn(),
  isInsightsEnabledForUser: vi.fn(),
  isMember: vi.fn(),
  isOrgAdmin: vi.fn(),
}));

vi.mock("@/app/teams/service", () => ({
  teamsService: {
    findById: mocks.findById,
    isMember: mocks.isMember,
  },
}));

vi.mock("@/lib/agent-session-sync-feature", () => ({
  isAgentMonitoringEnabledForUser: mocks.isAgentMonitoringEnabledForUser,
}));

vi.mock("@/lib/insights-feature", () => ({
  isInsightsEnabledForUser: mocks.isInsightsEnabledForUser,
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: mocks.isOrgAdmin,
}));

import { createInsightsHandler } from "./route-handler";

const USER = {
  active: true,
  avatarUrl: null,
  clerkId: "clerk_user_1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  email: "test@example.com",
  firstName: "Test",
  githubUsername: null,
  id: "019f0fcb-8336-7c4d-9f64-528fb9520c31",
  lastName: "User",
  linearId: null,
  organizationId: "019f0fcb-8336-7c4d-9f64-528fb9520c30",
  phoneNumber: null,
  role: ApproverRole.Engineer,
  slackId: null,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const TEAM_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c32";
const INVALID_TEAM_ID = "not-a-uuid";

describe("createInsightsHandler team scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue({ id: TEAM_ID });
    mocks.isAgentMonitoringEnabledForUser.mockResolvedValue(true);
    mocks.isInsightsEnabledForUser.mockResolvedValue(true);
    mocks.isMember.mockResolvedValue(true);
    mocks.isOrgAdmin.mockResolvedValue(false);
  });

  it("rejects team scope without teamId before auth or service calls", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}`
      )
    );

    expect(response.status).toBe(400);
    expect(mocks.isAgentMonitoringEnabledForUser).not.toHaveBeenCalled();
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid teamId before auth or service calls", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}&teamId=${INVALID_TEAM_ID}`
      )
    );

    expect(response.status).toBe(400);
    expect(mocks.isAgentMonitoringEnabledForUser).not.toHaveBeenCalled();
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes team context to the section service for team members", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.findById).toHaveBeenCalledWith(TEAM_ID, USER.organizationId);
    expect(mocks.isMember).toHaveBeenCalledWith(TEAM_ID, USER.id);
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      {
        organizationId: USER.organizationId,
        scope: InsightsScope.Team,
        teamId: TEAM_ID,
        userId: USER.id,
      },
      InsightsPeriod.Quarter
    );
  });

  it("passes team context to the section service for org admins", async () => {
    mocks.isMember.mockResolvedValueOnce(false);
    mocks.isOrgAdmin.mockResolvedValueOnce(true);
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.isOrgAdmin).toHaveBeenCalledWith(
      "org_clerk_1",
      "user_clerk_1"
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: InsightsScope.Team,
        teamId: TEAM_ID,
      }),
      InsightsPeriod.Quarter
    );
  });

  it("denies unauthorized team scope before section service access", async () => {
    mocks.findById.mockResolvedValueOnce(null);
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies non-member team scope before section service access", async () => {
    mocks.isMember.mockResolvedValueOnce(false);
    mocks.isOrgAdmin.mockResolvedValueOnce(false);
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies disabled monitoring before section service access", async () => {
    mocks.isAgentMonitoringEnabledForUser.mockResolvedValueOnce(false);
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(403);
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies team policy to legacy bare teamId requests", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.isAgentMonitoringEnabledForUser).toHaveBeenCalledWith({
      clerkUserId: "user_clerk_1",
      userId: USER.id,
    });
    expect(mocks.findById).toHaveBeenCalledWith(TEAM_ID, USER.organizationId);
    expect(fetch).toHaveBeenCalledWith(
      {
        organizationId: USER.organizationId,
        scope: InsightsScope.Team,
        teamId: TEAM_ID,
        userId: USER.id,
      },
      InsightsPeriod.Quarter
    );
  });

  it("rejects mixed non-team scope and teamId before auth or service calls", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Me}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(400);
    expect(mocks.isAgentMonitoringEnabledForUser).not.toHaveBeenCalled();
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("createInsightsHandler insights feature flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue({ id: TEAM_ID });
    mocks.isAgentMonitoringEnabledForUser.mockResolvedValue(true);
    mocks.isInsightsEnabledForUser.mockResolvedValue(true);
    mocks.isMember.mockResolvedValue(true);
    mocks.isOrgAdmin.mockResolvedValue(false);
  });

  it("evaluates the flag against the request principal for the default scope", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(`/insights/delivery?period=${InsightsPeriod.Quarter}`)
    );

    expect(response.status).toBe(200);
    expect(mocks.isInsightsEnabledForUser).toHaveBeenCalledWith({
      userId: USER.id,
      clerkUserId: "user_clerk_1",
    });
  });

  it("denies the disabled flag before params, auth, or service access", async () => {
    mocks.isInsightsEnabledForUser.mockResolvedValueOnce(false);
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(403);
    expect(mocks.isAgentMonitoringEnabledForUser).not.toHaveBeenCalled();
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  // Note: the "fails closed when flag evaluation is unavailable" path is
  // covered in insights-feature.test.ts, where the PostHog client is mocked to
  // throw/return null. At this route-handler level `isInsightsEnabledForUser`
  // is mocked, so an "unavailable" case is indistinguishable from "disabled"
  // (both resolve `false`) — a duplicate of the test above, removed here.
});

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost:3002${path}`);
}
