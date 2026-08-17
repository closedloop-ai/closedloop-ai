/**
 * FEA-2923 (T-10.7): Unit tests for desktopComponentsSyncService.
 *
 * The route test mocks this service wholesale, so its internals — the ownership
 * gate, the upsert where/create/update shape, ISO date parsing, and the
 * org-scoping invariant on the update payload — are exercised only here.
 *
 * Covers:
 *  - sync() returns Result.err("forbidden") when the compute target is not owned.
 *  - upsert is called with the correct where/create/update shape.
 *  - parseDateField handles valid ISO / null / undefined / absent fields.
 *  - the update payload never carries organizationId or computeTargetId.
 *  - one upsert per component, each keyed by
 *    (computeTargetId, componentKind, externalComponentId).
 */
import { Status } from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  findOwnedById: vi.fn(),
  upsert: vi.fn(),
  versionUpsert: vi.fn(),
  versionUpdate: vi.fn(),
  versionCreateMany: vi.fn(),
  versionUpdateMany: vi.fn(),
  registerDefinitionVersion: vi.fn(),
  relinkActiveForComputeTarget: vi.fn(),
  componentFindMany: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  indexManyAfterCommit: vi.fn(),
  removeManyAfterCommit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  // Enum runtime values referenced by the sync service (FEA-3290).
  SourceAccessState: { accessible: "accessible", inaccessible: "inaccessible" },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: mocks.findOwnedById,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: mocks.logInfo, warn: mocks.logWarn },
}));

vi.mock("@/app/agent-sessions/service/component-invocations", () => ({
  agentComponentInvocationsService: {
    relinkActiveForComputeTarget: mocks.relinkActiveForComputeTarget,
  },
}));

// FEA-3290 (F1, Slice 3): the sync writer delegates the exact-version registry
// write to this service. Mocked here so the sync-lane unit test asserts the
// wiring (called with the right args, link stamped) without a DB.
vi.mock("@/app/definition-registry/service", () => ({
  registerDefinitionVersion: mocks.registerDefinitionVersion,
}));

// FEA-4011 Slice A: keep the real `agentComponentProjection` mapper (so the test
// asserts the exact projection input) but stub the fail-open index hooks so the
// sync-lane unit test never touches a DB / waitUntil.
vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/search/search-index-service")>();
  return {
    ...actual,
    searchIndexService: {
      indexManyAfterCommit: mocks.indexManyAfterCommit,
      removeManyAfterCommit: mocks.removeManyAfterCommit,
    },
  };
});

import { agentComponentProjection } from "@/app/search/search-index-service";
import { desktopComponentsSyncService } from "./service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "org-sync-1";
const USER_ID = "user-sync-1";
const CLERK_USER_ID = "clerk-sync-1";
const COMPUTE_TARGET_ID = "target-sync-1";

type SyncedComponentInput = {
  externalId: string;
  componentKind: string;
  harness?: string | null;
  name?: string | null;
  componentKey?: string | null;
  version?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
  installPath?: string | null;
  packId?: string | null;
  scope?: string | null;
  projectPath?: string | null;
  metadata?: Record<string, unknown> | null;
  content?: string | null;
  contentHash?: string | null;
  resolvedState?: "resolved" | "unresolved" | "inaccessible" | "missing";
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  uninstalledAt?: string | null;
  // FEA-3290 (F1, Slice 3) additive source-evidence fields.
  accessState?: "accessible" | "inaccessible" | null;
  scannedAt?: string | null;
};

function buildComponent(
  overrides: Partial<SyncedComponentInput> = {}
): SyncedComponentInput {
  return {
    externalId: "skill::my-skill",
    componentKind: "skill",
    harness: "claude",
    name: "My Skill",
    componentKey: "my-skill",
    version: null,
    description: null,
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    metadata: null,
    content: null,
    contentHash: null,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-10T00:00:00.000Z",
    uninstalledAt: null,
    ...overrides,
  };
}

function buildPayload(components: SyncedComponentInput[]) {
  return {
    schemaVersion: 1 as const,
    batchId: "11111111-1111-4111-8111-111111111111",
    syncMode: "incremental" as const,
    componentCount: components.length,
    components,
  };
}

function buildInput(components: SyncedComponentInput[]) {
  return {
    clerkUserId: CLERK_USER_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    organizationId: ORG_ID,
    // `payload` is typed as DesktopAgentComponentsPayload in the service; the
    // fixture shape matches it structurally.
    payload: buildPayload(components) as never,
    userId: USER_ID,
    // FEA-4169: inject the org-policy gate as allowed so the write-path tests
    // exercise persistence; the DB-backed default would need withDb.organization
    // (not part of this unit's fake db). The policy-off case is covered below.
    isOrgPolicyEnabled: async () => true,
  };
}

// Row id counter so each upserted component gets a distinct, deterministic id
// in the mock's echoed-back row (the projection carries entity_id = this id).
let upsertRowSeq = 0;

/**
 * Echo the upserted AgentComponent row back from its create/update args so the
 * FEA-4011 post-commit projection can read `id`/`name`/…/`uninstalledAt` off it,
 * exactly as Prisma's `upsert` return would. `uninstalledAt` follows the
 * create/update payload so the index-vs-remove branch is faithful.
 */
function echoUpsertedRow(args: {
  where: {
    computeTargetId_componentKind_externalComponentId: {
      componentKind: string;
      externalComponentId: string;
    };
  };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}) {
  upsertRowSeq += 1;
  const key = args.where.computeTargetId_componentKind_externalComponentId;
  const create = args.create;
  return {
    id: `ac-${upsertRowSeq}`,
    organizationId: ORG_ID,
    componentKind: key.componentKind,
    externalComponentId: key.externalComponentId,
    name: (create.name as string | null) ?? null,
    componentKey: (create.componentKey as string | null) ?? null,
    description: (create.description as string | null) ?? null,
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    uninstalledAt: (create.uninstalledAt as Date | null) ?? null,
  };
}

function installOwnedTarget() {
  upsertRowSeq = 0;
  mocks.findOwnedById.mockResolvedValue({ id: COMPUTE_TARGET_ID });
  mocks.upsert.mockImplementation((args) =>
    Promise.resolve(echoUpsertedRow(args))
  );
  mocks.versionUpsert.mockResolvedValue({});
  mocks.versionCreateMany.mockResolvedValue({ count: 0 });
  mocks.versionUpdateMany.mockResolvedValue({ count: 0 });
  mocks.versionUpdate.mockResolvedValue({});
  mocks.registerDefinitionVersion.mockResolvedValue("definition-version-1");
  mocks.relinkActiveForComputeTarget.mockResolvedValue(0);
  // ISS-4778: the skew guard reads the target's already-stored RESOLVED skills.
  // Default to none, so the guard is a no-op unless a test opts in.
  mocks.componentFindMany.mockResolvedValue([]);
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      agentComponent: {
        findMany: mocks.componentFindMany,
        upsert: mocks.upsert,
      },
      agentComponentVersion: {
        upsert: mocks.versionUpsert,
        update: mocks.versionUpdate,
        createMany: mocks.versionCreateMany,
        updateMany: mocks.versionUpdateMany,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("desktopComponentsSyncService.sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Result.err(Status.Forbidden) when the compute target is not owned (gate before any write)", async () => {
    mocks.findOwnedById.mockResolvedValue(null);

    const result = await desktopComponentsSyncService.sync(
      buildInput([buildComponent()])
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Numeric 403 — matches the route's `result.error === Status.Forbidden`
      // check and the reference agent-sessions sync service.
      expect(result.error).toBe(Status.Forbidden);
    }
    // No DB access should occur when the ownership gate fails.
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.relinkActiveForComputeTarget).not.toHaveBeenCalled();
  });

  it("passes the ownership gate args (id, org, user, clerkUser) straight through", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(buildInput([buildComponent()]));

    expect(mocks.findOwnedById).toHaveBeenCalledWith(
      COMPUTE_TARGET_ID,
      ORG_ID,
      USER_ID,
      CLERK_USER_ID
    );
  });

  it("FEA-4169: denies (Status.Forbidden) when the org session-sync policy is OFF, without any write", async () => {
    installOwnedTarget();
    const isOrgPolicyEnabled = vi.fn(async () => false);

    const result = await desktopComponentsSyncService.sync({
      ...buildInput([buildComponent()]),
      isOrgPolicyEnabled,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(Status.Forbidden);
    }
    // Gate is org-scoped and enforced BEFORE any DB write.
    expect(isOrgPolicyEnabled).toHaveBeenCalledWith(ORG_ID);
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.relinkActiveForComputeTarget).not.toHaveBeenCalled();
  });

  it("upserts each component keyed by (computeTargetId, componentKind, externalComponentId)", async () => {
    installOwnedTarget();

    const result = await desktopComponentsSyncService.sync(
      buildInput([buildComponent()])
    );

    expect(result.ok).toBe(true);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const args = mocks.upsert.mock.calls[0]?.[0];
    expect(args?.where).toEqual({
      computeTargetId_componentKind_externalComponentId: {
        computeTargetId: COMPUTE_TARGET_ID,
        componentKind: "skill",
        externalComponentId: "skill::my-skill",
      },
    });
  });

  it("maps the create payload fields and parses ISO dates into Date instances", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(buildInput([buildComponent()]));

    const create = mocks.upsert.mock.calls[0]?.[0]?.create;
    expect(create).toMatchObject({
      organizationId: ORG_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      componentKind: "skill",
      externalComponentId: "skill::my-skill",
      harness: "claude",
      name: "My Skill",
      componentKey: "my-skill",
    });
    expect(create?.firstSeenAt).toBeInstanceOf(Date);
    expect(create?.firstSeenAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(create?.lastSeenAt).toBeInstanceOf(Date);
    // Absent/null dates parse to null.
    expect(create?.uninstalledAt).toBeNull();
  });

  it("AC-007: create defaults resolvedState to 'unresolved'; update omits it when the desktop does not send one", async () => {
    installOwnedTarget();

    // A label-minted component that carries no resolvedState (stale desktop, or
    // a brand-new label-only row) → create defaults to unresolved; update is a
    // no-op (undefined) so a resolved cloud row is never demoted.
    await desktopComponentsSyncService.sync(buildInput([buildComponent()]));
    const call = mocks.upsert.mock.calls[0]?.[0];
    expect(call?.create?.resolvedState).toBe("unresolved");
    expect(call?.update?.resolvedState).toBeUndefined();
  });

  it("AC-007: a desktop-sent resolvedState is written on both create and update", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([buildComponent({ resolvedState: "resolved" })])
    );
    const call = mocks.upsert.mock.calls[0]?.[0];
    expect(call?.create?.resolvedState).toBe("resolved");
    expect(call?.update?.resolvedState).toBe("resolved");
  });

  it("parses a null/undefined date field to null (parseDateField)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([buildComponent({ firstSeenAt: null, lastSeenAt: undefined })])
    );

    const create = mocks.upsert.mock.calls[0]?.[0]?.create;
    expect(create?.firstSeenAt).toBeNull();
    expect(create?.lastSeenAt).toBeNull();
  });

  it("never puts organizationId or computeTargetId in the update payload (identity is fixed at create)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(buildInput([buildComponent()]));

    const update = mocks.upsert.mock.calls[0]?.[0]?.update;
    expect(update).toBeDefined();
    expect(update).not.toHaveProperty("organizationId");
    expect(update).not.toHaveProperty("computeTargetId");
    // But it does refresh mutable fields like lastSeenAt.
    expect(update?.lastSeenAt).toBeInstanceOf(Date);
  });

  it("leaves uninstalledAt untouched on the update path when the field is omitted (preserves a tombstone)", async () => {
    installOwnedTarget();

    // An older Desktop omits `uninstalledAt`. The update must be a no-op
    // (undefined), NOT a clear (null) — clearing would resurrect a removed
    // component in search on the next re-index. (FEA-4011 review.)
    const { uninstalledAt: _omit, ...withoutUninstalled } = buildComponent();
    await desktopComponentsSyncService.sync(
      buildInput([withoutUninstalled as never])
    );

    const update = mocks.upsert.mock.calls[0]?.[0]?.update;
    expect(update?.uninstalledAt).toBeUndefined();
  });

  it("clears uninstalledAt on the update path only for an explicit null", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([buildComponent({ uninstalledAt: null })])
    );

    const update = mocks.upsert.mock.calls[0]?.[0]?.update;
    expect(update?.uninstalledAt).toBeNull();
  });

  it("sets uninstalledAt on the update path for an explicit date (tombstone)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({ uninstalledAt: "2026-03-01T00:00:00.000Z" }),
      ])
    );

    const update = mocks.upsert.mock.calls[0]?.[0]?.update;
    expect(update?.uninstalledAt).toEqual(new Date("2026-03-01T00:00:00.000Z"));
  });

  it("issues one upsert per component in the batch", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({ externalId: "skill::a", componentKey: "a" }),
        buildComponent({
          externalId: "command::b",
          componentKind: "command",
          componentKey: "b",
        }),
        buildComponent({
          externalId: "mcp::c",
          componentKind: "mcp",
          componentKey: "c",
        }),
      ])
    );

    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    const kinds = mocks.upsert.mock.calls.map(
      (call) =>
        call[0]?.where?.computeTargetId_componentKind_externalComponentId
          ?.componentKind
    );
    expect(kinds).toEqual(["skill", "command", "mcp"]);
  });

  // FEA-2923 (Gap A): cloud-authored agents are backfilled onto a synthetic
  // per-org sentinel compute target. Desktop sync must keep upserting onto the
  // real, ownership-verified device target — never the sentinel — so its rows
  // are isolated from the backfilled cloud rows by a distinct computeTargetId
  // in the (computeTargetId, componentKind, externalComponentId) upsert key.
  it("keys every upsert on the ownership-verified device target, isolating it from cloud-sentinel rows", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        // A subagent whose external id would collide with a backfilled cloud
        // agent IF they shared a compute target — they must not.
        buildComponent({
          externalId: "cloud:agent:legacy-1",
          componentKind: "subagent",
          componentKey: "reviewer",
        }),
      ])
    );

    const key =
      mocks.upsert.mock.calls[0]?.[0]?.where
        ?.computeTargetId_componentKind_externalComponentId;
    // Device upsert uses the real device target id from the authenticated
    // request, not any sentinel — so a matching external id lands on a
    // different row than the cloud-owned one.
    expect(key?.computeTargetId).toBe(COMPUTE_TARGET_ID);
    expect(mocks.upsert.mock.calls[0]?.[0]?.create?.computeTargetId).toBe(
      COMPUTE_TARGET_ID
    );
  });

  // FEA-3321: the sync payload carries no `format`, so the version row's format
  // must be inferred from the already-synced `installPath` via the shared
  // `inferComponentFormat` SSOT. Leaving it null made the read path's
  // `format ?? "md"` fallback label every non-markdown definition as Markdown on
  // the web Prompt panel, disagreeing with desktop.
  it("infers the version row's format from installPath (real extension wins)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          componentKind: "hook",
          installPath: ".claude/hooks/guard.sh",
          content: "#!/bin/bash\necho hi",
          contentHash: "hash-hook-1",
        }),
      ])
    );

    expect(mocks.versionUpsert.mock.calls[0]?.[0]?.create?.format).toBe("sh");
  });

  it("falls back to the kind's conventional format when installPath carries no extension", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          componentKind: "mcp",
          installPath: null,
          content: '{"mcpServers":{}}',
          contentHash: "hash-mcp-1",
        }),
      ])
    );

    expect(mocks.versionUpsert.mock.calls[0]?.[0]?.create?.format).toBe("json");
  });

  // The revision identity includes its content hash, so a row's format is fixed
  // at first observation — the update path only refreshes lastSeenAt, mirroring
  // the desktop collector's `ON CONFLICT DO UPDATE SET last_seen_at`.
  it("sets format on create only, never on the version update payload", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          content: "# My Skill",
          contentHash: "hash-skill-1",
        }),
      ])
    );

    // ISS-4662: the update payload is now EMPTY entirely — the observation
    // window is widened monotonically after the upsert so a stale observation
    // from one desktop cannot move an org-global row's window backward.
    expect(mocks.versionUpsert.mock.calls[0]?.[0]?.update).not.toHaveProperty(
      "format"
    );
    expect(mocks.versionUpsert.mock.calls[0]?.[0]?.update).toEqual({});
  });

  // Regression: a large inventory must not fan out one pooled pg connection per
  // component in a single request. Unbounded `Promise.all` over the whole
  // inventory drained the pool and starved every other endpoint ("timeout
  // exceeded when trying to connect"). The fan-out is now bounded, so peak
  // in-flight upserts stay capped regardless of inventory size.
  it("bounds concurrent upserts so a large inventory can't exhaust the connection pool", async () => {
    mocks.findOwnedById.mockResolvedValue({ id: COMPUTE_TARGET_ID });

    let inFlight = 0;
    let peakInFlight = 0;
    mocks.upsert.mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Yield twice so overlapping upserts within a batch are observed as
      // concurrent before any of them settles.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return {};
    });
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ agentComponent: { upsert: mocks.upsert } })
    );

    // Sized off the bound, not hardcoded: the payload must always exceed
    // DB_FANOUT_MAX_CONCURRENCY or the assertion below would hold against an
    // unbounded fan-out too.
    const componentCount = DB_FANOUT_MAX_CONCURRENCY * 2 + 2;
    const components = Array.from({ length: componentCount }, (_, i) =>
      buildComponent({ externalId: `skill::c${i}`, componentKey: `c${i}` })
    );

    await desktopComponentsSyncService.sync(buildInput(components));

    // Every component is still upserted...
    expect(mocks.upsert).toHaveBeenCalledTimes(componentCount);
    // ...but never more than DB_FANOUT_MAX_CONCURRENCY at once. An unbounded
    // fan-out would peak at componentCount.
    expect(peakInFlight).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
  });

  // -------------------------------------------------------------------------
  // FEA-3290 (F1, Slice 3): sync-lane registers the exact DefinitionVersion +
  // occurrence and stamps definitionVersionId onto the coarse version row.
  // -------------------------------------------------------------------------

  it("registers a DefinitionVersion for a content-bearing component and stamps definitionVersionId onto the version row", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          content: "# My Skill",
          contentHash: "hash-skill-1",
          installPath: ".claude/skills/my-skill/SKILL.md",
          scannedAt: "2026-01-11T00:00:00.000Z",
        }),
      ])
    );

    // The registry writer was called with the authenticated org + target, the
    // whole-file content, and the scan timestamp (never from the payload's org).
    expect(mocks.registerDefinitionVersion).toHaveBeenCalledTimes(1);
    const [tx, regArgs] = mocks.registerDefinitionVersion.mock.calls[0] ?? [];
    expect(tx).toBeDefined(); // ran inside the withDb tx client
    expect(regArgs).toMatchObject({
      organizationId: ORG_ID,
      componentKind: "skill",
      content: "# My Skill",
      computeTargetId: COMPUTE_TARGET_ID,
      installPath: ".claude/skills/my-skill/SKILL.md",
      accessState: "accessible",
    });
    expect(regArgs?.observedAt).toBeInstanceOf(Date);
    expect(regArgs?.observedAt?.toISOString()).toBe("2026-01-11T00:00:00.000Z");

    // The returned id is stamped onto the coarse AgentComponentVersion row via
    // its natural key (org-scoped, "" source sentinel, componentKey fallback).
    expect(mocks.versionUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = mocks.versionUpdate.mock.calls[0]?.[0];
    expect(updateArgs?.where).toEqual({
      organizationId_componentKind_componentKey_source_contentHash: {
        organizationId: ORG_ID,
        componentKind: "skill",
        componentKey: "my-skill",
        source: "",
        contentHash: "hash-skill-1",
      },
    });
    expect(updateArgs?.data).toEqual({
      definitionVersionId: "definition-version-1",
    });
  });

  it("forwards an inaccessible accessState from the payload to the registry writer (AC-5)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          content: "# Private",
          contentHash: "hash-priv-1",
          accessState: "inaccessible",
        }),
      ])
    );

    expect(mocks.registerDefinitionVersion.mock.calls[0]?.[1]).toMatchObject({
      accessState: "inaccessible",
    });
  });

  // AC-018 / older-client contract: a component without content (older desktop,
  // or an event-driven label with no definition) must NOT register a version and
  // must NOT stamp a link — the inventory row stays unresolved (Slice 4).
  it("does NOT register a version or stamp a link for a content-less component (older client stays unresolved)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([buildComponent({ content: null, contentHash: null })])
    );

    expect(mocks.registerDefinitionVersion).not.toHaveBeenCalled();
    expect(mocks.versionUpdate).not.toHaveBeenCalled();
    // The component existence row is still upserted (inventory is unaffected).
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("keys the stamp on componentKey, falling back to externalId when componentKey is absent", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "skill::fallback",
          componentKey: null,
          content: "# Fallback",
          contentHash: "hash-fallback-1",
        }),
      ])
    );

    const key =
      mocks.versionUpdate.mock.calls[0]?.[0]?.where
        ?.organizationId_componentKind_componentKey_source_contentHash;
    expect(key?.componentKey).toBe("skill::fallback");
  });

  it("runs one set-based late-arrival invocation relink after inventory is durable", async () => {
    installOwnedTarget();

    const result = await desktopComponentsSyncService.sync(
      buildInput([buildComponent()])
    );

    expect(result.ok).toBe(true);
    expect(mocks.relinkActiveForComputeTarget).toHaveBeenCalledTimes(1);
    expect(mocks.relinkActiveForComputeTarget).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      computeTargetId: COMPUTE_TARGET_ID,
    });
  });

  it("keeps authoritative inventory sync successful when late relink fails", async () => {
    installOwnedTarget();
    mocks.relinkActiveForComputeTarget.mockRejectedValueOnce(
      new Error("relink unavailable")
    );

    const result = await desktopComponentsSyncService.sync(
      buildInput([buildComponent()])
    );

    expect(result).toEqual({ ok: true, value: { synced: true } });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "Late agent component invocation relink failed",
      expect.objectContaining({
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
      })
    );
  });

  // -------------------------------------------------------------------------
  // FEA-4011 Slice A: post-commit, fail-open search projection sync.
  // -------------------------------------------------------------------------

  it("indexes each installed component into unified search after the upsert commits", async () => {
    installOwnedTarget();

    const result = await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "skill::my-skill",
          componentKind: "skill",
          name: "My Skill",
          componentKey: "my-skill",
          description: "does a thing",
        }),
      ])
    );

    expect(result.ok).toBe(true);
    // Asserted AFTER the sync ran, from the test body — one BATCH upsert
    // carrying the upserted row's id + the exact mapper output.
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledTimes(1);
    expect(mocks.removeManyAfterCommit).toHaveBeenCalledWith([]);
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledWith([
      agentComponentProjection({
        id: "ac-1",
        organizationId: ORG_ID,
        componentKind: "skill",
        name: "My Skill",
        componentKey: "my-skill",
        externalComponentId: "skill::my-skill",
        description: "does a thing",
        updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ]);
  });

  it("removes an uninstalled component from unified search instead of indexing it", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "skill::gone",
          componentKind: "skill",
          uninstalledAt: "2026-02-02T00:00:00.000Z",
        }),
      ])
    );

    expect(mocks.indexManyAfterCommit).toHaveBeenCalledWith([]);
    expect(mocks.removeManyAfterCommit).toHaveBeenCalledWith([
      {
        organizationId: ORG_ID,
        entityType: SearchEntityType.AgentComponent,
        entityId: "ac-1",
      },
    ]);
  });

  it("indexes only the installed components in a mixed install/uninstall batch", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "skill::a",
          componentKey: "a",
          name: "a",
        }),
        buildComponent({
          externalId: "skill::b",
          componentKey: "b",
          name: "b",
          uninstalledAt: "2026-02-02T00:00:00.000Z",
        }),
      ])
    );

    // One BATCH index carrying the live "a" and one BATCH remove carrying the
    // uninstalled "b". The fail-open guarantee of the hook itself is covered in
    // the index-service test — production swallows its own errors.
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledTimes(1);
    expect(mocks.removeManyAfterCommit).toHaveBeenCalledTimes(1);
    const indexedBatch = mocks.indexManyAfterCommit.mock.calls[0][0] as Array<{
      title: string;
    }>;
    const removedBatch = mocks.removeManyAfterCommit.mock.calls[0][0] as Array<{
      entityType: string;
    }>;
    // The live "a" is indexed (distinct slug from "b"), the uninstalled "b" is
    // removed — one entry each, regardless of fan-out ordering.
    expect(indexedBatch).toHaveLength(1);
    expect(indexedBatch[0].title).toBe("a");
    expect(removedBatch).toHaveLength(1);
    expect(removedBatch[0].entityType).toBe(SearchEntityType.AgentComponent);
  });
  // -------------------------------------------------------------------------
  // ISS-4778 — skew guard: a stale Desktop still emitting the phantom `command`
  // component for a slash-invoked SKILL must not re-pollute the inventory after
  // the one-time backfill migration.
  // -------------------------------------------------------------------------

  it("drops a skewed client's phantom command when a resolved skill sibling is already stored", async () => {
    installOwnedTarget();
    mocks.componentFindMany.mockResolvedValue([{ componentKey: "review" }]);

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "/review",
          componentKind: "command",
          componentKey: "/review",
          name: "/review",
          content: null,
          resolvedState: "unresolved",
        }),
      ])
    );

    expect(mocks.componentFindMany).toHaveBeenCalledWith({
      where: {
        computeTargetId: COMPUTE_TARGET_ID,
        componentKind: "skill",
        resolvedState: "resolved",
        componentKey: { in: ["review"] },
      },
      select: { componentKey: true },
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledWith([]);
  });

  it("drops the phantom command when its resolved skill sibling rides in the same payload", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "skill::review",
          componentKind: "skill",
          componentKey: "review",
          name: "review",
          resolvedState: "resolved",
        }),
        buildComponent({
          externalId: "/review",
          componentKind: "command",
          componentKey: "/review",
          name: "/review",
          resolvedState: "unresolved",
        }),
      ])
    );

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(
      mocks.upsert.mock.calls[0][0].where
        .computeTargetId_componentKind_externalComponentId.externalComponentId
    ).toBe("skill::review");
  });

  it("ingests a genuine command with no skill sibling untouched", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "/deploy",
          componentKind: "command",
          componentKey: "/deploy",
          name: "/deploy",
          resolvedState: "unresolved",
        }),
      ])
    );

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(
      mocks.upsert.mock.calls[0][0].where
        .computeTargetId_componentKind_externalComponentId.externalComponentId
    ).toBe("/deploy");
  });

  it("skips the guard's lookup entirely when the payload carries no slash-keyed unresolved command", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(buildInput([buildComponent()]));

    expect(mocks.componentFindMany).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });
});
