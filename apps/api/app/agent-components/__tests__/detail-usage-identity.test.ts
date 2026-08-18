/**
 * ISS-4660 item 1 — the DETAIL half of list ⇄ detail usage parity.
 *
 * The list has attributed a usage group by the group's OWN
 * `(componentKind, componentKey)` since ISS-4630. The detail read loaded
 * FK-linked usage by the selected family's INVENTORY IDS and summed everything
 * it got back, so a usage row installed as Y but FK-linked to X's inventory row
 * was credited to Y in the list and to X on the detail page. One usage row, two
 * screens, two numbers.
 *
 * Its own file rather than another block in the grandfathered `service.test.ts`,
 * which is shrink-only. The fixture builders and the fake Prisma client are the
 * shared ones from `service-db-double.ts`, so this suite drives the same
 * production paths against the same double the list-side suite does — the parity
 * asserted here is over one population, not two fixtures that happen to agree.
 */

import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  // ISS-4669: the population reads FK-linked + orphan usage under one
  // `withDb.tx` snapshot, so the mocked module must expose that enum value.
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: {
    listByArtifactIds: mocks.listByArtifactIds,
  },
}));

import type { UsageGroupRow } from "../identity";
import { agentComponentsService } from "../service";
import { filterUsageGroupsToDetailIdentity } from "../service/detail-usage-identity";
import { buildInventoryRow, buildServiceDb } from "./service-db-double";

const ORG = "org-1";
const KIND = "tool";
const FK_KEY = "update_workstream";
const OWN_KEY = "other_tool";

function installDb(db: Record<string, unknown>) {
  const dbWithDefaults = buildServiceDb(db);
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  return dbWithDefaults;
}

function usageGroup(
  agentSessionId: string,
  own: { componentKind: string | null; componentKey: string | null }
): UsageGroupRow {
  return {
    agentComponentId: "ac-x",
    agentSessionId,
    gitBranch: "",
    harness: "claude",
    componentKind: own.componentKind,
    componentKey: own.componentKey,
    componentVersionHash: null,
    definitionHash: null,
    _sum: { invocationCount: 1, errorCount: 0 },
    _max: { lastInvokedAt: null },
  };
}

function sessionIds(groups: UsageGroupRow[]): string[] {
  return groups.map((group) => group.agentSessionId);
}

/**
 * Driven directly rather than through the service, because the service's fake
 * Prisma client derives a usage group's own `(kind, key)` from the FK'd row when
 * the fixture omits them — so the "legacy group with no own key" branch is
 * unreachable from there and a service-level test of it would pass on pre-fix
 * code too. This is the one branch that has to be exercised at the unit.
 */
describe("filterUsageGroupsToDetailIdentity", () => {
  const identity = {
    kind: KIND,
    key: FK_KEY,
    keys: [] as readonly string[],
    inventoryRows: [
      { componentKind: KIND, componentKey: FK_KEY, name: FK_KEY },
    ],
  };

  it("keeps a group carrying no own identity at all", () => {
    const groups = [
      usageGroup("legacy-null", { componentKind: null, componentKey: null }),
      usageGroup("legacy-empty", { componentKind: KIND, componentKey: "" }),
      usageGroup("mine", { componentKind: KIND, componentKey: FK_KEY }),
      usageGroup("theirs", { componentKind: KIND, componentKey: OWN_KEY }),
    ];

    // The legacy pair survives (the list credits them to the FK'd row's slug,
    // so dropping them here would under-count); only the group that names a
    // different family is dropped.
    expect(
      sessionIds(filterUsageGroupsToDetailIdentity(groups, identity))
    ).toEqual(["legacy-null", "legacy-empty", "mine"]);
  });

  it("accepts every name the rendered inventory rows carry, not just the version-derived keys", () => {
    // ISS-4660 H1: a content-hash route selects inventory rows by contentHash
    // alone, while `keys` comes from the version table — so a row whose version
    // row is missing or not definition-linked is rendered by this detail while
    // its name never reaches `keys`. Its usage still belongs to this page.
    const groups = [
      usageGroup("via-inventory-name", {
        componentKind: KIND,
        componentKey: OWN_KEY,
      }),
    ];

    const withRenderedRow = {
      ...identity,
      inventoryRows: [
        { componentKind: KIND, componentKey: FK_KEY, name: FK_KEY },
        { componentKind: KIND, componentKey: OWN_KEY, name: OWN_KEY },
      ],
    };

    expect(
      sessionIds(filterUsageGroupsToDetailIdentity(groups, withRenderedRow))
    ).toEqual(["via-inventory-name"]);
    // …and without that row rendered, the same group is correctly foreign.
    expect(filterUsageGroupsToDetailIdentity(groups, identity)).toEqual([]);
  });

  it("falls back to the inventory row's name when its componentKey is null", () => {
    const groups = [
      usageGroup("named-only", { componentKind: KIND, componentKey: OWN_KEY }),
    ];

    const namedOnly = {
      ...identity,
      inventoryRows: [
        { componentKind: KIND, componentKey: null, name: OWN_KEY },
      ],
    };

    expect(
      sessionIds(filterUsageGroupsToDetailIdentity(groups, namedOnly))
    ).toEqual(["named-only"]);
  });
});

describe("detail usage identity (ISS-4660 item 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("does not credit the detail with FK usage whose own key names another family", async () => {
    // One inventory row installed as `update_workstream`, carrying a usage row
    // FK-linked to it but whose OWN key is `other_tool` — the mismatch the
    // desktop can produce. The list already credits `other_tool`; before this
    // fix the `update_workstream` detail also reported those 4 invocations.
    const row = buildInventoryRow({
      id: "ac-x",
      componentKind: KIND,
      componentKey: FK_KEY,
      name: FK_KEY,
      sessionUsages: [
        {
          agentSessionId: "sess-mismatch",
          invocationCount: 4,
          usageComponentKind: KIND,
          usageComponentKey: OWN_KEY,
          session: {
            artifactId: "sess-mismatch",
            artifact: { organizationId: ORG },
          },
        },
      ],
    });

    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      agentComponentSessionUsage: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const detail = await agentComponentsService.getDetailForOrg(
      ORG,
      encodeComponentSlug(KIND, FK_KEY, null)
    );

    expect(detail?.invocations).toBe(0);
    expect(detail?.sessions).toBe(0);
  });

  it("still counts FK usage whose own identity matches the detail", async () => {
    // The guard against over-correcting through the real service: the filter
    // must drop ONLY groups naming a different family. (The no-own-key branch
    // is unreachable from here — the fake Prisma client resolves a group's own
    // kind/key from the FK'd row — so it is pinned at the unit above.)
    const row = buildInventoryRow({
      id: "ac-match",
      componentKind: KIND,
      componentKey: FK_KEY,
      name: FK_KEY,
      sessionUsages: [
        {
          agentSessionId: "sess-own-identity",
          invocationCount: 5,
          usageComponentKind: KIND,
          usageComponentKey: FK_KEY,
          session: {
            artifactId: "sess-own-identity",
            artifact: { organizationId: ORG },
          },
        },
        {
          // Omits the own kind/key, which the double resolves from the FK'd
          // row — so this is a second group on the SAME identity, not a legacy
          // one. It pins that the filter is per-group, not all-or-nothing.
          agentSessionId: "sess-second-group",
          invocationCount: 2,
          session: {
            artifactId: "sess-second-group",
            artifact: { organizationId: ORG },
          },
        },
      ],
    });

    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      agentComponentSessionUsage: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const detail = await agentComponentsService.getDetailForOrg(
      ORG,
      encodeComponentSlug(KIND, FK_KEY, null)
    );

    expect(detail?.invocations).toBe(7);
    expect(detail?.sessions).toBe(2);
  });

  it("keeps the detail read org-scoped for an out-of-org caller", async () => {
    // The identity filter narrows WITHIN an org and must never widen across one:
    // every inventory read still carries the caller's own organizationId, so a
    // different org sees nothing.
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany },
      agentComponentSessionUsage: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const detail = await agentComponentsService.getDetailForOrg(
      "org-other",
      encodeComponentSlug(KIND, FK_KEY, null)
    );

    expect(detail).toBeNull();
    expect(findMany).toHaveBeenCalled();
    for (const call of findMany.mock.calls) {
      expect(call[0].where.organizationId).toBe("org-other");
    }
  });
});
