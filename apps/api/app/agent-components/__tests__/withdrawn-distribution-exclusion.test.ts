/**
 * ISS-5123 — withdrawal must be honoured by every consumer of `distributions`,
 * not only by the distributions service that introduced the column.
 *
 * Adding `withdrawnAt` created two silent regressions outside that service,
 * because both of these read the table directly and neither knew the concept:
 *
 *  1. **Promote self-heal** — its documented contract is "this component
 *     auto-installs org-wide", and it recreates the distribution when one was
 *     "removed out of band". A withdrawn distribution IS that case, but an
 *     unfiltered lookup finds it, returns its id, and re-promoting silently
 *     leaves the pack offered to nobody.
 *  2. **Compliance** — a withdrawn distribution imposes no obligation, so
 *     counting it reports machines as non-compliant for a pack the org no
 *     longer offers and nobody can install: a gap no admin could ever close.
 *
 * Both mocks below genuinely APPLY the `withdrawnAt` predicate to a fixture
 * containing a withdrawn row, so removing the filter from either query makes
 * that row reappear and fails the test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  isOrgAdmin: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: { QueryMode: { insensitive: "insensitive" } },
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: mocks.isOrgAdmin,
}));

import { complianceService } from "../compliance/service";
import { promoteAgentComponent } from "../promote/service";

const ORG = "org-1";
const WITHDRAWN_DIST = "dist-withdrawn";
const CATALOG_ITEM = "item-1";
const AGENT_COMPONENT = "11111111-1111-4111-8111-111111111111";
const WITHDRAWN_AT = new Date("2026-08-08T00:00:00.000Z");

type WhereClause = { withdrawnAt?: unknown } | undefined;

/** The production predicate is the literal `withdrawnAt: null`. */
function requiresLive(where: WhereClause): boolean {
  return where?.withdrawnAt === null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

describe("compliance excludes withdrawn distributions (ISS-5123)", () => {
  it("reports no gap for a withdrawn auto_install distribution", async () => {
    // One distribution in the org, withdrawn, with a machine that never
    // installed it — a maximal compliance gap if it were still counted.
    const withdrawnRow = {
      id: WITHDRAWN_DIST,
      targetingType: "all",
      mode: "auto_install",
      withdrawnAt: WITHDRAWN_AT,
      catalogItem: { name: "My Plugin", targetKind: "plugin" },
      targetStatuses: [],
      targetingEntries: [],
    };

    const db = {
      distribution: {
        findMany: vi.fn(({ where }: { where?: WhereClause }) =>
          Promise.resolve(requiresLive(where) ? [] : [withdrawnRow])
        ),
      },
      computeTarget: {
        findMany: vi.fn().mockResolvedValue([{ id: "target-1" }]),
      },
      agentComponentSessionUsage: {
        groupBy: vi.fn().mockResolvedValue([]),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(db)
    );

    const result = await complianceService.getCompliance({
      organizationId: ORG,
      limit: 50,
    });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Promote self-heal
// ---------------------------------------------------------------------------

describe("promote self-heals past a withdrawn distribution (ISS-5123)", () => {
  it("recreates the org-wide distribution instead of returning the withdrawn one", async () => {
    const withdrawnRow = {
      id: WITHDRAWN_DIST,
      withdrawnAt: WITHDRAWN_AT,
    };
    const distributionCreate = vi
      .fn()
      .mockResolvedValue({ id: "dist-recreated" });

    const db = {
      agentComponent: {
        findFirst: vi.fn().mockResolvedValue({
          id: AGENT_COMPONENT,
          componentKind: "subagent",
          name: "My Plugin",
          description: null,
          componentKey: "my-plugin",
          harness: "claude",
          version: null,
          sourceUrl: null,
          installPath: null,
          scope: null,
          metadata: null,
        }),
      },
      // The idempotency lookup: the item still exists from the first promotion,
      // and Prisma applies the nested `distributions.where` — including the new
      // `withdrawnAt: null` — when selecting the relation.
      catalogItem: {
        findFirst: vi.fn(({ select }: { select?: Record<string, never> }) => {
          const nested = (
            select as unknown as {
              distributions?: { where?: WhereClause };
            }
          )?.distributions;
          return Promise.resolve({
            id: CATALOG_ITEM,
            distributions: requiresLive(nested?.where) ? [] : [withdrawnRow],
          });
        }),
      },
      distribution: {
        findFirst: vi.fn(({ where }: { where?: WhereClause }) =>
          Promise.resolve(requiresLive(where) ? null : withdrawnRow)
        ),
        create: distributionCreate,
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };

    mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback(db)
    );
    mocks.withDb.tx.mockImplementation(
      (callback: (client: unknown) => unknown) => callback(db)
    );

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: "user-1",
      agentComponentId: AGENT_COMPONENT,
    });

    // Re-promoting a withdrawn component must put it back on offer. Returning
    // the withdrawn id would report success while leaving the pack distributed
    // to nobody — every live read filters that row out.
    expect(distributionCreate).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.ok && result.response.distributionId).toBe("dist-recreated");
    expect(result.ok && result.response.distributionId).not.toBe(
      WITHDRAWN_DIST
    );
  });
});
