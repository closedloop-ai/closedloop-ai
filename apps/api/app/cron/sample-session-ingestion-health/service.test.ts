import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";

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
  type GroupByArgs,
  group,
  hoursAgo,
  type IngestGroup,
  lastSeenGroup,
  MS_PER_HOUR,
  metricsEmitted,
  NOW,
  ORG_ACTIVE,
  ORG_DORMANT,
  ORG_STALLED,
  type PresenceGroup,
  policyRow,
  routeGroupBy,
} from "@/__tests__/support/cron/sample-session-ingestion-health/service.test-fixtures";
import {
  SESSION_INGESTION_DORMANT_AFTER_HOURS,
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

describe("sampleSessionIngestionHealth", () => {
  it("classifies orgs as active, stalled, or dormant by ingest age", async () => {
    pinGroups(
      [
        group(ORG_ACTIVE, hoursAgo(1)),
        group(
          ORG_STALLED,
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 1)
        ),
        group(ORG_DORMANT, hoursAgo(SESSION_INGESTION_DORMANT_AFTER_HOURS + 1)),
      ],
      [
        lastSeenGroup(ORG_ACTIVE, NOW),
        lastSeenGroup(ORG_STALLED, NOW),
        // ISS-4831: a dormant org's fleet is gone too. Giving it a fresh ATTEMPT
        // would (correctly) reclassify it as a returning-and-failing org, which
        // is a different test below.
        lastSeenGroup(
          ORG_DORMANT,
          hoursAgo(SESSION_INGESTION_DORMANT_AFTER_HOURS + 1)
        ),
      ]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_ACTIVE, true),
      policyRow(ORG_STALLED, true),
      policyRow(ORG_DORMANT, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary).toMatchObject({
      orgsWithIngestHistory: 3,
      activeOrgCount: 1,
      stalledOrgCount: 1,
      quietOrgCount: 0,
      dormantOrgCount: 1,
    });
    expect(emittedMetrics(FilterToken.SessionIngestionStalledOrgs)).toEqual([
      {
        metric: FilterToken.SessionIngestionStalledOrgs,
        value: 1,
        thresholdHours: SESSION_INGESTION_STALL_THRESHOLD_HOURS,
      },
    ]);
    expect(emittedMetrics(FilterToken.SessionIngestionActiveOrgs)).toEqual([
      {
        metric: FilterToken.SessionIngestionActiveOrgs,
        value: 1,
        windowHours: SESSION_INGESTION_STALL_THRESHOLD_HOURS,
        quietOrgCount: 0,
      },
    ]);
  });

  it("treats an org exactly at the stall threshold as still active", async () => {
    pinGroups([
      group(ORG_ACTIVE, hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS)),
    ]);
    mocks.organizationFindMany.mockResolvedValue([policyRow(ORG_ACTIVE, true)]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.activeOrgCount).toBe(1);
    expect(summary.stalledOrgCount).toBe(0);
  });

  it("reports a stalled org whose sync policy is disabled — the ISS-4537 shape", async () => {
    // The org that caused the outage had ingested before, then went silent
    // because FEA-4169's fail-closed gate denied every subsequent batch. The
    // stall must be counted regardless of the policy value, and the policy
    // state must ride along so an operator can tell the two causes apart.
    pinGroups([
      group(ORG_STALLED, hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 2)),
    ]);
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_STALLED, false),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.stalledOrgCount).toBe(1);
    expect(emittedMetrics(FilterToken.SessionIngestionStaleness)).toEqual([
      {
        metric: FilterToken.SessionIngestionStaleness,
        orgId: ORG_STALLED,
        policyEnabled: false,
        value: (SESSION_INGESTION_STALL_THRESHOLD_HOURS + 2) * MS_PER_HOUR,
      },
    ]);
  });

  it("excludes never-synced devices from the date window instead of counting them as stalled", async () => {
    // `lastAgentSessionSyncAt` is nullable and NULL means "never ingested",
    // not "ingested long ago". A null must never be folded into the staleness
    // window as an infinitely old timestamp.
    pinGroups([]);
    mocks.computeTargetCount.mockResolvedValue(7);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(mocks.computeTargetGroupBy).toHaveBeenCalledWith({
      by: ["organizationId"],
      where: { isCloudSentinel: false, lastAgentSessionSyncAt: { not: null } },
      _max: { lastAgentSessionSyncAt: true },
    });
    expect(mocks.computeTargetCount).toHaveBeenCalledWith({
      where: { isCloudSentinel: false, lastAgentSessionSyncAt: null },
    });
    expect(summary.neverIngestedTargetCount).toBe(7);
    expect(summary.stalledOrgCount).toBe(0);
    expect(summary.orgsWithIngestHistory).toBe(0);
    expect(emittedMetrics(FilterToken.SessionIngestionStaleness)).toEqual([]);
  });

  it("drops a group whose aggregate ingest timestamp is null rather than inventing one", async () => {
    pinGroups([
      group(ORG_ACTIVE, null),
      group(ORG_STALLED, hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 3)),
    ]);
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_STALLED, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.orgsWithIngestHistory).toBe(1);
    expect(mocks.organizationFindMany).toHaveBeenCalledWith({
      where: { active: true, id: { in: [ORG_STALLED] } },
      select: { id: true, sessionSyncPolicyEnabled: true },
    });
  });

  it("skips orgs that no longer resolve as active", async () => {
    pinGroups([
      group(ORG_STALLED, hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 4)),
    ]);
    mocks.organizationFindMany.mockResolvedValue([]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.orgsWithIngestHistory).toBe(0);
    expect(summary.stalledOrgCount).toBe(0);
    expect(emittedMetrics(FilterToken.SessionIngestionStaleness)).toEqual([]);
  });

  it("clamps a future-dated sync timestamp to zero staleness", async () => {
    pinGroups([group(ORG_ACTIVE, new Date(NOW.getTime() + 5 * 60 * 1000))]);
    mocks.organizationFindMany.mockResolvedValue([policyRow(ORG_ACTIVE, true)]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.activeOrgCount).toBe(1);
    expect(emittedMetrics(FilterToken.SessionIngestionStaleness)).toEqual([
      {
        metric: FilterToken.SessionIngestionStaleness,
        orgId: ORG_ACTIVE,
        policyEnabled: true,
        value: 0,
      },
    ]);
  });

  it("caps per-org staleness samples and keeps the most stale orgs", async () => {
    const orgCount = 130;
    const groups: IngestGroup[] = [];
    const policies: Array<{ id: string; sessionSyncPolicyEnabled: boolean }> =
      [];
    for (let index = 0; index < orgCount; index++) {
      const orgId = `org-${index}`;
      // Older index => more recent sync, so the LAST org is the most stale.
      groups.push(group(orgId, hoursAgo(index / 60)));
      policies.push(policyRow(orgId, true));
    }
    pinGroups(groups);
    mocks.organizationFindMany.mockResolvedValue(policies);

    const summary = await sampleSessionIngestionHealth(new Date());

    const staleness = emittedMetrics(FilterToken.SessionIngestionStaleness);
    expect(summary.orgsWithIngestHistory).toBe(orgCount);
    expect(summary.stalenessSamplesEmitted).toBe(100);
    expect(staleness).toHaveLength(100);
    expect(staleness[0].orgId).toBe(`org-${orgCount - 1}`);
    expect(staleness.some((payload) => payload.orgId === "org-0")).toBe(false);
  });

  it("never lets dormant orgs crowd stalled orgs out of the capped samples", async () => {
    // Dormant orgs are the MOST stale rows by definition, so a most-stale-first
    // cap that included them would spend the entire budget on churned orgs and
    // silently drop the orgs the page exists to name.
    const groups: IngestGroup[] = [];
    const policies: Array<{ id: string; sessionSyncPolicyEnabled: boolean }> =
      [];
    const fleets: PresenceGroup[] = [];
    for (let index = 0; index < 120; index++) {
      const orgId = `dormant-${index}`;
      const ageHours = SESSION_INGESTION_DORMANT_AFTER_HOURS + 1 + index;
      groups.push(group(orgId, hoursAgo(ageHours)));
      // A churned org's fleet stopped checking in and stopped attempting at the
      // same time it stopped ingesting.
      fleets.push(lastSeenGroup(orgId, hoursAgo(ageHours)));
      policies.push(policyRow(orgId, true));
    }
    groups.push(
      group(ORG_STALLED, hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 1))
    );
    fleets.push(lastSeenGroup(ORG_STALLED, NOW));
    policies.push(policyRow(ORG_STALLED, false));
    pinGroups(groups, fleets);
    mocks.organizationFindMany.mockResolvedValue(policies);

    const summary = await sampleSessionIngestionHealth(new Date());

    const staleness = emittedMetrics(FilterToken.SessionIngestionStaleness);
    expect(summary.dormantOrgCount).toBe(120);
    expect(summary.stalledOrgCount).toBe(1);
    expect(staleness.map((payload) => payload.orgId)).toEqual([ORG_STALLED]);
    expect(summary.stalenessSamplesEmitted).toBe(1);
  });

  it("bounds the policy IN and top-100 across a fleet larger than the bind-chunk width", async () => {
    // A synthetic fleet whose org count EXCEEDS 5x the policy-lookup bind-chunk
    // width (1000), i.e. more chunks than the fan-out concurrency bound (5): the
    // sampler must chunk each id array so no single `IN` crosses the driver
    // bind-parameter ceiling, run the chunks through the BOUNDED fan-out (never a
    // single unbounded Promise.all that would peak at one pooled connection per
    // chunk), keep EXACT active/stalled/dormant counts by merging the chunk
    // results, and emit the true top-100 most-stale — not an arbitrary 100
    // (ISS-4708). Staleness grows monotonically with index, so the last-indexed
    // orgs in each class are the most stale within that class.
    const CHUNK_WIDTH = 1000;
    const activeCount = 3000;
    const stalledCount = 2000;
    const dormantCount = 1000;
    const totalOrgs = activeCount + stalledCount + dormantCount;
    const expectedChunks = Math.ceil(totalOrgs / CHUNK_WIDTH);

    const groups: IngestGroup[] = [];
    const lastSeenGroups: PresenceGroup[] = [];
    const policies: Array<{ id: string; sessionSyncPolicyEnabled: boolean }> =
      [];

    // Active: a few seconds ago each — always inside the 6h stall window even at
    // 3000 orgs (max ~50 minutes back), so none spill into the stalled class.
    for (let index = 0; index < activeCount; index++) {
      const orgId = `active-${index}`;
      groups.push(group(orgId, hoursAgo((index + 1) / 3600)));
      lastSeenGroups.push(lastSeenGroup(orgId, NOW));
      policies.push(policyRow(orgId, true));
    }
    // Stalled: strictly inside (stall threshold, dormant cutoff), each with a
    // fresh heartbeat so they classify stalled (present-but-not-landing). Spread
    // across that window by a fraction of an hour per index so all stay stalled
    // (never crossing the 7-day dormant cutoff) and staleness is monotonic in
    // index — the highest-index stalled orgs are the most stale reportable ones.
    for (let index = 0; index < stalledCount; index++) {
      const orgId = `stalled-${index}`;
      groups.push(
        group(
          orgId,
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 1 + index / 1000)
        )
      );
      lastSeenGroups.push(lastSeenGroup(orgId, NOW));
      policies.push(policyRow(orgId, true));
    }
    // Dormant: past the dormant cutoff — the MOST stale rows, and excluded from
    // the emitted samples entirely.
    for (let index = 0; index < dormantCount; index++) {
      const orgId = `dormant-${index}`;
      const ageHours = SESSION_INGESTION_DORMANT_AFTER_HOURS + 1 + index;
      groups.push(group(orgId, hoursAgo(ageHours)));
      // ISS-4831: a churned org's fleet is gone — no heartbeat, no attempt. An
      // org that IS still attempting is a returning org, not a dormant one, and
      // is covered separately.
      lastSeenGroups.push(lastSeenGroup(orgId, hoursAgo(ageHours)));
      policies.push(policyRow(orgId, true));
    }

    // Track peak in-flight policy chunk reads and honor `where.id.in` so the
    // merged result can only be correct if the chunks were actually merged (not
    // a full-fleet passthrough per chunk). Yield across several microtasks inside
    // the tracked window so overlapping chunk calls are observed simultaneously —
    // an unbounded Promise.all would then peak at `expectedChunks` (> 5), a
    // bounded fan-out at the concurrency bound.
    const policyById = new Map(
      policies.map((policy) => [policy.id, policy] as const)
    );
    const policyFanout = { inFlight: 0, peak: 0 };
    mocks.organizationFindMany.mockImplementation(
      async (args: { where: { id: { in: string[] } } }) => {
        policyFanout.inFlight += 1;
        policyFanout.peak = Math.max(policyFanout.peak, policyFanout.inFlight);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        policyFanout.inFlight -= 1;
        return args.where.id.in
          .map((id) => policyById.get(id))
          .filter((policy) => policy !== undefined);
      }
    );

    // Route the two groupBy scans by `_max` shape, and — like the policy mock —
    // honor `where.organizationId.in` so the heartbeat scan is also proven to be
    // chunked-and-merged rather than a full-fleet passthrough per chunk.
    const lastSeenById = new Map(
      lastSeenGroups.map((entry) => [entry.organizationId, entry] as const)
    );
    mocks.computeTargetGroupBy.mockImplementation(
      (
        args: GroupByArgs & { where?: { organizationId?: { in: string[] } } }
      ) => {
        if (args._max?.lastSeenAt) {
          const ids = args.where?.organizationId?.in ?? [];
          return Promise.resolve(
            ids
              .map((id) => lastSeenById.get(id))
              .filter((entry) => entry !== undefined)
          );
        }
        return Promise.resolve(groups);
      }
    );

    const summary = await sampleSessionIngestionHealth(new Date());

    // Exact counts preserved across every chunk.
    expect(summary.orgsWithIngestHistory).toBe(totalOrgs);
    expect(summary.activeOrgCount).toBe(activeCount);
    expect(summary.stalledOrgCount).toBe(stalledCount);
    expect(summary.dormantOrgCount).toBe(dormantCount);

    // The policy IN was chunked: every call's id array stays within the bind
    // width, the chunks together cover the whole fleet exactly once, and the
    // fan-out stayed bounded (peaked at the concurrency bound, not one pooled
    // connection per chunk) despite more chunks than the bound.
    const inArrays = mocks.organizationFindMany.mock.calls.map(
      ([args]) => args.where.id.in as string[]
    );
    expect(inArrays.length).toBe(expectedChunks);
    for (const idArray of inArrays) {
      expect(idArray.length).toBeLessThanOrEqual(CHUNK_WIDTH);
    }
    expect(inArrays.flat().sort()).toEqual(
      policies.map((policy) => policy.id).sort()
    );
    expect(expectedChunks).toBeGreaterThan(DB_FANOUT_MAX_CONCURRENCY);
    expect(policyFanout.peak).toBeGreaterThan(1);
    expect(policyFanout.peak).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);

    // The heartbeat scan was chunked the same way over the same fleet.
    const heartbeatInArrays = mocks.computeTargetGroupBy.mock.calls
      .filter(([args]) => (args as GroupByArgs)._max?.lastSeenAt)
      .map(
        ([args]) =>
          (args as { where: { organizationId: { in: string[] } } }).where
            .organizationId.in
      );
    expect(heartbeatInArrays.length).toBe(expectedChunks);
    expect(heartbeatInArrays.flat().sort()).toEqual(
      policies.map((policy) => policy.id).sort()
    );

    // The emitted set is the correct top-100 most-stale REPORTABLE orgs (active
    // + stalled; dormant excluded), most-stale-first. The most stale reportable
    // orgs are the last-indexed stalled orgs.
    const staleness = emittedMetrics(FilterToken.SessionIngestionStaleness);
    expect(summary.stalenessSamplesEmitted).toBe(100);
    expect(staleness).toHaveLength(100);
    const expectedTopIds: string[] = [];
    for (let index = 0; index < 100; index++) {
      expectedTopIds.push(`stalled-${stalledCount - 1 - index}`);
    }
    expect(staleness.map((payload) => payload.orgId)).toEqual(expectedTopIds);
    // No dormant org leaked into the samples despite being strictly more stale.
    expect(
      staleness.some((payload) => payload.orgId.startsWith("dormant-"))
    ).toBe(false);
  });

  it("ISS-4830: keeps quiet orgs out of the staleness emission entirely", async () => {
    // A quiet org is past the stall threshold too, so it can be MORE stale than a
    // genuinely-stalled org — and `session.ingestion.staleness` carries only
    // (orgId, policyEnabled, value), so a quiet row and a stalled row are
    // INDISTINGUISHABLE to an operator drilling into a `stalled_orgs` page. Quiet
    // rows are therefore not emitted at all: every org named by this metric is
    // one the page is about, and the emission can no longer be filled by a
    // weekend's worth of idle orgs.
    const ingestGroups: IngestGroup[] = [];
    const lastSeenGroups: PresenceGroup[] = [];
    const policies: Array<{ id: string; sessionSyncPolicyEnabled: boolean }> =
      [];
    // 120 quiet orgs, each MORE stale than the stalled org but still short of the
    // dormant cutoff, and each with a stale heartbeat so they classify quiet.
    // Ages span (threshold+2h .. threshold+62h), all below DORMANT_AFTER_HOURS.
    for (let index = 0; index < 120; index++) {
      const orgId = `quiet-${index}`;
      const ageHours =
        SESSION_INGESTION_STALL_THRESHOLD_HOURS + 2 + index * 0.5;
      ingestGroups.push(group(orgId, hoursAgo(ageHours)));
      lastSeenGroups.push(lastSeenGroup(orgId, hoursAgo(ageHours)));
      policies.push(policyRow(orgId, true));
    }
    // One stalled org: past the threshold but LESS stale than every quiet org,
    // with a fresh heartbeat so it classifies stalled.
    ingestGroups.push(
      group(ORG_STALLED, hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 1))
    );
    lastSeenGroups.push(lastSeenGroup(ORG_STALLED, hoursAgo(0.5)));
    policies.push(policyRow(ORG_STALLED, false));
    pinGroups(ingestGroups, lastSeenGroups);
    mocks.organizationFindMany.mockResolvedValue(policies);

    const summary = await sampleSessionIngestionHealth(new Date());

    const staleness = emittedMetrics(FilterToken.SessionIngestionStaleness);
    expect(summary.stalledOrgCount).toBe(1);
    expect(summary.quietOrgCount).toBe(120);
    // Exactly one sample: the stalled org. Not 100, and not a mixed set an
    // operator would have to guess at.
    expect(summary.stalenessSamplesEmitted).toBe(1);
    expect(staleness.map((payload) => payload.orgId)).toEqual([ORG_STALLED]);
    expect(
      staleness.some((payload) => payload.orgId.startsWith("quiet-"))
    ).toBe(false);
  });

  it("ISS-4678: does NOT count a quiet-but-healthy org (old ingest, no recent heartbeat) as stalled", async () => {
    // The false-page shape: an org that simply had no new sessions overnight or
    // over a weekend. Its ingest watermark is old (only ACCEPTED batches advance
    // it, and Desktop only posts when sessions are queued) but its desktop fleet
    // has also gone quiet. No work is happening — this is NOT an ingestion
    // outage and must not page.
    pinGroups(
      [
        group(
          ORG_STALLED,
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 2)
        ),
      ],
      [
        lastSeenGroup(
          ORG_STALLED,
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 2)
        ),
      ]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_STALLED, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.stalledOrgCount).toBe(0);
    expect(summary.quietOrgCount).toBe(1);
    expect(summary.dormantOrgCount).toBe(0);
    expect(emittedMetrics(FilterToken.SessionIngestionStalledOrgs)).toEqual([
      {
        metric: FilterToken.SessionIngestionStalledOrgs,
        value: 0,
        thresholdHours: SESSION_INGESTION_STALL_THRESHOLD_HOURS,
      },
    ]);
    // ISS-4830: a quiet org emits no per-org staleness sample at all.
    expect(emittedMetrics(FilterToken.SessionIngestionStaleness)).toEqual([]);
  });

  it("ISS-4678: DOES count an org past the threshold whose fleet is still present as stalled", async () => {
    // Genuine ingestion failure / attempt-and-denied: the ISS-4537 shape. A live
    // desktop is checking in (recent heartbeat) but its session data is not
    // landing — an old ingest watermark with a fresh presence signal.
    pinGroups(
      [
        group(
          ORG_STALLED,
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 2)
        ),
      ],
      [lastSeenGroup(ORG_STALLED, hoursAgo(0.5))]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_STALLED, false),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.stalledOrgCount).toBe(1);
    expect(summary.quietOrgCount).toBe(0);
    expect(emittedMetrics(FilterToken.SessionIngestionStalledOrgs)).toEqual([
      {
        metric: FilterToken.SessionIngestionStalledOrgs,
        value: 1,
        thresholdHours: SESSION_INGESTION_STALL_THRESHOLD_HOURS,
      },
    ]);
  });

  it("ISS-4678: treats an org with no resolvable heartbeat as quiet, never stalled", async () => {
    // A null/absent heartbeat is not positive evidence of an attempting fleet.
    // The classifier only pages on POSITIVE presence, so a missing signal
    // degrades to the non-paging (quiet) side — no false page from a data gap.
    pinGroups(
      [
        group(
          ORG_STALLED,
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 2)
        ),
      ],
      []
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_STALLED, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.stalledOrgCount).toBe(0);
    expect(summary.quietOrgCount).toBe(1);
  });

  it("ISS-4678: a present fleet exactly at the activity window still counts as stalled", async () => {
    pinGroups(
      [
        group(
          ORG_STALLED,
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 1)
        ),
      ],
      [
        lastSeenGroup(
          ORG_STALLED,
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS)
        ),
      ]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_STALLED, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.stalledOrgCount).toBe(1);
    expect(summary.quietOrgCount).toBe(0);
  });

  it("ISS-4678: never queries the fleet scan when no org has ingest history", async () => {
    const summary = await sampleSessionIngestionHealth(new Date());

    // loadPresenceByOrg short-circuits on an empty id list, so the only groupBy
    // issued is the ingest-watermark scan — the fleet scan is skipped.
    const lastSeenScans = mocks.computeTargetGroupBy.mock.calls.filter(
      ([args]) => (args as GroupByArgs)._max?.lastSeenAt
    );
    expect(lastSeenScans).toHaveLength(0);
    expect(summary.quietOrgCount).toBe(0);
  });

  it("ISS-4827: an idle-but-open desktop (fresh heartbeat, no ingest attempt) is QUIET, not stalled", async () => {
    // THE false page this ticket exists to kill. A developer leaves the desktop
    // app open over a long weekend and does no agent work. `lastSeenAt` is
    // refreshed every ~30-90s by registration/heartbeat/online check-ins, so the
    // fleet looks maximally "present" — but the sync service sends NO ingest
    // request when its queues are empty, so nothing was ever attempted. Presence
    // is not an attempt: this org must not page.
    pinGroups(
      [
        group(
          ORG_STALLED,
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 12)
        ),
      ],
      [
        lastSeenGroup(
          ORG_STALLED,
          // Heartbeat 20 SECONDS old — as present as a fleet can possibly be.
          new Date(NOW.getTime() - 20 * 1000),
          // ...but the last accepted batch is as old as the ingest watermark.
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 12)
        ),
      ]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_STALLED, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.stalledOrgCount).toBe(0);
    expect(summary.quietOrgCount).toBe(1);
    // Presence is still observed — it is just not what classifies the org.
    expect(summary.fleetPresentOrgCount).toBe(1);
    expect(emittedMetrics(FilterToken.SessionIngestionStalledOrgs)).toEqual([
      {
        metric: FilterToken.SessionIngestionStalledOrgs,
        value: 0,
        thresholdHours: SESSION_INGESTION_STALL_THRESHOLD_HOURS,
      },
    ]);
  });

  it("ISS-4827: a wedged sync queue (attempting, not landing) is still STALLED", async () => {
    // The genuine outage the detector must keep catching: a desktop whose
    // batches ARE being accepted (empty or all-foreign-chunk, so zero rows land)
    // while its session data never persists. The attempt watermark is fresh, the
    // landed-data watermark is old — page.
    pinGroups(
      [
        group(
          ORG_STALLED,
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 12)
        ),
      ],
      [
        lastSeenGroup(
          ORG_STALLED,
          // A DEAD heartbeat, to prove the classification is driven by the
          // attempt watermark alone and not by presence leaking back in.
          hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 12),
          hoursAgo(0.25)
        ),
      ]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_STALLED, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.stalledOrgCount).toBe(1);
    expect(summary.quietOrgCount).toBe(0);
    expect(summary.fleetPresentOrgCount).toBe(0);
    expect(emittedMetrics(FilterToken.SessionIngestionStalledOrgs)).toEqual([
      {
        metric: FilterToken.SessionIngestionStalledOrgs,
        value: 1,
        thresholdHours: SESSION_INGESTION_STALL_THRESHOLD_HOURS,
      },
    ]);
    // ISS-4830: a stalled org DOES get named in the per-org emission.
    expect(emittedMetrics(FilterToken.SessionIngestionStaleness)).toEqual([
      {
        metric: FilterToken.SessionIngestionStaleness,
        orgId: ORG_STALLED,
        policyEnabled: true,
        value: (SESSION_INGESTION_STALL_THRESHOLD_HOURS + 12) * MS_PER_HOUR,
      },
    ]);
  });

  it("ISS-4827: a pre-acceptance outage (both watermarks equally stale, fleet present) is QUIET, not stalled", async () => {
    // Review, PR #4256 — the KNOWN LIMIT of the attempt signal, pinned so it is
    // a documented trade rather than an accident. When ingest fails BEFORE a
    // batch is accepted (auth, org policy, a 5xx that never reaches the ingest
    // service), nothing stamps the attempt watermark, so it ages in lockstep
    // with the landed-data one and both cross the window together. Heartbeats
    // keep flowing, so the fleet still reads as present. The classifier pages
    // only on POSITIVE attempt evidence, so this is QUIET — see the KNOWN LIMIT
    // block on `classifyOrgIngestionRow` for why that trade is deliberate and
    // which faster signals cover these classes instead.
    const equallyStale = hoursAgo(SESSION_INGESTION_STALL_THRESHOLD_HOURS + 1);
    pinGroups(
      [group(ORG_STALLED, equallyStale)],
      [lastSeenGroup(ORG_STALLED, NOW, equallyStale)]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_STALLED, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.stalledOrgCount).toBe(0);
    expect(summary.quietOrgCount).toBe(1);
    // Presence is still observed — it is the platform-reach signal, not a
    // classifier input, and it is what makes this run read as platform-quiet.
    expect(summary.fleetPresentOrgCount).toBe(1);
    expect(summary.platformQuiet).toBe(true);
  });

  it("ISS-4831: a returning org with a fresh attempt and a failing ingest re-enters the monitored population", async () => {
    // A customer comes back after 9 days. Their ingest watermark is still older
    // than the DORMANT cutoff — precisely because they were away — but their
    // fleet is present and its first batch back is being accepted without
    // landing anything. The dormant branch used to win before presence was even
    // consulted, so exactly the org whose first day back is broken was excluded
    // from the page signal. The attempt check now runs FIRST.
    pinGroups(
      [
        group(
          ORG_DORMANT,
          hoursAgo(SESSION_INGESTION_DORMANT_AFTER_HOURS + 48)
        ),
      ],
      [lastSeenGroup(ORG_DORMANT, hoursAgo(0.05), hoursAgo(0.1))]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_DORMANT, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.stalledOrgCount).toBe(1);
    expect(summary.dormantOrgCount).toBe(0);
    expect(summary.quietOrgCount).toBe(0);
    expect(emittedMetrics(FilterToken.SessionIngestionStalledOrgs)).toEqual([
      {
        metric: FilterToken.SessionIngestionStalledOrgs,
        value: 1,
        thresholdHours: SESSION_INGESTION_STALL_THRESHOLD_HOURS,
      },
    ]);
  });

  it("ISS-4831: a genuinely churned org whose fleet is not attempting stays DORMANT", async () => {
    // The other half of the reordering: promoting the attempt check above the
    // dormant cutoff must not re-admit the churned orgs the cutoff exists to
    // exclude. A trial that ended has no fleet attempting anything.
    pinGroups(
      [
        group(
          ORG_DORMANT,
          hoursAgo(SESSION_INGESTION_DORMANT_AFTER_HOURS + 48)
        ),
      ],
      [
        lastSeenGroup(
          ORG_DORMANT,
          hoursAgo(SESSION_INGESTION_DORMANT_AFTER_HOURS + 48)
        ),
      ]
    );
    mocks.organizationFindMany.mockResolvedValue([
      policyRow(ORG_DORMANT, true),
    ]);

    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.dormantOrgCount).toBe(1);
    expect(summary.stalledOrgCount).toBe(0);
    expect(summary.quietOrgCount).toBe(0);
  });

  it("ISS-4827: reads both fleet signals in ONE grouped scan over non-sentinel targets", async () => {
    pinGroups([group(ORG_ACTIVE, hoursAgo(1))]);
    mocks.organizationFindMany.mockResolvedValue([policyRow(ORG_ACTIVE, true)]);

    await sampleSessionIngestionHealth(new Date());

    expect(mocks.computeTargetGroupBy).toHaveBeenCalledWith({
      by: ["organizationId"],
      where: { isCloudSentinel: false, organizationId: { in: [ORG_ACTIVE] } },
      _max: { lastSeenAt: true, lastAgentSessionSyncAttemptAt: true },
    });
  });

  it("emits a zero active-org gauge when nothing is ingesting platform-wide", async () => {
    const summary = await sampleSessionIngestionHealth(new Date());

    expect(summary.activeOrgCount).toBe(0);
    expect(summary.platformQuiet).toBe(false);
    expect(mocks.organizationFindMany).not.toHaveBeenCalled();
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
