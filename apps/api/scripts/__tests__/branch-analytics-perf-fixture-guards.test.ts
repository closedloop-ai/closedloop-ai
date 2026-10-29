import { describe, expect, it } from "vitest";
import {
  BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_CLERK_ID,
  BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_NAME,
  BranchAnalyticsPerfFixtureRefusalCode,
  checkBranchAnalyticsPerfDatabaseUrl,
  checkBranchAnalyticsPerfFixtureOrganization,
} from "../branch-analytics-perf-fixture-guards";

describe("branch analytics perf fixture guards", () => {
  it("accepts the local Branch analytics fixture database", () => {
    expect(
      checkBranchAnalyticsPerfDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5432/closedloop_ai"
      )
    ).toEqual({ ok: true });
  });

  it("accepts the local perf database used by perf lanes", () => {
    expect(
      checkBranchAnalyticsPerfDatabaseUrl(
        "postgresql://postgres:postgres@127.0.0.1:5432/closedloop_perf"
      )
    ).toEqual({ ok: true });
  });

  it("accepts IPv6 loopback through the shared database localhost classifier", () => {
    expect(
      checkBranchAnalyticsPerfDatabaseUrl(
        "postgresql://postgres:postgres@[::1]:5432/closedloop_ai"
      )
    ).toEqual({ ok: true });
  });

  it("refuses missing, remote, host-overridden, and non-fixture database URLs", () => {
    expect(checkBranchAnalyticsPerfDatabaseUrl(undefined)).toMatchObject({
      ok: false,
      error: {
        code: BranchAnalyticsPerfFixtureRefusalCode.DatabaseUrlMissing,
      },
    });
    expect(
      checkBranchAnalyticsPerfDatabaseUrl(
        "postgresql://postgres:postgres@db.example.test:5432/closedloop_ai"
      )
    ).toMatchObject({
      ok: false,
      error: {
        code: BranchAnalyticsPerfFixtureRefusalCode.DatabaseUrlNotLocal,
      },
    });
    expect(
      checkBranchAnalyticsPerfDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5432/closedloop_ai?host=db.example.test"
      )
    ).toMatchObject({
      ok: false,
      error: {
        code: BranchAnalyticsPerfFixtureRefusalCode.DatabaseUrlHostOverride,
      },
    });
    expect(
      checkBranchAnalyticsPerfDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5432/app"
      )
    ).toMatchObject({
      ok: false,
      error: {
        code: BranchAnalyticsPerfFixtureRefusalCode.DatabaseUrlNotFixtureDatabase,
      },
    });
  });

  it("requires the fixture-owned organization sentinel before cleanup", () => {
    expect(
      checkBranchAnalyticsPerfFixtureOrganization({
        clerkId: BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_CLERK_ID,
        name: BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_NAME,
      })
    ).toEqual({ ok: true });

    expect(
      checkBranchAnalyticsPerfFixtureOrganization({
        clerkId: null,
        name: BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_NAME,
      })
    ).toMatchObject({
      ok: false,
      error: {
        code: BranchAnalyticsPerfFixtureRefusalCode.OrganizationSentinelMismatch,
      },
    });

    expect(
      checkBranchAnalyticsPerfFixtureOrganization({
        clerkId: BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_CLERK_ID,
        name: "Some Other Org",
      })
    ).toMatchObject({
      ok: false,
      error: {
        code: BranchAnalyticsPerfFixtureRefusalCode.OrganizationSentinelMismatch,
      },
    });
  });
});
