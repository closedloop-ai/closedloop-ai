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
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  findOwnedById: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: mocks.findOwnedById,
  },
}));

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
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  uninstalledAt?: string | null;
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
  };
}

function installOwnedTarget() {
  mocks.findOwnedById.mockResolvedValue({ id: COMPUTE_TARGET_ID });
  mocks.upsert.mockResolvedValue({});
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({ agentComponent: { upsert: mocks.upsert } })
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
});
