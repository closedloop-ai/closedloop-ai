/**
 * ISS-4829: the zero-active-org page and the platform-quiet withholding.
 *
 * Split out of `service.test.ts` (which crossed the 1,000-line ceiling) as its
 * own responsibility: everything here is about WHEN `session.ingestion.active_orgs`
 * is emitted at all, not about how an individual org is classified. The shared
 * fixtures live in `service.test-fixtures.ts` so the two suites cannot drift.
 */
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  computeTargetGroupBy: vi.fn(),
  computeTargetCount: vi.fn(),
  organizationFindMany: vi.fn(),
  emitTelemetryMetric: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

import {
  group,
  hoursAgo,
  type IngestGroup,
  lastSeenGroup,
  metricsEmitted,
  NOW,
  ORG_STALLED,
  type PresenceGroup,
  policyRow,
  routeGroupBy,
} from "@/__tests__/support/cron/sample-session-ingestion-health/service.test-fixtures";
import {
  SESSION_INGESTION_STALL_THRESHOLD_HOURS,
  sampleSessionIngestionHealth,
} from "./service";

function pinGroups(
  ingestGroups: IngestGroup[],
  lastSeenGroups?: PresenceGroup[]
): void {
  routeGroupBy(mocks.computeTargetGroupBy, ingestGroups, lastSeenGroups);
}

function emittedMetrics(metric: string) {
  return metricsEmitted(mocks.emitTelemetryMetric, metric);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  pinGroups([]);
  mocks.computeTargetCount.mockResolvedValue(0);
  mocks.organizationFindMany.mockResolvedValue([]);
  mocks.withDb.mockImplementation(
    (
      fn: (db: {
        computeTarget: {
          groupBy: typeof mocks.computeTargetGroupBy;
          count: typeof mocks.computeTargetCount;
        };
        organization: { findMany: typeof mocks.organizationFindMany };
      }) => unknown
    ) =>
      fn({
        computeTarget: {
          groupBy: mocks.computeTargetGroupBy,
          count: mocks.computeTargetCount,
        },
        organization: { findMany: mocks.organizationFindMany },
      })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sampleSessionIngestionHealth — platform-quiet withholding (ISS-4829)", () => {
  it("ISS-4829: a platform-wide quiet period does NOT fire the zero-active page", async () => {
    // A weekend. Every org is past the freshness window, none is attempting, and
    // none is stalled — but the fleet is still checking in, so the platform is
    // demonstrably reachable and this is a lull, not an outage. Emitting a `0`
    // active-org gauge here pages on ordinary inactivity, exactly the failure
    // ISS-4678 fixed for `stalled_orgs` and never applied to `active_orgs`.
    const quietAge = SESSION_INGESTION_STALL_THRESHOLD_HOURS + 30;
    pinGroups(
      [
        group("org-quiet-a", hoursAgo(quietAge)),
        group("org-quiet-b", hoursAgo(quietAge)),
      ],
      [
        lastSeenGroup("org-quiet-a", hoursAgo(0.05), hoursAgo(quietAge)),
        lastSeenGroup("org-quiet-b", hoursAgo(0.05), hoursAgo(quietAge)),
      ]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow("org-quiet-a", true),
      policyRow("org-quiet-b", true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.activeOrgCount).toBe(0);
    expect(summary.stalledOrgCount).toBe(0);
    expect(summary.quietOrgCount).toBe(2);
    expect(summary.fleetPresentOrgCount).toBe(2);
    expect(summary.platformQuiet).toBe(true);
    expect(emittedMetrics(FilterToken.SessionIngestionActiveOrgs)).toEqual([]);
    // The stalled gauge still reports every run — only the zero-active page is
    // withheld, and only for this shape.
    expect(emittedMetrics(FilterToken.SessionIngestionStalledOrgs)).toEqual([
      {
        metric: FilterToken.SessionIngestionStalledOrgs,
        value: 0,
        thresholdHours: SESSION_INGESTION_STALL_THRESHOLD_HOURS,
      },
    ]);
  });

  it("ISS-4829: a genuinely dark platform (nothing ingesting, no fleet reachable) STILL fires the zero-active page", async () => {
    // The negative case that keeps the suppression honest. Same zero-active,
    // zero-stalled, all-quiet shape as above — but NO org's fleet is checking
    // in. Nothing can reach us, which is the platform outage `active_orgs`
    // exists to catch, so the `0` must still be emitted.
    const quietAge = SESSION_INGESTION_STALL_THRESHOLD_HOURS + 30;
    pinGroups(
      [
        group("org-quiet-a", hoursAgo(quietAge)),
        group("org-quiet-b", hoursAgo(quietAge)),
      ],
      [
        lastSeenGroup("org-quiet-a", hoursAgo(quietAge)),
        lastSeenGroup("org-quiet-b", hoursAgo(quietAge)),
      ]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow("org-quiet-a", true),
      policyRow("org-quiet-b", true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.quietOrgCount).toBe(2);
    expect(summary.fleetPresentOrgCount).toBe(0);
    expect(summary.platformQuiet).toBe(false);
    expect(emittedMetrics(FilterToken.SessionIngestionActiveOrgs)).toEqual([
      {
        metric: FilterToken.SessionIngestionActiveOrgs,
        value: 0,
        windowHours: SESSION_INGESTION_STALL_THRESHOLD_HOURS,
        quietOrgCount: 2,
      },
    ]);
  });

  it("ISS-4829: a stalled platform with zero active orgs STILL fires the zero-active page", async () => {
    // The second negative case: zero active, but the orgs are STALLED, not
    // quiet. That is a real outage and must never be suppressed.
    pinGroups([
      group(ORG_STALLED, hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 3)),
    ]);
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_STALLED, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.activeOrgCount).toBe(0);
    expect(summary.stalledOrgCount).toBe(1);
    expect(summary.platformQuiet).toBe(false);
    expect(emittedMetrics(FilterToken.SessionIngestionActiveOrgs)).toEqual([
      {
        metric: FilterToken.SessionIngestionActiveOrgs,
        value: 0,
        windowHours: SESSION_INGESTION_STALL_THRESHOLD_HOURS,
        quietOrgCount: 0,
      },
    ]);
  });
});
