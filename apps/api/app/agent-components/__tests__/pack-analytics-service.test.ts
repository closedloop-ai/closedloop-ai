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
import { type PrismaOrderBy, sortByPrismaOrderBy } from "./prisma-order-double";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ values }),
  },
}));

vi.mock("@repo/database", () => ({
  Prisma: mocks.Prisma,
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

/** A user the roster can resolve a display name for, org-scoped. */
type OrgUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
};

/**
 * Install a fake `withDb` client with the delegate defaults the pack-analytics
 * path reads. `getPackAnalytics` touches `agentComponentSessionUsage.findMany`
 * (child-usage rollup), `agentComponent.findMany` (inventory), `user.findMany`
 * (the roster's name resolution), `sessionDetail` aggregate reads, and the raw
 * fallback-LOC SQL (LOC/cost + cohort performance); anything a case does not set
 * defaults to empty so no metric is fabricated.
 *
 * `orgUsers` backs the org-scoped `User` read the roster resolves names through
 * (ISS-6768). It honors `where.organizationId`, so a user absent from the list —
 * or present under a different org — is one this tenant cannot see, and the
 * roster must drop the row rather than name another tenant's member.
 */
/**
 * ISS-9854: the installer aggregate joins `users` scoped to the requested org
 * (the org id is a bound parameter, rendered as `?` in the joined statement)
 * and counts through that join, never the compute target's raw `user_id`.
 */
const ORG_SCOPED_USERS_JOIN =
  /LEFT JOIN "users" u\s+ON u\."id" = ct\."user_id"\s+AND u\."organization_id" = \?::uuid/;
const COUNTS_TARGET_USER_ID = /THEN ct\."user_id"/;

/** The `Prisma.sql` template the aggregate is issued with. */
type AggregateStatement = {
  strings: readonly string[];
  values: readonly unknown[];
};

function queryRawMock(
  aggregate: { deviceCount: number; installerCount: number } = {
    deviceCount: 0,
    installerCount: 0,
  }
) {
  return vi.fn().mockImplementation((sql: { strings?: readonly string[] }) => {
    const text = sql?.strings?.join("") ?? "";
    if (text.includes("installerCount")) {
      return Promise.resolve([aggregate]);
    }
    return Promise.resolve([{ unkeyableLoc: 0n, keyedLocs: [] }]);
  });
}

function installDb(db: Record<string, unknown>, orgUsers: OrgUser[] = []) {
  const dbWithDefaults = {
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findMany: vi.fn(
        (args?: {
          where?: { organizationId?: string; id?: { in?: string[] } };
        }) => {
          const requested = new Set(args?.where?.id?.in ?? []);
          return Promise.resolve(
            orgUsers.filter(
              (user) =>
                requested.has(user.id) &&
                args?.where?.organizationId === "org-1"
            )
          );
        }
      ),
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
        // ISS-9751's baseline LOC/$ coverage verdict, read off the SAME
        // statement as the `_sum` it certifies (#6878) — an empty window, so
        // there is nothing unpriced and nothing negative.
        _count: { _all: 0, estimatedCost: 0 },
        _min: { estimatedCost: null },
      }),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    // ISS-9114: one statement returns both fallback halves. ISS-9854 added a
    // second $queryRaw (exact install aggregate); dispatch on the SQL shape.
    $queryRaw: queryRawMock(),
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
 * both). No PR links → the cohort's success/quality lanes
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
    estimatedCost,
    inputTokens,
    outputTokens,
    sessionStartedAt: new Date("2026-02-01T00:00:00.000Z"),
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
    // ISS-8932: the child-usage read selects the row's primary key and
    // de-duplicates its sliced statements on it, so every fixture row needs a
    // DISTINCT one — id-less rows would collapse onto a single key and this
    // double would report a rollup no database could produce.
    id: `child-usage-${nextChildUsageRowId++}`,
    agentSessionId: overrides.agentSessionId,
    componentKind: overrides.componentKind ?? "command",
    componentKey: overrides.componentKey,
    invocationCount: overrides.invocationCount,
    errorCount: overrides.errorCount ?? 0,
    lastInvokedAt: null,
  };
}

/** Distinguishes the fixture rows above; see the `id` note there. */
let nextChildUsageRowId = 0;

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
  computeTarget: { userId: string } | null;
  uninstalledAt?: Date | null;
  /** ISS-6768: nullable, and the roster's order key — see the ordering case. */
  lastSeenAt?: Date | null;
  id?: string;
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
      orderBy?: PrismaOrderBy;
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
      // ISS-6768: the read's own `orderBy` decides the order, with PostgreSQL's
      // real null placement, so the roster's ordering is proven by the query.
      return Promise.resolve(sortByPrismaOrderBy(scoped, args?.orderBy));
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
    installDb(
      {
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
              {
                computeTargetId: "device-1",
                computeTarget: { userId: OWNER.id },
              },
              {
                computeTargetId: "device-2",
                computeTarget: { userId: OWNER.id },
              },
            ],
            [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
          ),
        },
        // ISS-9854: exact counts from the rowless aggregate.
        $queryRaw: queryRawMock({ deviceCount: 2, installerCount: 1 }),
      },
      [OWNER]
    );

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
      deviceCount: 2, // ISS-9854: from exact aggregate, not capped inventory
      installerCount: 1, // ISS-9854: exact, excluding cloud-authored sentinels
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
      // ISS-9853: no baseline was computed (the empty cohort short-circuits
      // before one), so no comparator sample was taken to disclose.
      baselineSampleSize: null,
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
    installDb(
      {
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
                computeTarget: { userId: OWNER.id },
                uninstalledAt: null,
              },
              {
                computeTargetId: "device-2",
                computeTarget: { userId: OTHER.id },
                uninstalledAt: new Date("2026-07-01T00:00:00.000Z"),
              },
            ],
            [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
          ),
        },
        $queryRaw: queryRawMock({ deviceCount: 1, installerCount: 1 }),
      },
      [OWNER, OTHER]
    );

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

  it("omits an owner whose compute-target user is outside the organization", async () => {
    // ISS-6768 (davetho): `AgentComponent`, `ComputeTarget`, and `User` carry
    // independent org foreign keys, so this overlay used to render whatever user
    // the nested join pointed at. Names now come from an org-scoped `User` read,
    // and a row that resolves to no in-org user contributes nothing — the same
    // boundary the web detail read enforces through the same fold.
    const FOREIGN = {
      id: "user-other-org",
      firstName: "Elsewhere",
      lastName: "Person",
      email: "elsewhere@other-tenant.example.com",
    };
    const queryRaw = queryRawMock({ deviceCount: 2, installerCount: 1 });
    installDb(
      {
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
                computeTarget: { userId: FOREIGN.id },
              },
              {
                computeTargetId: "device-2",
                computeTarget: { userId: OWNER.id },
              },
            ],
            [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
          ),
        },
        $queryRaw: queryRaw,
      },
      // `FOREIGN` is deliberately absent from the org-scoped read.
      [OWNER]
    );

    const result = await packAnalyticsService.getPackAnalytics(
      "org-1",
      "pack-1"
    );

    expect(result?.owners).toEqual(["Alice Ng"]);
    expect(result?.owners).not.toContain("Elsewhere Person");
    // ISS-9854 (Codex, #7148): the exact installer aggregate must apply the
    // SAME org boundary the roster does, or it reports more installers than
    // the roster names. The statement counts users through an org-scoped
    // `users` join, with the org bound as a parameter beside the pack id.
    const aggregateSql = queryRaw.mock.calls
      .map(([sql]) => sql as AggregateStatement)
      .find((sql) => sql.strings.join("").includes("installerCount"));
    expect(aggregateSql).toBeDefined();
    const statement = aggregateSql?.strings.join("?") ?? "";
    expect(statement).toMatch(ORG_SCOPED_USERS_JOIN);
    expect(statement).not.toMatch(COUNTS_TARGET_USER_ID);
    expect(aggregateSql?.values).toEqual(["org-1", "org-1", "pack-1"]);
    // The device count is a device count: it still sees both rows.
    expect(result?.deviceCount).toBe(2);
  });

  it("orders an install with no lastSeenAt behind one that has it", async () => {
    // ISS-6768 (davetho): the same nullable-timestamp ordering hole the web
    // detail read carries. PostgreSQL sorts nulls FIRST on a descending sort, so
    // a bare `lastSeenAt: "desc"` leads this roster with a legacy row that never
    // recorded a timestamp. Both roster-producing queries must say `nulls:
    // "last"` or the two surfaces order the same people differently.
    const LEGACY = {
      id: "user-legacy",
      firstName: "Legacy",
      lastName: "Install",
      email: "legacy@example.com",
    };
    installDb(
      {
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
              // Fixture order deliberately leads with the null-timestamp row, so
              // the assertion can only pass if the QUERY reordered it.
              {
                id: "ac-1",
                computeTargetId: "device-1",
                computeTarget: { userId: LEGACY.id },
                lastSeenAt: null,
              },
              {
                id: "ac-2",
                computeTargetId: "device-2",
                computeTarget: { userId: OWNER.id },
                lastSeenAt: new Date("2026-02-01T00:00:00.000Z"),
              },
            ],
            [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
          ),
        },
      },
      [LEGACY, OWNER]
    );

    const result = await packAnalyticsService.getPackAnalytics(
      "org-1",
      "pack-1"
    );

    expect(result?.owners).toEqual(["Alice Ng", "Legacy Install"]);
  });

  it("falls back to email when the owner has no name", async () => {
    const NO_NAME = {
      id: "user-2",
      firstName: null,
      lastName: null,
      email: "noname@example.com",
    };
    installDb(
      {
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
                computeTarget: { userId: NO_NAME.id },
              },
            ],
            [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
          ),
        },
      },
      [NO_NAME]
    );

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
    installDb(
      {
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
            [
              {
                computeTargetId: "device-1",
                computeTarget: { userId: OWNER.id },
              },
            ],
            [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
          ),
        },
        sessionDetail: {
          // The pack's own sessions carry real LOC + cost. `loadSessionLocCost`
          // and the cohort scan both read these (the `in` query); the baseline
          // (`notIn`) scan returns none so no delta is computed.
          findMany: vi.fn(
            (args?: {
              where?: { artifactId?: { notIn?: readonly string[] } };
            }) =>
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
            _count: { _all: 0, estimatedCost: 0 },
            _min: { estimatedCost: null },
          }),
          groupBy: vi.fn().mockResolvedValue([]),
        },
      },
      [OWNER]
    );

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

  // FEA-4144 (whitlockk): the headline `locPerDollar` is not the only KLOC signal
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
      // ISS-9751: a fully priced baseline, in the SAME statement as the `_sum`
      // above (#6878), so `locDelta`'s null below is the pack-kind gate and not
      // a coverage hole.
      _count: { _all: 2, estimatedCost: 2 },
      _min: { estimatedCost: 1 },
    };
    installDb(
      {
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
            [
              {
                computeTargetId: "device-1",
                computeTarget: { userId: OWNER.id },
              },
            ],
            [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
          ),
        },
        sessionDetail: {
          // Cohort (`in`) scan → the pack's own rows; baseline (`notIn`) scan →
          // one out-of-cohort row so the baseline sample is non-empty and the
          // delta branch (`cohortSessionIds.length <= cap`) runs its aggregates.
          findMany: vi.fn(
            (args?: {
              where?: { artifactId?: { notIn?: readonly string[] } };
            }) =>
              Promise.resolve(
                args?.where?.artifactId?.notIn
                  ? [buildPackCohortSessionRow("baseline-1", 0, 0, 0)]
                  : cohortRows
              )
          ),
          // The baseline LOC/token/cost sums that make `baselineLocPerDollar` and
          // `baselineTokensPerLoc` computable (so a real locDelta WOULD exist).
          aggregate: vi.fn().mockResolvedValue(baselineAggregate),
          groupBy: vi.fn().mockResolvedValue([]),
        },
      },
      [OWNER]
    );

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

  it("returns exact counts from the aggregate, not the capped inventory (ISS-9854)", async () => {
    installDb(
      {
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
                computeTarget: { userId: OWNER.id },
              },
            ],
            [childInvRow({ componentKey: "git-status", packId: "pack-1" })]
          ),
        },
        // The aggregate returns counts beyond the inventory cap — proving the
        // response uses the aggregate, not the capped findMany result.
        $queryRaw: queryRawMock({ deviceCount: 5001, installerCount: 4999 }),
      },
      [OWNER]
    );

    const result = await packAnalyticsService.getPackAnalytics(
      "org-1",
      "pack-1"
    );

    expect(result?.deviceCount).toBe(5001);
    expect(result?.installerCount).toBe(4999);
    expect(result?.owners).toEqual(["Alice Ng"]);
  });
});
