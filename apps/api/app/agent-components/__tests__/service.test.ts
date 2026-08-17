/**
 * T-10.1: Cloud service unit tests for agentComponentsService.
 *
 * Tests:
 * - listForOrg: org-scoping, dedup by (componentKind, componentKey), usage
 *   aggregation, keyset cursor, hook kind with usage=0.
 * - getDetailForOrg: provenance[], usageSessions[] with branch attribution,
 *   404 when not found.
 *
 * AC-009, AC-013
 */
import {
  AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS,
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentSortDir,
  AgentComponentSortKey,
  SourceAccessState,
  SourceOccurrenceType,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import {
  AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  // ISS-4669: `buildOrgComponentPopulation` reads FK-linked + orphan usage in one
  // `withDb.tx({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })`
  // snapshot, so the mocked module must expose that enum value.
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

// The detail path reuses the agent-sessions read service to populate
// `sessionsTab`; mock it so these tests stay isolated from the (heavy) session
// service and can assert exactly which artifact ids the detail forwarded.
vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: {
    listByArtifactIds: mocks.listByArtifactIds,
  },
}));

import { MAX_ORG_POPULATION_ROWS } from "../org-population-reads";
import { agentComponentsService } from "../service";
import {
  buildComputeTarget,
  buildInventoryRow,
  buildServiceDb,
} from "./service-db-double";
import {
  inventorySpineCall,
  type OrphanUsageShape,
  orphanGroupByCalls,
} from "./usage-lane-doubles";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// [P1] The per-session version/definition attribution read (`attachUsageSessionVersions`)
// is the ONLY `agentComponentSessionUsage.findMany` that selects both
// `componentVersionHash` and `definitionVersionId`; every other usage `findMany`
// (orphan/child fold) does not. Tests discriminate on that select so the single
// shared mock can return version rows for the attribution read and [] elsewhere.
type FindManyArgs = { select?: Record<string, unknown> } | undefined;
function isVersionAttributionRead(args: FindManyArgs): boolean {
  return (
    args?.select?.componentVersionHash === true &&
    args?.select?.definitionVersionId === true
  );
}

function installDb(
  db: Record<string, unknown>,
  orphanUsage: readonly OrphanUsageShape[] = []
) {
  const dbWithDefaults = buildServiceDb(db, orphanUsage);
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  return dbWithDefaults;
}

/** Wrap a bare `groupBy` spy in the delegate shape `orphanGroupByCalls` reads. */
function usageDelegate(groupBy: unknown): Record<string, unknown> {
  return { groupBy };
}

function buildUsageRow(
  agentSessionId: string,
  invocationCount: number,
  organizationId = "org-1",
  lastInvokedAt: Date | null = null,
  // FEA-3758: the session harness this usage ran in; null keeps the pre-fix
  // inventory-harness fallback for cases that don't care about harness.
  harness: string | null = null
) {
  return {
    agentSessionId,
    invocationCount,
    lastInvokedAt,
    harness,
    session: {
      artifactId: agentSessionId,
      userId: "user-1",
      artifact: { organizationId },
    },
  };
}

/**
 * The inventory-row preamble that every `getDetailForOrg` fixture below
 * repeated verbatim. Spread it first and override only what a test actually
 * varies, so the shared shape lives in one place instead of a dozen literals
 * (ISS-5464 — this file is grandfathered over the 1,000-line ceiling, so a
 * change here pays some of that debt down rather than adding to it).
 */
function detailInventoryDefaults(): Record<string, unknown> {
  return {
    id: "ac-1",
    computeTargetId: "target-1",
    componentKind: "command",
    componentKey: "code-review",
    externalComponentId: "command::code-review",
    harness: "claude",
    name: "Code Review",
    sourceUrl: null,
    installPath: null,
    scope: null,
    projectPath: null,
    description: null,
    firstSeenAt: new Date("2026-01-01"),
    lastSeenAt: new Date("2026-01-10"),
    computeTarget: buildComputeTarget("target-1", "user-1"),
  };
}

// ---------------------------------------------------------------------------
// listForOrg tests
// ---------------------------------------------------------------------------

describe("agentComponentsService.listForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only the calling org's components (org-scoping)", async () => {
    const orgComponentRow = buildInventoryRow({
      id: "ac-org-1",
      organizationId: "org-1",
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([orgComponentRow]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("ac-org-1");
  });

  // FEA-4374: the list Install gate needs a Pack `sourceType`, and the Install
  // action reads the pack id from `source` (via `normalizePackId`). A hardcoded
  // Repo at the list call site would let both regress silently — assert the
  // wired `listForOrg` emits Pack + the pack id (not the repo URL) as `source`.
  it("emits Pack sourceType + the pack id as source for a pack-backed row", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            packId: "acme-pack",
            sourceUrl: "github.com/acme/repo",
          }),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items[0].sourceType).toBe(SourceType.Pack);
    expect(result.items[0].source).toBe("acme-pack");
  });

  it("surfaces cloud-authored (sentinel-owned) org-custom agents backfilled from catalog_items (FEA-2923 Gap A)", async () => {
    // A backfilled row: subagent owned by the per-org "cloud" sentinel target,
    // deterministic external id, slug as key, source_repo as sourceUrl.
    const cloudAgentRow = buildInventoryRow({
      id: "ac-cloud-reviewer",
      organizationId: "org-1",
      computeTargetId: "sentinel-org-1",
      componentKind: "subagent",
      externalComponentId: "cloud:agent:legacy-reviewer-1",
      name: "Reviewer",
      componentKey: "reviewer",
      sourceUrl: "github.com/acme/repo",
      // FEA-4247: a real backfilled cloud row carries `cloudAuthored` in metadata.
      metadata: { cloudAuthored: true, source: "org_custom" },
      // Sentinel owner: the org's EARLIEST active user, not the creator.
      computeTarget: buildComputeTarget("sentinel-org-1", "owner-1", {
        id: "owner-1",
        firstName: "Org",
        lastName: "Owner",
        email: "owner-1@example.com",
      }),
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([cloudAgentRow]),
      },
      // FEA-4247: even if the sentinel owner were resolvable, a cloud-authored
      // row must NOT attribute it as the author — this seeds "Org Owner" so the
      // assertion below fails if the cloud-authored guard were dropped.
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "owner-1",
            firstName: "Org",
            lastName: "Owner",
            email: "owner-1@example.com",
          },
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: "Reviewer",
      kind: "subagent",
      source: "github.com/acme/repo",
      // FEA-4098 (Slice 3) + FEA-4247: `owner` is gone. This row links no
      // DefinitionVersion (no lineage), and it is cloud-authored, so the sentinel
      // owner is NOT used as a fallback author — the authors set is honestly empty
      // rather than attributing the org's earliest user.
      collaborators: [],
      computeTargetIds: ["sentinel-org-1"],
    });
    // The wrong-owner leak the guard prevents.
    expect(result.items[0]).not.toHaveProperty("owner");
  });

  it("rolls up instance-unique 'Claude subagent <id>' rows into one general-purpose entry (FEA-2923)", async () => {
    // The Claude parser names every typeless subagent spawn uniquely, so
    // pre-rollup installs synced one inventory row per spawn. listForOrg must
    // collapse them to a single 'general-purpose' component at read time.
    const spawnA = buildInventoryRow({
      id: "ac-sub-a",
      computeTargetId: "device-1",
      componentKind: "subagent",
      externalComponentId: "local:claude-subagent-a00eeb0c",
      name: "Claude subagent a00eeb0c",
      componentKey: "Claude subagent a00eeb0c",
      computeTarget: buildComputeTarget("device-1", "owner-1"),
    });
    const spawnB = buildInventoryRow({
      id: "ac-sub-b",
      computeTargetId: "device-1",
      componentKind: "subagent",
      externalComponentId: "local:claude-subagent-a00f43fc",
      name: "Claude subagent a00f43fc",
      componentKey: "Claude subagent a00f43fc",
      computeTarget: buildComputeTarget("device-1", "owner-1"),
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([spawnA, spawnB]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "subagent",
      name: "general-purpose",
    });
  });

  it("does not roll up a genuinely-typed subagent (subagent_type set)", async () => {
    const typed = buildInventoryRow({
      id: "ac-sub-explore",
      componentKind: "subagent",
      externalComponentId: "local:explore",
      name: "Explore",
      componentKey: "Explore",
      computeTarget: buildComputeTarget("device-1", "owner-1"),
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([typed]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "subagent",
      name: "Explore",
    });
  });

  it("merges a cloud-authored agent and its device-synced twin into one org entry (shared identity, both provenance targets)", async () => {
    // Same (subagent, reviewer) identity: one backfilled on the sentinel, one
    // synced from a real device. listForOrg dedups by org identity and unions
    // provenance — proving desktop sync and the backfill coexist, not collide.
    const cloudRow = buildInventoryRow({
      id: "ac-cloud",
      computeTargetId: "sentinel-org-1",
      componentKind: "subagent",
      externalComponentId: "cloud:agent:legacy-1",
      name: "Reviewer",
      componentKey: "reviewer",
      computeTarget: buildComputeTarget("sentinel-org-1", "owner-1"),
    });
    const deviceRow = buildInventoryRow({
      id: "ac-device",
      computeTargetId: "device-1",
      componentKind: "subagent",
      externalComponentId: "local:reviewer",
      name: "Reviewer",
      componentKey: "reviewer",
      computeTarget: buildComputeTarget("device-1", "owner-1"),
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([cloudRow, deviceRow]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].computeTargetIds.sort()).toEqual([
      "device-1",
      "sentinel-org-1",
    ]);
  });

  it("does not leak another org's cloud-authored agents (cross-org isolation)", async () => {
    // The service filters agentComponent by organizationId; the sentinel's own
    // organizationId is what scopes it. A row belonging to org-2 must never be
    // returned for org-1 — mirror that by returning [] for the org-1 query.
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({ agentComponent: { findMany } });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(0);
    // The org filter is applied in the DB query, not post-hoc in JS.
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      organizationId: "org-1",
    });
  });

  it("bounds memory: both population lanes cap DISTINCT IDENTITIES, ordered deterministically (ISS-4797)", async () => {
    // FEA-2923 bounded these lanes with a raw-row `take` applied AFTER the
    // request's facets, which is what let a `?kinds=` request retain components
    // the unfiltered request had truncated away (ISS-4797/ISS-4799). The bound
    // now lives on the identity SPINE — a `(componentKind, componentKey)`
    // groupBy, recency-ordered and capped — so the retained population no longer
    // depends on which facet was requested.
    const inventoryFindMany = vi.fn().mockResolvedValue([]);
    const db = installDb({
      agentComponent: { findMany: inventoryFindMany },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    const inventorySpine = inventorySpineCall(db.agentComponent);
    expect(inventorySpine?.by).toEqual(["componentKind", "componentKey"]);
    expect(inventorySpine?.take).toBe(AGENT_COMPONENT_INVENTORY_CAP);
    expect(inventorySpine?.orderBy).toBeDefined();

    // The row read that follows is bounded by the spine above in the dimension
    // (distinct components) that actually grows with org size. It still carries
    // `MAX_ORG_POPULATION_ROWS`, but as a MEMORY ceiling an order of magnitude
    // above what the identity cap can legitimately expand to — reaching it is an
    // anomaly the read LOGS, not the routine truncation that made the count
    // facet-dependent.
    const invArgs = inventoryFindMany.mock.calls[0]?.[0];
    expect(invArgs?.orderBy).toBeDefined();
    expect(invArgs?.take).toBe(MAX_ORG_POPULATION_ROWS);

    // The orphan (null-FK) lane is capped the same way, so its truncation is
    // facet-independent too.
    const orphanSpine = orphanGroupByCalls(db.agentComponentSessionUsage).find(
      (call) => call.by?.length === 2
    );
    expect(orphanSpine?.by).toEqual(["componentKind", "componentKey"]);
    expect(orphanSpine?.take).toBe(AGENT_COMPONENT_INVENTORY_CAP);
  });

  it("applies the active `search` filter to the orphan-usage query so usage-only rows can't leak across filters (FEA-3215)", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([]);
    const db = installDb({
      agentComponent: { findMany: inventoryFindMany },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      search: "review",
      harness: "codex",
    });

    // The orphan (usage-only) read seeds synthetic "used-only" entries; it
    // must honor the `search` predicate, or a searched list surfaces components
    // outside the filter. The usage table has no display `name`, so `search`
    // matches `componentKey`. With no inventory rows there are no name-matched
    // keys, so `OR` has the one arm.
    //
    // FEA-3758: harness is NOT pre-filtered on the orphan read anymore — the
    // derived harness needs ALL of a component's usage rows, so harness is
    // applied post-fold on the derived value (see the dedicated test below), not
    // as a DB predicate here.
    const orphanWhere = orphanGroupByCalls(db.agentComponentSessionUsage)[0]
      ?.where;
    // Lane membership: proven by `orphanGroupByCalls`'s own selector, not here.
    expect(orphanWhere).toMatchObject({
      OR: [{ componentKey: { contains: "review", mode: "insensitive" } }],
    });
    expect(orphanWhere?.harness).toBeUndefined();
  });

  it("FEA-3758: filters the list by the DERIVED harness (post-fold), not the inventory column", async () => {
    // Two subagents: `explorer` ran only in Codex (inventory harness null),
    // `planner` ran only in Claude. `?harness=codex` must return explorer only —
    // proving the facet matches the displayed (derived) harness, not the
    // inventory-row harness.
    const explorer = buildInventoryRow({
      id: "ac-explorer-filter",
      componentKind: "subagent",
      componentKey: "explorer",
      name: "explorer",
      harness: null,
      sessionUsages: [buildUsageRow("sess-codex", 2, "org-1", null, "codex")],
    });
    const planner = buildInventoryRow({
      id: "ac-planner-filter",
      componentKind: "subagent",
      componentKey: "planner",
      name: "planner",
      harness: null,
      sessionUsages: [buildUsageRow("sess-claude", 3, "org-1", null, "claude")],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([explorer, planner]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      harness: "codex",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("explorer");
    expect(result.items[0]?.harness).toBe("codex");
    // `total` counts the filtered set.
    expect(result.total).toBe(1);
  });

  it("carries the (kind, key) identity of inventory rows that matched `search` on `name` alone into the orphan-usage query, so their usage isn't undercounted (FEA-3215)", async () => {
    // `name` matches "review"; `componentKey` does not. The usage table has no
    // `name` column, so without the identity carry-over this component's orphan
    // usage would be filtered out and its totals would undercount. The arm is
    // scoped to `componentKind` (identity is (kind, key), so a bare key would
    // admit an unrelated same-key row of another kind) and compares the key
    // case-insensitively, mirroring the `encodeComponentSlug` fold.
    const inventoryFindMany = vi.fn().mockResolvedValue([
      buildInventoryRow({
        componentKind: "agent",
        name: "Code Review",
        componentKey: "CR-Helper",
      }),
    ]);
    const db = installDb({
      agentComponent: { findMany: inventoryFindMany },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      search: "review",
    });

    const orphanWhere = orphanGroupByCalls(db.agentComponentSessionUsage)[0]
      ?.where;
    expect(orphanWhere?.OR).toEqual([
      { componentKey: { contains: "review", mode: "insensitive" } },
      {
        componentKind: "agent",
        componentKey: { equals: "CR-Helper", mode: "insensitive" },
      },
    ]);
  });

  it("does not carry a name-matched key into the orphan-usage query for a different componentKind (FEA-3215)", async () => {
    // Regression guard: an `agent` matched `search` on its name, so its key is
    // carried. An unrelated `command` sharing that key matches the search on
    // nothing — the carried arm must not admit it, or the orphan fold mints a
    // synthetic entry outside the active filter (the leak FEA-3215 closed).
    const inventoryFindMany = vi.fn().mockResolvedValue([
      buildInventoryRow({
        componentKind: "agent",
        name: "Code Review",
        componentKey: "cr-helper",
      }),
    ]);
    const db = installDb({
      agentComponent: { findMany: inventoryFindMany },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      search: "review",
    });

    const orphanWhere = orphanGroupByCalls(db.agentComponentSessionUsage)[0]
      ?.where;
    // Every carried arm is kind-scoped; none matches a bare key alone. Assert the
    // arms exist first, or an orphan read that never ran would pass vacuously.
    const carriedArms = orphanWhere?.OR as
      | { componentKind?: string; componentKey?: Record<string, unknown> }[]
      | undefined;
    expect(carriedArms).toHaveLength(2);
    for (const arm of carriedArms ?? []) {
      if (!("contains" in (arm.componentKey ?? {}))) {
        expect(arm.componentKind).toBe("agent");
      }
    }
  });

  it("deduplicates two compute-target rows with the same (componentKind, componentKey) into one org-level entry", async () => {
    const sharedKind = "command";
    const sharedKey = "code-review";
    const row1 = buildInventoryRow({
      id: "ac-target1",
      computeTargetId: "target-1",
      componentKind: sharedKind,
      componentKey: sharedKey,
      name: "Code Review",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [buildUsageRow("sess-1", 3)],
    });
    const row2 = buildInventoryRow({
      id: "ac-target2",
      computeTargetId: "target-2",
      componentKind: sharedKind,
      componentKey: sharedKey,
      name: "Code Review",
      computeTarget: buildComputeTarget("target-2", "user-2", {
        id: "user-2",
        firstName: "Bob",
        lastName: "Smith",
        email: "bob@example.com",
      }),
      sessionUsages: [buildUsageRow("sess-2", 7)],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row1, row2]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // Should be deduplicated to a single org-level entry
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item).toBeDefined();
    // Both compute targets should be listed in provenance
    expect(item?.computeTargetIds).toContain("target-1");
    expect(item?.computeTargetIds).toContain("target-2");
  });

  it("aggregates invocationCount org-wide across all inventory rows", async () => {
    const row1 = buildInventoryRow({
      id: "ac-1",
      componentKind: "skill",
      componentKey: "my-skill",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [buildUsageRow("sess-1", 5)],
    });
    const row2 = buildInventoryRow({
      id: "ac-2",
      computeTargetId: "target-2",
      componentKind: "skill",
      componentKey: "my-skill",
      computeTarget: buildComputeTarget("target-2", "user-2", {
        id: "user-2",
        firstName: "Carol",
        lastName: null,
        email: "carol@example.com",
      }),
      sessionUsages: [buildUsageRow("sess-2", 10)],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row1, row2]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // 5 + 10 = 15 total across the org
    expect(result.items[0]?.invocations).toBe(15);
  });

  it("projects lastInvokedAt as the max usage lastInvokedAt across all inventory rows (FEA-3179)", async () => {
    const older = new Date("2026-03-01T00:00:00.000Z");
    const newer = new Date("2026-03-05T12:00:00.000Z");
    const row1 = buildInventoryRow({
      id: "ac-1",
      componentKind: "skill",
      componentKey: "my-skill",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [buildUsageRow("sess-1", 5, "org-1", older)],
    });
    const row2 = buildInventoryRow({
      id: "ac-2",
      computeTargetId: "target-2",
      componentKind: "skill",
      componentKey: "my-skill",
      computeTarget: buildComputeTarget("target-2", "user-2", {
        id: "user-2",
        firstName: "Carol",
        lastName: null,
        email: "carol@example.com",
      }),
      // The later invocation must win regardless of row order.
      sessionUsages: [buildUsageRow("sess-2", 10, "org-1", newer)],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row1, row2]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // Real usage recency, NOT the inventory lastSeenAt (which is 2026-01-10).
    expect(result.items[0]?.lastInvokedAt).toBe(newer.toISOString());
  });

  it("omits lastInvokedAt for a component with no usage rows (FEA-3179)", async () => {
    // An installed component that has never been invoked (no usage rows) must
    // NOT carry a lastInvokedAt — so the "active" dot never lights off the
    // sync-refreshed lastSeenAt.
    const row = buildInventoryRow({
      id: "ac-never-used",
      componentKind: "config",
      componentKey: "settings",
      name: "Settings",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.lastInvokedAt).toBeUndefined();
  });

  it("folds orphaned (null-FK) usage into the matching entry's totals", async () => {
    const row = buildInventoryRow({
      id: "ac-1",
      componentKind: "skill",
      componentKey: "my-skill",
      name: "My Skill",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      // FK-linked usage on this inventory row
      sessionUsages: [buildUsageRow("sess-linked", 4)],
    });

    installDb(
      {
        agentComponent: {
          findMany: vi.fn().mockResolvedValue([row]),
        },
      },
      // A usage row synced before the inventory row was linked (agentComponentId
      // null). Matched to the entry by (kind, componentKey).
      [
        {
          agentSessionId: "sess-orphan",
          componentKind: "skill",
          componentKey: "my-skill",
          invocationCount: 6,
        },
      ]
    );

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // 4 (linked) + 6 (orphan) = 10 invocations; two distinct sessions.
    expect(result.items[0]?.invocations).toBe(10);
    expect(result.items[0]?.sessions).toBe(2);
  });

  it("surfaces a component that exists only as session usage (no inventory row) — Gap B", async () => {
    // No inventory rows at all: the component was USED in parsed sessions but
    // never collected as installed inventory. Session-sync delivered the usage
    // as an orphan (null-FK) row. It must still appear in the list.
    installDb(
      {
        agentComponent: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      [
        {
          agentSessionId: "sess-orphan",
          componentKind: "skill",
          componentKey: "used-only-skill",
          harness: "claude",
          invocationCount: 9,
          firstInvokedAt: new Date("2026-03-01T00:00:00.000Z"),
          lastInvokedAt: new Date("2026-03-05T00:00:00.000Z"),
        },
      ]
    );

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    // Falls back to componentKey for the label (usage row has no name).
    expect(item?.name).toBe("used-only-skill");
    expect(item?.kind).toBe("skill");
    expect(item?.harness).toBe("claude");
    expect(item?.invocations).toBe(9);
    expect(item?.sessions).toBe(1);
    // No installed inventory ⇒ no compute-target provenance.
    expect(item?.computeTargetIds).toEqual([]);
    // Timestamps seeded from invocation times.
    expect(item?.firstSeenAt).toBe("2026-03-01T00:00:00.000Z");
    expect(item?.lastSeenAt).toBe("2026-03-05T00:00:00.000Z");
  });

  it("FEA-3758: attributes harness from the sessions a subagent ran in, not the (null/defaulted) inventory harness", async () => {
    // subagent::explorer used ONLY in Codex sessions. Its event-driven inventory
    // row was minted with NO harness (harness=null), which pre-fix defaulted to
    // 'claude'. The usage rows carry the real session harness ('codex'), so the
    // list must report 'codex' — the actual harness it ran in.
    const row = buildInventoryRow({
      id: "ac-explorer",
      componentKind: "subagent",
      componentKey: "explorer",
      name: "explorer",
      harness: null,
      sessionUsages: [
        buildUsageRow("sess-codex-1", 3, "org-1", null, "codex"),
        buildUsageRow("sess-codex-2", 5, "org-1", null, "codex"),
      ],
    });

    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // Harness reflects the Codex sessions it ran in — NOT the defaulted 'claude'.
    expect(result.items[0]?.harness).toBe("codex");
    // Token/invocation attribution is intact (8 total, 2 sessions).
    expect(result.items[0]?.invocations).toBe(8);
    expect(result.items[0]?.sessions).toBe(2);
  });

  it("FEA-3758: reports 'both' for a component used across claude and codex sessions", async () => {
    const row = buildInventoryRow({
      id: "ac-multi",
      componentKind: "subagent",
      componentKey: "general-purpose",
      name: "general-purpose",
      harness: "claude",
      sessionUsages: [
        buildUsageRow("sess-claude", 2, "org-1", null, "claude"),
        buildUsageRow("sess-codex", 4, "org-1", null, "codex"),
      ],
    });

    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items[0]?.harness).toBe("both");
  });

  it("FEA-3758: falls back to the inventory harness when no usage carries one", async () => {
    // A configured-but-unused component (or older desktop builds that left the
    // usage harness unset) must keep the inventory-row harness — unchanged.
    const row = buildInventoryRow({
      id: "ac-configured",
      componentKind: "skill",
      componentKey: "unused-skill",
      name: "unused-skill",
      harness: "codex",
      sessionUsages: [],
    });

    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items[0]?.harness).toBe("codex");
  });

  it("merges (not duplicates) a synthetic orphan entry into a matching inventory row", async () => {
    // Same (kind, key) exists both as an inventory row and as an orphan usage
    // row. The list must collapse to ONE entry, summing usage.
    const row = buildInventoryRow({
      id: "ac-inv-1",
      componentKind: "skill",
      componentKey: "shared-skill",
      name: "Shared Skill",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [buildUsageRow("sess-linked", 4)],
    });

    installDb(
      {
        agentComponent: {
          findMany: vi.fn().mockResolvedValue([row]),
        },
      },
      [
        {
          agentSessionId: "sess-orphan",
          componentKind: "skill",
          componentKey: "shared-skill",
          harness: "claude",
          invocationCount: 6,
          firstInvokedAt: null,
          lastInvokedAt: null,
        },
      ]
    );

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // One merged entry (the real inventory row wins as canonical), not two.
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.id).toBe("ac-inv-1");
    expect(item?.name).toBe("Shared Skill");
    // 4 (linked) + 6 (orphan) = 10, across two distinct sessions.
    expect(item?.invocations).toBe(10);
    expect(item?.sessions).toBe(2);
  });

  it("does not leak another org's orphan usage as a synthetic entry (cross-org isolation)", async () => {
    // The orphan-usage query is org-scoped through SessionDetail.organizationId,
    // so another org's usage never reaches this org's list. The seed carries only
    // org-1 rows to mirror that filter; assert the foreign component is absent
    // regardless, and assert the org scope from the test body (never inside the
    // mock, which may never run).
    const db = installDb(
      {
        agentComponent: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      [
        {
          agentSessionId: "sess-org1",
          componentKind: "skill",
          componentKey: "org1-skill",
          harness: "claude",
          invocationCount: 2,
          firstInvokedAt: null,
          lastInvokedAt: null,
        },
      ]
    );

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // Only org-1's component surfaces; no org-2 component leaks in.
    expect(result.items).toHaveLength(1);
    expect(result.items.map((i) => i.name)).toEqual(["org1-skill"]);
    // Belt-and-suspenders: every orphan read must be org-scoped via the session
    // relation, else cross-org usage could leak.
    const orphanReads = orphanGroupByCalls(db.agentComponentSessionUsage);
    expect(orphanReads.length).toBeGreaterThan(0);
    for (const args of orphanReads) {
      expect(args?.where?.session).toBeDefined();
    }
  });

  it("orders equal-sort-key rows deterministically by id (stable paging)", async () => {
    // Three entries with identical invocation counts (0) and names — the
    // primary sort ties, so only the id tiebreaker keeps paging stable.
    const rows = ["ac-c", "ac-a", "ac-b"].map((id) =>
      buildInventoryRow({
        id,
        componentKind: "skill",
        componentKey: id, // distinct keys => distinct entries
        name: "same-name",
        computeTarget: buildComputeTarget("target-1", "user-1"),
        sessionUsages: [],
      })
    );

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue(rows),
      },
    });

    const page1 = await agentComponentsService.listForOrg("org-1", {
      limit: 2,
      offset: 0,
      sortBy: AgentComponentSortKey.Name,
      sortDir: AgentComponentSortDir.Asc,
    });
    const page2 = await agentComponentsService.listForOrg("org-1", {
      limit: 2,
      offset: 2,
      sortBy: AgentComponentSortKey.Name,
      sortDir: AgentComponentSortDir.Asc,
    });

    // Ascending id order across the page boundary: no skips or repeats.
    expect(page1.items.map((i) => i.id)).toEqual(["ac-a", "ac-b"]);
    expect(page2.items.map((i) => i.id)).toEqual(["ac-c"]);
  });

  it("returns hasMore=true when there are more results beyond the page", async () => {
    // 3 rows with same kind+key would dedup to 1 org-level entry;
    // use distinct keys for independent entries to test pagination
    const rows = ["skill-a", "skill-b", "skill-c"].map((key, i) =>
      buildInventoryRow({
        id: `ac-${i}`,
        componentKind: "skill",
        componentKey: key,
        name: key,
        computeTarget: buildComputeTarget("target-1", "user-1"),
        sessionUsages: [],
      })
    );

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue(rows),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 2,
      offset: 0,
    });

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });

  it("returns usage=0 for hook kind (on-read derivation — zero usage is real, not missing)", async () => {
    const hookRow = buildInventoryRow({
      id: "ac-hook-1",
      componentKind: "hook",
      componentKey: "pre-commit",
      name: "pre-commit",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [], // Hooks have zero usage rows — this is correct, not missing
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([hookRow]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.invocations).toBe(0);
    expect(result.items[0]?.sessions).toBe(0);
  });

  it("filters out usage rows from another org (belt-and-suspenders org guard)", async () => {
    const row = buildInventoryRow({
      id: "ac-1",
      componentKind: "command",
      componentKey: "test-cmd",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        // This usage row belongs to org-2, not org-1
        buildUsageRow("sess-other", 99, "org-2"),
        // This usage row belongs to org-1
        buildUsageRow("sess-1", 3, "org-1"),
      ],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // Only org-1 usage should be counted
    expect(result.items[0]?.invocations).toBe(3);
  });

  it("returns an empty list when no components exist for the org", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("rolls up ORPHAN-FK child usage into a plugin's invocations/sessions (FEA-4337)", async () => {
    // FEA-4337 regression: a plugin inventory row (packId = "rtk") with NO usage
    // rows of its own — the real sync pipeline never materializes plugin-kind
    // usage. Its invocations/sessions come from its CHILD components' usage,
    // attributed by the child INVENTORY identity (kind, key) → packId, NOT the
    // usage row's `agentComponentId` FK. The child usage rows below are ORPHANED
    // (agentComponentId: null) — the exact case the old FK-based rollup
    // (`agentComponent.packId in [...]`) dropped, folding every plugin to
    // invocations=0/sessions=0. The natural-key join recovers them, matching the
    // desktop reader so both surfaces agree.
    const pluginRow = buildInventoryRow({
      id: "ac-plugin-rtk",
      componentKind: "plugin",
      externalComponentId: "plugin::rtk",
      name: "RTK",
      componentKey: "rtk",
      packId: "rtk",
      sessionUsages: [],
    });
    // The plugin's child inventory row: a `git-status` command belonging to the
    // rtk pack. This is what maps the orphan child usage (kind, key) to packId.
    const childInventoryRow = buildInventoryRow({
      id: "ac-git-status",
      componentKind: "command",
      externalComponentId: "command::git-status",
      name: "Git Status",
      componentKey: "git-status",
      packId: "rtk",
      sessionUsages: [],
    });

    // Child usage rows: 2 sessions, 5 total invocations, carrying their natural
    // (kind, key) identity and a NULL FK — the orphan case.
    const childUsage = [
      {
        agentSessionId: "sess-1",
        componentKind: "command",
        componentKey: "git-status",
        invocationCount: 3,
        errorCount: 0,
        lastInvokedAt: null,
      },
      {
        agentSessionId: "sess-2",
        componentKind: "command",
        componentKey: "git-status",
        invocationCount: 2,
        errorCount: 0,
        lastInvokedAt: null,
      },
    ];
    const usageFindMany = vi
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        // Plugin child-usage read: child kinds, org-scoped, and — critically —
        // NO `agentComponentId` filter (attribution is by inventory identity).
        if (where.componentKind && where.agentComponentId === undefined) {
          return Promise.resolve(childUsage);
        }
        // Orphan-usage fold query (agentComponentId: null) — none for the plugin
        // itself (plugins carry no own usage rows).
        return Promise.resolve([]);
      });

    // `agentComponent.findMany` serves the main inventory read (no
    // `componentKind` filter → both rows) and the FEA-4337 child-identity read
    // (child `componentKind` + `packId in [...]` → the child row only).
    const inventoryFindMany = vi
      .fn()
      .mockImplementation(({ where }: { where?: Record<string, unknown> }) => {
        if (where?.componentKind && where?.packId) {
          return Promise.resolve([childInventoryRow]);
        }
        return Promise.resolve([pluginRow, childInventoryRow]);
      });

    installDb({
      agentComponent: {
        findMany: inventoryFindMany,
      },
      agentComponentSessionUsage: {
        findMany: usageFindMany,
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(2);
    const plugin = result.items.find((i) => i.kind === "plugin");
    expect(plugin).toBeDefined();
    // 3 + 2 child invocations rolled up from ORPHAN-FK usage (NOT the plugin's
    // own 0 usage rows). Zero under the old FK-based rollup.
    expect(plugin?.invocations).toBe(5);
    // 2 distinct child sessions.
    expect(plugin?.sessions).toBe(2);
    // The child-usage read must NOT depend on the usage row's FK.
    const childCall = usageFindMany.mock.calls.find(
      ([arg]) =>
        arg?.where?.componentKind && arg?.where?.agentComponentId === undefined
    );
    expect(childCall?.[0]?.where?.agentComponent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FEA-4098 (Slice 3): collaborators (authors) people-set from the
// DefinitionVersionEditor lineage, replacing the single compute-target owner.
// ---------------------------------------------------------------------------

describe("agentComponentsService.listForOrg — collaborators (authors) lineage (FEA-4098)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("derives collaborators = discoverer + editors of the version's fingerprint, discoverer first", async () => {
    // The inventory row's contentHash links to a DefinitionVersion fingerprint;
    // that fingerprint's lineage has two editors. The DB returns them ordered by
    // firstEditedAt asc (the discoverer leads), and the service must emit that
    // order deduped by user.
    const editorFindMany = vi.fn().mockResolvedValue([
      {
        userId: "u-discoverer",
        firstEditedAt: new Date("2026-01-01T00:00:00Z"),
        definitionVersion: { definitionHash: "fp-1" },
        user: {
          id: "u-discoverer",
          firstName: "Dana",
          lastName: "Discoverer",
          email: "dana@example.com",
        },
      },
      {
        userId: "u-editor",
        firstEditedAt: new Date("2026-01-05T00:00:00Z"),
        definitionVersion: { definitionHash: "fp-1" },
        user: {
          id: "u-editor",
          firstName: "Edith",
          lastName: "Editor",
          email: "edith@example.com",
        },
      },
    ]);
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          .mockResolvedValue([buildInventoryRow({ contentHash: "hash-1" })]),
      },
      // Link the coarse contentHash to the exact fingerprint the lineage keys on.
      // wongk: the identity is keyed on (kind, key, contentHash), so the version
      // row carries the same kind/key as the inventory row it resolves.
      agentComponentVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            componentKind: "skill",
            componentKey: "my-skill",
            contentHash: "hash-1",
            definitionVersion: { definitionHash: "fp-1" },
          },
        ]),
      },
      definitionVersionEditor: { findMany: editorFindMany },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // Discoverer FIRST, then the later editor — NOT the compute-target user.
    expect(result.items[0].collaborators).toEqual([
      "Dana Discoverer",
      "Edith Editor",
    ]);
    // AC-019: the lineage read is org-scoped through the parent version.
    const where = editorFindMany.mock.calls[0][0].where;
    expect(where.definitionVersion.organizationId).toBe("org-1");
  });

  it("emits an empty collaborators set for a row with no linked DefinitionVersion (skew-safe)", async () => {
    // No contentHash → no fingerprint → no lineage query match → empty authors.
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([buildInventoryRow()]),
      },
      definitionVersionEditor: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].collaborators).toEqual([]);
    expect(result.items[0]).not.toHaveProperty("owner");
  });

  it("FEA-4247: falls back to the observing compute-target user as Owner when the lineage is empty", async () => {
    // A legacy/unlinked row (no DefinitionVersion lineage) still carries an
    // observing compute target whose user is the read-time owner fallback. The
    // service resolves that user id to a display name via `user.findMany` and
    // surfaces it as both `collaborators` and the `owner` compat alias, restoring
    // Owner for the FEA-4098 regression without a backfill.
    const observerFindMany = vi.fn().mockResolvedValue([
      {
        id: "user-1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "user-1@example.com",
      },
    ]);
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([buildInventoryRow()]),
      },
      // No lineage: the row has no linked DefinitionVersion editors.
      definitionVersionEditor: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: observerFindMany },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // The observing compute-target user, resolved from the empty-lineage fallback.
    expect(result.items[0].collaborators).toEqual(["Ada Lovelace"]);
    expect(result.items[0].owner).toBe("Ada Lovelace");
    // Scoped to the returned page's observing user ids, not the whole working set.
    expect(observerFindMany.mock.calls[0][0].where.id.in).toEqual(["user-1"]);
    // wongk (FEA-4247): the user lookup is org-scoped — ComputeTarget and User
    // have independent org FKs, so the fallback must re-filter by org.
    expect(observerFindMany.mock.calls[0][0].where.organizationId).toBe(
      "org-1"
    );
  });

  it("FEA-4247: the collaborator filter includes a fallback-only row (matches display, correct total)", async () => {
    // A lineage-less row whose observing user is Alice DISPLAYS Alice as author.
    // The `?collaborator=Alice` filter must therefore include it (and count it in
    // total) — filtering on lineage alone would show Alice yet drop the row.
    const observerFindMany = vi.fn().mockResolvedValue([
      {
        id: "user-1",
        firstName: "Alice",
        lastName: "A",
        email: "a@example.com",
      },
    ]);
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([buildInventoryRow()]),
      },
      definitionVersionEditor: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: observerFindMany },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      collaborator: "Alice",
    });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].collaborators).toEqual(["Alice A"]);
    // Org-scoped over the working set (the filter needs every candidate's author).
    expect(observerFindMany.mock.calls[0][0].where.organizationId).toBe(
      "org-1"
    );
  });

  it("FEA-4247: does not collapse two distinct fallback owners who share a display name", async () => {
    // Two rows, two DIFFERENT users who happen to share the display name "Sam
    // Smith", observing the SAME identity. The fallback must keep both (dedup is
    // by user id, never by name), so a name collision is not silently merged.
    const rowA = buildInventoryRow({
      id: "ac-a",
      computeTargetId: "target-a",
      computeTarget: buildComputeTarget("target-a", "user-a"),
    });
    const rowB = buildInventoryRow({
      id: "ac-b",
      computeTargetId: "target-b",
      computeTarget: buildComputeTarget("target-b", "user-b"),
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([rowA, rowB]),
      },
      definitionVersionEditor: { findMany: vi.fn().mockResolvedValue([]) },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "user-a",
            firstName: "Sam",
            lastName: "Smith",
            email: "a@x.com",
          },
          {
            id: "user-b",
            firstName: "Sam",
            lastName: "Smith",
            email: "b@x.com",
          },
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // rowA and rowB share the (kind, key) identity, so they merge to one entry
    // whose fallback authors are BOTH Sams (two ids, one shared name).
    expect(result.items).toHaveLength(1);
    expect(result.items[0].collaborators).toEqual(["Sam Smith", "Sam Smith"]);
  });

  it("filters the list to components authored by a given collaborator", async () => {
    const rowAlice = buildInventoryRow({
      id: "ac-alice",
      componentKey: "alice-skill",
      externalComponentId: "skill::alice-skill",
      name: "Alice Skill",
      contentHash: "hash-alice",
    });
    const rowBob = buildInventoryRow({
      id: "ac-bob",
      componentKey: "bob-skill",
      externalComponentId: "skill::bob-skill",
      name: "Bob Skill",
      contentHash: "hash-bob",
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([rowAlice, rowBob]),
      },
      agentComponentVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            componentKind: "skill",
            componentKey: "alice-skill",
            contentHash: "hash-alice",
            definitionVersion: { definitionHash: "fp-alice" },
          },
          {
            componentKind: "skill",
            componentKey: "bob-skill",
            contentHash: "hash-bob",
            definitionVersion: { definitionHash: "fp-bob" },
          },
        ]),
      },
      definitionVersionEditor: {
        findMany: vi.fn().mockResolvedValue([
          {
            userId: "u-alice",
            firstEditedAt: new Date("2026-01-01T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-alice" },
            user: {
              id: "u-alice",
              firstName: "Alice",
              lastName: "A",
              email: "alice@example.com",
            },
          },
          {
            userId: "u-bob",
            firstEditedAt: new Date("2026-01-01T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-bob" },
            user: {
              id: "u-bob",
              firstName: "Bob",
              lastName: "B",
              email: "bob@example.com",
            },
          },
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      collaborator: "Alice",
    });

    expect(result.items.map((i) => i.name)).toEqual(["Alice Skill"]);
    expect(result.items[0].collaborators).toEqual(["Alice A"]);
  });

  it("wongk (contentHash collision): a skill and a command with identical bytes resolve to their OWN distinct authors", async () => {
    // Same content bytes ⇒ same coarse contentHash, but definitionHash folds in
    // the kind, so the skill and the command link to DIFFERENT DefinitionVersions
    // with DIFFERENT lineage. Keying the resolution on (kind, key, contentHash)
    // (not the raw contentHash) keeps the two identities' authors distinct; a
    // contentHash-only key would collapse both onto whichever row sorted first.
    const skillRow = buildInventoryRow({
      id: "ac-skill",
      componentKind: "skill",
      componentKey: "shared-bytes",
      externalComponentId: "skill::shared-bytes",
      name: "Shared Skill",
      contentHash: "same-bytes",
    });
    const commandRow = buildInventoryRow({
      id: "ac-command",
      componentKind: "command",
      componentKey: "shared-bytes",
      externalComponentId: "command::shared-bytes",
      name: "Shared Command",
      contentHash: "same-bytes",
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([skillRow, commandRow]),
      },
      // ONE coarse contentHash, TWO distinct (kind) version links.
      agentComponentVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            componentKind: "skill",
            componentKey: "shared-bytes",
            contentHash: "same-bytes",
            definitionVersion: { definitionHash: "fp-skill" },
          },
          {
            componentKind: "command",
            componentKey: "shared-bytes",
            contentHash: "same-bytes",
            definitionVersion: { definitionHash: "fp-command" },
          },
        ]),
      },
      definitionVersionEditor: {
        findMany: vi.fn().mockResolvedValue([
          {
            userId: "u-skill",
            firstEditedAt: new Date("2026-01-01T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-skill" },
            user: {
              id: "u-skill",
              firstName: "Skill",
              lastName: "Author",
              email: "skill@example.com",
            },
          },
          {
            userId: "u-command",
            firstEditedAt: new Date("2026-01-01T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-command" },
            user: {
              id: "u-command",
              firstName: "Command",
              lastName: "Author",
              email: "command@example.com",
            },
          },
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    const byKind = new Map(result.items.map((i) => [i.kind, i]));
    // Each identity keeps its OWN author — no collision collapse.
    expect(byKind.get("skill")?.collaborators).toEqual(["Skill Author"]);
    expect(byKind.get("command")?.collaborators).toEqual(["Command Author"]);
  });

  it("codex P2 (name collision): two distinct users sharing a display name are NOT deduped into one", async () => {
    // Two authors of the same version have the SAME display name but DIFFERENT
    // user ids. Deduping on the display name would collapse them into one
    // collaborator and undercount authors; deduping on the stable user id keeps
    // both (rendered as the same name twice — an honest 2-author signal).
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          .mockResolvedValue([buildInventoryRow({ contentHash: "hash-dup" })]),
      },
      agentComponentVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            componentKind: "skill",
            componentKey: "my-skill",
            contentHash: "hash-dup",
            definitionVersion: { definitionHash: "fp-dup" },
          },
        ]),
      },
      definitionVersionEditor: {
        findMany: vi.fn().mockResolvedValue([
          {
            userId: "u-jsmith-1",
            firstEditedAt: new Date("2026-01-01T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-dup" },
            user: {
              id: "u-jsmith-1",
              firstName: "John",
              lastName: "Smith",
              email: "john.smith.1@example.com",
            },
          },
          {
            userId: "u-jsmith-2",
            firstEditedAt: new Date("2026-01-05T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-dup" },
            user: {
              id: "u-jsmith-2",
              firstName: "John",
              lastName: "Smith",
              email: "john.smith.2@example.com",
            },
          },
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // BOTH distinct users are kept — not collapsed by their shared name.
    expect(result.items[0].collaborators).toEqual(["John Smith", "John Smith"]);
  });

  it("wongk (N+1 / working-set): the lineage read is scoped to the RETURNED page, not the whole working set", async () => {
    // 5 inventory rows, each a distinct linked version; limit=2. With no
    // collaborator filter the lineage read must resolve only the 2 paged
    // fingerprints, not all 5 — so the read scales with the response limit.
    const rows = Array.from({ length: 5 }, (_, i) =>
      buildInventoryRow({
        id: `ac-${i}`,
        componentKey: `skill-${i}`,
        externalComponentId: `skill::skill-${i}`,
        name: `Skill ${i}`,
        contentHash: `hash-${i}`,
        // Descending lastSeenAt so sort order is deterministic (skill-0 first).
        lastSeenAt: new Date(2026, 0, 10 - i),
      })
    );
    const editorFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue(rows) },
      agentComponentVersion: {
        findMany: vi.fn().mockResolvedValue(
          rows.map((_, i) => ({
            componentKind: "skill",
            componentKey: `skill-${i}`,
            contentHash: `hash-${i}`,
            definitionVersion: { definitionHash: `fp-${i}` },
          }))
        ),
      },
      definitionVersionEditor: { findMany: editorFindMany },
    });

    await agentComponentsService.listForOrg("org-1", { limit: 2, offset: 0 });

    // The lineage read ran once, and its `definitionHash IN (...)` predicate
    // carried only the 2 fingerprints on the returned page — not all 5.
    expect(editorFindMany).toHaveBeenCalledTimes(1);
    const inClause =
      editorFindMany.mock.calls[0][0].where.definitionVersion.definitionHash.in;
    expect(inClause).toHaveLength(2);
    expect(new Set(inClause)).toEqual(new Set(["fp-0", "fp-1"]));
  });
});

// ---------------------------------------------------------------------------
// FEA-3160: server-side USAGE time-window (startDate) tests
// ---------------------------------------------------------------------------

/**
 * A usage row carrying `lastInvokedAt`, the field the FEA-3160 window predicate
 * filters on. The window DB read scopes `sessionUsages` to
 * `lastInvokedAt >= startDate`; these tests supply rows whose usage the mock has
 * ALREADY filtered (mirroring what Prisma would return), plus assert the
 * predicate reaches the query.
 */
function buildWindowedUsageRow(
  agentSessionId: string,
  invocationCount: number,
  lastInvokedAt: string
) {
  return {
    agentSessionId,
    invocationCount,
    lastInvokedAt: new Date(lastInvokedAt),
    session: {
      artifactId: agentSessionId,
      userId: "user-1",
      artifact: { organizationId: "org-1" },
    },
  };
}

describe("agentComponentsService.listForOrg — source filter (FEA-3249)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // `source` is derived (sourceUrl ?? key), not a column, so it cannot be a
  // where-clause like `harness` — it is filtered post-dedup. These cases pin the
  // web behaviour to the desktop `matchesFilters` contract: exact equality
  // against the SAME label the DTO exposes.
  function installTwoSources() {
    const fromRepo = buildInventoryRow({
      id: "ac-repo",
      externalComponentId: "skill::repo-skill",
      name: "Repo Skill",
      componentKey: "repo-skill",
      sourceUrl: "github.com/acme/repo",
    });
    // sourceUrl null ⇒ the label falls back to the component key.
    const fromKey = buildInventoryRow({
      id: "ac-key",
      externalComponentId: "skill::key-skill",
      name: "Key Skill",
      componentKey: "key-skill",
      sourceUrl: null,
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([fromRepo, fromKey]),
      },
    });
  }

  it("filters to components whose derived source matches exactly", async () => {
    installTwoSources();

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      source: "github.com/acme/repo",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "ac-repo",
      source: "github.com/acme/repo",
    });
  });

  it("matches the componentKey fallback when sourceUrl is null", async () => {
    installTwoSources();

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      source: "key-skill",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("ac-key");
  });

  it("counts only the filtered set in total/hasMore (filter precedes pagination)", async () => {
    installTwoSources();

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      source: "github.com/acme/repo",
    });

    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it("does not match on a partial/substring source", async () => {
    installTwoSources();

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      source: "github.com",
    });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns the unfiltered list when source is absent", async () => {
    installTwoSources();

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(2);
  });
});

describe("agentComponentsService.listForOrg — startDate windowing (FEA-3160)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const START = "2026-06-01T00:00:00.000Z";

  it("threads startDate into every usage-lane where clause", async () => {
    // At least one inventory row so the usage rollup `groupBy` actually fires
    // (it is skipped when there are no inventory ids to scope to).
    const inventoryFindMany = vi.fn().mockResolvedValue([buildInventoryRow()]);
    const usageFindMany = vi.fn().mockResolvedValue([]);
    // FEA-3467: direct usage is now aggregated by a sibling `groupBy`, not a
    // nested `sessionUsages` relation — assert the window reaches its `where`.
    const usageGroupBy = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
      agentComponentSessionUsage: {
        findMany: usageFindMany,
        groupBy: usageGroupBy,
      },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      startDate: START,
    });

    // Usage rollup: the groupBy is windowed by lastInvokedAt.
    const groupWhere = usageGroupBy.mock.calls[0]?.[0]?.where;
    expect(groupWhere?.lastInvokedAt).toEqual({ gte: new Date(START) });

    // Orphan-usage fold: also windowed. ISS-4799 moved this lane onto `groupBy`,
    // so the window has to reach the orphan groupBy's `where`, not a row read.
    const orphanReads = orphanGroupByCalls(usageDelegate(usageGroupBy));
    expect(orphanReads).not.toHaveLength(0);
    for (const read of orphanReads) {
      expect(read.where?.lastInvokedAt).toEqual({ gte: new Date(START) });
    }
  });

  it("does NOT add a window predicate when startDate is absent (all-time)", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([buildInventoryRow()]);
    const usageFindMany = vi.fn().mockResolvedValue([]);
    const usageGroupBy = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
      agentComponentSessionUsage: {
        findMany: usageFindMany,
        groupBy: usageGroupBy,
      },
    });

    await agentComponentsService.listForOrg("org-1", { limit: 50, offset: 0 });

    const groupWhere = usageGroupBy.mock.calls[0]?.[0]?.where;
    expect(groupWhere?.lastInvokedAt).toBeUndefined();
    const orphanReads = orphanGroupByCalls(usageDelegate(usageGroupBy));
    expect(orphanReads).not.toHaveLength(0);
    for (const read of orphanReads) {
      expect(read.where?.lastInvokedAt).toBeUndefined();
    }
  });

  it("with startDate: a component whose only usage is BEFORE the window is dropped (zero in-window)", async () => {
    // Two components. The mock returns their sessionUsages already filtered by
    // the window (as Prisma would): the stale one has NO in-window usage rows,
    // the active one keeps its in-window row.
    const stale = buildInventoryRow({
      id: "ac-stale",
      componentKind: "skill",
      componentKey: "stale-skill",
      name: "Stale Skill",
      // Simulate DB-side windowing: no rows survive the lastInvokedAt filter.
      sessionUsages: [],
    });
    const active = buildInventoryRow({
      id: "ac-active",
      componentKind: "skill",
      componentKey: "active-skill",
      name: "Active Skill",
      sessionUsages: [
        buildWindowedUsageRow("sess-in", 8, "2026-06-15T00:00:00.000Z"),
      ],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([stale, active]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      startDate: START,
    });

    // The stale component (zero in-window usage) is dropped; only the active
    // one survives, with its windowed invocation total.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("Active Skill");
    expect(result.items[0]?.invocations).toBe(8);
    expect(result.items[0]?.sessions).toBe(1);
  });

  it("with startDate: hook/config components (no usage-tracking signal) survive the window while a zero-in-window usage-trackable component is dropped", async () => {
    // hook/config kinds are never materialized into AgentComponentSessionUsage,
    // so they ALWAYS report zero usage by design. A windowed query must keep
    // them visible (dropping them would erase the whole kind under any window),
    // while a usage-trackable skill with no in-window usage is still dropped.
    const hook = buildInventoryRow({
      id: "ac-hook",
      componentKind: "hook",
      componentKey: "pre-commit-hook",
      name: "Pre-commit Hook",
      // No usage rows exist for hooks (by design).
      sessionUsages: [],
    });
    const config = buildInventoryRow({
      id: "ac-config",
      componentKind: "config",
      componentKey: "claude-config",
      name: "Claude Config",
      sessionUsages: [],
    });
    const staleSkill = buildInventoryRow({
      id: "ac-stale-skill",
      componentKind: "skill",
      componentKey: "stale-skill",
      name: "Stale Skill",
      // Usage-trackable but no rows survive the window filter.
      sessionUsages: [],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([hook, config, staleSkill]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      startDate: START,
    });

    // Hook + config survive despite zero windowed usage; the stale skill is
    // dropped for having zero in-window usage on a usage-trackable kind.
    const names = result.items.map((i) => i.name).sort();
    expect(names).toEqual(["Claude Config", "Pre-commit Hook"]);
    const kinds = result.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["config", "hook"]);
    // The surviving zero-usage kinds honestly report zero usage.
    for (const item of result.items) {
      expect(item.invocations).toBe(0);
      expect(item.sessions).toBe(0);
    }
  });

  it("without startDate: a zero-usage component is KEPT (all-time inventory view unchanged)", async () => {
    const zeroUsage = buildInventoryRow({
      id: "ac-zero",
      componentKind: "skill",
      componentKey: "zero-skill",
      name: "Zero Usage Skill",
      sessionUsages: [],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([zeroUsage]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // No window ⇒ the inventory row surfaces even with zero usage.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("Zero Usage Skill");
    expect(result.items[0]?.invocations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FEA-3178: server-side USAGE upper-bound (endDate) windowing tests. Mirrors the
// startDate suite above — the preceding-period query the summary-card delta uses
// sends BOTH bounds (startDate=prevStart, endDate=prevEnd) so the two windows do
// not overlap.
// ---------------------------------------------------------------------------

describe("agentComponentsService.listForOrg — endDate windowing (FEA-3178)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PREV_START = "2026-04-01T00:00:00.000Z";
  const PREV_END = "2026-05-01T00:00:00.000Z";

  it("threads endDate (lte) alongside startDate (gte) into every usage-lane where clause", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([buildInventoryRow()]);
    const usageFindMany = vi.fn().mockResolvedValue([]);
    const usageGroupBy = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
      agentComponentSessionUsage: {
        findMany: usageFindMany,
        groupBy: usageGroupBy,
      },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      startDate: PREV_START,
      endDate: PREV_END,
    });

    // FEA-3467: the usage rollup groupBy carries BOTH bounds.
    const groupWhere = usageGroupBy.mock.calls[0]?.[0]?.where;
    expect(groupWhere?.lastInvokedAt).toEqual({
      gte: new Date(PREV_START),
      lte: new Date(PREV_END),
    });

    // Orphan-usage fold: also bounded on both sides (ISS-4799: on `groupBy`).
    const orphanReads = orphanGroupByCalls(usageDelegate(usageGroupBy));
    expect(orphanReads).not.toHaveLength(0);
    for (const read of orphanReads) {
      expect(read.where?.lastInvokedAt).toEqual({
        gte: new Date(PREV_START),
        lte: new Date(PREV_END),
      });
    }
  });

  it("supports endDate WITHOUT startDate (upper bound only ⇒ lte only)", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([buildInventoryRow()]);
    const usageGroupBy = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([]),
        groupBy: usageGroupBy,
      },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      endDate: PREV_END,
    });

    const groupWhere = usageGroupBy.mock.calls[0]?.[0]?.where;
    expect(groupWhere?.lastInvokedAt).toEqual({ lte: new Date(PREV_END) });
  });

  it("does NOT add any window predicate when both bounds are absent (all-time)", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([buildInventoryRow()]);
    const usageGroupBy = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([]),
        groupBy: usageGroupBy,
      },
    });

    await agentComponentsService.listForOrg("org-1", { limit: 50, offset: 0 });

    const groupWhere = usageGroupBy.mock.calls[0]?.[0]?.where;
    expect(groupWhere?.lastInvokedAt).toBeUndefined();
  });

  it("with a bounded [start,end] window: a component with zero in-window usage is dropped", async () => {
    // The mock returns each component's sessionUsages already filtered by the
    // window (as Prisma would): the stale one has no surviving rows, the active
    // one keeps its in-window row.
    const stale = buildInventoryRow({
      id: "ac-stale",
      componentKind: "skill",
      componentKey: "stale-skill",
      name: "Stale Skill",
      sessionUsages: [],
    });
    const active = buildInventoryRow({
      id: "ac-active",
      componentKind: "skill",
      componentKey: "active-skill",
      name: "Active Skill",
      sessionUsages: [
        buildWindowedUsageRow("sess-prev", 5, "2026-04-15T00:00:00.000Z"),
      ],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([stale, active]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      startDate: PREV_START,
      endDate: PREV_END,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("Active Skill");
    expect(result.items[0]?.invocations).toBe(5);
    expect(result.items[0]?.sessions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// KLOC/$ efficiency metric (FEA-2923 follow-up)
// ---------------------------------------------------------------------------

function buildSessionDetailRow(
  artifactId: string,
  linesAdded: number | null,
  linesRemoved: number | null,
  estimatedCost: number
) {
  return { artifactId, linesAdded, linesRemoved, estimatedCost };
}

describe("agentComponentsService.listForOrg — locPerDollar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes locPerDollar = (linesAdded+linesRemoved) / summed cost across the component's sessions", async () => {
    const row = buildInventoryRow({
      id: "ac-kloc",
      componentKind: "subagent",
      componentKey: "my-subagent",
      sessionUsages: [buildUsageRow("sess-1", 4), buildUsageRow("sess-2", 6)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          // 900 + 100 = 1000 lines total, $2.00 total cost across two sessions.
          buildSessionDetailRow("sess-1", 700, 200, 1.5),
          buildSessionDetailRow("sess-2", 80, 20, 0.5),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // ISS-4667: 1000 LINES / $2.00 = 500 LOC per dollar (no divide-by-1000).
    expect(result.items[0]?.locPerDollar).toBeCloseTo(500, 6);
  });

  it("counts a session's LOC + cost exactly once even when it has multiple usage rows (no double-count)", async () => {
    // Two usage rows for the SAME session (e.g. per-branch buckets) must not
    // count that session's LOC/cost twice.
    const row = buildInventoryRow({
      id: "ac-dedup",
      componentKind: "subagent",
      componentKey: "dedup-subagent",
      sessionUsages: [buildUsageRow("sess-1", 3), buildUsageRow("sess-1", 2)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([buildSessionDetailRow("sess-1", 400, 100, 1)]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // 500 LINES / $1 = 500 — NOT 1000 (which double-counting would produce).
    expect(result.items[0]?.locPerDollar).toBeCloseTo(500, 6);
  });

  it("returns locPerDollar=null when the sessions' summed cost is 0 (no divide-by-zero, no fabricated number)", async () => {
    const row = buildInventoryRow({
      id: "ac-zero-cost",
      componentKind: "subagent",
      componentKey: "free-subagent",
      sessionUsages: [buildUsageRow("sess-1", 5)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([buildSessionDetailRow("sess-1", 500, 0, 0)]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items[0]?.locPerDollar).toBeNull();
  });

  it("returns locPerDollar=null when the sessions produced no measurable lines", async () => {
    const row = buildInventoryRow({
      id: "ac-no-loc",
      componentKind: "subagent",
      componentKey: "no-loc-subagent",
      sessionUsages: [buildUsageRow("sess-1", 5)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([buildSessionDetailRow("sess-1", 0, 0, 2)]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items[0]?.locPerDollar).toBeNull();
  });

  it("returns locPerDollar=null for a component whose sessions have no SessionDetail LOC/cost rows", async () => {
    const row = buildInventoryRow({
      id: "ac-missing",
      componentKind: "subagent",
      componentKey: "missing-subagent",
      sessionUsages: [buildUsageRow("sess-1", 5)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      // sessionDetail.findMany defaults to [] — no LOC/cost available.
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items[0]?.locPerDollar).toBeNull();
  });

  // FEA-4052: KLOC/$ is gated on the component KIND's per-component attribution
  // reliability. A non-verifiable kind (mcp/tool/plugin/…) reports null even
  // when its sessions produced real, measurable LOC at real cost — the surface
  // must not render a session-level number it can't back to one component.
  it("returns locPerDollar=null for a non-verifiable kind (mcp) despite real LOC + cost", async () => {
    const row = buildInventoryRow({
      id: "ac-mcp",
      componentKind: "mcp",
      componentKey: "mcp__some__tool",
      sessionUsages: [buildUsageRow("sess-1", 4)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        // 1000 lines at $2.00 — a verifiable kind would report 500 here.
        findMany: vi
          .fn()
          .mockResolvedValue([buildSessionDetailRow("sess-1", 800, 200, 2)]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("mcp");
    expect(result.items[0]?.locPerDollar).toBeNull();
  });

  // FEA-4052 (wongk, PR #3720): skill and command are NOT verifiable. A single
  // session gives every co-invoked component its FULL LOC/cost, so a per-component
  // KLOC/$ for a skill or command would be a misleading session-level number.
  // Until sessions can be partitioned across co-invoked components, both report
  // null even with real, measurable LOC at real cost — exactly like mcp above.
  it.each([
    "skill",
    "command",
  ] as const)("returns locPerDollar=null for %s (session-level attribution, not component-level) despite real LOC + cost", async (componentKind) => {
    const row = buildInventoryRow({
      id: `ac-${componentKind}`,
      componentKind,
      componentKey: `my-${componentKind}`,
      sessionUsages: [buildUsageRow("sess-1", 4)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        // 1000 lines at $2.00 — a verifiable kind would report 500 here.
        findMany: vi
          .fn()
          .mockResolvedValue([buildSessionDetailRow("sess-1", 800, 200, 2)]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe(componentKind);
    expect(result.items[0]?.locPerDollar).toBeNull();
  });

  it("scopes the SessionDetail LOC/cost lookup to the org via the parent artifact", async () => {
    const sessionDetailFindMany = vi.fn().mockResolvedValue([]);
    const row = buildInventoryRow({
      id: "ac-scope",
      sessionUsages: [buildUsageRow("sess-1", 1)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: { findMany: sessionDetailFindMany },
    });

    await agentComponentsService.listForOrg("org-1", { limit: 50, offset: 0 });

    const where = sessionDetailFindMany.mock.calls[0]?.[0]?.where;
    // Org scope must go through the parent artifact (SessionDetail has no
    // organizationId column of its own).
    expect(where?.artifact).toMatchObject({ organizationId: "org-1" });
  });

  // FEA-3750: agentic (subagent) components must report a real, non-zero KLOC/$
  // — not 0.0 / null. The subagent usage row's `agentSessionId` is the PARENT
  // session (which carries the local-git LOC + cost), so the metric is honest
  // whether that usage is FK-linked to an event-minted inventory row or arrives
  // as an orphan (null-FK) row. `componentKey` is the RAW subagent type from the
  // transcript (mixed case, e.g. `Explore`), so these lock in that the LOC/cost
  // join is not case-sensitive on the identity key.
  it("FEA-3750: a subagent (mixed-case FK-linked usage) reports a real non-zero locPerDollar", async () => {
    const row = buildInventoryRow({
      id: "ac-explore",
      componentKind: "subagent",
      // Raw transcript-cased key (event-minted inventory rows store it verbatim).
      componentKey: "Explore",
      name: "Explore",
      harness: null,
      sessionUsages: [
        buildUsageRow("sess-a", 3, "org-1", null, "claude"),
        buildUsageRow("sess-b", 2, "org-1", null, "claude"),
      ],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          // 700+200 + 80+20 = 1000 lines total, $2.00 total cost.
          buildSessionDetailRow("sess-a", 700, 200, 1.5),
          buildSessionDetailRow("sess-b", 80, 20, 0.5),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("subagent");
    // 1000 LINES / $2.00 = 500 — a real signal, NOT 0.0 / null.
    expect(result.items[0]?.locPerDollar).toBeCloseTo(500, 6);
  });

  it("FEA-3750: a subagent surfaced only as orphan (null-FK) usage still reports a real non-zero locPerDollar", async () => {
    installDb(
      {
        agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
        sessionDetail: {
          findMany: vi
            .fn()
            .mockResolvedValue([buildSessionDetailRow("sess-a", 400, 100, 1)]),
        },
      },
      [
        {
          agentSessionId: "sess-a",
          componentKind: "subagent",
          componentKey: "code-review",
          harness: "claude",
          invocationCount: 4,
          firstInvokedAt: new Date("2026-03-01T00:00:00.000Z"),
          lastInvokedAt: new Date("2026-03-05T00:00:00.000Z"),
        },
      ]
    );

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("subagent");
    // 500 LINES / $1 = 500 — orphan-only subagents are honest too.
    expect(result.items[0]?.locPerDollar).toBeCloseTo(500, 6);
  });
});

// ---------------------------------------------------------------------------
// getDetailForOrg tests
// ---------------------------------------------------------------------------

describe("agentComponentsService.getDetailForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the sessions read service returns no summaries. Individual tests
    // override this to assert sessionsTab population + the forwarded ids.
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("returns null (404) when no inventory rows match the slug", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::nonexistent"
    );

    expect(result).toBeNull();
  });

  it("returns null for an invalid slug format (no :: separator)", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "invalid-slug-no-separator"
    );

    expect(result).toBeNull();
  });

  it("includes all compute targets in provenance[]", async () => {
    const detailRow1 = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "skill",
      componentKey: "my-skill",
      externalComponentId: "skill::my-skill",
      harness: "claude",
      name: "My Skill",
      sourceUrl: null,
      installPath: "/home/user/.skills/my-skill",
      scope: "user",
      projectPath: null,
      description: "A test skill",
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [],
    };
    const detailRow2 = {
      ...detailRow1,
      id: "ac-2",
      computeTargetId: "target-2",
      installPath: "/home/user2/.skills/my-skill",
      scope: "project",
      computeTarget: buildComputeTarget("target-2", "user-2", {
        id: "user-2",
        firstName: "Bob",
        lastName: null,
        email: "bob@example.com",
      }),
      sessionUsages: [],
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow1, detailRow2]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result).not.toBeNull();
    expect(result?.provenance).toHaveLength(2);
    const provenanceIds = result?.provenance.map((p) => p.computeTargetId);
    expect(provenanceIds).toContain("target-1");
    expect(provenanceIds).toContain("target-2");
  });

  it("keeps the legacy aggregate when no exact invocation rows exist", async () => {
    const detailRow = buildInventoryRow({
      sessionUsages: [buildUsageRow("session-legacy", 7)],
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result?.invocations).toBe(7);
    expect(result?.invocationRows).toEqual({
      items: [],
      total: 0,
      hasMore: false,
      unmatchedCount: 0,
      ambiguousCount: 0,
    });
  });

  it("returns a bounded active-generation invocation page with exact evidence and scoped identity fallback", async () => {
    const invocationFindMany = vi.fn().mockResolvedValue([
      {
        id: "invocation-row-1",
        externalInvocationId: "external-invocation-1",
        sourceSessionId: "source-session-1",
        childSessionId: "child-session-1",
        parentExternalInvocationId: "parent-invocation-1",
        externalAgentId: "external-agent-1",
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: "my-skill",
        rawName: "My Skill",
        normalizedName: "my-skill",
        relationship: AgentComponentInvocationRelationship.ChildSession,
        invokedAt: new Date("2026-01-10T12:30:00.000Z"),
        sequence: 4,
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Agent,
          agentId: "agent-row-1",
          externalAgentId: "anchor-external-agent-1",
          transcriptFileId: "agent-transcript-1",
        },
        providerInvocationId: "provider-invocation-1",
        attributionStatus: AgentComponentInvocationAttributionStatus.Unmatched,
        evidenceClass: AgentComponentInvocationEvidenceClass.RepositoryCommit,
        definitionHash: "definition-hash-1",
        normalizerContractVersion: 1,
        definitionVersionId: "definition-version-1",
        sourceOccurrenceId: "source-occurrence-1",
        sourcePath: "skills/my-skill/SKILL.md",
        sourceModifiedAt: new Date("2026-01-09T10:00:00.000Z"),
        capturedAt: new Date("2026-01-10T12:00:00.000Z"),
        repositoryFullName: "closedloop-ai/symphony-alpha",
        repositoryCommit: "abc123",
        packId: "pack-1",
        branchName: "feat/fea-3294",
        generation: {
          agentSessionId: "session-cloud-1",
          session: { externalSessionId: "external-session-1" },
        },
      },
    ]);
    const sourceOccurrenceFindMany = vi.fn().mockResolvedValue([
      {
        id: "source-occurrence-1",
        occurrenceType: SourceOccurrenceType.Repository,
        accessState: SourceAccessState.Accessible,
        repoFullName: "closedloop-ai/symphony-alpha",
        repoPath: "skills/my-skill/SKILL.md",
        repoCommit: "abc123",
        computeTargetId: null,
        localPath: null,
        packId: null,
        firstSeenAt: new Date("2026-01-09T10:00:00.000Z"),
        lastSeenAt: new Date("2026-01-10T12:00:00.000Z"),
      },
    ]);
    const invocationGroupBy = vi.fn().mockResolvedValue([
      {
        attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
        _count: { _all: 4 },
      },
      {
        attributionStatus: AgentComponentInvocationAttributionStatus.Unmatched,
        _count: { _all: 2 },
      },
      {
        attributionStatus: AgentComponentInvocationAttributionStatus.Ambiguous,
        _count: { _all: 3 },
      },
      {
        attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
        _count: { _all: 1 },
      },
    ]);
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          .mockResolvedValue([buildInventoryRow({ id: "component-cloud-1" })]),
      },
      agentComponentInvocation: {
        findMany: invocationFindMany,
        groupBy: invocationGroupBy,
      },
      sourceOccurrence: { findMany: sourceOccurrenceFindMany },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result?.invocationRows).toEqual({
      items: [
        {
          id: "invocation-row-1",
          externalInvocationId: "external-invocation-1",
          sessionId: "session-cloud-1",
          externalSessionId: "external-session-1",
          sourceSessionId: "source-session-1",
          childSessionId: "child-session-1",
          parentExternalInvocationId: "parent-invocation-1",
          externalAgentId: "external-agent-1",
          kind: AgentComponentInvocationKind.Skill,
          componentKey: "my-skill",
          rawName: "My Skill",
          normalizedName: "my-skill",
          relationship: AgentComponentInvocationRelationship.ChildSession,
          invokedAt: "2026-01-10T12:30:00.000Z",
          sequence: 4,
          anchor: {
            kind: AgentComponentInvocationAnchorKind.Agent,
            agentId: "agent-row-1",
            externalAgentId: "anchor-external-agent-1",
            transcriptFileId: "agent-transcript-1",
          },
          providerInvocationId: "provider-invocation-1",
          status: AgentComponentInvocationAttributionStatus.Unmatched,
          evidenceClass: AgentComponentInvocationEvidenceClass.RepositoryCommit,
          definitionHash: "definition-hash-1",
          normalizerContractVersion: 1,
          definitionVersionId: "definition-version-1",
          sourceOccurrence: {
            occurrenceType: SourceOccurrenceType.Repository,
            accessState: SourceAccessState.Accessible,
            repoFullName: "closedloop-ai/symphony-alpha",
            repoPath: "skills/my-skill/SKILL.md",
            repoCommit: "abc123",
            computeTargetId: null,
            localPath: null,
            packId: null,
            firstSeenAt: "2026-01-09T10:00:00.000Z",
            lastSeenAt: "2026-01-10T12:00:00.000Z",
          },
          sourcePath: "skills/my-skill/SKILL.md",
          sourceModifiedAt: "2026-01-09T10:00:00.000Z",
          capturedAt: "2026-01-10T12:00:00.000Z",
          repositoryFullName: "closedloop-ai/symphony-alpha",
          repositoryCommit: "abc123",
          packId: "pack-1",
          branchName: "feat/fea-3294",
        },
      ],
      total: 10,
      hasMore: true,
      unmatchedCount: 2,
      ambiguousCount: 3,
    });
    const expectedWhere = {
      generation: {
        activeAt: { not: null },
        completedAt: { not: null },
        session: { artifact: { organizationId: "org-1" } },
      },
      OR: [
        { agentComponentId: { in: ["component-cloud-1"] } },
        {
          agentComponentId: null,
          componentKind: AgentComponentInvocationKind.Skill,
          componentKey: { equals: "my-skill", mode: "insensitive" },
        },
      ],
    };
    expect(invocationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
        take: AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS,
        orderBy: [
          { invokedAt: { sort: "desc", nulls: "last" } },
          { generationId: "asc" },
          { sequence: "asc" },
          { externalInvocationId: "asc" },
          { id: "asc" },
        ],
      })
    );
    expect(invocationGroupBy).toHaveBeenCalledWith({
      by: ["attributionStatus"],
      where: expectedWhere,
      _count: { _all: true },
    });
    expect(sourceOccurrenceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          id: { in: ["source-occurrence-1"] },
        },
      })
    );
  });

  it("builds usageSessions[] with branch attribution via on-read artifact_link join", async () => {
    const sessionId = "session-abc";
    const detailRow = {
      ...detailInventoryDefaults(),
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 8,
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    const branchLinkRow = {
      sourceId: sessionId,
      metadata: {
        linkKind: "session_branch",
        branchName: "fea-2923",
      },
      target: {
        branch: { branchName: "fea-2923" },
      },
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([branchLinkRow]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "command::code-review"
    );

    expect(result).not.toBeNull();
    expect(result?.usageSessions).toHaveLength(1);
    expect(result?.usageSessions[0]).toMatchObject({
      sessionId,
      invocationCount: 8,
      branchName: "fea-2923",
    });
  });

  it("returns usageSessions[] with branchName=null when no branch link exists", async () => {
    const sessionId = "session-no-branch";
    const detailRow = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "skill",
      componentKey: "my-skill",
      externalComponentId: "skill::my-skill",
      harness: "claude",
      name: "My Skill",
      sourceUrl: null,
      installPath: null,
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 3,
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result?.usageSessions[0]?.branchName).toBeNull();
    expect(result?.usageSessions[0]?.invocationCount).toBe(3);
  });

  it("FEA-2923: attaches versionHash from the winning usage row, null for sessions with no match", async () => {
    const stampedSession = "session-stamped";
    const unstampedSession = "session-unstamped";
    const detailRow = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "skill",
      componentKey: "my-skill",
      externalComponentId: "skill::my-skill",
      harness: "claude",
      name: "My Skill",
      sourceUrl: null,
      installPath: null,
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        {
          agentSessionId: stampedSession,
          invocationCount: 5,
          session: {
            artifactId: stampedSession,
            artifact: { organizationId: "org-1" },
          },
        },
        {
          agentSessionId: unstampedSession,
          invocationCount: 2,
          session: {
            artifactId: unstampedSession,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      // Only the stamped session has a per-session version hash; the other has
      // no usage row → its versionHash must resolve to null. The version/
      // definition attribution read selects `componentVersionHash`; every other
      // `agentComponentSessionUsage.findMany` (orphan/child fold) returns [].
      agentComponentSessionUsage: {
        findMany: vi.fn().mockImplementation((args?: FindManyArgs) =>
          isVersionAttributionRead(args)
            ? Promise.resolve([
                {
                  agentSessionId: stampedSession,
                  componentVersionHash: "hash-abc123",
                  definitionVersionId: null,
                  lastInvokedAt: new Date("2026-01-10"),
                  id: "u-stamped",
                },
              ])
            : Promise.resolve([])
        ),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result?.usageSessions).toHaveLength(2);
    const byId = new Map(
      (result?.usageSessions ?? []).map((u) => [u.sessionId, u])
    );
    expect(byId.get(stampedSession)?.versionHash).toBe("hash-abc123");
    expect(byId.get(unstampedSession)?.versionHash).toBeNull();
  });

  it("FEA-2990: splits one session's usage per-event branch, overriding the session-level link", async () => {
    // A single session ran this component on two branches (checkout mid-run).
    // The desktop materialized one usage row per (component, branch); the cloud
    // must surface BOTH branches at invocation granularity instead of crediting
    // the whole session to the single session-level SessionBranch link.
    const sessionId = "session-multi-branch";
    const detailRow = {
      ...detailInventoryDefaults(),
      componentKind: "tool",
      componentKey: "Bash",
      externalComponentId: "tool::Bash",
      name: "Bash",
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 4,
          gitBranch: "feat/a",
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
        {
          agentSessionId: sessionId,
          invocationCount: 9,
          gitBranch: "feat/b",
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    // Session-level link points at a THIRD branch — it must NOT win over the
    // per-event branches. A branch-dropping (session-level-only) implementation
    // would emit a single row attributed to this stale branch, failing below.
    const branchLinkRow = {
      sourceId: sessionId,
      metadata: {
        linkKind: "session_branch",
        branchName: "session-level-stale",
      },
      target: { branch: { branchName: "session-level-stale" } },
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([branchLinkRow]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "tool::Bash"
    );

    expect(result).not.toBeNull();
    // Two entries — one per branch actually run on — not one session-level row.
    expect(result?.usageSessions).toHaveLength(2);
    const byBranch = new Map(
      result?.usageSessions.map((u) => [u.branchName, u.invocationCount])
    );
    expect(byBranch.get("feat/a")).toBe(4);
    expect(byBranch.get("feat/b")).toBe(9);
    // The stale session-level branch never appears for these precise buckets.
    expect(byBranch.has("session-level-stale")).toBe(false);
    // Aggregate total still counts every invocation.
    expect(result?.invocations).toBe(13);
  });

  it("FEA-2990: a branch-less ('' sentinel) usage bucket falls back to the session-level SessionBranch link", async () => {
    // Legacy/Codex usage carries no per-event branch (gitBranch ''), so the
    // session-level SessionBranch link must still supply the attribution — no
    // regression for pre-column data.
    const sessionId = "session-legacy";
    const detailRow = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "tool",
      componentKey: "Bash",
      externalComponentId: "tool::Bash",
      harness: "codex",
      name: "Bash",
      sourceUrl: null,
      installPath: null,
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 6,
          gitBranch: "",
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    const branchLinkRow = {
      sourceId: sessionId,
      metadata: {
        linkKind: "session_branch",
        branchName: "legacy-branch",
      },
      target: { branch: { branchName: "legacy-branch" } },
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([branchLinkRow]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "tool::Bash"
    );

    expect(result?.usageSessions).toHaveLength(1);
    expect(result?.usageSessions[0]).toMatchObject({
      sessionId,
      invocationCount: 6,
      branchName: "legacy-branch",
    });
  });

  it("FEA-2990: merges the '' fallback bucket into a real per-event bucket of the same branch (no double-count)", async () => {
    // A session has BOTH a branch-less ('' sentinel) bucket AND a real per-event
    // bucket, and the session-level SessionBranch link resolves '' to that SAME
    // real branch. Naively pushing one row per bucket would emit two rows both
    // named "feat/x", and the detail/token-trend sum-over-rows would then
    // double-count. buildUsageSessions must fold by RESOLVED branch and sum.
    const sessionId = "session-collide";
    const detailRow = {
      ...detailInventoryDefaults(),
      componentKind: "tool",
      componentKey: "Bash",
      externalComponentId: "tool::Bash",
      name: "Bash",
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 5,
          gitBranch: "feat/x",
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
        {
          agentSessionId: sessionId,
          invocationCount: 2,
          gitBranch: "",
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    // Session-level link resolves the '' bucket to "feat/x" — the SAME branch as
    // the real per-event bucket, forcing the collision.
    const branchLinkRow = {
      sourceId: sessionId,
      metadata: {
        linkKind: "session_branch",
        branchName: "feat/x",
      },
      target: { branch: { branchName: "feat/x" } },
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([branchLinkRow]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "tool::Bash"
    );

    expect(result).not.toBeNull();
    // ONE merged row for feat/x, not two — the '' bucket folds into the real one.
    expect(result?.usageSessions).toHaveLength(1);
    expect(result?.usageSessions[0]).toMatchObject({
      sessionId,
      branchName: "feat/x",
      invocationCount: 7,
    });
  });

  it("returns the detail with id matching the first inventory row", async () => {
    const detailRow = {
      id: "canonical-uuid-1",
      computeTargetId: "target-1",
      componentKind: "mcp",
      componentKey: "my-mcp",
      externalComponentId: "mcp::my-mcp",
      harness: "claude",
      name: "My MCP",
      sourceUrl: "https://example.com/mcp",
      installPath: null,
      scope: null,
      projectPath: null,
      description: "Test MCP server",
      firstSeenAt: new Date("2026-02-01"),
      lastSeenAt: new Date("2026-02-15"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [],
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "mcp::my-mcp"
    );

    expect(result?.id).toBe("canonical-uuid-1");
    expect(result?.name).toBe("My MCP");
    expect(result?.kind).toBe("mcp");
    // firstSeenAt and lastSeenAt are ISO strings on the response
    expect(result?.firstSeenAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result?.lastSeenAt).toBe("2026-02-15T00:00:00.000Z");
  });

  it("populates sessionsTab from the usage→session join (FEA-2923: not hardcoded [])", async () => {
    const sessionId = "session-sessions-tab";
    const detailRow = {
      ...detailInventoryDefaults(),
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 5,
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    // The agent-sessions read service returns a real list-item summary; the
    // detail must surface it as sessionsTab (previously hardcoded []).
    const sessionSummary = { id: sessionId, name: "Code Review Session" };
    mocks.listByArtifactIds.mockResolvedValue([sessionSummary]);

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "command::code-review"
    );

    // sessionsTab must be populated from the reused session service, org-scoped,
    // for exactly the session ids that invoked the component.
    expect(mocks.listByArtifactIds).toHaveBeenCalledWith(
      "org-1",
      [sessionId],
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );
    expect(result?.sessionsTab).toHaveLength(1);
    expect(result?.sessionsTab[0]).toMatchObject({ id: sessionId });
  });

  it("rolls up ORPHAN-FK child usage into a plugin detail's invocations/sessions/sessionsTab (FEA-4337)", async () => {
    // FEA-4337 regression (detail parity with the list): a plugin inventory row
    // (packId="rtk") with NO own usage rows. Its detail invocations/sessions/
    // sessionsTab are derived from CHILD usage attributed by the child INVENTORY
    // identity (kind, key) → packId, NOT the usage FK — so ORPHANED (null-FK)
    // child usage still rolls up, matching the list view and the desktop reader.
    const pluginDetailRow = {
      id: "ac-plugin-rtk",
      computeTargetId: "target-1",
      componentKind: "plugin",
      componentKey: "rtk",
      externalComponentId: "plugin::rtk",
      harness: "claude",
      name: "RTK",
      sourceUrl: null,
      installPath: null,
      packId: "rtk",
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      // Plugins are never invoked directly — no own usage rows.
      sessionUsages: [],
    };
    // The plugin's child inventory row that maps the orphan child usage to packId.
    const childInventoryRow = {
      componentKind: "command",
      componentKey: "git-status",
      packId: "rtk",
    };

    // Child usage rows carrying their natural identity and a NULL FK (orphan).
    const childUsage = [
      {
        agentSessionId: "sess-a",
        componentKind: "command",
        componentKey: "git-status",
        invocationCount: 4,
      },
      {
        agentSessionId: "sess-b",
        componentKind: "command",
        componentKey: "git-status",
        invocationCount: 1,
      },
    ];
    const usageFindMany = vi
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        // Plugin child-usage read: child kinds, no FK filter (FEA-4337).
        if (where.componentKind && where.agentComponentId === undefined) {
          return Promise.resolve(childUsage);
        }
        return Promise.resolve([]);
      });
    // `agentComponent.findMany`: the child-identity read (componentKind + packId)
    // returns the child inventory row; every other read returns the plugin row.
    const inventoryFindMany = vi
      .fn()
      .mockImplementation(({ where }: { where?: Record<string, unknown> }) => {
        if (where?.componentKind && where?.packId) {
          return Promise.resolve([childInventoryRow]);
        }
        return Promise.resolve([pluginDetailRow]);
      });

    mocks.listByArtifactIds.mockResolvedValue([
      { id: "sess-a" },
      { id: "sess-b" },
    ]);

    installDb({
      agentComponent: {
        findMany: inventoryFindMany,
      },
      agentComponentSessionUsage: {
        findMany: usageFindMany,
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "plugin::rtk"
    );

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("plugin");
    // 4 + 1 child invocations rolled up (NOT the plugin's empty own usage).
    expect(result?.invocations).toBe(5);
    expect(result?.sessions).toBe(2);
    // sessionsTab is no longer hardcoded []: it lists the child-usage sessions.
    expect(mocks.listByArtifactIds).toHaveBeenCalledWith(
      "org-1",
      ["sess-a", "sess-b"],
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );
    expect(result?.sessionsTab).toHaveLength(2);
  });

  it("resolves an orphan-only (used-but-not-inventoried) component to a synthetic detail instead of 404 (#2613)", async () => {
    const sessionId = "session-orphan-only";
    // No inventory rows for this identity...
    // ...but usage rows exist (agentComponentId IS NULL). Previously this 404ed
    // even though the list surfaces the component via the orphan-usage fold.
    mocks.listByArtifactIds.mockResolvedValue([{ id: sessionId }]);

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          {
            agentSessionId: sessionId,
            invocationCount: 9,
            // Orphan usage recorded against codex — the synthetic detail must
            // reflect the actual row harness, NOT a hardcoded "claude".
            harness: "codex",
          },
        ]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::used-only-skill"
    );

    // Must NOT 404 — a synthetic detail is built from orphan usage.
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("skill");
    // id must be built via the encodeComponentSlug SSOT (FEA-3204), not an
    // inline `${kind}::${key}` literal that could drift from the codec.
    expect(result?.id).toBe(
      encodeComponentSlug("skill", "used-only-skill", null)
    );
    // Harness is derived from the usage row (codex), not hardcoded claude.
    expect(result?.harness).toBe("codex");
    expect(result?.invocations).toBe(9);
    expect(result?.sessions).toBe(1);
    expect(result?.usageSessions).toHaveLength(1);
    expect(result?.usageSessions[0]).toMatchObject({
      sessionId,
      invocationCount: 9,
    });
    // sessionsTab still populated from the reused session service.
    expect(mocks.listByArtifactIds).toHaveBeenCalledWith(
      "org-1",
      [sessionId],
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );
    expect(result?.sessionsTab).toHaveLength(1);
    // No inventory row => no compute targets / provenance.
    expect(result?.provenance).toHaveLength(0);
    expect(result?.computeTargetIds).toHaveLength(0);
  });

  it("wongk (orphan authors): an orphan-only detail carries the authors from its usage's definitionVersionId lineage, not an empty set", async () => {
    const sessionId = "session-orphan-authored";
    mocks.listByArtifactIds.mockResolvedValue([{ id: sessionId }]);

    installDb({
      // No inventory row for this identity...
      agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
      agentComponentSessionUsage: {
        // ...but the orphan usage carries a definitionVersionId (the version it
        // ran against). The list view already shows authors from this link, so
        // the detail must resolve them too instead of hardcoding [].
        findMany: vi.fn().mockResolvedValue([
          {
            agentSessionId: sessionId,
            invocationCount: 5,
            harness: "claude",
            gitBranch: "",
            definitionVersionId: "dv-orphan",
          },
        ]),
      },
      // definitionVersionId → definitionHash resolution.
      definitionVersion: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "dv-orphan", definitionHash: "fp-orphan" },
          ]),
      },
      // That fingerprint's lineage names the authors.
      definitionVersionEditor: {
        findMany: vi.fn().mockResolvedValue([
          {
            userId: "u-orphan-author",
            firstEditedAt: new Date("2026-01-01T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-orphan" },
            user: {
              id: "u-orphan-author",
              firstName: "Orin",
              lastName: "Orphan",
              email: "orin@example.com",
            },
          },
        ]),
      },
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::orphan-authored-skill"
    );

    expect(result).not.toBeNull();
    // Authors resolved from the orphan usage's own version link — NOT empty.
    expect(result?.collaborators).toEqual(["Orin Orphan"]);
    // Additive skew-compat `owner` alias = the discoverer.
    expect(result?.owner).toBe("Orin Orphan");
  });

  it("wongk (no 20-row cap): the detail authors set includes an author from a revision beyond the 20-row prompt-history cap", async () => {
    // The prompt-history DTO is capped at 20 rows. The authors lineage must NOT
    // be derived from it: an author who only touched revision 21+ must still
    // appear. Here the dedicated lineage identity read returns 25 fingerprints
    // (uncapped), and the 25th links the only author — proving the detail's
    // Collaborators are not truncated by the prompt cap.
    const inventoryRow = buildInventoryRow({ contentHash: "hash-current" });
    // agentComponentVersion.findMany backs BOTH the version-history (registry)
    // read and the lineage identity read. Return 25 linked revisions so the
    // lineage read sees fingerprint fp-24 (the 25th), which the version-history
    // read would drop past its own 20-cap.
    const versionRows = Array.from({ length: 25 }, (_, i) => ({
      componentKind: "skill",
      componentKey: "my-skill",
      contentHash: `hash-${i}`,
      source: "repo",
      format: "md",
      firstSeenAt: new Date(`2026-01-01T00:00:0${i % 10}Z`),
      content: `# rev ${i}`,
      definitionVersion: {
        definitionHash: `fp-${i}`,
        normalizerContractVersion: 1,
        content: `# rev ${i}`,
      },
    }));
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([inventoryRow]),
      },
      agentComponentVersion: {
        findMany: vi.fn().mockResolvedValue(versionRows),
      },
      // The ONLY author touched the 25th revision (fp-24) — beyond a 20-cap.
      definitionVersionEditor: {
        findMany: vi.fn().mockResolvedValue([
          {
            userId: "u-late",
            firstEditedAt: new Date("2026-02-01T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-24" },
            user: {
              id: "u-late",
              firstName: "Lena",
              lastName: "Late",
              email: "lena@example.com",
            },
          },
        ]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    // The late-revision author is present — the authors set was not truncated.
    expect(result?.collaborators).toEqual(["Lena Late"]);
  });

  it("derives harness='both' for an orphan-only detail when usage rows disagree", async () => {
    const sessionA = "session-orphan-claude";
    const sessionB = "session-orphan-codex";
    mocks.listByArtifactIds.mockResolvedValue([
      { id: sessionA },
      { id: sessionB },
    ]);

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          { agentSessionId: sessionA, invocationCount: 2, harness: "claude" },
          { agentSessionId: sessionB, invocationCount: 3, harness: "codex" },
        ]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::mixed-harness-skill"
    );

    expect(result).not.toBeNull();
    // Conflicting harnesses across rows collapse to "both".
    expect(result?.harness).toBe("both");
  });

  it("falls back to harness='claude' for an orphan-only detail when rows leave harness unset", async () => {
    const sessionId = "session-orphan-null-harness";
    mocks.listByArtifactIds.mockResolvedValue([{ id: sessionId }]);

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { agentSessionId: sessionId, invocationCount: 4, harness: null },
          ]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::null-harness-skill"
    );

    expect(result).not.toBeNull();
    expect(result?.harness).toBe("claude");
  });

  it("FEA-3758: inventory-present detail attributes harness from the sessions it ran in (subagent used only in Codex)", async () => {
    // subagent::explorer has an inventory row whose harness is null (event-driven
    // mint sets no harness) but ran only in Codex sessions. The detail must
    // report 'codex' from the usage rows, not the defaulted 'claude'.
    const row = buildInventoryRow({
      id: "ac-explorer-detail",
      componentKind: "subagent",
      componentKey: "explorer",
      name: "explorer",
      harness: null,
      sessionUsages: [
        buildUsageRow("sess-codex-a", 3, "org-1", null, "codex"),
        buildUsageRow("sess-codex-b", 4, "org-1", null, "codex"),
      ],
    });
    mocks.listByArtifactIds.mockResolvedValue([
      { id: "sess-codex-a" },
      { id: "sess-codex-b" },
    ]);

    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "subagent::explorer"
    );

    expect(result).not.toBeNull();
    expect(result?.harness).toBe("codex");
    // Token/invocation attribution still lands on the subagent identity.
    expect(result?.invocations).toBe(7);
    expect(result?.sessions).toBe(2);
  });

  it("FEA-3758: inventory-present detail reports 'both' when the component ran in claude and codex sessions", async () => {
    const row = buildInventoryRow({
      id: "ac-gp-detail",
      componentKind: "subagent",
      componentKey: "general-purpose",
      name: "general-purpose",
      harness: "claude",
      sessionUsages: [
        buildUsageRow("sess-c", 1, "org-1", null, "claude"),
        buildUsageRow("sess-x", 2, "org-1", null, "codex"),
      ],
    });
    mocks.listByArtifactIds.mockResolvedValue([
      { id: "sess-c" },
      { id: "sess-x" },
    ]);

    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "subagent::general-purpose"
    );

    expect(result?.harness).toBe("both");
  });

  it("still 404s when there are neither inventory rows nor orphan usage", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::truly-missing"
    );

    expect(result).toBeNull();
  });

  it("returns usage=0 and empty tabs for a config-kind component (honest zero, no AgentSessionEvent fabrication)", async () => {
    const configRow = {
      id: "ac-config-1",
      computeTargetId: "target-1",
      componentKind: "config",
      componentKey: "settings-json",
      externalComponentId: "config::settings-json",
      harness: "claude",
      name: "settings.json",
      sourceUrl: null,
      installPath: null,
      scope: "user",
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [], // config kinds are not materialized into usage
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([configRow]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "config::settings-json"
    );

    expect(result).not.toBeNull();
    expect(result?.invocations).toBe(0);
    expect(result?.sessions).toBe(0);
    expect(result?.usageSessions).toHaveLength(0);
    expect(result?.sessionsTab).toHaveLength(0);
    // No session ids to forward => the session service is never queried.
    expect(mocks.listByArtifactIds).not.toHaveBeenCalled();
  });

  // FEA-3750: the detail inventory read matched `componentKey` case-SENSITIVELY
  // (`{ componentKey: key }`), but the slug `key` is lowercased while an
  // event-minted subagent inventory row stores the RAW transcript-cased key
  // (`Explore`). So drilling into a mixed-case-keyed agentic component matched
  // zero inventory rows and fell through to the orphan-only path — which reads
  // only null-FK usage. A subagent whose usage is already FK-linked to its
  // inventory row therefore surfaced NO usage and a null locPerDollar (or 404).
  // The read now matches case-insensitively (mirroring the list fold + the
  // version-attribution read), so the inventory row is found and its FK-linked
  // usage → LOC/cost → KLOC/$ is honest.
  it("FEA-3750: resolves a mixed-case subagent by its lowercased slug and reports its FK-linked locPerDollar", async () => {
    const inventoryRow = {
      id: "ac-explore",
      computeTargetId: "target-1",
      componentKind: "subagent",
      // Raw transcript-cased key — the exact value an event-minted row stores.
      componentKey: "Explore",
      externalComponentId: "subagent::Explore",
      // Event-minted rows carry no harness (defaults to claude downstream).
      harness: null,
      name: "Explore",
      sourceUrl: null,
      installPath: null,
      scope: null,
      projectPath: null,
      description: null,
      metadata: null,
      content: null,
      contentHash: null,
      resolvedState: "unresolved",
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      // FK-linked usage (agentComponentId set); the orphan-only path (null-FK)
      // would find nothing, so a case-sensitive miss zeroed the detail metric.
      sessionUsages: [buildUsageRow("sess-a", 5, "org-1", null, "claude")],
    };

    // Emulate Prisma applying the detail read's `where.OR` componentKey
    // predicate so the case-(in)sensitivity of the fix is actually exercised.
    const agentComponentFindMany = vi.fn(
      (args?: {
        where?: {
          OR?: {
            componentKey?: string | { equals?: string; mode?: string } | null;
          }[];
        };
      }) => {
        const or = args?.where?.OR;
        if (!Array.isArray(or)) {
          return [inventoryRow];
        }
        for (const arm of or) {
          const ck = arm.componentKey;
          if (
            ck &&
            typeof ck === "object" &&
            typeof ck.equals === "string" &&
            ck.mode === "insensitive" &&
            ck.equals.toLowerCase() === inventoryRow.componentKey.toLowerCase()
          ) {
            return [inventoryRow];
          }
          // A bare case-sensitive `{ componentKey: "explore" }` arm never equals
          // the stored "Explore" — reproduces the pre-fix drop.
          if (typeof ck === "string" && ck === inventoryRow.componentKey) {
            return [inventoryRow];
          }
        }
        return [];
      }
    );

    installDb({
      agentComponent: { findMany: agentComponentFindMany },
      sessionDetail: {
        // The LOC/cost read (`loadSessionLocCost`) selects `estimatedCost`;
        // `computeCohortPerformance` selects a richer PR/loop shape. Return the
        // LOC/cost rows only to the former and `[]` to the latter so the cohort
        // read (unrelated to KLOC) stays a no-op in this focused test.
        findMany: vi.fn(async (args?: { select?: Record<string, unknown> }) =>
          // The LOC/cost read selects only the KLOC scalars (no `artifact`
          // relation / `sourceLoopId`), unlike the cohort read.
          args?.select?.estimatedCost === true &&
          args?.select?.artifact === undefined &&
          args?.select?.sourceLoopId === undefined
            ? [buildSessionDetailRow("sess-a", 700, 300, 2)]
            : []
        ),
      },
    });

    // decodeComponentSlug lowercases the key: subagent::explore
    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      encodeComponentSlug("subagent", "Explore", null)
    );

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("subagent");
    expect(result?.sessions).toBe(1);
    expect(result?.invocations).toBe(5);
    // 1000 LINES / $2 = 500 — a real signal, NOT null / 0.0.
    expect(result?.locPerDollar).toBeCloseTo(500, 6);
  });
});

// ---------------------------------------------------------------------------
// F1 (FEA-3290 / PRD-527, Slice 6) read surface + privacy tests
// ---------------------------------------------------------------------------

describe("getDetailForOrg — F1 resolvedState (FEA-3290)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("surfaces the DB resolvedState verbatim for a resolved component", async () => {
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            buildInventoryRow({ resolvedState: "resolved" }),
          ]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result?.resolvedState).toBe("resolved");
  });

  it("defaults resolvedState to unresolved for a legacy/name-only row (never promoted to resolved)", async () => {
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            buildInventoryRow({ resolvedState: "unresolved" }),
          ]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result?.resolvedState).toBe("unresolved");
  });

  it("AC-5: NEVER collapses inaccessible into missing — an inaccessible device row wins over a missing sibling", async () => {
    // One device could not read the private body (inaccessible); another reports
    // it gone (missing). The org-level fold must surface `inaccessible`, so a
    // permission-denied body is never reported as deleted.
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            id: "ac-missing",
            computeTargetId: "target-missing",
            resolvedState: "missing",
          }),
          buildInventoryRow({
            id: "ac-inaccessible",
            computeTargetId: "target-inaccessible",
            computeTarget: buildComputeTarget("target-inaccessible", "user-2"),
            resolvedState: "inaccessible",
          }),
        ]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result?.resolvedState).toBe("inaccessible");
    expect(result?.resolvedState).not.toBe("missing");
  });

  it("AC-5: a resolved device row wins over inaccessible/missing siblings (org honestly knows the definition)", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            id: "ac-inaccessible",
            computeTargetId: "target-inaccessible",
            resolvedState: "inaccessible",
          }),
          buildInventoryRow({
            id: "ac-resolved",
            computeTargetId: "target-resolved",
            computeTarget: buildComputeTarget("target-resolved", "user-3"),
            resolvedState: "resolved",
          }),
        ]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result?.resolvedState).toBe("resolved");
  });

  it("AC-020: an orphan-only (usage-but-no-inventory) identity is unresolved, never resolved/missing", async () => {
    installDb({
      // No inventory rows → orphan-only path.
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      // But it demonstrably ran (orphan usage rows exist).
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          {
            agentSessionId: "session-orphan",
            invocationCount: 3,
            gitBranch: "",
            componentKind: "skill",
            componentKey: "my-skill",
            session: {
              artifactId: "session-orphan",
              artifact: { organizationId: "org-1" },
            },
          },
        ]),
        groupBy: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result).not.toBeNull();
    expect(result?.resolvedState).toBe("unresolved");
  });
});

describe("getDetailForOrg — F1 version definitionHash (FEA-3290)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("surfaces definitionHash + normalizerContractVersion once a revision is linked", async () => {
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            buildInventoryRow({ contentHash: "hash-current" }),
          ]),
      },
      // The version history read joins each coarse revision to its exact
      // DefinitionVersion; the linked row carries the F1 fingerprint.
      agentComponentVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            contentHash: "hash-current",
            source: "repo",
            format: "md",
            firstSeenAt: new Date("2026-01-05"),
            content: "# body",
            definitionVersion: {
              definitionHash: "fp-exact-abc",
              normalizerContractVersion: 1,
              content: "# body",
            },
          },
        ]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result?.versions).toHaveLength(1);
    const [v] = result?.versions ?? [];
    expect(v?.hash).toBe("hash-current");
    expect(v?.definitionHash).toBe("fp-exact-abc");
    expect(v?.normalizerContractVersion).toBe(1);
  });

  it("union-fallback: an UNLINKED revision still surfaces (no version disappears pre-backfill), definitionHash omitted", async () => {
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            buildInventoryRow({ contentHash: "hash-linked" }),
          ]),
      },
      agentComponentVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            contentHash: "hash-linked",
            source: "repo",
            format: "md",
            firstSeenAt: new Date("2026-01-06"),
            content: "# linked",
            definitionVersion: {
              definitionHash: "fp-linked",
              normalizerContractVersion: 2,
              content: "# linked",
            },
          },
          {
            // Pre-backfill: still-unlinked coarse revision (link is NULL).
            contentHash: "hash-unlinked",
            source: "repo",
            format: "md",
            firstSeenAt: new Date("2026-01-04"),
            content: "# unlinked",
            definitionVersion: null,
          },
        ]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    // BOTH versions present — the unlinked one is not dropped.
    expect(result?.versions).toHaveLength(2);
    const byHash = new Map((result?.versions ?? []).map((v) => [v.hash, v]));
    expect(byHash.get("hash-linked")?.definitionHash).toBe("fp-linked");
    // Unlinked: definitionHash omitted (wire-identical to pre-F1).
    expect(byHash.has("hash-unlinked")).toBe(true);
    expect(byHash.get("hash-unlinked")?.definitionHash).toBeUndefined();
    expect(
      byHash.get("hash-unlinked")?.normalizerContractVersion
    ).toBeUndefined();
  });

  it("AC-019: the version history read is org-scoped (organizationId in the where)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([buildInventoryRow()]),
      },
      agentComponentVersion: { findMany },
    });

    await agentComponentsService.getDetailForOrg("org-1", "skill::my-skill");

    expect(findMany).toHaveBeenCalled();
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.organizationId).toBe("org-1");
  });
});

describe("getDetailForOrg — F1 usage definitionHash + cross-org isolation (FEA-3290)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("resolves usageSession definitionHash via the org-scoped DefinitionVersion link", async () => {
    const linkedSession = "session-linked";
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            sessionUsages: [
              {
                agentSessionId: linkedSession,
                invocationCount: 4,
                gitBranch: "",
                session: {
                  artifactId: linkedSession,
                  artifact: { organizationId: "org-1" },
                },
              },
            ],
          }),
        ]),
      },
      agentComponentSessionUsage: {
        // The winning usage row carries BOTH the legacy hash and the exact
        // `definitionVersionId` — both are read from this ONE row, so they can
        // never describe different revisions/branches ([P1]).
        findMany: vi.fn().mockImplementation((args?: FindManyArgs) =>
          isVersionAttributionRead(args)
            ? Promise.resolve([
                {
                  agentSessionId: linkedSession,
                  componentVersionHash: "hash-legacy",
                  definitionVersionId: "dv-1",
                  lastInvokedAt: new Date("2026-01-10"),
                  id: "u-linked",
                },
              ])
            : Promise.resolve([])
        ),
      },
      definitionVersion: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "dv-1", definitionHash: "fp-usage" }]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    const usage = (result?.usageSessions ?? []).find(
      (u) => u.sessionId === linkedSession
    );
    expect(usage?.versionHash).toBe("hash-legacy");
    expect(usage?.definitionHash).toBe("fp-usage");
  });

  it("[P1] pairs versionHash + definitionHash from ONE row for a multi-branch session (no cross-branch bleed)", async () => {
    // A session that switched branches mid-run persists one usage row per
    // (component, branch). Each branch's row carries its OWN
    // (componentVersionHash, definitionVersionId) pair. The winning row is the
    // most-recently-invoked (`feat/b` here). The buggy two-independent-`_max`
    // implementation would surface `feat/b`'s componentVersionHash (lexicographic
    // max "vh-newer") alongside `feat/a`'s definitionVersionId (whichever id won
    // its own max) — pairing a versionHash with a definitionHash from a DIFFERENT
    // revision. This asserts BOTH come from the single winning row.
    const multiBranch = "session-multi-branch";
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            sessionUsages: [
              {
                agentSessionId: multiBranch,
                invocationCount: 3,
                gitBranch: "feat/a",
                session: {
                  artifactId: multiBranch,
                  artifact: { organizationId: "org-1" },
                },
              },
              {
                agentSessionId: multiBranch,
                invocationCount: 7,
                gitBranch: "feat/b",
                session: {
                  artifactId: multiBranch,
                  artifact: { organizationId: "org-1" },
                },
              },
            ],
          }),
        ]),
      },
      agentComponentSessionUsage: {
        // Ordered newest-first (as the service's orderBy produces): `feat/b`
        // wins. Its pair is (vh-newer, dv-b) → fp-b. `feat/a`'s pair
        // (vh-older, dv-a) → fp-a must NOT bleed into the surfaced result.
        findMany: vi.fn().mockImplementation((args?: FindManyArgs) =>
          isVersionAttributionRead(args)
            ? Promise.resolve([
                {
                  agentSessionId: multiBranch,
                  componentVersionHash: "vh-newer",
                  definitionVersionId: "dv-b",
                  lastInvokedAt: new Date("2026-02-02"),
                  id: "u-b",
                },
                {
                  agentSessionId: multiBranch,
                  componentVersionHash: "vh-older",
                  definitionVersionId: "dv-a",
                  lastInvokedAt: new Date("2026-01-01"),
                  id: "u-a",
                },
              ])
            : Promise.resolve([])
        ),
      },
      definitionVersion: {
        findMany: vi.fn().mockResolvedValue([
          { id: "dv-a", definitionHash: "fp-a" },
          { id: "dv-b", definitionHash: "fp-b" },
        ]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    const usage = (result?.usageSessions ?? []).find(
      (u) => u.sessionId === multiBranch
    );
    // Both attributes come from the winning (`feat/b`) row — consistent pairing.
    expect(usage?.versionHash).toBe("vh-newer");
    expect(usage?.definitionHash).toBe("fp-b");
    // The other branch's fingerprint must NOT surface — that would be the bleed.
    expect(usage?.definitionHash).not.toBe("fp-a");
  });

  it("[P1] definitionHash of a version linked to a DIFFERENT org is never surfaced", async () => {
    // Even if a usage row's `definitionVersionId` somehow references a version
    // owned by another org, the org-scoped DefinitionVersion read returns no
    // match, so `definitionHash` stays null (never a cross-org fingerprint).
    const s = "session-x";
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            sessionUsages: [
              {
                agentSessionId: s,
                invocationCount: 1,
                gitBranch: "",
                session: {
                  artifactId: s,
                  artifact: { organizationId: "org-1" },
                },
              },
            ],
          }),
        ]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockImplementation((args?: FindManyArgs) =>
          isVersionAttributionRead(args)
            ? Promise.resolve([
                {
                  agentSessionId: s,
                  componentVersionHash: "vh",
                  definitionVersionId: "dv-foreign",
                  lastInvokedAt: new Date("2026-01-10"),
                  id: "u-x",
                },
              ])
            : Promise.resolve([])
        ),
      },
      // The org-scoped read excludes the foreign id → empty result.
      definitionVersion: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    const usage = (result?.usageSessions ?? []).find((u) => u.sessionId === s);
    expect(usage?.versionHash).toBe("vh");
    // No same-org DefinitionVersion resolved → definitionHash null, not bled.
    expect(usage?.definitionHash).toBeNull();
  });

  it("AC-019: the DefinitionVersion resolution is org-scoped so a foreign id is never read", async () => {
    const dvFindMany = vi
      .fn()
      .mockResolvedValue([{ id: "dv-1", definitionHash: "fp-usage" }]);
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            sessionUsages: [
              {
                agentSessionId: "s-1",
                invocationCount: 1,
                gitBranch: "",
                session: {
                  artifactId: "s-1",
                  artifact: { organizationId: "org-1" },
                },
              },
            ],
          }),
        ]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockImplementation((args?: FindManyArgs) =>
          isVersionAttributionRead(args)
            ? Promise.resolve([
                {
                  agentSessionId: "s-1",
                  componentVersionHash: "h",
                  definitionVersionId: "dv-1",
                  lastInvokedAt: new Date("2026-01-10"),
                  id: "u-s1",
                },
              ])
            : Promise.resolve([])
        ),
      },
      definitionVersion: { findMany: dvFindMany },
    });

    await agentComponentsService.getDetailForOrg("org-1", "skill::my-skill");

    expect(dvFindMany).toHaveBeenCalled();
    expect(dvFindMany.mock.calls[0][0].where.organizationId).toBe("org-1");
  });
});

describe("getSourceOccurrencesForOrg — F1 provenance read (FEA-3290)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC-019: filters on BOTH organizationId AND definitionVersionId in the where", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({ sourceOccurrence: { findMany } });

    await agentComponentsService.getSourceOccurrencesForOrg("org-1", "dv-99");

    expect(findMany).toHaveBeenCalled();
    const where = findMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe("org-1");
    expect(where.definitionVersionId).toBe("dv-99");
  });

  it("AC-5: surfaces accessState verbatim (inaccessible never collapsed) and NEVER a definition body", async () => {
    installDb({
      sourceOccurrence: {
        findMany: vi.fn().mockResolvedValue([
          {
            occurrenceType: "repository",
            accessState: "inaccessible",
            repoFullName: "acme/private",
            repoPath: "skills/x.md",
            repoCommit: "abc123",
            computeTargetId: null,
            localPath: null,
            packId: null,
            firstSeenAt: new Date("2026-01-01"),
            lastSeenAt: new Date("2026-01-02"),
          },
        ]),
      },
    });

    const result = await agentComponentsService.getSourceOccurrencesForOrg(
      "org-1",
      "dv-1"
    );

    expect(result).toHaveLength(1);
    const [occ] = result;
    expect(occ.accessState).toBe("inaccessible");
    expect(occ.repoFullName).toBe("acme/private");
    // Provenance only — the DTO carries no body/content field at all.
    expect(occ).not.toHaveProperty("content");
    expect(occ).not.toHaveProperty("body");
  });

  it("cross-org: a foreign org returns no occurrences (empty read)", async () => {
    // The mock DB (org-scoped where) returns nothing for a non-owning org.
    installDb({
      sourceOccurrence: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getSourceOccurrencesForOrg(
      "org-2",
      "dv-1"
    );

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ISS-4630: list ⇄ detail usage-total parity (orphan-usage attribution)
//
// The same component MUST report the same invocation/session totals on the list
// row and its detail page. Detail attributes usage by the usage row's OWN
// case-insensitive `(kind, componentKey)` (`fetchDetailOrphanUsage` + the
// FK-linked read scoped to the identity's own inventory rows); before the fix the
// list attributed FK-linked usage by the FK'd inventory row's slug, so usage whose
// own key differed from — or whose inventory row fell outside — the list working
// set silently attributed to the wrong family (or nowhere), and the list row read
// 0 while detail read N. This suite pins both surfaces to the same identity across
// mcp/tool/skill and guards against double-counting. (FEA-4337/ISS-4456 recurrence.)
// ---------------------------------------------------------------------------

describe("agentComponentsService — list ⇄ detail usage parity (ISS-4630)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  for (const kind of ["mcp", "tool", "skill"] as const) {
    it(`used-only ${kind}: list totals == detail totals for null-FK orphan usage`, async () => {
      const key = `${kind}-used-only`;
      const orphanUsage = {
        agentSessionId: `sess-${kind}`,
        componentKind: kind,
        componentKey: key,
        harness: "claude",
        invocationCount: 3,
        firstInvokedAt: new Date("2026-02-01T00:00:00.000Z"),
        lastInvokedAt: new Date("2026-02-02T00:00:00.000Z"),
        componentVersionHash: null,
        definitionVersionId: null,
        gitBranch: "",
      };

      // LIST: no inventory row; the null-FK orphan surfaces as a synthetic row.
      // The SAME rows back both lanes — the list's identity-capped `groupBy`
      // (ISS-4799) and the detail's per-identity row read — so the parity this
      // test asserts is over one population, not two fixtures that happen to
      // agree.
      installDb(
        { agentComponent: { findMany: vi.fn().mockResolvedValue([]) } },
        [orphanUsage]
      );
      const list = await agentComponentsService.listForOrg("org-1", {
        limit: 50,
        offset: 0,
      });
      const listRow = list.items.find((i) => i.name === key);
      expect(listRow?.invocations).toBe(3);
      expect(listRow?.sessions).toBe(1);

      // DETAIL for the same identity: same totals. The detail orphan read is
      // still a row read, so it is served by `findMany`.
      installDb(
        {
          agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
          agentComponentSessionUsage: {
            findMany: vi.fn().mockResolvedValue([orphanUsage]),
          },
        },
        [orphanUsage]
      );
      const detail = await agentComponentsService.getDetailForOrg(
        "org-1",
        encodeComponentSlug(kind, key, null)
      );
      expect(detail?.invocations).toBe(listRow?.invocations);
      expect(detail?.sessions).toBe(listRow?.sessions);
    });
  }

  it("FK usage whose OWN key differs from its inventory row lands on its own family (no double-count)", async () => {
    // Inventory rows: X (installed `update_workstream`) and Y (installed
    // `other_tool`). A usage row is FK-linked to X's id but carries its OWN
    // componentKey `other_tool` (the mismatch the desktop can produce). The list
    // must credit `other_tool` (matching the detail read for `other_tool`), NOT
    // `update_workstream`, and must not double-count.
    const rowX = buildInventoryRow({
      id: "ac-x",
      componentKind: "tool",
      componentKey: "update_workstream",
      name: "update_workstream",
      // The FK-linked usage carries a DIFFERENT own key than this row's.
      sessionUsages: [
        {
          agentSessionId: "sess-mismatch",
          invocationCount: 4,
          usageComponentKind: "tool",
          usageComponentKey: "other_tool",
          session: {
            artifactId: "sess-mismatch",
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    });
    const rowY = buildInventoryRow({
      id: "ac-y",
      componentKind: "tool",
      componentKey: "other_tool",
      name: "other_tool",
      sessionUsages: [],
    });

    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([rowX, rowY]) },
    });
    const list = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });
    const updateRow = list.items.find((i) => i.name === "update_workstream");
    const otherRow = list.items.find((i) => i.name === "other_tool");
    // The mismatched usage credited `other_tool`, its OWN identity.
    expect(otherRow?.invocations).toBe(4);
    expect(otherRow?.sessions).toBe(1);
    // `update_workstream` (the FK'd inventory row) did NOT absorb the mismatched
    // usage — no double-count / no mis-attribution.
    expect(updateRow?.invocations ?? 0).toBe(0);
  });
});
