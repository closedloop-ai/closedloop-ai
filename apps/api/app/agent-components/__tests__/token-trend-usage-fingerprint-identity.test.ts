/**
 * ISS-10815: the token-trend sub-route resolves a detail slug through the SAME
 * identity ladder the detail card does.
 *
 * The two halves of one page must not answer different questions about one URL.
 * Before this, the trend resolved a fingerprint with `resolveContentHashIdentity`
 * alone — version rows only — so a usage-only representative fingerprint, which
 * by construction sits on no version row, short-circuited to the empty series
 * that reads as "this component was never used", directly beside a card the
 * detail read now fills with the named family and its session count.
 *
 * Driven through the production entry point (`analyticsService.fetchTokenTrend`)
 * with Prisma doubled, and asserted on the `where` the usage read actually
 * received — the identity the trend resolved is only observable there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withDb: vi.fn() }));
vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

import { analyticsService } from "../analytics-service";

const ORG = "org-iss-10815-trend";
const KIND = "skill";
/** Carried by usage rows; on no version row and no inventory row. */
const USAGE_ONLY_FINGERPRINT = "2".repeat(64);
/** On a version row, so it resolves the pre-existing content-scoped way. */
const VERSIONED_FINGERPRINT = "1".repeat(64);
const FAMILY_KEY = "portfolio-rebalance";

type UsageWhere = {
  componentKeyNormalized?: { in?: string[] };
  OR?: { componentVersionHash?: { in?: string[] } }[];
  AND?: unknown;
};

/**
 * Double the four delegates the ladder plus the trend read touch. The usage
 * `findMany` records the `where` it was handed and returns no rows — the
 * assertion is about WHICH identity was resolved, and an empty result set keeps
 * the rest of the trend fold out of the way.
 */
function installDb() {
  const usageFindMany = vi.fn().mockResolvedValue([]);
  const usageGroupBy = vi
    .fn()
    .mockResolvedValue([{ componentKeyNormalized: FAMILY_KEY }]);
  const versionFindMany = vi.fn((args: { where: { contentHash?: string } }) =>
    Promise.resolve(
      args.where.contentHash === VERSIONED_FINGERPRINT
        ? [{ componentKey: FAMILY_KEY, contentHash: VERSIONED_FINGERPRINT }]
        : []
    )
  );
  const db = {
    agentComponentSessionUsage: {
      findMany: usageFindMany,
      groupBy: usageGroupBy,
    },
    agentComponentVersion: { findMany: versionFindMany },
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  mocks.withDb.mockImplementation((cb: (d: typeof db) => unknown) => cb(db));
  return { usageFindMany, usageGroupBy };
}

const usageWhereOf = (findMany: ReturnType<typeof vi.fn>): UsageWhere =>
  findMany.mock.calls[0][0].where;

describe("fetchTokenTrend identity resolution (ISS-10815)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a usage-only fingerprint to the family, so the chart matches the card", async () => {
    const { usageFindMany, usageGroupBy } = installDb();

    const result = await analyticsService.fetchTokenTrend(
      ORG,
      `${KIND}::${USAGE_ONLY_FINGERPRINT}`,
      {}
    );

    // Not the short-circuit: the read ran, and ran on the family's name.
    expect(usageGroupBy).toHaveBeenCalled();
    expect(usageFindMany).toHaveBeenCalledTimes(1);
    expect(usageWhereOf(usageFindMany).componentKeyNormalized).toEqual({
      in: [FAMILY_KEY],
    });
    expect(result?.points).toEqual([]);
  });

  it("accepts the name-qualified id the list publishes for such a row", async () => {
    const { usageFindMany } = installDb();

    await analyticsService.fetchTokenTrend(
      ORG,
      `${KIND}::${FAMILY_KEY}@${USAGE_ONLY_FINGERPRINT}`,
      {}
    );

    expect(usageFindMany).toHaveBeenCalledTimes(1);
    expect(usageWhereOf(usageFindMany).componentKeyNormalized).toEqual({
      in: [FAMILY_KEY],
    });
  });

  it("keeps a versioned fingerprint content-scoped, as it has always been", async () => {
    const { usageFindMany, usageGroupBy } = installDb();

    await analyticsService.fetchTokenTrend(
      ORG,
      `${KIND}::${VERSIONED_FINGERPRINT}`,
      {}
    );

    // The version row resolved it, so the ladder never reaches the usage rung
    // and the read stays narrowed to the requested byte-version.
    expect(usageGroupBy).not.toHaveBeenCalled();
    const where = usageWhereOf(usageFindMany);
    expect(where.componentKeyNormalized).toEqual({ in: [FAMILY_KEY] });
    expect(JSON.stringify(where)).toContain(VERSIONED_FINGERPRINT);
  });

  it("answers an empty series, not another component's rows, for a fingerprint nothing names", async () => {
    const { usageFindMany, usageGroupBy } = installDb();
    usageGroupBy.mockResolvedValue([]);

    const result = await analyticsService.fetchTokenTrend(
      ORG,
      `${KIND}::${"9".repeat(64)}`,
      {}
    );

    expect(result?.points).toEqual([]);
    expect(usageFindMany).not.toHaveBeenCalled();
  });
});
