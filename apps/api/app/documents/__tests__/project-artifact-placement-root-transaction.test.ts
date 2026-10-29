import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  type PlaceProjectArtifactsRequest,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { Status } from "@repo/api/src/types/result";
import { Prisma, type TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  lockProjectRank: vi.fn(),
  lockPlacementReceipt: vi.fn(),
  readPlacementReceipt: vi.fn(),
  authorizePlacementDomain: vi.fn(),
  readPlacementState: vi.fn(),
  applyPlacementPlan: vi.fn(),
  recordPlacementActivity: vi.fn(),
  captureMovedProjectChanges: vi.fn(),
  artifactFindMany: vi.fn(),
  artifactUpdateMany: vi.fn(),
  tagCount: vi.fn(),
  tagDeleteMany: vi.fn(),
  tagCreateMany: vi.fn(),
  captureBatchStatusChange: vi.fn(),
  captureBatchPriorityChange: vi.fn(),
  emitPlacementRootFieldEffects: vi.fn(),
}));

vi.mock("../project-artifact-placement-root-fields", async () => {
  const actual = await vi.importActual<
    typeof import("../project-artifact-placement-root-fields")
  >("../project-artifact-placement-root-fields");
  return {
    ...actual,
    emitPlacementRootFieldEffects: mocks.emitPlacementRootFieldEffects,
  };
});

vi.mock("@/lib/artifact-activity-capture", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/artifact-activity-capture")
  >("@/lib/artifact-activity-capture");
  return {
    ...actual,
    captureBatchStatusChange: mocks.captureBatchStatusChange,
    captureBatchPriorityChange: mocks.captureBatchPriorityChange,
  };
});

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  return { ...actual, withDb: mocks.withDb };
});
vi.mock("../document-sort-order", async () => {
  const actual = await vi.importActual<typeof import("../document-sort-order")>(
    "../document-sort-order"
  );
  return { ...actual, lockProjectRank: mocks.lockProjectRank };
});
vi.mock("../project-artifact-placement-receipt", async () => {
  const actual = await vi.importActual<
    typeof import("../project-artifact-placement-receipt")
  >("../project-artifact-placement-receipt");
  return {
    ...actual,
    lockPlacementReceipt: mocks.lockPlacementReceipt,
    readPlacementReceipt: mocks.readPlacementReceipt,
  };
});
vi.mock("../project-artifact-placement-service-support", async () => {
  const actual = await vi.importActual<
    typeof import("../project-artifact-placement-service-support")
  >("../project-artifact-placement-service-support");
  return {
    ...actual,
    authorizePlacementDomain: mocks.authorizePlacementDomain,
    readPlacementState: mocks.readPlacementState,
  };
});
vi.mock("../project-artifact-placement-persistence", async () => {
  const actual = await vi.importActual<
    typeof import("../project-artifact-placement-persistence")
  >("../project-artifact-placement-persistence");
  return { ...actual, applyPlacementPlan: mocks.applyPlacementPlan };
});
vi.mock("../project-artifact-placement-activity", () => ({
  recordPlacementActivity: mocks.recordPlacementActivity,
  captureMovedProjectChanges: mocks.captureMovedProjectChanges,
}));

import { projectArtifactPlacementService } from "../project-artifact-placement-service";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const SOURCE_ID = "00000000-0000-4000-8000-000000000003";
const TARGET_ID = "00000000-0000-4000-8000-000000000004";
const TAG_ID = "00000000-0000-4000-8000-000000000005";
const ACTOR_ID = "00000000-0000-4000-8000-000000000006";
const CREATED_AT = new Date("2026-10-20T12:00:00.000Z");

let persisted: { order: string[]; status: string; tagIds: string[] };

function state() {
  const artifacts = persisted.order.map((id, index) => ({
    id,
    projectId: PROJECT_ID,
    sortOrder: index * 1024,
    createdAt: CREATED_AT,
  }));
  return {
    artifacts,
    artifactsById: new Map(artifacts.map((row) => [row.id, row])),
    canonicalParents: new Map(),
    allParentIds: new Map(),
    incomingProduces: new Map(),
    parentProjectIds: new Map(artifacts.map((row) => [row.id, PROJECT_ID])),
    childrenByParent: new Map(),
    projectVersions: {
      [PROJECT_ID]: persisted.order[0] === SOURCE_ID ? "v1" : "v2",
    },
  };
}

function client(): TransactionClient {
  return {
    artifact: {
      findMany: mocks.artifactFindMany,
      updateMany: mocks.artifactUpdateMany,
    },
    tag: { count: mocks.tagCount },
    tagArtifact: {
      deleteMany: mocks.tagDeleteMany,
      createMany: mocks.tagCreateMany,
    },
  } as unknown as TransactionClient;
}

function request(): PlaceProjectArtifactsRequest {
  return {
    kind: ProjectArtifactPlacementKind.Place,
    sourceArtifactIds: [SOURCE_ID],
    destinationProjectId: PROJECT_ID,
    position: ProjectArtifactPlacementPosition.After,
    targetArtifactId: TARGET_ID,
    rootUpdates: { status: IssueStatus.InProgress, tagIds: [TAG_ID] },
    expectedProjectVersions: { [PROJECT_ID]: "v1" },
    idempotencyKey: "root-fields-transaction",
    source: ProjectArtifactPlacementSource.Pointer,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  persisted = {
    order: [SOURCE_ID, TARGET_ID],
    status: IssueStatus.Todo,
    tagIds: [],
  };
  const tx = client();
  mocks.withDb.tx.mockImplementation(
    async (run: (client: TransactionClient) => Promise<unknown>) => {
      const prior = structuredClone(persisted);
      try {
        return await run(tx);
      } catch (error) {
        persisted = prior;
        throw error;
      }
    }
  );
  mocks.readPlacementReceipt.mockResolvedValue(null);
  mocks.authorizePlacementDomain.mockResolvedValue({
    authorized: true,
    canWrite: true,
  });
  mocks.readPlacementState.mockImplementation(async () => state());
  mocks.applyPlacementPlan.mockImplementation(
    (_tx: unknown, _organizationId: string, plan: { mode: string }) => {
      persisted.order =
        plan.mode === "restore"
          ? [SOURCE_ID, TARGET_ID]
          : [TARGET_ID, SOURCE_ID];
    }
  );
  mocks.artifactFindMany.mockImplementation(
    async ({ select }: { select: { subtype?: boolean } }) =>
      select.subtype
        ? [
            {
              id: SOURCE_ID,
              type: ArtifactType.Document,
              subtype: ArtifactSubtype.Feature,
            },
          ]
        : [
            {
              id: SOURCE_ID,
              status: persisted.status,
              assigneeId: null,
              priority: null,
              tagArtifacts: persisted.tagIds.map((tagId) => ({ tagId })),
            },
          ]
  );
  mocks.artifactUpdateMany.mockImplementation(
    ({ data }: { data: { status: string } }) => {
      persisted.status = data.status;
      return { count: 1 };
    }
  );
  mocks.tagCount.mockResolvedValue(1);
  mocks.tagDeleteMany.mockImplementation(() => {
    persisted.tagIds = [];
  });
  mocks.tagCreateMany.mockImplementation(
    ({ data }: { data: Array<{ tagId: string }> }) => {
      persisted.tagIds = data.map((row) => row.tagId);
    }
  );
});

describe("placement transaction with root fields", () => {
  it("records hierarchy and group fields in the same receipt after one commit", async () => {
    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORGANIZATION_ID,
      request(),
      {
        userId: ACTOR_ID,
        authMethod: "session",
        tagPermissions: { canApply: true, canRemove: true },
      }
    );

    expect(result.ok).toBe(true);
    expect(persisted).toEqual({
      order: [TARGET_ID, SOURCE_ID],
      status: IssueStatus.InProgress,
      tagIds: [TAG_ID],
    });
    expect(mocks.recordPlacementActivity).toHaveBeenCalledWith(
      expect.anything(),
      ORGANIZATION_ID,
      expect.anything(),
      expect.anything(),
      undefined,
      expect.anything(),
      ProjectArtifactPlacementSource.Pointer,
      expect.objectContaining({
        beforeState: expect.objectContaining({
          rootFields: [
            expect.objectContaining({ status: IssueStatus.Todo, tagIds: [] }),
          ],
        }),
        afterState: expect.objectContaining({
          rootFields: [
            expect.objectContaining({
              status: IssueStatus.InProgress,
              tagIds: [TAG_ID],
            }),
          ],
        }),
      })
    );
    expect(mocks.captureBatchStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [
          {
            artifactId: SOURCE_ID,
            before: IssueStatus.Todo,
            after: IssueStatus.InProgress,
          },
        ],
      })
    );
    expect(mocks.emitPlacementRootFieldEffects).toHaveBeenCalledTimes(1);
  });

  it("rolls back placement and scalar changes when the tag write fails", async () => {
    mocks.tagCreateMany.mockRejectedValueOnce(new Error("tag write failed"));

    await expect(
      projectArtifactPlacementService.placeProjectArtifacts(
        PROJECT_ID,
        ORGANIZATION_ID,
        request(),
        {
          userId: ACTOR_ID,
          authMethod: "session",
          tagPermissions: { canApply: true, canRemove: true },
        }
      )
    ).rejects.toThrow("tag write failed");

    expect(persisted).toEqual({
      order: [SOURCE_ID, TARGET_ID],
      status: IssueStatus.Todo,
      tagIds: [],
    });
    expect(mocks.recordPlacementActivity).not.toHaveBeenCalled();
    expect(mocks.emitPlacementRootFieldEffects).not.toHaveBeenCalled();
  });

  it("restores group fields with the hierarchy when Undo uses the stored receipt", async () => {
    const actor = {
      userId: ACTOR_ID,
      authMethod: "session" as const,
      tagPermissions: { canApply: true, canRemove: true },
    };
    const placed = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORGANIZATION_ID,
      request(),
      actor
    );
    expect(placed.ok).toBe(true);
    if (!placed.ok) {
      throw new Error("Expected placement receipt");
    }
    const receipt = mocks.recordPlacementActivity.mock.calls[0]?.[7];
    mocks.readPlacementReceipt.mockImplementation(
      async (_tx: unknown, _org: string, lookup: { transactionId?: string }) =>
        lookup.transactionId === placed.value.transactionId ? receipt : null
    );

    const undone = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORGANIZATION_ID,
      {
        kind: ProjectArtifactPlacementKind.Undo,
        undoOfTransactionId: placed.value.transactionId,
        expectedProjectVersions: { [PROJECT_ID]: "v2" },
        idempotencyKey: "root-fields-undo",
        source: ProjectArtifactPlacementSource.Undo,
      },
      actor
    );

    expect(undone.ok).toBe(true);
    expect(persisted).toEqual({
      order: [SOURCE_ID, TARGET_ID],
      status: IssueStatus.Todo,
      tagIds: [],
    });
  });

  it("reports the committed result even if post-commit emission fails", async () => {
    mocks.emitPlacementRootFieldEffects.mockRejectedValueOnce(
      new Error("analytics unavailable")
    );

    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORGANIZATION_ID,
      request(),
      {
        userId: ACTOR_ID,
        authMethod: "session",
        tagPermissions: { canApply: true, canRemove: true },
      }
    );

    expect(result.ok).toBe(true);
    expect(persisted.status).toBe(IssueStatus.InProgress);
  });

  it.each([
    new Prisma.PrismaClientKnownRequestError("serialization failure", {
      code: "P2034",
      clientVersion: "7.10.0",
    }),
    { code: "P2010", meta: { code: "40001" } },
  ])(
    "maps concurrent flag-off hierarchy failure to conflict",
    async (failure) => {
      mocks.withDb.tx.mockRejectedValueOnce(failure);
      const result =
        await projectArtifactPlacementService.placeProjectArtifacts(
          PROJECT_ID,
          ORGANIZATION_ID,
          request(),
          { userId: ACTOR_ID, authMethod: "session" },
          { includeAllTypes: true }
        );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.status).toBe(Status.Conflict);
      }
    }
  );
});
