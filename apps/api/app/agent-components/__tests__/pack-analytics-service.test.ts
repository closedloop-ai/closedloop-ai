/**
 * Unit tests for `packAnalyticsService.getPackAnalytics` — the per-pack org-wide
 * analytics rollup for the desktop-team overlay.
 *
 * Split out of `service.test.ts` (FEA-4144 review, root AGENTS.md shrink-only
 * rule): the pack-analytics surface is its own service module, so its suite
 * lives beside it rather than in the (grandfathered) `agentComponentsService`
 * suite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

// `packAnalyticsService` transitively imports `./service`, which reuses the
// agent-sessions read service elsewhere; mock it so this suite stays isolated
// from the (heavy) session service (mirrors `service.test.ts`).
vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: {
    listByArtifactIds: vi.fn(),
  },
}));

import { packAnalyticsService } from "../pack-analytics-service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Install a fake `withDb` client with the delegate defaults the pack-analytics
 * path reads. `getPackAnalytics` touches `agentComponentSessionUsage.findMany`
 * (child-usage rollup), `agentComponent.findMany` (inventory), and
 * `sessionDetail.{findMany,aggregate,groupBy}` (LOC/cost + cohort performance);
 * anything a case does not set defaults to empty so no metric is fabricated.
 */
function installDb(db: Record<string, unknown>) {
  const dbWithDefaults = {
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({
        _sum: {
          estimatedCost: null,
          inputTokens: null,
          outputTokens: null,
          linesAdded: null,
          linesRemoved: null,
        },
      }),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    ...db,
  };
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
}

/**
 * A fully-shaped `SessionDetail` row for the pack-analytics path: the LOC/cost
 * scalars `loadSessionLocCost` reads PLUS the cohort scalars/relations
 * `computeCohortPerformance` reads (so one `sessionDetail.findMany` mock feeds
 * both). No PR links and no source loop → the cohort's success/quality lanes
 * stay empty without extra delegate mocks. Tokens default to 0; pass them when a
 * case needs a non-null token-efficiency signal.
 */
function buildPackCohortSessionRow(
  artifactId: string,
  linesAdded: number,
  linesRemoved: number,
  estimatedCost: number,
  inputTokens = 0,
  outputTokens = 0
) {
  return {
    artifactId,
    linesAdded,
    linesRemoved,
    locSource: null,
    repositoryFullName: null,
    branch: null,
    estimatedCost,
    inputTokens,
    outputTokens,
    sessionStartedAt: new Date("2026-02-01T00:00:00.000Z"),
    sourceLoopId: null,
    artifact: { sourceLinks: [] },
  };
}

/**
 * One child `AgentComponentSessionUsage` row as returned by the FEA-4337 plugin
 * child-usage read. Attribution is by the child's natural identity
 * `(componentKind, componentKey)` joined to a child INVENTORY row's `packId`,
 * not the usage row's (nullable) FK — so the row carries its identity and a
 * matching child inventory row (see `childInvRow`) supplies the pack.
 */
function childUsageRow(overrides: {
  agentSessionId: string;
  componentKey: string;
  componentKind?: string;
  invocationCount: number;
  errorCount?: number;
}) {
  return {
    agentSessionId: overrides.agentSessionId,
    componentKind: overrides.componentKind ?? "command",
    componentKey: overrides.componentKey,
    invocationCount: overrides.invocationCount,
    errorCount: overrides.errorCount ?? 0,
    lastInvokedAt: null,
  };
}

/** A child inventory row (kind/key/packId) the child-usage rollup joins on. */
function childInvRow(overrides: {
  componentKey: string;
  componentKind?: string;
  packId: string;
}) {
  return {
    componentKind: overrides.componentKind ?? "command",
    componentKey: overrides.componentKey,
    packId: overrides.packId,
  };
}

/** One owner/device inventory row, optionally tombstoned (ISS-6180). */
type OwnerRow = {
  computeTargetId: string;
  computeTarget: { user: unknown } | null;
  uninstalledAt?: Date | null;
};

/**
 * A filter-aware `agentComponent.findMany` mock. `getPackAnalytics` issues TWO
 * inventory reads through one delegate: the FEA-4337 child-pack-identity read
 * (`where.componentKind` present → returns `childInventory`) and the owner/device
 * read (no `componentKind` → returns `ownerRows`). Splitting on the where lets a
 * single fixture back both without the owner rows leaking into the identity map.
 *
 * ISS-6180: both reads now carry `uninstalledAt: null`, and the mock honors it,
 * so a test can prove a tombstoned row is dropped by the QUERY rather than by
 * application code downstream of it.
 */
function agentComponentFindMany(
  ownerRows: OwnerRow[],
  childInventory: ReturnType<typeof childInvRow>[]
) {
  return vi.fn(
    (args?: {
      where?: { componentKind?: unknown; uninstalledAt?: Date | null };
    }) => {
      const rows = args?.where?.componentKind ? childInventory : ownerRows;
      const scoped =
        args?.where && "uninstalledAt" in args.where
          ? rows.filter(
              (r) =>
                ((r as OwnerRow).uninstalledAt ?? null) ===
                args.where?.uninstalledAt
            )
          : rows;
      return Promise.resolve(scoped);
    }
  );
}

// ---------------------------------------------------------------------------
// getPackAnalytics tests
// ---------------------------------------------------------------------------

describe("packAnalyticsService.getPackAnalytics", () => {
  const OWNER = {
    id: "user-1",
    firstName: "Alice",
    lastName: "Ng",
    email: "alice@example.com",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates child usage + owners/devices for a pack", async () => {
    installDb({
      // child usage rows consumed by loadChildUsageByPackId — attributed to the
      // pack via the child inventory identity (kind, key), NOT the usage FK.
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          childUsageRow({
            agentSessionId: "s1",
            componentKey: "git-status",
            invocationCount: 5,
          }),
          childUsageRow({
            agentSessionId: "s2",
            componentKey: "git-status",
            invocationCount: 3,
          }),
        ]),
      },
      // two inventory rows for the SAME owner across two devices, plus the child
      // inventory row (git-status → pack-1) the child usage attributes through.
      agentComponent: {
        findMany: agentComponentFindMany(
          [
            { computeTargetId: "device-1", computeTarget: { user: OWNER } },
            { computeTargetId: "device-2", computeTarget: { user: OWNER } },
          ],
          [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
        ),
      },
    });

    const result = await packAnalyticsService.getPackAnalytics(
      "org-1",
      "pack-1"
    );

    expect(result).toEqual({
      packId: "pack-1",
      invocations: 8, // 5 + 3
      sessions: 2, // s1, s2 deduped
      locPerDollar: null, // no sessionDetail loc/cost rows
      // ISS-4667 version-skew EMIT: deprecated KLOC-unit aliases emitted for old
      // Desktop builds. Null here because `locPerDollar`/`locDelta` are null.
      klocPerDollar: null,
      klocDelta: null,
      owners: ["Alice Ng"], // deduped by user id across the two devices
      deviceCount: 2,
      // Comparison metrics: the fake db returns no sessionDetail rows for the
      // cohort, so `computeCohortPerformance` short-circuits to empty (all real
      // "not computable" nulls — never fabricated).
      locDelta: null,
      successRate: null,
      successDelta: null,
      tokenEfficiencyDelta: null,
      efficiencyTrend: [],
      mergedPrs: null,
      // ISS-5521: the pack rollup spreads `CohortDeliveryMetrics`, so it carries
      // the cap disclosure too. `false` here because the empty-cohort
      // short-circuit means nothing was truncated — there was nothing to scan.
      mergedPrsTruncated: false,
      qualityScore: null,
      qualityDelta: null,
    });
  });

  it("counts only LIVE installs toward owners/devices, matching the usage half (ISS-6180)", async () => {
    // The usage rollup is scoped to live inventory children, so this read must
    // be too: otherwise a pack uninstalled on a device reports zero invocations
    // for it beside a device/owner count that still includes it.
    const OTHER = {
      id: "user-2",
      firstName: "Bo",
      lastName: "Reyes",
      email: "bo@example.com",
    };
    installDb({
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          childUsageRow({
            agentSessionId: "s1",
            componentKey: "git-status",
            invocationCount: 5,
          }),
        ]),
      },
      agentComponent: {
        findMany: agentComponentFindMany(
          [
            {
              computeTargetId: "device-1",
              computeTarget: { user: OWNER },
              uninstalledAt: null,
            },
            {
              computeTargetId: "device-2",
              computeTarget: { user: OTHER },
              uninstalledAt: new Date("2026-07-01T00:00:00.000Z"),
            },
          ],
          [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
        ),
      },
    });

    const result = await packAnalyticsService.getPackAnalytics(
      "org-1",
      "pack-1"
    );

    expect(result?.deviceCount).toBe(1);
    expect(result?.owners).toEqual(["Alice Ng"]);
  });

  it("returns null when the pack has no usage and no inventory", async () => {
    installDb({
      agentComponentSessionUsage: { findMany: vi.fn().mockResolvedValue([]) },
      agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await packAnalyticsService.getPackAnalytics(
      "org-1",
      "pack-missing"
    );

    expect(result).toBeNull();
  });

  it("falls back to email when the owner has no name", async () => {
    installDb({
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          childUsageRow({
            agentSessionId: "s1",
            componentKey: "git-status",
            invocationCount: 1,
          }),
        ]),
      },
      agentComponent: {
        findMany: agentComponentFindMany(
          [
            {
              computeTargetId: "device-1",
              computeTarget: {
                user: {
                  id: "user-2",
                  firstName: null,
                  lastName: null,
                  email: "noname@example.com",
                },
              },
            },
          ],
          [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
        ),
      },
    });

    const result = await packAnalyticsService.getPackAnalytics(
      "org-1",
      "pack-1"
    );

    expect(result?.owners).toEqual(["noname@example.com"]);
  });

  // FEA-4144: the pack overlay's KLOC/$ must obey the SAME FEA-4052
  // verifiability gate the inventory + detail paths apply. A pack is the
  // `Plugin` kind — non-verifiable, because its child-usage rollup is a
  // session-level (not per-component) attribution — so even with real,
  // measurable LOC at real cost across the pack's sessions the overlay reports
  // locPerDollar=null rather than the misattributed number this same pack's
  // inventory row hides. Without the gate `computeLocPerDollar` would report
  // 1000 lines / $2.00 = 0.5.
  it("gates locPerDollar to null for a pack (Plugin kind) despite real LOC + cost", async () => {
    const cohortRows = [
      buildPackCohortSessionRow("s1", 700, 200, 1.5),
      buildPackCohortSessionRow("s2", 80, 20, 0.5),
    ];
    installDb({
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          childUsageRow({
            agentSessionId: "s1",
            componentKey: "git-status",
            invocationCount: 5,
          }),
          childUsageRow({
            agentSessionId: "s2",
            componentKey: "git-status",
            invocationCount: 3,
          }),
        ]),
      },
      agentComponent: {
        findMany: agentComponentFindMany(
          [{ computeTargetId: "device-1", computeTarget: { user: OWNER } }],
          [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
        ),
      },
      sessionDetail: {
        // The pack's own sessions carry real LOC + cost. `loadSessionLocCost`
        // and the cohort scan both read these (the `in` query); the baseline
        // (`notIn`) scan returns none so no delta is computed.
        findMany: vi.fn(
          (args?: { where?: { artifactId?: { notIn?: readonly string[] } } }) =>
            Promise.resolve(args?.where?.artifactId?.notIn ? [] : cohortRows)
        ),
        aggregate: vi.fn().mockResolvedValue({
          _sum: {
            estimatedCost: null,
            inputTokens: null,
            outputTokens: null,
            linesAdded: null,
            linesRemoved: null,
          },
        }),
        groupBy: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await packAnalyticsService.getPackAnalytics(
      "org-1",
      "pack-1"
    );

    // Gated to null (Plugin is not verifiable), matching the inventory row.
    expect(result?.locPerDollar).toBeNull();
    // The rest of the rollup is unaffected — usage/sessions still aggregate.
    expect(result?.invocations).toBe(8);
    expect(result?.sessions).toBe(2);
  });

  // FEA-4144 (wongk): the headline `locPerDollar` is not the only KLOC signal
  // the overlay renders — `pack-detail.tsx` also shows `locDelta` (the KLOC/$
  // lift vs. the baseline) even when the headline is hidden. That delta is the
  // SAME unverifiable Plugin efficiency number, so it must be gated too. This
  // case supplies a NON-EMPTY baseline (real LOC + cost + tokens for the `notIn`
  // scan) so `computeCohortPerformance` DOES compute a real locDelta and a real
  // tokenEfficiencyDelta; the gate must null `locDelta` while leaving the
  // (verifiable) token-efficiency delta intact — proving the null is the gate,
  // not an empty baseline.
  it("gates locDelta to null for a pack even when the baseline is non-empty", async () => {
    const cohortRows = [
      buildPackCohortSessionRow("s1", 700, 200, 1.5, 500, 500),
      buildPackCohortSessionRow("s2", 80, 20, 0.5, 250, 250),
    ];
    const baselineAggregate = {
      _sum: {
        estimatedCost: 4,
        inputTokens: 1000,
        outputTokens: 1000,
        linesAdded: 3000,
        linesRemoved: 1000,
      },
    };
    installDb({
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          childUsageRow({
            agentSessionId: "s1",
            componentKey: "git-status",
            invocationCount: 5,
          }),
          childUsageRow({
            agentSessionId: "s2",
            componentKey: "git-status",
            invocationCount: 3,
          }),
        ]),
      },
      agentComponent: {
        findMany: agentComponentFindMany(
          [{ computeTargetId: "device-1", computeTarget: { user: OWNER } }],
          [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
        ),
      },
      sessionDetail: {
        // Cohort (`in`) scan → the pack's own rows; baseline (`notIn`) scan →
        // one out-of-cohort row so the baseline sample is non-empty and the
        // delta branch (`cohortSessionIds.length <= cap`) runs its aggregates.
        findMany: vi.fn(
          (args?: { where?: { artifactId?: { notIn?: readonly string[] } } }) =>
            Promise.resolve(
              args?.where?.artifactId?.notIn
                ? [buildPackCohortSessionRow("baseline-1", 0, 0, 0)]
                : cohortRows
            )
        ),
        // The baseline LOC/token/cost sums that make `baselineLocPerDollar` and
        // `baselineTokensPerKloc` computable (so a real locDelta WOULD exist).
        aggregate: vi.fn().mockResolvedValue(baselineAggregate),
        groupBy: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await packAnalyticsService.getPackAnalytics(
      "org-1",
      "pack-1"
    );

    // The KLOC/$ delta is gated to null for a pack (Plugin is not verifiable)...
    expect(result?.locDelta).toBeNull();
    expect(result?.locPerDollar).toBeNull();
    // ...but the baseline path still ran and produced the deltas the gate does
    // NOT touch — proving `locDelta`'s null is the gate, not a missing baseline.
    expect(result?.tokenEfficiencyDelta).not.toBeNull();
  });
});
