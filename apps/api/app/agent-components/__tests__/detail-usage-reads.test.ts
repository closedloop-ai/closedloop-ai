/**
 * ISS-5441: pin the moved-inventory usage read and its fail-closed guard. The
 * read must recover hash-A usage after the linked inventory row moves to hash B,
 * and must never query a population it has no identity for.
 *
 * ISS-10469 re-keyed that read from the content scope onto
 * `usedOnlyUsageIdentityWhere`, so the guard it fails closed on moved with it:
 * from "no content scope" to "no identity at all". A name-level route now DOES
 * grow the second arm — keyed on that route's own names, never org-wide — which
 * is the family scoping this suite pins below.
 */

import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  USAGE_WITHOUT_LIVE_INVENTORY_WHERE,
  type WhereClause,
} from "@/__tests__/support/agent-components/usage-lane-doubles";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import {
  detailOrphanUsageWhere,
  fetchDetailLiveInventoryUsage,
  fetchDetailUsageSeenBounds,
  usageNameIdentityWhere,
  usedOnlyUsageIdentityWhere,
} from "../detail-usage-reads";

describe("fetchDetailLiveInventoryUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns no rows without querying the database when there is no identity", async () => {
    const findMany = trackedDelegate([] as DetailUsageRow[]);
    const db = {
      agentComponentSessionUsage: { findMany },
    } as unknown as DetailUsageDb;

    const result = await fetchDetailLiveInventoryUsage(
      db,
      ORGANIZATION_ID,
      AgentComponentKind.Skill,
      null
    );

    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("recovers hash-A usage after its linked inventory row moves to hash B", async () => {
    const findMany = trackedDelegate([MOVED_HASH_USAGE_ROW]);
    const db = {
      agentComponentSessionUsage: { findMany },
    } as unknown as DetailUsageDb;

    const result = await fetchDetailLiveInventoryUsage(
      db,
      ORGANIZATION_ID,
      AgentComponentKind.Skill,
      CONTENT_IDENTITY_A
    );

    expect(result).toEqual([MOVED_HASH_USAGE_ROW]);
    expect(findMany).toHaveBeenCalledOnce();
    const call = findMany.mock.calls[0]?.[0] as FindManyArgs | undefined;
    expect(call?.where).toEqual({
      // ISS-6180: a LIVE FK target only — `fetchDetailOrphanUsage` now claims the
      // tombstoned-FK rows, and `buildOrphanOnlyDetail` folds both lanes.
      agentComponent: { uninstalledAt: null },
      componentKind: AgentComponentKind.Skill,
      // ISS-10469: nested under `AND`, never spread — the content identity IS an
      // `OR`, and spreading one beside a sibling `OR` replaces it.
      AND: [
        {
          OR: [
            { componentVersionHash: { in: [CONTENT_HASH_A] } },
            {
              definitionVersion: {
                definitionHash: DEFINITION_HASH_A,
              },
            },
          ],
        },
      ],
      session: {
        artifact: {
          organizationId: ORGANIZATION_ID,
        },
      },
    });
  });
});

/**
 * ISS-5577: the seen-window aggregate is the ONLY read whose predicate is built
 * by OR-ing both detail usage lanes, so what must be pinned here is that BOTH
 * arms stay org-scoped and that neither can read a population it has no identity
 * for. ISS-10469 gave the FK-linked arm the same identity as its sibling, so the
 * second half of that is now "no identity, no arm" rather than "no fingerprint,
 * no arm".
 */
describe("fetchDetailUsageSeenBounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ORs both org-scoped lanes for a content-hash route", async () => {
    const aggregate = trackedDelegate(EMPTY_BOUNDS);
    const db = {
      agentComponentSessionUsage: { aggregate },
    } as unknown as DetailUsageDb;

    await fetchDetailUsageSeenBounds(
      db,
      ORGANIZATION_ID,
      AgentComponentKind.Skill,
      COMPONENT_KEY,
      [COMPONENT_KEY],
      CONTENT_SCOPE_A
    );

    const call = aggregate.mock.calls[0]?.[0] as AggregateArgs | undefined;
    const lanes = call?.where.OR ?? [];
    expect(lanes).toHaveLength(2);
    // Neither arm may read outside the caller's organization.
    for (const lane of lanes) {
      expect(lane.session).toEqual({
        artifact: { organizationId: ORGANIZATION_ID },
      });
      expect(lane.componentKind).toBe(AgentComponentKind.Skill);
    }
    // ISS-6180: the two lanes stay disjoint, but lane membership is no longer a
    // bare null/non-null FK test. The orphan lane claims usage no LIVE inventory
    // row owns (null FK OR a FK to a tombstoned row), so the moved-inventory lane
    // narrows to a live FK target — otherwise a tombstoned row's usage would sit
    // in both lanes and be counted twice.
    expect(lanes[0]?.AND).toContainEqual(USAGE_WITHOUT_LIVE_INVENTORY_WHERE);
    expect(lanes[1]?.agentComponent).toEqual({ uninstalledAt: null });
  });

  it("keys BOTH lanes on the family's names on a name-level route", async () => {
    const aggregate = trackedDelegate(EMPTY_BOUNDS);
    const db = {
      agentComponentSessionUsage: { aggregate },
    } as unknown as DetailUsageDb;

    await fetchDetailUsageSeenBounds(
      db,
      ORGANIZATION_ID,
      AgentComponentKind.Skill,
      COMPONENT_KEY
    );

    const call = aggregate.mock.calls[0]?.[0] as AggregateArgs | undefined;
    // ISS-10469 (behavior change): this used to assert ONE lane, because the
    // FK-linked arm keyed on CONTENT alone and a name route has no fingerprint,
    // so growing it would have meant the org-wide live-FK population. The arm now
    // carries the route's OWN names, so the window covers the whole family — the
    // same population every other field on the page states — rather than only the
    // usage no live inventory row owns.
    expect(call?.where.OR).toHaveLength(2);
    expect(call?.where.OR[0]?.AND).toContainEqual(
      USAGE_WITHOUT_LIVE_INVENTORY_WHERE
    );
    expect(call?.where.OR[1]?.agentComponent).toEqual({ uninstalledAt: null });
  });

  it("omits the FK-linked lane when the route resolved no identity at all", async () => {
    const aggregate = trackedDelegate(EMPTY_BOUNDS);
    const db = {
      agentComponentSessionUsage: { aggregate },
    } as unknown as DetailUsageDb;

    await fetchDetailUsageSeenBounds(
      db,
      ORGANIZATION_ID,
      AgentComponentKind.Skill,
      ""
    );

    const call = aggregate.mock.calls[0]?.[0] as AggregateArgs | undefined;
    // No name and no fingerprint: an arm with no identity of its own would be
    // every live-FK usage row of this kind in the org. Fails closed.
    expect(call?.where.OR).toHaveLength(1);
  });
});

type AggregateArgs = {
  where: {
    OR: {
      AND?: unknown[];
      agentComponent?: unknown;
      componentKind?: string;
      session?: unknown;
    }[];
  };
};

const EMPTY_BOUNDS = {
  _min: { firstInvokedAt: null },
  _max: { lastInvokedAt: null },
};

type DetailUsageDb = Parameters<typeof fetchDetailLiveInventoryUsage>[0];
type DetailUsageRow = Awaited<
  ReturnType<typeof fetchDetailLiveInventoryUsage>
>[number];
type FindManyArgs = { where: WhereClause };

const ORGANIZATION_ID = "org-1";
const COMPONENT_KEY = "my-skill";
const CONTENT_HASH_A = "content-hash-a";
const DEFINITION_HASH_A = "definition-hash-a";
const CONTENT_SCOPE_A = {
  fingerprint: DEFINITION_HASH_A,
  contentHashes: [CONTENT_HASH_A],
};

/** The identity a nameless content-hash route resolves to (ISS-10469). */
const CONTENT_IDENTITY_A = usedOnlyUsageIdentityWhere("", [], CONTENT_SCOPE_A)
  .where as NonNullable<Parameters<typeof fetchDetailLiveInventoryUsage>[3]>;

// The inventory FK remains non-null but now points at the row's hash-B state;
// the selected usage shape carries the historical hash-A invocation evidence.
const MOVED_HASH_USAGE_ROW = {
  agentSessionId: "session-that-used-hash-a",
  invocationCount: 7,
  harness: Harness.Claude,
  gitBranch: "",
  definitionVersionId: "definition-version-a",
  componentVersionHash: "hash-a",
  firstInvokedAt: new Date("2026-02-01T00:00:00.000Z"),
  lastInvokedAt: new Date("2026-02-09T00:00:00.000Z"),
} satisfies DetailUsageRow;

function trackedDelegate<T>(value: T) {
  return vi.fn(async (_args: unknown): Promise<T> => value);
}

/**
 * ISS-6756 — the identity-scoped usage lanes must ask for the PERSISTED fold,
 * not for `mode: "insensitive"`.
 *
 * Prisma compiles `{ equals: k, mode: "insensitive" }` to `component_key ILIKE
 * $n`, an operator NO btree can serve — not even a `LOWER(component_key)`
 * expression index, which is exactly the distinction migration 20260815120000
 * (ISS-6452) turns on. These lanes bind neither `agentComponentId` nor
 * `agentSessionId`, and `agent_component_session_usage` carries no
 * `organization_id` column (org arrives through the `session.artifact` join), so
 * the ILIKE left them narrowing only to the same-kind partition of every tenant.
 *
 * The tests below pin the SPELLING, because both spellings select the same rows:
 * a `where`-evaluating double cannot tell them apart, so only asserting the
 * absence of the raw-key predicate distinguishes the indexed read from the
 * scanning one.
 */
describe("usageNameIdentityWhere", () => {
  it("matches the persisted fold, with no ILIKE anywhere in the predicate", () => {
    const where = usageNameIdentityWhere(["Reviewer"]);

    expect(where).toEqual({ componentKeyNormalized: { in: ["reviewer"] } });
    expect(JSON.stringify(where)).not.toContain("insensitive");
  });

  it("drops a name that folds to nothing instead of emitting `IN ('')`", () => {
    // `IN ('')` matches every row still carrying the column's
    // `ADD COLUMN … DEFAULT ''` value — the widest predicate in the shape of
    // the narrowest. An all-empty set fails CLOSED, selecting nothing.
    expect(usageNameIdentityWhere(["Reviewer", "  ", ""])).toEqual({
      componentKeyNormalized: { in: ["reviewer"] },
    });
    expect(usageNameIdentityWhere(["", "   "])).toEqual({
      componentKeyNormalized: { in: [] },
    });
  });

  it("folds and de-duplicates alias names that differ only by case or padding", () => {
    // FEA-4335 hands this lane every name the content is installed under. Two
    // spellings of one name are ONE index probe, not two.
    expect(
      usageNameIdentityWhere(["Reviewer", "  reviewer ", "alias"])
    ).toEqual({ componentKeyNormalized: { in: ["reviewer", "alias"] } });
  });
});

describe("detailOrphanUsageWhere", () => {
  it("carries the folded identity beside the lane and content predicates, all under AND", () => {
    const where = detailOrphanUsageWhere(
      ORGANIZATION_ID,
      "skill",
      COMPONENT_KEY,
      ["My-Skill"],
      CONTENT_SCOPE_A
    );

    expect(where.componentKind).toBe("skill");
    expect(where.AND).toEqual([
      USAGE_WITHOUT_LIVE_INVENTORY_WHERE,
      { componentKeyNormalized: { in: ["my-skill"] } },
      {
        OR: [
          { componentVersionHash: { in: [CONTENT_HASH_A] } },
          { definitionVersion: { definitionHash: DEFINITION_HASH_A } },
        ],
      },
    ]);
    expect(where).not.toHaveProperty("componentKey");
  });

  it("drops the identity predicate entirely for the orphan-only content-hash case", () => {
    // No name at all: `contentScope` alone selects the rows. An empty `in` here
    // would select NOTHING, silently emptying the lane.
    const where = detailOrphanUsageWhere(
      ORGANIZATION_ID,
      "skill",
      "",
      [],
      CONTENT_SCOPE_A
    );

    expect(where.AND).toHaveLength(2);
    expect(JSON.stringify(where)).not.toContain("componentKeyNormalized");
  });
});
