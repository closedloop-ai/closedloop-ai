/**
 * Shared fake-Prisma fixtures for the ISS-4635 org component population.
 *
 * `buildOrgComponentPopulation` backs BOTH the catalog list and the ranking
 * leaderboard, so its test doubles live here rather than being copied into each
 * suite (`ranking.test.ts`, `ranking-list-parity.test.ts`). The helper models
 * every read the shared pipeline performs — the org inventory scan, the FK-linked
 * usage `groupBy`, the ORPHAN (no live inventory owner) usage read, and the
 * plugin child-usage read — plus the empty defaults the catalog list layers on
 * top (authors lineage, LOC/cost, owner fallback).
 *
 * Not a test file: the vitest include pattern only collects `*.test.ts`.
 */

import { vi } from "vitest";
import {
  identitySpine,
  isOrphanUsageRead,
  matchesOrphanWhere,
  matchesUsageSearchOr,
  resolveOrphanUsageGroupBy,
  sortByRecency,
  spinePassOf,
  takeRows,
  type UsageSearchOr,
  type WhereClause,
} from "./usage-lane-doubles";

export const ORG_A = "org-aaaa-1111";
export const TARGET_1 = "target-1111";
export const TARGET_2 = "target-2222";
export const TARGET_3 = "target-3333";

export type InventoryFixture = {
  id: string;
  componentKind: string;
  componentKey: string | null;
  name: string | null;
  computeTargetId: string;
  packId: string | null;
  contentHash: string | null;
  // ISS-4797: the column the org inventory read orders (and, above the identity
  // cap, truncates) on. Fixtures that do not care about recency inherit one
  // shared default so their relative order stays stable. NULLABLE in
  // `schema.prisma`, and a fixture may say so explicitly: Postgres sorts NULLs
  // FIRST under `DESC`, so a never-stamped identity is exactly the one that
  // would win the cap over genuinely recent components if the spine did not
  // demote it.
  lastSeenAt: Date | null;
};

/**
 * One grouped FK-linked usage row as `agentComponentSessionUsage.groupBy`
 * returns it. ISS-4630 put the usage row's OWN `(componentKind, componentKey)`
 * into the grouping key so `foldFkUsageIntoMerged` attributes by that identity
 * rather than the FK'd inventory row's slug; `buildPopulationDb` fills both from
 * the matching inventory fixture row so these doubles carry the same shape the
 * real query returns instead of silently exercising the legacy null fallback.
 */
export type UsageRollup = {
  agentComponentId: string | null;
  componentKind: string | null;
  componentKey: string | null;
  agentSessionId: string;
  gitBranch: string;
  harness: string | null;
  componentVersionHash: string | null;
  definitionVersionId: string | null;
  _sum: { invocationCount: number | null; errorCount: number | null };
  _max: { lastInvokedAt: Date | null };
};

/**
 * One ORPHANED usage row — one no live inventory row owns. This is the lane the
 * pre-ISS-4635 ranking service never read, so a component whose usage rows were
 * never FK-linked ranked at `invocations: 0` while its detail page reported the
 * real count.
 */
export type OrphanUsageFixture = {
  agentSessionId: string;
  componentKind: string;
  componentKey: string;
  invocationCount: number;
  errorCount: number;
  componentVersionHash: string | null;
  // ISS-4799: the column the orphan usage read orders (and, above the identity
  // cap, truncates) on.
  lastInvokedAt: Date | null;
};

/** One child usage row as the plugin pack rollup's `findMany` returns it. */
export type ChildUsageRow = {
  agentSessionId: string;
  agentComponentId: string | null;
  componentKind: string;
  componentKey: string;
  invocationCount: number;
  errorCount: number;
  lastInvokedAt: Date | null;
};

/**
 * One `SessionDetail` LOC + cost row, as the catalog list's LOC/$ loader reads
 * it. Seeded only by suites that assert the emitted `locPerDollar` or the
 * `sortBy=metric` order; every other suite leaves the read empty (LOC/$ null).
 */
export type SessionLocCostFixture = {
  artifactId: string;
  linesAdded: number | null;
  linesRemoved: number | null;
  estimatedCost: number;
};

export type PopulationFixtures = {
  inventory?: InventoryFixture[];
  rollups?: UsageRollup[];
  orphanUsage?: OrphanUsageFixture[];
  childUsage?: ChildUsageRow[];
  sessionLocCost?: SessionLocCostFixture[];
  /**
   * Hand the FK-usage fold EVERY seeded rollup, ignoring the
   * `where.agentComponentId.in` filter the real `groupBy` carries.
   *
   * The default (`false`) mirrors SQL: the query is scoped to the capped
   * inventory ids, so a rollup outside that set is never returned. But that also
   * means a double which always pre-filters can never drive the two guards the
   * fold keeps for input the TYPE still permits — `groupUsageByComponentId`'s
   * null-`agentComponentId` skip (the column is nullable) and
   * `foldFkUsageIntoMerged`'s "no own identity and no FK'd slug" skip. With
   * pre-filtering those rows vanish before the code under test sees them, so both
   * guards could be deleted with every test still green. Opt in from the test
   * that exists to pin those guards; leave it off everywhere else so the double
   * keeps telling the truth about the query.
   */
  deliverUnjoinedRollups?: boolean;
};

export type PopulationDb = {
  db: Record<string, unknown>;
  findMany: ReturnType<typeof vi.fn>;
  /** ISS-4797: the `agentComponent.groupBy` identity-spine read. */
  inventoryGroupBy: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
  usageFindMany: ReturnType<typeof vi.fn>;
};

/**
 * Monotonic counter that hands each rollup group a globally-unique default
 * `agentSessionId`, so a fixture that omits `sessionId` gets one distinct session
 * per group. Tests that exercise the distinct-count union (FEA-3386) pass an
 * explicit shared `sessionId` to fold multiple groups into one session.
 */
let sessionIdCounter = 0;

/** Build a minimal inventory fixture row. */
export function makeInventoryRow(overrides: {
  id: string;
  componentKind: string;
  componentKey?: string;
  name?: string;
  computeTargetId: string;
  packId?: string;
  contentHash?: string;
  lastSeenAt?: Date | null;
}): InventoryFixture {
  return {
    id: overrides.id,
    componentKind: overrides.componentKind,
    componentKey: overrides.componentKey ?? null,
    name: overrides.name ?? null,
    computeTargetId: overrides.computeTargetId,
    packId: overrides.packId ?? null,
    contentHash: overrides.contentHash ?? null,
    // Keyed on PRESENCE, not truthiness: an explicit `null` models a
    // never-stamped identity and must survive, where `??` would replace it.
    lastSeenAt:
      "lastSeenAt" in overrides
        ? (overrides.lastSeenAt ?? null)
        : DEFAULT_LAST_SEEN_AT,
  };
}

/**
 * Build one grouped (component, session) usage rollup row. Each row represents a
 * single distinct session for the component; omit `sessionId` to get a fresh
 * distinct one, or pass a shared value to model a session that spans multiple
 * components folding into one identity.
 */
export function makeRollup(overrides: {
  agentComponentId: string | null;
  sessionId?: string;
  invocationCount?: number;
  errorCount?: number;
  // ISS-4630: the usage row's own identity. Left null here and resolved from the
  // matching inventory fixture row by `buildPopulationDb`, so a fixture only
  // names it explicitly when modelling a usage row whose key DIFFERS from the
  // inventory row it is FK-linked to.
  componentKind?: string;
  componentKey?: string;
  // FEA-3982: the content fingerprint the usage was recorded against. Pin it to
  // route the rollup into a SPECIFIC version bucket of a multi-version family;
  // omit it (the common case) for a component observed at a single version.
  componentVersionHash?: string;
}): UsageRollup {
  return {
    agentComponentId: overrides.agentComponentId,
    componentKind: overrides.componentKind ?? null,
    componentKey: overrides.componentKey ?? null,
    agentSessionId: overrides.sessionId ?? `session-${sessionIdCounter++}`,
    gitBranch: "",
    harness: null,
    componentVersionHash: overrides.componentVersionHash ?? null,
    definitionVersionId: null,
    _sum: {
      invocationCount: overrides.invocationCount ?? null,
      errorCount: overrides.errorCount ?? null,
    },
    _max: { lastInvokedAt: null },
  };
}

/** Build one orphaned (null-FK) usage row for a `(kind, key)` identity. */
export function makeOrphanUsage(overrides: {
  agentSessionId: string;
  componentKind: string;
  componentKey: string;
  invocationCount: number;
  errorCount?: number;
  componentVersionHash?: string;
  lastInvokedAt?: Date;
}): OrphanUsageFixture {
  return {
    agentSessionId: overrides.agentSessionId,
    componentKind: overrides.componentKind,
    componentKey: overrides.componentKey,
    invocationCount: overrides.invocationCount,
    errorCount: overrides.errorCount ?? 0,
    componentVersionHash: overrides.componentVersionHash ?? null,
    lastInvokedAt: overrides.lastInvokedAt ?? null,
  };
}

/**
 * Build a child `AgentComponentSessionUsage` row as returned by the plugin
 * rollup read (`loadChildUsageByPackId`). FEA-4337: the row carries its natural
 * `(componentKind, componentKey)` identity; the pack it rolls up into is
 * resolved by matching that identity to a child INVENTORY row's `packId`, not by
 * an FK on the usage row. Callers must therefore also add a matching child
 * inventory row (via {@link makeInventoryRow} with the same kind/key + the
 * plugin's `packId`) for the rollup to attribute the usage.
 */
export function makeChildUsageRow(overrides: {
  agentSessionId: string;
  componentKind?: string;
  componentKey: string;
  invocationCount: number;
  errorCount?: number;
}): ChildUsageRow {
  return {
    agentSessionId: overrides.agentSessionId,
    agentComponentId: null,
    componentKind: overrides.componentKind ?? "command",
    componentKey: overrides.componentKey,
    invocationCount: overrides.invocationCount,
    errorCount: overrides.errorCount ?? 0,
    lastInvokedAt: null,
  };
}

/** The catalog-list query shape with the defaults the validator applies. */
export function listQuery(overrides: Record<string, unknown> = {}) {
  return { limit: 200, offset: 0, ...overrides };
}

/**
 * Build the fake Prisma client every population-backed read runs against, plus
 * handles on the three spied delegates the suites assert query shapes on.
 * Callers wire it into their own hoisted `withDb` mock.
 */
export function buildPopulationDb(fixtures: PopulationFixtures): PopulationDb {
  const inventory = fixtures.inventory ?? [];
  const orphanUsage = fixtures.orphanUsage ?? [];
  // ISS-4797: the org inventory read orders `lastSeenAt desc, id asc` and (above
  // the identity cap) truncates on it. Model both here, or a truncation-shaped
  // fixture would pass vacuously against a double that returns everything.
  const findMany = vi
    .fn()
    .mockImplementation((args?: { where?: WhereClause; take?: number }) =>
      Promise.resolve(
        takeRows(
          sortByRecency(
            filterInventoryForFindMany(inventory, args?.where),
            (row) => row.lastSeenAt
          ),
          args?.take
        ).map(toSelectedInventoryRow)
      )
    );
  // ISS-4797: the identity spine — the distinct `(componentKind, componentKey)`
  // pairs the facets admit, ordered by `max(lastSeenAt)` and capped.
  const inventoryGroupBy = vi
    .fn()
    .mockImplementation((args?: { where?: WhereClause; take?: number }) =>
      Promise.resolve(
        identitySpine(
          filterInventoryForFindMany(inventory, args?.where).map((row) => ({
            componentKind: row.componentKind,
            componentKey: row.componentKey,
            recency: row.lastSeenAt,
          })),
          args?.take,
          spinePassOf(args?.where, "lastSeenAt")
        )
      )
    );
  // `agentComponentSessionUsage.groupBy` serves THREE reads: the FK-linked usage
  // rollup, and (ISS-4799) the orphan lane's identity spine plus its aggregated
  // groups. Discriminate on the usage-only lane's own predicate
  // (`isOrphanUsageRead`) and the grouping key.
  const groupBy = vi.fn().mockImplementation(
    (args?: {
      by?: string[];
      where?: {
        AND?: WhereClause[];
        agentComponentId?: unknown;
        componentKind?: { in?: string[] };
        OR?: UsageSearchOr;
      };
      take?: number;
    }) => {
      if (isOrphanUsageRead(args?.where)) {
        return Promise.resolve(resolveOrphanUsageGroupBy(orphanUsage, args));
      }
      const idFilter = args?.where?.agentComponentId as
        | { in?: string[] }
        | undefined;
      // ISS-4635 (shafty023): the FK groups carry the same `?kind=` facet as the
      // inventory read (`componentKind IN kinds`). Honor it in the double so a
      // mismatched-FK usage row (own kind ≠ the requested kind) is dropped here
      // exactly as SQL would, rather than the mock ignoring the predicate and
      // passing vacuously. (A row whose own kind resolved to null — no FK'd
      // inventory match — is kept, mirroring the fold's own-key-absent fallback.)
      const kindIn = args?.where?.componentKind?.in;
      let rows = (fixtures.rollups ?? []).map((row) =>
        withUsageIdentity(row, inventory)
      );
      if (kindIn) {
        rows = rows.filter(
          (row) =>
            row.componentKind === null || kindIn.includes(row.componentKind)
        );
      }
      // ISS-4660: the FK groups now carry the same `?search=` predicate as the
      // orphan lane (shared `usageSearchWhere`). Honor it here for the same
      // reason the kind facet is honored above — a double that ignored the
      // predicate would let the leak test pass vacuously.
      rows = rows.filter((row) => matchesUsageSearchOr(row, args?.where?.OR));
      if (fixtures.deliverUnjoinedRollups || !idFilter?.in) {
        return Promise.resolve(rows);
      }
      return Promise.resolve(
        rows.filter(
          (row) =>
            row.agentComponentId !== null &&
            idFilter.in?.includes(row.agentComponentId)
        )
      );
    }
  );
  // `agentComponentSessionUsage.findMany` serves the plugin child-usage read and
  // the DETAIL orphan read (`fetchDetailOrphanUsage`), which stays a row read
  // scoped to one identity. The list's orphan lane moved to `groupBy` (ISS-4799).
  const usageFindMany = vi
    .fn()
    .mockImplementation((args?: { where?: WhereClause; take?: number }) => {
      const where = args?.where ?? {};
      if (isOrphanUsageRead(where)) {
        return Promise.resolve(
          takeRows(
            sortByRecency(
              orphanUsage.filter((row) => matchesOrphanWhere(row, where)),
              (row) => row.lastInvokedAt
            ),
            args?.take
          ).map((row) => ({
            ...row,
            harness: null,
            firstInvokedAt: null,
            gitBranch: "",
            definitionVersionId: null,
          }))
        );
      }
      // The plugin CHILD-usage read. Its ISS-6180 tombstoned-FK exclusion is
      // deliberately NOT modelled here: {@link InventoryFixture} carries no
      // `uninstalledAt`, so there is no FK target whose liveness this double
      // could resolve, and pretending otherwise would let a suite claim coverage
      // it does not have. That predicate is covered against a fully
      // `where`-evaluating double — one that resolves the `agentComponent`
      // relation from its own inventory — in
      // `detail-list-usage-reconciliation.test.ts`, through the production list
      // AND detail paths.
      return Promise.resolve(fixtures.childUsage ?? []);
    });

  return {
    db: {
      agentComponent: { findMany, groupBy: inventoryGroupBy },
      agentComponentSessionUsage: { groupBy, findMany: usageFindMany },
      agentComponentVersion: { findMany: vi.fn().mockResolvedValue([]) },
      definitionVersion: { findMany: vi.fn().mockResolvedValue([]) },
      definitionVersionEditor: { findMany: vi.fn().mockResolvedValue([]) },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue(
          (fixtures.sessionLocCost ?? []).map((row) => ({
            ...row,
            locSource: null,
            repositoryFullName: null,
            branch: null,
          }))
        ),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    },
    findMany,
    inventoryGroupBy,
    groupBy,
    usageFindMany,
  };
}

/** The default `lastSeenAt` every inventory fixture inherits. */
const DEFAULT_LAST_SEEN_AT = new Date("2026-01-10T00:00:00.000Z");

/**
 * Apply the subset of `agentComponent.findMany` where-filters the two inventory
 * reads use, so one fixture list backs both: the shared population's org scan
 * (`componentKind: { in: [...] }` when a kind facet is set) and the FEA-4337
 * child-pack-identity read (`packId in [...]` + child kinds + `componentKey`
 * not null).
 */
function filterInventoryForFindMany(
  inventory: InventoryFixture[],
  where?: Record<string, unknown>
): InventoryFixture[] {
  if (!where) {
    return inventory;
  }
  // ISS-4797: an identity-capped read nests its extra predicate under `AND`
  // rather than spreading it (the `?search=` facet already owns the base
  // clause's `OR` key), so the facet filters below sit one level down. Recurse
  // before reading them, or a narrowed read would be filtered as if unfaceted.
  //
  // The nullable-recency arm a spine pass adds is deliberately NOT applied here:
  // it constrains the AGGREGATED `max(...)` of an identity, which `identitySpine`
  // resolves, not the individual rows this function filters.
  const and = where.AND;
  const scoped = Array.isArray(and)
    ? and.reduce<InventoryFixture[]>(
        (rows, clause) =>
          filterInventoryForFindMany(rows, clause as Record<string, unknown>),
        inventory
      )
    : inventory;
  const packIdFilter = where.packId as { in?: string[] } | undefined;
  const kindFilter = where.componentKind as { in?: string[] } | undefined;
  const keyFilter = where.componentKey as { not?: null } | undefined;
  return scoped.filter((row) => {
    if (
      packIdFilter?.in &&
      !(row.packId && packIdFilter.in.includes(row.packId))
    ) {
      return false;
    }
    if (kindFilter?.in && !kindFilter.in.includes(row.componentKind)) {
      return false;
    }
    if (keyFilter?.not === null && row.componentKey === null) {
      return false;
    }
    return true;
  });
}

/**
 * ISS-4630: fill a rollup's own `(componentKind, componentKey)` from the
 * inventory row its FK points at, unless the fixture named them explicitly. The
 * real `groupBy` always returns these columns (they are in the grouping key), so
 * filling them here keeps the double's shape honest — otherwise every fixture
 * would leave them null and exercise only the legacy FK'd-slug fallback branch
 * rather than the identity attribution the production fold now performs.
 */
function withUsageIdentity(
  row: UsageRollup,
  inventory: InventoryFixture[]
): UsageRollup {
  if (row.componentKind !== null || row.agentComponentId === null) {
    return row;
  }
  const owner = inventory.find((item) => item.id === row.agentComponentId);
  if (!owner) {
    return row;
  }
  return {
    ...row,
    componentKind: owner.componentKind,
    componentKey: owner.componentKey,
  };
}

/** Expand a fixture row into the full column set the population read selects. */
function toSelectedInventoryRow(row: InventoryFixture) {
  return {
    ...row,
    organizationId: ORG_A,
    externalComponentId: `${row.componentKind}::${row.componentKey ?? ""}`,
    harness: null,
    sourceUrl: null,
    installPath: null,
    scope: null,
    projectPath: null,
    metadata: null,
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    computeTarget: { id: row.computeTargetId, userId: "user-1" },
  };
}

/**
 * The reported ISS-4635 org fixture, compressed: an MCP tool whose usage rows all
 * carry a NULL `agentComponentId` (the component-sync lane never linked them), a
 * plain FK-linked command, three instance-unique Claude subagent spawn rows that
 * roll up to one `general-purpose` identity, and a usage-ONLY skill with no
 * inventory row at all. Shared by the ranking regression test and the
 * list/ranking parity test so both read the identical org.
 */
export function reportedOrgFixtures(): PopulationFixtures {
  return {
    inventory: [
      makeInventoryRow({
        id: "c-create-branch-artifact",
        componentKind: "mcp",
        componentKey: "mcp__closedloop__create_branch_artifact",
        name: "mcp__closedloop__create_branch_artifact",
        computeTargetId: TARGET_1,
      }),
      makeInventoryRow({
        id: "c-add-comment",
        componentKind: "command",
        componentKey: "_add_comment_to_issue",
        name: "_add_comment_to_issue",
        computeTargetId: TARGET_1,
      }),
      // Three instance-unique typeless subagent spawns: ONE identity. The
      // pre-ISS-4635 ranking keyed the raw label, so these alone inflated its
      // `total` by two over the list's — the 3311-vs-2132 shape.
      makeInventoryRow({
        id: "c-subagent-1",
        componentKind: "subagent",
        componentKey: "Claude subagent a1b2c3d4",
        name: "Claude subagent a1b2c3d4",
        computeTargetId: TARGET_1,
      }),
      makeInventoryRow({
        id: "c-subagent-2",
        componentKind: "subagent",
        componentKey: "Claude subagent deadbeef",
        name: "Claude subagent deadbeef",
        computeTargetId: TARGET_2,
      }),
      makeInventoryRow({
        id: "c-subagent-3",
        componentKind: "subagent",
        componentKey: "Claude subagent 0f0f0f0f",
        name: "Claude subagent 0f0f0f0f",
        computeTargetId: TARGET_3,
      }),
    ],
    rollups: [
      makeRollup({
        agentComponentId: "c-add-comment",
        sessionId: "s-cmd",
        invocationCount: 1,
        errorCount: 0,
      }),
    ],
    orphanUsage: [
      // The ticket's evidence: detail reports 3 invocations, ranking reported 0
      // because this lane was never read.
      makeOrphanUsage({
        agentSessionId: "s-mcp-1",
        componentKind: "mcp",
        componentKey: "mcp__closedloop__create_branch_artifact",
        invocationCount: 2,
        errorCount: 1,
      }),
      makeOrphanUsage({
        agentSessionId: "s-mcp-2",
        componentKind: "mcp",
        componentKey: "mcp__closedloop__create_branch_artifact",
        invocationCount: 1,
      }),
      // A skill the org only ever USED — no inventory row exists for it, so it
      // surfaces as a synthetic usage-only entry on BOTH surfaces.
      makeOrphanUsage({
        agentSessionId: "s-skill",
        componentKind: "skill",
        componentKey: "usage-only-skill",
        invocationCount: 7,
      }),
    ],
  };
}

/**
 * ISS-4635 (shafty023 review): one `command` component installed at TWO distinct
 * content hashes — two version buckets of the SAME `command::build` family — each
 * carrying its own FK-linked usage. `mergeComponentRows` seeds two buckets (the
 * coarse `contentHash` widens the org dedup key), the FK fold routes each session
 * into the bucket whose `componentVersionHash` matches, and
 * `collapseToCanonicalFamilies` MUST fold both into ONE family row reporting the
 * SUMMED usage (5 + 3 = 8 invocations across 2 sessions) with `versionCount: 2`.
 *
 * This is the fixture that makes family collapse load-bearing in the parity
 * suite: with it, dropping `collapseToCanonicalFamilies` from either surface
 * makes the family split back into two rows and the parity assertions fail.
 */
export function multiVersionFamilyFixtures(): PopulationFixtures {
  return {
    inventory: [
      makeInventoryRow({
        id: "c-build-v1",
        componentKind: "command",
        componentKey: "build",
        name: "build",
        computeTargetId: TARGET_1,
        contentHash: "hash-build-v1",
      }),
      makeInventoryRow({
        id: "c-build-v2",
        componentKind: "command",
        componentKey: "build",
        name: "build",
        computeTargetId: TARGET_2,
        contentHash: "hash-build-v2",
      }),
    ],
    rollups: [
      makeRollup({
        agentComponentId: "c-build-v1",
        sessionId: "s-build-v1",
        invocationCount: 5,
        errorCount: 0,
        componentVersionHash: "hash-build-v1",
      }),
      makeRollup({
        agentComponentId: "c-build-v2",
        sessionId: "s-build-v2",
        invocationCount: 3,
        errorCount: 0,
        componentVersionHash: "hash-build-v2",
      }),
    ],
  };
}

/**
 * ISS-4635 (shafty023 review): the mismatched-FK cross-kind leak. One `skill`
 * inventory row (`review`) with TWO FK-linked usage groups:
 *   - a matching one whose OWN identity is `skill::review` (the honest case), and
 *   - a MISMATCHED one whose OWN identity is `command::deploy` — a usage row that
 *     happens to carry the skill row's FK but records a DIFFERENT `(kind, key)`.
 *
 * Because `foldFkUsageIntoMerged` (ISS-4630) attributes by the usage row's OWN
 * `(componentKind, componentKey)` and SEEDS a synthetic bucket for an identity not
 * already in the (kind-filtered) inventory, a `?kind=skill` request must NOT
 * surface a `command::deploy` row. The FK groupBy is now kind-scoped, so the
 * mismatched group is dropped before the fold — the response carries only the
 * skill, with just its matching usage (4), never the command's 9.
 */
export function mismatchedFkKindFixtures(): PopulationFixtures {
  return {
    inventory: [
      makeInventoryRow({
        id: "c-review-skill",
        componentKind: "skill",
        componentKey: "review",
        name: "review",
        computeTargetId: TARGET_1,
      }),
    ],
    rollups: [
      // Honest: this usage row's own identity matches its FK'd skill row.
      makeRollup({
        agentComponentId: "c-review-skill",
        sessionId: "s-skill-review",
        invocationCount: 4,
        errorCount: 0,
        componentKind: "skill",
        componentKey: "review",
      }),
      // Mismatched FK: FK-linked to the skill row, but its OWN identity is a
      // command. Under ISS-4630 attribution this would seed a synthetic
      // `command::deploy` bucket that leaks into a `?kind=skill` response unless
      // the FK groupBy is kind-scoped.
      makeRollup({
        agentComponentId: "c-review-skill",
        sessionId: "s-cmd-deploy",
        invocationCount: 9,
        errorCount: 0,
        componentKind: "command",
        componentKey: "deploy",
      }),
    ],
  };
}

/**
 * ISS-4660 (item 3): the `?search=` analogue of `mismatchedFkKindFixtures`. One
 * installed `skill` carrying two usage rows: one honest (own identity == its
 * FK'd row) and one whose OWN key is a different component entirely. Under
 * ISS-4630 attribution the mismatched row seeds a synthetic `deploy` bucket that
 * leaks into a `?search=review` response unless the FK groupBy carries the
 * search predicate.
 *
 * The match is deliberately NAME-ONLY (PR #4285 reviewer wongk): the display
 * name carries "review" and the component KEY does not. `usageSearchWhere` has
 * two arms — a `contains` match on the usage row's own key, and one exact
 * `(kind, key)` arm per inventory row that matched on its display name — and
 * `collectNameMatchedIdentities` SKIPS any row whose key already contains the
 * term. A fixture whose key and name both matched therefore exercised only the
 * `contains` arm and left `nameMatchedIdentities` empty, so the arm that keeps
 * this predicate a filter rather than an undercount was never covered. With a
 * name-only match the honest row is admitted ONLY by that arm, which is what
 * makes the "invocations == 4" assertion load-bearing.
 */
export function mismatchedFkSearchFixtures(): PopulationFixtures {
  return {
    inventory: [
      makeInventoryRow({
        id: "c-review-skill",
        componentKind: "skill",
        componentKey: "code-audit",
        name: "Review helper",
        computeTargetId: TARGET_1,
      }),
    ],
    rollups: [
      makeRollup({
        agentComponentId: "c-review-skill",
        sessionId: "s-skill-review",
        invocationCount: 4,
        errorCount: 0,
        componentKind: "skill",
        componentKey: "code-audit",
      }),
      makeRollup({
        agentComponentId: "c-review-skill",
        sessionId: "s-skill-deploy",
        invocationCount: 9,
        errorCount: 0,
        componentKind: "skill",
        componentKey: "deploy",
      }),
    ],
  };
}
