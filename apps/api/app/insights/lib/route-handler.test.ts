import {
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsInOrganization: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  isMember: vi.fn(),
  getOrgAdminStatus: vi.fn(),
}));

vi.mock("@/app/teams/service", () => ({
  teamsService: {
    existsInOrganization: mocks.existsInOrganization,
    isMember: mocks.isMember,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    flush: vi.fn(async () => undefined),
    info: mocks.logInfo,
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

import {
  ORG_ADMIN_STATUS_ADMIN,
  ORG_ADMIN_STATUS_NOT_ADMIN,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import type { InsightsScopeContext } from "../service/scope";
import { createInsightsHandler } from "./route-handler";
import { request, TEAM_ID, USER } from "./route-handler-test-fixtures";

const INVALID_TEAM_ID = "not-a-uuid";

const OFFSET_TIME_ZONE = "+01:00";
const CANONICAL_OFFSET_TIME_ZONE = "Etc/GMT-1";
const MALFORMED_TIME_ZONE = "Not/AZone";
// Chosen so UTC+1 has already rolled over while UTC has not: a canonicalization
// that drops, inverts, or mis-signs the offset buckets this instant onto a
// visibly different day rather than an equivalent one.
const BUCKETING_INSTANT = new Date("2026-03-15T23:30:00.000Z");
const OFFSET_LOCAL_DAY = "2026-03-16";
const UTC_LOCAL_DAY = "2026-03-15";

describe("createInsightsHandler team scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsInOrganization.mockResolvedValue(true);
    mocks.isMember.mockResolvedValue(true);
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
  });

  it("rejects team scope without teamId before auth or service calls", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
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
    expect(mocks.existsInOrganization).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid teamId before auth or service calls", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
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
    expect(mocks.existsInOrganization).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes team context to the section service for team members", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
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
    expect(mocks.existsInOrganization).toHaveBeenCalledWith(
      TEAM_ID,
      USER.organizationId
    );
    expect(mocks.isMember).toHaveBeenCalledWith(TEAM_ID, USER.id);
    expect(mocks.getOrgAdminStatus).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      {
        organizationId: USER.organizationId,
        scope: InsightsScope.Team,
        teamId: TEAM_ID,
        userId: USER.id,
        // ISS-8148: carried so a server-side flag gate can evaluate the Clerk
        // distinct-id namespace as well as the internal one.
        clerkUserId: "user_clerk_1",
        // The exact-object match is deliberate: a new context field must be
        // stated here rather than slipping through an `objectContaining`.
        // ISS-10541 removed `sessionDateField` — the windowed reads no longer
        // take a basis off the context, so a context that still carried one
        // would be a field nothing consumes.
      },
      InsightsPeriod.Quarter
    );
  });

  it("passes team context to the section service for org admins", async () => {
    mocks.isMember.mockResolvedValueOnce(false);
    mocks.getOrgAdminStatus.mockResolvedValueOnce(ORG_ADMIN_STATUS_ADMIN);
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
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
    expect(mocks.getOrgAdminStatus).toHaveBeenCalledWith(
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
    mocks.existsInOrganization.mockResolvedValueOnce(false);
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
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
    mocks.getOrgAdminStatus.mockResolvedValueOnce(ORG_ADMIN_STATUS_NOT_ADMIN);
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
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

  it("applies team policy to legacy bare teamId requests", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
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
    expect(mocks.existsInOrganization).toHaveBeenCalledWith(
      TEAM_ID,
      USER.organizationId
    );
    expect(fetch).toHaveBeenCalledWith(
      {
        organizationId: USER.organizationId,
        scope: InsightsScope.Team,
        teamId: TEAM_ID,
        userId: USER.id,
        // ISS-8148: carried so a server-side flag gate can evaluate the Clerk
        // distinct-id namespace as well as the internal one.
        clerkUserId: "user_clerk_1",
        // The exact-object match is deliberate: a new context field must be
        // stated here rather than slipping through an `objectContaining`.
        // ISS-10541 removed `sessionDateField` — the windowed reads no longer
        // take a basis off the context, so a context that still carried one
        // would be a field nothing consumes.
      },
      InsightsPeriod.Quarter
    );
  });

  it("rejects mixed non-team scope and teamId before auth or service calls", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
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
    expect(mocks.existsInOrganization).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("createInsightsHandler failure logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsInOrganization.mockResolvedValue(true);
    mocks.isMember.mockResolvedValue(true);
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
  });

  it("logs a section failure with the team-scope correlation", async () => {
    const error = new Error("insights service unavailable");
    const fetch = vi.fn().mockRejectedValue(error);
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Utilization,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/utilization?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith("insights.utilization_failed", {
      error,
      organizationId: USER.organizationId,
      userId: USER.id,
      scope: InsightsScope.Team,
      teamId: TEAM_ID,
    });
  });

  it("correlates a failure raised by team-scope authorization, before the service call", async () => {
    const error = new Error("team scope authorization exploded");
    // Non-member falls through to the org-admin check, which is what throws.
    mocks.isMember.mockResolvedValue(false);
    mocks.getOrgAdminStatus.mockRejectedValue(error);
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Agents,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/agents?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith("insights.agents_failed", {
      error,
      organizationId: USER.organizationId,
      userId: USER.id,
      scope: InsightsScope.Team,
      teamId: TEAM_ID,
    });
  });

  it("omits teamId from the correlation outside team scope", async () => {
    const error = new Error("insights service unavailable");
    const fetch = vi.fn().mockRejectedValue(error);
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Org}`
      )
    );

    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith("insights.delivery_failed", {
      error,
      organizationId: USER.organizationId,
      userId: USER.id,
      scope: InsightsScope.Org,
      teamId: undefined,
    });
  });
});

describe("createInsightsHandler unsupported query params (ISS-4505)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMember.mockResolvedValue(true);
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
  });

  it("rejects unsupported query params on the default path", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request("/insights/delivery?unknownFilter=value")
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported query params via the legacy teamId transform path", async () => {
    mocks.existsInOrganization.mockResolvedValue(true);
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(`/insights/delivery?teamId=${TEAM_ID}&unknownFilter=value`)
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// FEA-2881: `../validators` canonicalizes the caller's timezone at the single
// seam every downstream consumer reads from — PG's `AT TIME ZONE` bucketing and
// the JS day-key labeling both take it from `ctx.timeZone`. These cases assert
// the delivered zone AND the day it buckets onto, rather than the `undefined`
// representation of the fallback: an absent zone and a malformed one both
// legitimately produce `undefined`, so the day it buckets onto is the outcome
// worth stating, and it survives a refactor that returns "UTC" over null.
describe("createInsightsHandler timezone canonicalization (FEA-2881)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMember.mockResolvedValue(true);
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
  });

  it("delivers an offset zone as the Etc/GMT name PG and Intl bucket alike", async () => {
    let received: InsightsScopeContext | undefined;
    const fetch = vi.fn((ctx: InsightsScopeContext) => {
      received = ctx;
      return Promise.resolve({ kpis: [], charts: {} });
    });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?timeZone=${encodeURIComponent(OFFSET_TIME_ZONE)}`
      )
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Load-bearing: `Intl` reads a raw `+01:00` correctly, so the day-key oracle
    // below passes even when the offset survives un-normalized. Only the
    // canonical NAME proves the value handed to SQL is one PG signs the same way.
    expect(received?.timeZone).toBe(CANONICAL_OFFSET_TIME_ZONE);
    // ...and the canonical name must still mean the caller's local day.
    expect(dayKey(BUCKETING_INSTANT, received?.timeZone)).toBe(
      dayKey(BUCKETING_INSTANT, OFFSET_TIME_ZONE)
    );
    expect(dayKey(BUCKETING_INSTANT, received?.timeZone)).toBe(
      OFFSET_LOCAL_DAY
    );
  });

  it("buckets a malformed zone in UTC instead of rejecting the chart request", async () => {
    let received: InsightsScopeContext | undefined;
    const fetch = vi.fn((ctx: InsightsScopeContext) => {
      received = ctx;
      return Promise.resolve({ kpis: [], charts: {} });
    });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(
        `/insights/delivery?timeZone=${encodeURIComponent(MALFORMED_TIME_ZONE)}`
      )
    );

    // 200 is load-bearing twice over: the request was not rejected, and since
    // the schema is `.strict()`, an accepted `timeZone` key proves the param
    // reached the validator rather than going green by never existing.
    expect(response.status).toBe(200);
    // Closes the vacuous path: without a call, `received` stays undefined and
    // `dayKey` would default it to UTC and pass having observed nothing.
    expect(fetch).toHaveBeenCalledTimes(1);
    // `dayKey` throws a RangeError on an un-dropped malformed zone, so this also
    // pins that the garbage never reaches a consumer that formats with it.
    expect(dayKey(BUCKETING_INSTANT, received?.timeZone)).toBe(
      dayKey(BUCKETING_INSTANT, "UTC")
    );
    expect(dayKey(BUCKETING_INSTANT, received?.timeZone)).toBe(UTC_LOCAL_DAY);
  });
});

// The two cross-field rules are already known to 400 (above); these pin WHICH
// field the client is told to blame and WHICH rule fired. `formatZodErrors`
// prefixes the issue path, so dropping `path: ["teamId"]` from either branch
// degrades the message while every status-only assertion stays green.
describe("createInsightsHandler scope/teamId cross-field diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMember.mockResolvedValue(true);
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
  });

  it("blames the teamId field when team scope arrives without one", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(`/insights/delivery?scope=${InsightsScope.Team}`)
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("teamId: teamId is required when scope is team");
  });

  it("blames the teamId field when a teamId arrives outside team scope", async () => {
    const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request(`/insights/delivery?scope=${InsightsScope.Me}&teamId=${TEAM_ID}`)
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("teamId: teamId requires scope team");
  });
});

// Every other case in this file sends `period` explicitly, and the ones that
// omit `scope` either 400 first or go through the preprocessor's forced Team
// override — so the two bare `.default()` literals in `../validators` reached
// the service unasserted, and retuning either one changed no status anywhere.
describe("createInsightsHandler query defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMember.mockResolvedValue(true);
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
  });

  it("defaults an unqualified query to the quarter period and me scope", async () => {
    let received: InsightsScopeContext | undefined;
    let receivedPeriod: InsightsPeriod | undefined;
    const fetch = vi.fn((ctx: InsightsScopeContext, period: InsightsPeriod) => {
      received = ctx;
      receivedPeriod = period;
      return Promise.resolve({ kpis: [], charts: {} });
    });
    const handler = createInsightsHandler({
      fetch,
      section: InsightsSection.Delivery,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      {
        user: USER,
        clerkOrgId: "org_clerk_1",
        clerkUserId: "user_clerk_1",
      },
      request("/insights/delivery")
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(receivedPeriod).toBe(InsightsPeriod.Quarter);
    expect(received?.scope).toBe(InsightsScope.Me);
    // A default that widened to a team or org scope would read another
    // population's data for a caller who asked for none.
    expect(received?.teamId).toBeUndefined();
  });
});

/** The calendar day an instant lands on in `timeZone`, UTC when none survived. */
function dayKey(instant: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
