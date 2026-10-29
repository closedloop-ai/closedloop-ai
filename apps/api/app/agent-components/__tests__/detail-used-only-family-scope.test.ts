/**
 * ISS-10469: the USED-ONLY detail sums the FAMILY, and its two lanes partition
 * that family rather than overlapping it.
 *
 * ISS-10341 made every other aggregate on the agent-component detail
 * family-scoped ("one population per page"); the used-only state — a route whose
 * fingerprint resolved version rows but whose family has no LIVE inventory row —
 * kept narrowing its usage to one content version, so that one page state
 * answered a different question than the rest of the page.
 *
 * Re-keying was attempted once and reverted because it appeared to double-count.
 * It did not: the doubling came from doubles that answered the FK-linked arm with
 * the orphan fixture list (see `requiresLiveInventoryOwner`). The double below
 * EVALUATES both arms' membership terms against a modelled inventory owner, so a
 * row admitted twice would be visible here as a duplicate id rather than hidden
 * in a total that happens to reconcile.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { normalizeComponentKey } from "@repo/api/src/types/agent-component-analytics";
import { describe, expect, it, vi } from "vitest";
import {
  USAGE_WITHOUT_LIVE_INVENTORY_WHERE,
  type WhereClause,
} from "@/__tests__/support/agent-components/usage-lane-doubles";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import {
  detailUsageLaneWheres,
  fetchDetailOrphanUsageLanes,
} from "../detail-usage-reads";

const ORGANIZATION_ID = "org-1";
const KIND = AgentComponentKind.Skill;
const FAMILY_KEY = "deploy";
/** The same family, spelled the way an event-minted row stores it. */
const FAMILY_ALIAS_KEY = "  Deploy ";
const OTHER_FAMILY_KEY = "publish";
const HASH_A = "hash-a";
const HASH_B = "hash-b";
const HASH_C = "hash-c";
const CONTENT_SCOPE_A = { fingerprint: HASH_A, contentHashes: [HASH_A] };

const UNINSTALLED_AT = new Date("2026-03-01T00:00:00.000Z");

/**
 * One usage row with the two things the real partition turns on that
 * `OrphanUsageShape` does not model: which inventory row owns it, and whether
 * that owner is tombstoned. `owner: null` is a null FK.
 */
type UsageFixture = {
  id: string;
  agentSessionId: string;
  componentKey: string;
  componentVersionHash: string | null;
  owner: { uninstalledAt: Date | null } | null;
  invocationCount: number;
};

const ROWS: readonly UsageFixture[] = [
  // No live inventory owner: the orphan arm's population.
  row("orphan-at-a", FAMILY_KEY, HASH_A, null, 5),
  row("orphan-at-b", FAMILY_KEY, HASH_B, null, 7),
  row(
    "tombstoned-at-a",
    FAMILY_KEY,
    HASH_A,
    { uninstalledAt: UNINSTALLED_AT },
    11
  ),
  // A live inventory owner: the FK-linked arm's population. `live-at-a` is the
  // moved-inventory row FEA-4335 added the second lane for — its owner has since
  // moved to hash B, so no live inventory row carries hash A.
  row("live-at-b", FAMILY_KEY, HASH_B, { uninstalledAt: null }, 13),
  row("live-at-a", FAMILY_KEY, HASH_A, { uninstalledAt: null }, 3),
  // FEA-4335 supplies alias spellings that differ only by case or padding. This
  // row is the family under one of them, so a double comparing the raw key
  // instead of its fold would drop it while SQL admits it.
  row("alias-at-b", FAMILY_ALIAS_KEY, HASH_B, { uninstalledAt: null }, 2),
  // A second family, so a fixture that admitted everything could not pass.
  row("other-family", OTHER_FAMILY_KEY, HASH_C, null, 101),
];

/**
 * Independent literals: what the FAMILY holds, counted by hand from ROWS. Rows
 * are identified by their session id, the identity the lane read actually
 * selects — one fixture row per session, so a row admitted by both arms shows up
 * as a repeated entry.
 */
const FAMILY_SESSION_IDS = [
  "session-alias-at-b",
  "session-live-at-a",
  "session-live-at-b",
  "session-orphan-at-a",
  "session-orphan-at-b",
  "session-tombstoned-at-a",
];
const FAMILY_INVOCATIONS = 41;
/** What the pre-ISS-10469, content-narrowed read returned for the same route. */
const VERSION_A_INVOCATIONS = 19;

describe("used-only detail usage lanes are family-scoped (ISS-10469)", () => {
  it("sums the whole family on a content-hash route, not the addressed version", async () => {
    const db = usageDouble();

    const lanes = await fetchDetailOrphanUsageLanes(
      db,
      ORGANIZATION_ID,
      KIND,
      FAMILY_KEY,
      [FAMILY_KEY],
      CONTENT_SCOPE_A
    );

    expect(sumInvocations(lanes.rows)).toBe(FAMILY_INVOCATIONS);
    expect(sumInvocations(lanes.rows)).not.toBe(VERSION_A_INVOCATIONS);
  });

  it("sums the same family on a legacy name route with no content scope", async () => {
    const db = usageDouble();

    const lanes = await fetchDetailOrphanUsageLanes(
      db,
      ORGANIZATION_ID,
      KIND,
      FAMILY_KEY
    );

    // Same population as the content-hash route above: the route is the address,
    // not the population.
    expect(sumInvocations(lanes.rows)).toBe(FAMILY_INVOCATIONS);
  });

  it("admits every family row EXACTLY ONCE across the two lanes", async () => {
    const db = usageDouble();

    const lanes = await fetchDetailOrphanUsageLanes(
      db,
      ORGANIZATION_ID,
      KIND,
      FAMILY_KEY,
      [FAMILY_KEY],
      CONTENT_SCOPE_A
    );

    // The direct disjointness pin: ids, not a total. A total can reconcile under
    // a double-count that happens to cancel; a duplicated id cannot hide.
    const ids = lanes.rows.map((r) => r.agentSessionId).sort();
    expect(ids).toEqual(FAMILY_SESSION_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the nameless content-hash route keyed on its fingerprint", async () => {
    const db = usageDouble();

    // The orphan-only route: the fingerprint matched no version row, so there is
    // no family to be narrower than and the hash IS the identity.
    const lanes = await fetchDetailOrphanUsageLanes(
      db,
      ORGANIZATION_ID,
      KIND,
      "",
      [],
      CONTENT_SCOPE_A
    );

    expect(lanes.rows.map((r) => r.agentSessionId).sort()).toEqual([
      "session-live-at-a",
      "session-orphan-at-a",
      "session-tombstoned-at-a",
    ]);
  });

  it("excludes a row of another family from every lane", async () => {
    const db = usageDouble();

    const lanes = await fetchDetailOrphanUsageLanes(
      db,
      ORGANIZATION_ID,
      KIND,
      FAMILY_KEY,
      [FAMILY_KEY],
      CONTENT_SCOPE_A
    );

    expect(lanes.rows.map((r) => r.agentSessionId)).not.toContain(
      "session-other-family"
    );
  });
});

describe("used-only lane predicates (ISS-10469)", () => {
  it("gives both arms the SAME identity and differs only on FK liveness", () => {
    const lanes = detailUsageLaneWheres(
      ORGANIZATION_ID,
      KIND,
      FAMILY_KEY,
      [FAMILY_KEY],
      CONTENT_SCOPE_A
    );

    expect(lanes).toHaveLength(2);
    const identity = { componentKeyNormalized: { in: [FAMILY_KEY] } };
    expect(lanes[0]?.AND).toContainEqual(identity);
    expect(lanes[1]?.AND).toContainEqual(identity);
    // The complement pair that makes the union double-count-proof.
    expect(lanes[0]?.AND).toContainEqual(USAGE_WITHOUT_LIVE_INVENTORY_WHERE);
    expect(lanes[1]?.agentComponent).toEqual({ uninstalledAt: null });
    // No content narrowing survives on a family route, on either arm.
    expect(JSON.stringify(lanes)).not.toContain("componentVersionHash");
  });

  it("keys both arms on the fingerprint when the route resolved no name", () => {
    const lanes = detailUsageLaneWheres(
      ORGANIZATION_ID,
      KIND,
      "",
      [],
      CONTENT_SCOPE_A
    );

    const identity = {
      OR: [
        { componentVersionHash: { in: [HASH_A] } },
        { definitionVersion: { definitionHash: HASH_A } },
      ],
    };
    expect(lanes).toHaveLength(2);
    expect(lanes[0]?.AND).toContainEqual(identity);
    expect(lanes[1]?.AND).toContainEqual(identity);
    expect(JSON.stringify(lanes)).not.toContain("componentKeyNormalized");
  });
});

function row(
  id: string,
  componentKey: string,
  componentVersionHash: string | null,
  owner: { uninstalledAt: Date | null } | null,
  invocationCount: number
): UsageFixture {
  return {
    id,
    agentSessionId: `session-${id}`,
    componentKey,
    componentVersionHash,
    owner,
    invocationCount,
  };
}

function sumInvocations(rows: readonly { invocationCount: number }[]): number {
  return rows.reduce((total, r) => total + r.invocationCount, 0);
}

/** A `findMany` that EVALUATES the lane predicate instead of routing on it. */
function usageDouble() {
  return {
    agentComponentSessionUsage: {
      findMany: vi.fn((args: { where?: WhereClause }) =>
        Promise.resolve(
          ROWS.filter((r) => matches(r, args?.where)).map((r) => ({
            ...r,
            harness: null,
            gitBranch: "",
            definitionVersionId: null,
            firstInvokedAt: null,
            lastInvokedAt: null,
          }))
        )
      ),
    },
  } as unknown as Parameters<typeof fetchDetailOrphanUsageLanes>[0];
}

/** The subset of Prisma `where` shapes these two lanes actually emit. */
function matches(row: UsageFixture, where: WhereClause | undefined): boolean {
  if (!where) {
    return true;
  }
  return Object.entries(where).every(([field, value]) =>
    matchesTerm(row, field, value)
  );
}

function matchesTerm(
  row: UsageFixture,
  field: string,
  value: unknown
): boolean {
  if (field === "AND") {
    return (value as WhereClause[]).every((clause) => matches(row, clause));
  }
  if (field === "OR") {
    return (value as WhereClause[]).some((clause) => matches(row, clause));
  }
  if (field === "componentKind") {
    return value === KIND;
  }
  if (field === "session") {
    return (
      (value as { artifact: { organizationId: string } }).artifact
        .organizationId === ORGANIZATION_ID
    );
  }
  if (field === "agentComponentId") {
    return value === null && row.owner === null;
  }
  if (field === "agentComponent") {
    return matchesOwner(row, value as { uninstalledAt: unknown });
  }
  if (field === "componentKeyNormalized") {
    // The column is the PERSISTED fold the table's trigger maintains, and
    // `usageNameIdentityWhere` already folded the names it asks for — so the row
    // side must fold too. Comparing the raw key would silently drop an alias
    // spelling that SQL admits, which is the case `alias-at-b` below pins.
    return (value as { in: string[] }).in.includes(
      normalizeComponentKey(row.componentKey)
    );
  }
  if (field === "componentVersionHash") {
    return (
      row.componentVersionHash !== null &&
      (value as { in: string[] }).in.includes(row.componentVersionHash)
    );
  }
  if (field === "definitionVersion") {
    // No fixture row links a DefinitionVersion, so this arm never admits one.
    return false;
  }
  throw new Error(`unmodelled predicate field: ${field}`);
}

/** The FK-liveness half of the partition, decided from the modelled owner. */
function matchesOwner(
  row: UsageFixture,
  relation: { uninstalledAt: unknown }
): boolean {
  if (row.owner === null) {
    return false;
  }
  if (relation.uninstalledAt === null) {
    return row.owner.uninstalledAt === null;
  }
  return row.owner.uninstalledAt !== null;
}
