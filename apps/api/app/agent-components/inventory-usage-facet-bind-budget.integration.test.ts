/**
 * ISS-7271 (davetho review): a real-Postgres proof that the FK usage rollup
 * survives a broad `?search=` + `?kinds=` request over an id list past one
 * statement's bind budget, and returns the WHOLE rollup rather than the chunk it
 * happened to fit.
 *
 * The unit suite beside this file (`__tests__/inventory-usage-facet-bind-budget`)
 * asserts the widths the production call emits, read off a `groupBy` double. It
 * cannot see the half that decides whether the Agents catalog answers at all:
 * what Prisma does when the predicate it is asked to build wants more bind
 * parameters than it will emit. Measured on this stack (Prisma 7.8 /
 * `@prisma/adapter-pg` / PostgreSQL 16) that is not a slow query and not a
 * truncated read — the operation is refused outright with P2029, and this lane
 * is deliberately NOT fail-open (see `runUsageGroupByChunked`), so the rejection
 * propagates and 500s the request. A double cannot refuse anything, so a
 * serialization or bind-shape regression would keep 500ing in production while
 * that suite stayed green. This one has to run the statement.
 *
 * WHY IT ENTERS AT `loadUsageGroupsForInventory` rather than at the HTTP list
 * route. Two independent widths have to be past the budget at once: the
 * inventory id list (tens of thousands of ids) and the `?search=` readmission
 * arms (two binds per name-matched identity). Reaching those THROUGH the route
 * means seeding tens of thousands of inventory rows per run to be handed back as
 * ids the read already has. The precedent is
 * `lib/skill-shadow-bind-ceiling.integration.test.ts`: the over-ceiling payload
 * is in memory, the rows the assertions name are real, and the function driven
 * is the one the production read routes through — `readUsageSnapshot` calls
 * exactly this, with exactly these arguments.
 *
 * WHY THE ASSERTIONS NAME ROWS. "It did not throw" would pass against a chunker
 * that dropped its last partial slice, which is the failure a narrower chunk
 * makes MORE likely, and which surfaces as an understated invocation count
 * rather than an error. So the rows that must come back sit at both ENDS of the
 * id list, and rows the facets exclude are seeded alongside them so a predicate
 * that degenerated into a tautology is visible too.
 *
 * Run against a database with the schema applied:
 *
 *   DATABASE_URL=… pnpm --filter api exec vitest run \
 *     app/agent-components/inventory-usage-facet-bind-budget.integration.test.ts \
 *     --config vitest.config.integration.mts
 */
import { randomUUID } from "node:crypto";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { withDb } from "@repo/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countPredicateBindParameters,
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS,
} from "@/lib/postgres-bind-parameters";
import { loadUsageGroupsForInventory } from "./org-population";
import { usageSearchWhere } from "./org-population-reads";
import {
  BIND_PARAMETERS_RESERVED_PER_STATEMENT,
  INVENTORY_USAGE_ID_CHUNK_SIZE,
} from "./usage-bind-budget";

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const COMPUTE_TARGET_ID = randomUUID();
const SESSION_ID = randomUUID();

/** The `?search=` term, distinctive enough that no neighbouring row carries it. */
const SEARCH = "iss7271";
/** The `?kinds=` facet, as a request that narrowed to a few kinds would send it. */
const KINDS = [
  AgentComponentKind.Skill,
  AgentComponentKind.Command,
  AgentComponentKind.Subagent,
] as const;

/**
 * Name-matched identities the `?search=` facet readmits, i.e. `OR` arms of two
 * binds each.
 *
 * Sized against the FIXED RESERVE the chunker used to hold back for "the
 * facets" ({@link BIND_PARAMETERS_RESERVED_PER_STATEMENT}, 767) — the number the
 * defect was that the facets could exceed — and NOT at the identity cap (5,000),
 * which would be 10,001 arms for no additional discrimination. Crossing the
 * reserve at all is what puts a full unnarrowed chunk over the ceiling; the
 * assertion below pins that this fixture does, so a reader can see the margin
 * rather than trust this paragraph.
 */
const NAME_MATCHED_IDENTITY_COUNT = 1200;

/**
 * A dozen ids past the width a chunk reaches when the request carries NO facets,
 * so the unfixed code emits one FULL chunk — the statement that is refused —
 * before any tail, and the fixed code has to emit at least two.
 */
const INVENTORY_ID_COUNT = INVENTORY_USAGE_ID_CHUNK_SIZE + 12;

/** Matched by the facet's `componentKey contains` arm. */
const KEY_MATCH_KEY = `${SEARCH}-key-contains-the-search-term`;
/**
 * Matched ONLY by a readmission arm — its key does not contain the search term.
 * These arms are the width that broke the reserve, so this is the row that
 * proves they still SELECT after being counted.
 */
const NAME_MATCH_KEY = "readmitted-by-a-name-matched-arm";
/** Matched by neither arm: the facet must still exclude it. */
const UNMATCHED_KEY = "matched-by-no-arm-of-the-facet";
/** Key matches, kind does not: the `?kinds=` arm must still exclude it. */
const WRONG_KIND_KEY = `${SEARCH}-key-under-an-unrequested-kind`;

const KEY_MATCH_ID = randomUUID();
const NAME_MATCH_ID = randomUUID();
const UNMATCHED_ID = randomUUID();
const WRONG_KIND_ID = randomUUID();

const KEY_MATCH_INVOCATIONS = 7;
const NAME_MATCH_INVOCATIONS = 11;

/**
 * The identities the facet readmits: the filler arms that make the predicate
 * wide, plus the one real row that must come back through an arm.
 * `collectNameMatchedIdentities` returns exactly this shape.
 */
const NAME_MATCHED_IDENTITIES = [
  ...Array.from({ length: NAME_MATCHED_IDENTITY_COUNT - 1 }, (_unused, i) => ({
    kind: AgentComponentKind.Skill as string,
    key: `${SEARCH}-filler-identity-${i}`,
  })),
  { kind: AgentComponentKind.Skill as string, key: NAME_MATCH_KEY },
];

const SEARCH_FACET = {
  search: SEARCH,
  nameMatchedIdentities: NAME_MATCHED_IDENTITIES,
};

/**
 * The seeded ids at BOTH ENDS of the list, and every other id absent from the
 * database. A chunker that lost its last partial slice keeps the first row and
 * loses the rest, which is the shape of a fencepost bug and not of a refusal.
 */
function inventoryIds(): string[] {
  const absent = Array.from({ length: INVENTORY_ID_COUNT - 4 }, () =>
    randomUUID()
  );
  return [KEY_MATCH_ID, ...absent, UNMATCHED_ID, WRONG_KIND_ID, NAME_MATCH_ID];
}

/** The bind width this request's own facets spend, measured as the read does. */
function facetBindWidth(): number {
  return countPredicateBindParameters({
    ...usageSearchWhere(SEARCH_FACET),
    componentKind: { in: [...KINDS] },
    session: { artifact: { organizationId: ORG_ID } },
  });
}

async function seedUsageRow(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  row: {
    id: string;
    componentKey: string;
    componentKind: string;
    invocationCount: number;
  }
): Promise<void> {
  await db.agentComponent.create({
    data: {
      id: row.id,
      organizationId: ORG_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      componentKind: row.componentKind,
      externalComponentId: `${row.componentKind}:${row.componentKey}`,
      name: row.componentKey,
      componentKey: row.componentKey,
    },
    select: { id: true },
  });
  await db.agentComponentSessionUsage.create({
    data: {
      agentSessionId: SESSION_ID,
      agentComponentId: row.id,
      componentKind: row.componentKind,
      // `componentKeyNormalized` is derived by the table's own trigger, never by
      // a writer — seeding it here would prove the fold rather than use it.
      componentKey: row.componentKey,
      invocationCount: row.invocationCount,
      lastInvokedAt: new Date("2026-01-01T00:00:00Z"),
    },
    select: { id: true },
  });
}

describe.skipIf(!process.env.DATABASE_URL)(
  "the FK usage rollup under a broad facet, against real Postgres (ISS-7271)",
  () => {
    beforeAll(async () => {
      await withDb(async (db) => {
        await db.organization.create({
          data: {
            id: ORG_ID,
            clerkId: `clerk_org_${ORG_ID}`,
            name: "ISS-7271 facet bind budget org",
            slug: `iss7271-facet-bind-budget-${ORG_ID}`,
          },
          select: { id: true },
        });
        await db.user.create({
          data: {
            id: USER_ID,
            organizationId: ORG_ID,
            clerkId: `clerk_user_${USER_ID}`,
            email: "iss7271.facet.bind.budget@example.com",
          },
          select: { id: true },
        });
        await db.computeTarget.create({
          data: {
            id: COMPUTE_TARGET_ID,
            organizationId: ORG_ID,
            userId: USER_ID,
            machineName: "iss7271-facet-bind-budget",
            platform: "darwin",
          },
          select: { id: true },
        });
        await db.artifact.create({
          data: {
            id: SESSION_ID,
            organizationId: ORG_ID,
            type: "SESSION",
            name: "ISS-7271 facet bind budget session",
            slug: `iss7271-facet-bind-budget-session-${SESSION_ID}`,
            status: "active",
          },
          select: { id: true },
        });
        await db.sessionDetail.create({
          data: {
            artifactId: SESSION_ID,
            computeTargetId: COMPUTE_TARGET_ID,
            externalSessionId: `ext-${SESSION_ID}`,
            harness: "claude",
            sessionStartedAt: new Date("2026-01-01T00:00:00Z"),
            sessionUpdatedAt: new Date("2026-01-01T01:00:00Z"),
            lastActivityAt: new Date("2026-01-01T01:00:00Z"),
          },
          // `*Detail` tables are keyed on artifactId, not id.
          select: { artifactId: true },
        });

        await seedUsageRow(db, {
          id: KEY_MATCH_ID,
          componentKey: KEY_MATCH_KEY,
          componentKind: AgentComponentKind.Skill,
          invocationCount: KEY_MATCH_INVOCATIONS,
        });
        await seedUsageRow(db, {
          id: NAME_MATCH_ID,
          componentKey: NAME_MATCH_KEY,
          componentKind: AgentComponentKind.Skill,
          invocationCount: NAME_MATCH_INVOCATIONS,
        });
        await seedUsageRow(db, {
          id: UNMATCHED_ID,
          componentKey: UNMATCHED_KEY,
          componentKind: AgentComponentKind.Skill,
          invocationCount: 13,
        });
        await seedUsageRow(db, {
          id: WRONG_KIND_ID,
          componentKey: WRONG_KIND_KEY,
          componentKind: AgentComponentKind.Hook,
          invocationCount: 17,
        });
      });
    });

    afterAll(async () => {
      // Child-first: `users.organization_id` is RESTRICT, so the org delete
      // alone would fail, and the inventory FK from `compute_targets` is too.
      await withDb(async (db) => {
        await db.agentComponentSessionUsage.deleteMany({
          where: { agentSessionId: SESSION_ID },
        });
        await db.sessionDetail.deleteMany({
          where: { artifactId: SESSION_ID },
        });
        await db.artifact.deleteMany({ where: { organizationId: ORG_ID } });
        await db.agentComponent.deleteMany({
          where: { organizationId: ORG_ID },
        });
        await db.computeTarget.deleteMany({
          where: { organizationId: ORG_ID },
        });
        await db.user.deleteMany({ where: { organizationId: ORG_ID } });
        await db.organization.deleteMany({ where: { id: ORG_ID } });
      });
    });

    it("asks for a statement the pre-ISS-7271 reserve could not have fitted", () => {
      // The fixture only discriminates if the UNNARROWED chunk really is over
      // the ceiling. Assert it rather than assume it: an identity count trimmed
      // for speed, or a facet that stopped emitting arms, would leave the case
      // below green against the unfixed code and prove nothing.
      expect(facetBindWidth()).toBeGreaterThan(
        BIND_PARAMETERS_RESERVED_PER_STATEMENT
      );
      expect(INVENTORY_USAGE_ID_CHUNK_SIZE + facetBindWidth()).toBeGreaterThan(
        POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS
      );
      // …and that the narrowed chunk cannot hold the whole id list, so the
      // partition below is exercised over more than one statement.
      expect(INVENTORY_ID_COUNT).toBeGreaterThan(
        INVENTORY_USAGE_ID_CHUNK_SIZE - facetBindWidth()
      );
    });

    it("returns the complete faceted rollup, both ends of the id list included", async () => {
      const groups = await withDb((db) =>
        loadUsageGroupsForInventory(
          db,
          ORG_ID,
          inventoryIds(),
          {},
          null,
          KINDS,
          SEARCH_FACET
        )
      );

      // Sorted by key rather than trusted in chunk order: what has to hold is
      // that the concatenated chunks reproduce the single-statement result, and
      // the first/last placement above already pins that they came from
      // different slices.
      expect(
        groups
          .map((group) => ({
            componentKey: group.componentKey,
            agentComponentId: group.agentComponentId,
            invocationCount: group._sum.invocationCount,
          }))
          .sort((a, b) =>
            (a.componentKey ?? "").localeCompare(b.componentKey ?? "")
          )
      ).toEqual([
        {
          componentKey: KEY_MATCH_KEY,
          agentComponentId: KEY_MATCH_ID,
          invocationCount: KEY_MATCH_INVOCATIONS,
        },
        {
          componentKey: NAME_MATCH_KEY,
          agentComponentId: NAME_MATCH_ID,
          invocationCount: NAME_MATCH_INVOCATIONS,
        },
      ]);
    });
  }
);
