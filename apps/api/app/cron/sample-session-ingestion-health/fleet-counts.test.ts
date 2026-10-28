/**
 * ISS-12050: the `session.fleet.*` dashboard gauges, driven through the
 * production service against a DB fake holding two active orgs (one with zero
 * sessions) and one deactivated org that has sessions. Both gauges are pinned to
 * ACTIVE orgs: 2 orgs (not the 1 with sessions, not all 3 rows) and 2 sessions
 * (not the 3 that include the deactivated org's).
 */
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organizationCount: vi.fn(),
  sessionDetailCount: vi.fn(),
  emitTelemetryMetric: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

import { metricsEmitted } from "@/__tests__/support/cron/sample-session-ingestion-health/service.test-fixtures";
import { sampleSessionFleetCounts } from "./service/fleet-counts";

const ORG_WITH_SESSIONS = "org-with-sessions";
const ORG_WITHOUT_SESSIONS = "org-without-sessions";
const ORG_DEACTIVATED = "org-deactivated";

const ORGANIZATIONS = [
  { id: ORG_WITH_SESSIONS, active: true },
  { id: ORG_WITHOUT_SESSIONS, active: true },
  { id: ORG_DEACTIVATED, active: false },
];
const SESSIONS = [
  { artifactId: "session-1", organizationId: ORG_WITH_SESSIONS },
  { artifactId: "session-2", organizationId: ORG_WITH_SESSIONS },
  { artifactId: "session-3", organizationId: ORG_DEACTIVATED },
];

type SessionCountArgs = {
  where?: {
    artifact?: { is?: { organization?: { is?: Record<string, unknown> } } };
  };
};

/**
 * Sessions: an absent `where` constrains nothing; the one predicate modelled is
 * the org relation filter, evaluated against the joined org row. Any other key
 * is outside the contract, so the fake refuses it rather than guessing.
 */
function countSessions(args?: SessionCountArgs) {
  const where = args?.where ?? {};
  const unexpected = Object.keys(where).filter((key) => key !== "artifact");
  if (unexpected.length > 0) {
    return Promise.reject(new Error(`unexpected predicate: ${unexpected}`));
  }
  const orgWhere = where.artifact?.is?.organization?.is ?? {};
  return Promise.resolve(
    SESSIONS.filter((session) => {
      const org = ORGANIZATIONS.find(
        (candidate) => candidate.id === session.organizationId
      );
      return (
        org !== undefined &&
        Object.entries(orgWhere).every(
          ([key, value]) => org[key as keyof typeof org] === value
        )
      );
    }).length
  );
}

/**
 * Organizations: Prisma equality semantics over scalar `where` keys — an absent
 * key constrains nothing, so dropping the active predicate counts all 3 rows.
 */
function countMatching<Row extends Record<string, unknown>>(rows: Row[]) {
  return (args?: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? {};
    return Promise.resolve(
      rows.filter((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value)
      ).length
    );
  };
}

function emittedMetrics(metric: string) {
  return metricsEmitted(mocks.emitTelemetryMetric, metric);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.organizationCount.mockImplementation(countMatching(ORGANIZATIONS));
  mocks.sessionDetailCount.mockImplementation(countSessions);
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      organization: { count: mocks.organizationCount },
      sessionDetail: { count: mocks.sessionDetailCount },
    })
  );
});

describe("sampleSessionFleetCounts", () => {
  it("counts only active orgs and their sessions, keeping active orgs with zero sessions", async () => {
    const counts = await sampleSessionFleetCounts();

    expect(emittedMetrics(FilterToken.SessionFleetTotalSessions)).toEqual([
      { metric: FilterToken.SessionFleetTotalSessions, value: 2 },
    ]);
    expect(emittedMetrics(FilterToken.SessionFleetTotalOrgs)).toEqual([
      { metric: FilterToken.SessionFleetTotalOrgs, value: 2 },
    ]);
    expect(counts).toEqual({ totalSessionCount: 2, totalOrgCount: 2 });
  });

  it("emits neither gauge when one count fails", async () => {
    mocks.organizationCount.mockRejectedValue(new Error("db down"));

    await expect(sampleSessionFleetCounts()).rejects.toThrow("db down");

    expect(emittedMetrics(FilterToken.SessionFleetTotalSessions)).toEqual([]);
    expect(emittedMetrics(FilterToken.SessionFleetTotalOrgs)).toEqual([]);
  });
});
