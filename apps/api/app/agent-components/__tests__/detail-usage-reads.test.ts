/**
 * ISS-5441: pin the moved-content usage read and its fail-closed legacy-route
 * guard. The read must recover hash-A usage after the linked inventory row
 * moves to hash B, while a name-level route with no content scope must never
 * query the org-wide linked-usage population.
 */

import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  USAGE_WITHOUT_LIVE_INVENTORY_WHERE,
  type WhereClause,
} from "@/app/agent-components/__tests__/usage-lane-doubles";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import {
  fetchDetailLinkedUsageByContentScope,
  fetchDetailUsageSeenBounds,
} from "../detail-usage-reads";

describe("fetchDetailLinkedUsageByContentScope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns no rows without querying the database when content scope is null", async () => {
    const findMany = trackedDelegate([] as DetailUsageRow[]);
    const db = {
      agentComponentSessionUsage: { findMany },
    } as unknown as DetailUsageDb;

    const result = await fetchDetailLinkedUsageByContentScope(
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

    const result = await fetchDetailLinkedUsageByContentScope(
      db,
      ORGANIZATION_ID,
      AgentComponentKind.Skill,
      CONTENT_SCOPE_A
    );

    expect(result).toEqual([MOVED_HASH_USAGE_ROW]);
    expect(findMany).toHaveBeenCalledOnce();
    const call = findMany.mock.calls[0]?.[0] as FindManyArgs | undefined;
    expect(call?.where).toEqual({
      // ISS-6180: a LIVE FK target only — `fetchDetailOrphanUsage` now claims the
      // tombstoned-FK rows, and `buildOrphanOnlyDetail` folds both lanes.
      agentComponent: { uninstalledAt: null },
      componentKind: AgentComponentKind.Skill,
      OR: [
        { componentVersionHash: { in: [CONTENT_HASH_A] } },
        {
          definitionVersion: {
            definitionHash: DEFINITION_HASH_A,
          },
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
 * by OR-ing both detail usage lanes, and the moved-inventory lane carries no name
 * constraint — it selects by (kind, content hash) alone. So the thing that must
 * be pinned is that BOTH arms stay org-scoped, and that a name-level route never
 * grows the second arm at all.
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

  it("omits the moved-inventory lane entirely on a name-level route", async () => {
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
    // Without a fingerprint there is no moved row to recover, so the org-wide
    // FK-linked population must never widen the window.
    expect(call?.where.OR).toHaveLength(1);
    expect(call?.where.OR[0]?.AND).toContainEqual(
      USAGE_WITHOUT_LIVE_INVENTORY_WHERE
    );
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

type DetailUsageDb = Parameters<typeof fetchDetailLinkedUsageByContentScope>[0];
type DetailUsageRow = Awaited<
  ReturnType<typeof fetchDetailLinkedUsageByContentScope>
>[number];
type FindManyArgs = { where: WhereClause };

const ORGANIZATION_ID = "org-1";
const COMPONENT_KEY = "my-skill";
const CONTENT_HASH_A = "content-hash-a";
const DEFINITION_HASH_A = "definition-hash-a";
const CONTENT_SCOPE_A = {
  fingerprint: DEFINITION_HASH_A,
  contentHashes: [CONTENT_HASH_A],
} satisfies NonNullable<
  Parameters<typeof fetchDetailLinkedUsageByContentScope>[3]
>;

// The inventory FK remains non-null but now points at the row's hash-B state;
// the selected usage shape carries the historical hash-A invocation evidence.
const MOVED_HASH_USAGE_ROW = {
  agentSessionId: "session-that-used-hash-a",
  invocationCount: 7,
  harness: Harness.Claude,
  gitBranch: "",
  definitionVersionId: "definition-version-a",
  firstInvokedAt: new Date("2026-02-01T00:00:00.000Z"),
  lastInvokedAt: new Date("2026-02-09T00:00:00.000Z"),
} satisfies DetailUsageRow;

function trackedDelegate<T>(value: T) {
  return vi.fn(async (_args: unknown): Promise<T> => value);
}
