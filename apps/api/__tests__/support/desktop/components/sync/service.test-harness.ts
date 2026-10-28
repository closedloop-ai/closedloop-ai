// Fixtures and mock wiring shared by the desktop components-sync service
// suites. Imported statically AFTER the vi.mock declarations, so it may
// import app code; the mock bag itself lives in service.test-mocks.ts.
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { mocks } from "@/__tests__/support/desktop/components/sync/service.test-mocks";

export const ORG_ID = "org-sync-1";
export const USER_ID = "user-sync-1";
export const CLERK_USER_ID = "clerk-sync-1";
export const COMPUTE_TARGET_ID = "target-sync-1";

export type SyncedComponentInput = {
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

export function buildComponent(
  overrides: Partial<SyncedComponentInput> = {}
): SyncedComponentInput {
  return {
    externalId: "skill::my-skill",
    componentKind: AgentComponentKind.Skill,
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

export function buildPayload(components: SyncedComponentInput[]) {
  return {
    schemaVersion: 1 as const,
    batchId: "11111111-1111-4111-8111-111111111111",
    syncMode: "incremental" as const,
    componentCount: components.length,
    components,
  };
}

export function buildInput(components: SyncedComponentInput[]) {
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

// Row id counter so each upserted component gets a distinct, deterministic id
// in the mock's echoed-back row (the projection carries entity_id = this id).
let upsertRowSeq = 0;

/** Echo Prisma's upsert return so FEA-4011 projections see the written row. */
export function echoUpsertedRow(args: {
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
    contentHash: (create.contentHash as string | null) ?? null,
    updatedAt: new Date(
      key.externalComponentId === "skill::newer"
        ? "2026-02-02T00:00:00.000Z"
        : "2026-02-01T00:00:00.000Z"
    ),
    uninstalledAt: (create.uninstalledAt as Date | null) ?? null,
  };
}

export function installOwnedTarget() {
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
  // ISS-8285: the stored-identity probe, reached ONLY when a component's
  // identity was actually projected. Defaults to "no legacy row", so an
  // in-budget component never touches it and the probe stays invisible to every
  // suite that does not opt in.
  mocks.componentFindUnique.mockResolvedValue(null);
  // ISS-12552: each component writes in its own withDb.tx, so the
  // transaction runs against the same double.
  const db = {
    agentComponent: {
      findMany: mocks.componentFindMany,
      findUnique: mocks.componentFindUnique,
      upsert: mocks.upsert,
    },
    agentComponentVersion: {
      upsert: mocks.versionUpsert,
      update: mocks.versionUpdate,
      createMany: mocks.versionCreateMany,
      updateMany: mocks.versionUpdateMany,
    },
  };
  const run = (callback: (db: unknown) => unknown) => callback(db);
  mocks.withDb.mockImplementation(run);
  mocks.withDb.tx.mockImplementation(run);
}
