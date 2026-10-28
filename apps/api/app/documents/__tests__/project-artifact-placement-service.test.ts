import { LinkType } from "@repo/api/src/types/artifact";
import {
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementPosition,
} from "@repo/api/src/types/project-artifact-placement";
import { Status } from "@repo/api/src/types/result";
import type { TransactionClient } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { mocks } from "@/__tests__/support/documents/project-artifact-placement-service.test-mocks";

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  const { mocks: placementMocks } = await import(
    "@/__tests__/support/documents/project-artifact-placement-service.test-mocks"
  );
  return { ...actual, withDb: placementMocks.withDb };
});

import {
  ACTOR_ID,
  CHILD_RANK_UPDATE_PATTERN,
  CREATED_AT,
  client,
  currentVersion,
  DESTINATION_ID,
  DESTINATION_TARGET_ID,
  installPlacementHarness,
  mockArtifactRows,
  ORG_ID,
  PROJECT_ID,
  ROOT_RANK_UPDATE_PATTERN,
  request,
  SECOND_PARENT_ID,
  SOURCE_ID,
  TARGET_ID,
  TRANSACTION_ID,
} from "@/__tests__/support/documents/project-artifact-placement-service.test-harness";
import {
  applyProjectArtifactPlacementInTransaction,
  projectArtifactPlacementService,
} from "@/app/documents/project-artifact-placement-service";

installPlacementHarness();

describe("projectArtifactPlacementService", () => {
  it("AC-008 commits rank, receipt, and activity through one transaction", async () => {
    const version = await currentVersion();
    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({ expectedProjectVersions: { [PROJECT_ID]: version } }),
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value).toMatchObject({
      placed: true,
      transactionId: TRANSACTION_ID,
      affectedArtifactIds: [SOURCE_ID, TARGET_ID],
      affectedProjectIds: [PROJECT_ID],
      replayed: false,
      undoAvailable: true,
    });
    expect(mocks.activityCreateMany).toHaveBeenCalledTimes(1);
    expect(executedUpdateSql()).toEqual([
      expect.stringMatching(ROOT_RANK_UPDATE_PATTERN),
    ]);
  });

  it("returns authoritative lineage for an ancestor-plus-descendant request", async () => {
    mockArtifactRows(true);
    mocks.artifactLinkFindMany.mockResolvedValue([
      {
        id: "source-descendant",
        sourceId: SOURCE_ID,
        targetId: SECOND_PARENT_ID,
        linkType: LinkType.Produces,
        createdAt: CREATED_AT,
        source: { projectId: PROJECT_ID },
        target: { projectId: PROJECT_ID },
      },
    ]);
    const version = await currentVersion();

    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({
        sourceArtifactIds: [SOURCE_ID, SECOND_PARENT_ID],
        expectedProjectVersions: { [PROJECT_ID]: version },
      }),
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        placement: { sourceArtifactIds: [SOURCE_ID] },
        sourceRootMappings: [
          { sourceArtifactId: SOURCE_ID, rootArtifactId: SOURCE_ID },
          {
            sourceArtifactId: SECOND_PARENT_ID,
            rootArtifactId: SOURCE_ID,
          },
        ],
      },
    });
  });

  it("AC-009 returns an identical committed receipt without a second write", async () => {
    const version = await currentVersion();
    const input = request({
      expectedProjectVersions: { [PROJECT_ID]: version },
    });
    const first = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      input,
      { userId: ACTOR_ID, authMethod: "session" }
    );
    const second = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      input,
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!(first.ok && second.ok)) {
      throw new Error("expected committed placements");
    }
    expect(second.value).toEqual({ ...first.value, replayed: true });
    expect(mocks.activityCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.activityCreateMany).toHaveBeenCalledTimes(1);
  });

  it("binds an idempotency replay to the route project", async () => {
    const version = await currentVersion();
    const input = request({
      expectedProjectVersions: { [PROJECT_ID]: version },
    });
    const first = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      input,
      { userId: ACTOR_ID, authMethod: "session" }
    );
    expect(first.ok).toBe(true);
    mocks.projectFindMany.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id })))
    );

    const replay = await projectArtifactPlacementService.placeProjectArtifacts(
      DESTINATION_ID,
      ORG_ID,
      input,
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(replay).toMatchObject({
      ok: false,
      error: {
        status: Status.Conflict,
        detail: {
          reason: ProjectArtifactPlacementErrorReason.IdempotencyMismatch,
        },
      },
    });
    expect(mocks.activityCreateMany).toHaveBeenCalledTimes(1);
  });

  it("revalidates the actor after deterministic locks and before the claim", async () => {
    mocks.userFindFirst
      .mockResolvedValueOnce({ id: ACTOR_ID })
      .mockResolvedValueOnce(null);
    const version = await currentVersion();

    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({ expectedProjectVersions: { [PROJECT_ID]: version } }),
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        status: Status.NotFound,
        detail: {
          reason: ProjectArtifactPlacementErrorReason.PermissionDenied,
        },
      },
    });
    expect(mocks.executeRaw).toHaveBeenCalled();
    expect(mocks.activityCreateMany).not.toHaveBeenCalled();
  });

  it("invokes a caller validator on the caller transaction before placement writes", async () => {
    const version = await currentVersion();
    const tx = client() as unknown as TransactionClient;
    const validatePlacement = vi.fn(() => null);

    const result = await applyProjectArtifactPlacementInTransaction(tx, {
      routeProjectId: PROJECT_ID,
      organizationId: ORG_ID,
      input: request({ expectedProjectVersions: { [PROJECT_ID]: version } }),
      actor: { userId: ACTOR_ID, authMethod: "session" },
      validatePlacement,
    });

    expect(result.ok).toBe(true);
    expect(validatePlacement).toHaveBeenCalledWith(
      expect.objectContaining({
        tx,
        routeProjectId: PROJECT_ID,
        organizationId: ORG_ID,
        sourceArtifactIds: [SOURCE_ID],
        movedArtifactIds: [SOURCE_ID],
        destinationParentId: null,
        affectedProjectIds: [PROJECT_ID],
      })
    );
    expect(validatePlacement.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activityCreateMany.mock.invocationCallOrder[0] ?? Number.MAX_VALUE
    );
  });

  it("returns a caller validator refusal without claiming or mutating placement", async () => {
    const version = await currentVersion();
    const tx = client() as unknown as TransactionClient;

    const result = await applyProjectArtifactPlacementInTransaction(tx, {
      routeProjectId: PROJECT_ID,
      organizationId: ORG_ID,
      input: request({ expectedProjectVersions: { [PROJECT_ID]: version } }),
      actor: { userId: ACTOR_ID, authMethod: "session" },
      validatePlacement: () => ({
        status: Status.BadRequest,
        message: "Caller hierarchy policy refused placement",
        detail: { reason: ProjectArtifactPlacementErrorReason.MaxDepth },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        status: Status.BadRequest,
        detail: { reason: ProjectArtifactPlacementErrorReason.MaxDepth },
      },
    });
    expect(mocks.activityCreateMany).not.toHaveBeenCalled();
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
    expect(mocks.artifactLinkDeleteMany).not.toHaveBeenCalled();
    expect(mocks.activityCreateMany).not.toHaveBeenCalled();
  });

  it("allows a same-parent reorder without mutating either in-project parent link", async () => {
    mockArtifactRows(true);
    mocks.artifactLinkFindMany.mockResolvedValue([
      sameProjectParentLink("link-primary", TARGET_ID, SOURCE_ID, CREATED_AT),
      sameProjectParentLink(
        "link-secondary",
        SECOND_PARENT_ID,
        SOURCE_ID,
        new Date(CREATED_AT.getTime() + 1000)
      ),
    ]);
    const version = await currentVersion();

    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({
        position: ProjectArtifactPlacementPosition.Inside,
        targetArtifactId: TARGET_ID,
        expectedProjectVersions: { [PROJECT_ID]: version },
      }),
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.artifactLinkDeleteMany).not.toHaveBeenCalled();
    expect(mocks.artifactLinkCreateMany).not.toHaveBeenCalled();
    expect(executedUpdateSql()).toEqual([
      expect.stringMatching(CHILD_RANK_UPDATE_PATTERN),
    ]);
  });

  it("reparents only the canonical edge and preserves secondary lineage", async () => {
    mockArtifactRows(true);
    mocks.artifactLinkFindMany.mockResolvedValue([
      sameProjectParentLink("link-primary", TARGET_ID, SOURCE_ID, CREATED_AT),
      sameProjectParentLink(
        "link-secondary",
        SECOND_PARENT_ID,
        SOURCE_ID,
        new Date(CREATED_AT.getTime() + 1000)
      ),
    ]);
    const version = await currentVersion();

    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({
        position: ProjectArtifactPlacementPosition.Inside,
        targetArtifactId: SECOND_PARENT_ID,
        expectedProjectVersions: { [PROJECT_ID]: version },
      }),
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.artifactLinkDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.artifactLinkDeleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        sourceId: TARGET_ID,
        targetId: SOURCE_ID,
        linkType: LinkType.Produces,
      },
    });
    expect(mocks.artifactLinkCreateMany).not.toHaveBeenCalled();
  });

  it("promotes to root without deleting secondary lineage", async () => {
    mockArtifactRows(true);
    mocks.artifactLinkFindMany.mockResolvedValue([
      sameProjectParentLink("link-primary", TARGET_ID, SOURCE_ID, CREATED_AT),
      sameProjectParentLink(
        "link-secondary",
        SECOND_PARENT_ID,
        SOURCE_ID,
        new Date(CREATED_AT.getTime() + 1000)
      ),
    ]);
    const version = await currentVersion();

    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({
        position: ProjectArtifactPlacementPosition.Root,
        targetArtifactId: undefined,
        expectedProjectVersions: { [PROJECT_ID]: version },
      }),
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.artifactLinkDeleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        sourceId: TARGET_ID,
        targetId: SOURCE_ID,
        linkType: LinkType.Produces,
      },
    });
    expect(mocks.artifactLinkCreateMany).not.toHaveBeenCalled();
  });

  it("promotes across projects while retaining destination-project lineage", async () => {
    mocks.projectFindMany.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id })))
    );
    mocks.artifactFindMany.mockImplementation(
      ({ where }: { where: { id?: { in: string[] } } }) => {
        const rows = [
          {
            id: SOURCE_ID,
            projectId: PROJECT_ID,
            sortOrder: 0,
            createdAt: CREATED_AT,
          },
          {
            id: DESTINATION_TARGET_ID,
            projectId: DESTINATION_ID,
            sortOrder: 0,
            createdAt: CREATED_AT,
          },
        ];
        return Promise.resolve(
          where.id?.in
            ? rows.filter(({ id }) => where.id?.in.includes(id))
            : rows
        );
      }
    );
    mocks.artifactLinkFindMany.mockResolvedValue([
      {
        id: "destination-lineage",
        sourceId: DESTINATION_TARGET_ID,
        targetId: SOURCE_ID,
        linkType: LinkType.Produces,
        sortOrder: 0,
        metadata: null,
        createdAt: CREATED_AT,
        source: { projectId: DESTINATION_ID },
        target: { projectId: PROJECT_ID },
      },
    ]);
    const sourceVersion = await currentVersion();
    const destinationState =
      await projectArtifactPlacementService.getProjectPlacementState(
        DESTINATION_ID,
        ORG_ID,
        { userId: ACTOR_ID, authMethod: "session" }
      );
    if (!destinationState) {
      throw new Error("expected destination project version");
    }

    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({
        destinationProjectId: DESTINATION_ID,
        expectedProjectVersions: {
          [PROJECT_ID]: sourceVersion,
          [DESTINATION_ID]: destinationState.projectVersion,
        },
        position: ProjectArtifactPlacementPosition.Root,
        targetArtifactId: undefined,
      }),
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { projectId: DESTINATION_ID } })
    );
    expect(mocks.artifactLinkDeleteMany).not.toHaveBeenCalled();
  });

  it("refuses a descendant expansion above the bounded artifact limit", async () => {
    const artifacts = Array.from({ length: 5001 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      projectId: PROJECT_ID,
      sortOrder: index * 1024,
      createdAt: CREATED_AT,
    }));
    const root = artifacts.at(0);
    if (!root) {
      throw new Error("expected an expanded hierarchy root");
    }
    mocks.artifactFindMany.mockImplementation(
      ({ where }: { where: { id?: { in: string[] } } }) =>
        Promise.resolve(
          where.id?.in
            ? artifacts.filter(({ id }) => where.id?.in.includes(id))
            : artifacts
        )
    );
    mocks.artifactLinkFindMany.mockResolvedValue(
      artifacts.slice(1).map((artifact, index) => {
        const parent = artifacts.at(index);
        if (!parent) {
          throw new Error("expected an expanded hierarchy parent");
        }
        return {
          id: `link-${index}`,
          sourceId: parent.id,
          targetId: artifact.id,
          linkType: LinkType.Produces,
          createdAt: CREATED_AT,
          source: { projectId: PROJECT_ID },
          target: { projectId: PROJECT_ID },
        };
      })
    );
    const version = await currentVersion();

    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({
        sourceArtifactIds: [root.id],
        expectedProjectVersions: { [PROJECT_ID]: version },
      }),
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        status: Status.BadRequest,
        detail: {
          reason: ProjectArtifactPlacementErrorReason.ExpandedArtifactLimit,
        },
      },
    });
    expect(mocks.activityCreateMany).not.toHaveBeenCalled();
  });

  it("AC-009 rejects stale versions and idempotency-key mismatches without writes", async () => {
    const stale = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({ expectedProjectVersions: { [PROJECT_ID]: "stale" } }),
      { userId: ACTOR_ID, authMethod: "session" }
    );
    expect(stale).toMatchObject({
      ok: false,
      error: {
        status: Status.Conflict,
        detail: { reason: ProjectArtifactPlacementErrorReason.StaleVersion },
      },
    });
    expect(mocks.activityCreateMany).not.toHaveBeenCalled();

    const version = await currentVersion();
    const first = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({ expectedProjectVersions: { [PROJECT_ID]: version } }),
      { userId: ACTOR_ID, authMethod: "session" }
    );
    expect(first.ok).toBe(true);
    const mismatch =
      await projectArtifactPlacementService.placeProjectArtifacts(
        PROJECT_ID,
        ORG_ID,
        request({
          expectedProjectVersions: { [PROJECT_ID]: version },
          position: ProjectArtifactPlacementPosition.Before,
        }),
        { userId: ACTOR_ID, authMethod: "session" }
      );
    expect(mismatch).toMatchObject({
      ok: false,
      error: {
        status: Status.Conflict,
        detail: {
          reason: ProjectArtifactPlacementErrorReason.IdempotencyMismatch,
        },
      },
    });
    expect(mocks.activityCreateMany).toHaveBeenCalledTimes(1);
  });

  it("AC-008 refuses a source outside the route project before locking or writing", async () => {
    mocks.artifactFindMany.mockResolvedValue([
      {
        id: SOURCE_ID,
        projectId: "00000000-0000-4000-8000-000000000099",
        sortOrder: 0,
        createdAt: CREATED_AT,
      },
    ]);
    const version = await currentVersion();
    mocks.withDb.tx.mockClear();
    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({ expectedProjectVersions: { [PROJECT_ID]: version } }),
      { userId: ACTOR_ID, authMethod: "session" }
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        status: Status.BadRequest,
        detail: { reason: ProjectArtifactPlacementErrorReason.InvalidRequest },
      },
    });
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.activityCreateMany).not.toHaveBeenCalled();
  });

  it("AC-008 atomically places a subtree into a different project", async () => {
    mocks.projectFindMany.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id })))
    );
    mocks.artifactFindFirst.mockResolvedValueOnce({
      id: DESTINATION_TARGET_ID,
      projectId: DESTINATION_ID,
    });
    const sourceVersion = await currentVersion();
    const destinationState =
      await projectArtifactPlacementService.getProjectPlacementState(
        DESTINATION_ID,
        ORG_ID,
        { userId: ACTOR_ID, authMethod: "session" }
      );
    if (!destinationState) {
      throw new Error("expected destination project version");
    }
    const destinationVersion = destinationState.projectVersion;
    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({
        destinationProjectId: DESTINATION_ID,
        targetArtifactId: DESTINATION_TARGET_ID,
        position: ProjectArtifactPlacementPosition.Inside,
        expectedProjectVersions: {
          [PROJECT_ID]: sourceVersion,
          [DESTINATION_ID]: destinationVersion,
        },
      }),
      { userId: ACTOR_ID, authMethod: "session" }
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        affectedProjectIds: [PROJECT_ID, DESTINATION_ID],
        placement: {
          destinationProjectId: DESTINATION_ID,
          position: ProjectArtifactPlacementPosition.Inside,
          targetArtifactId: DESTINATION_TARGET_ID,
        },
      },
    });
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: DESTINATION_ID }),
        where: expect.objectContaining({ id: { in: [SOURCE_ID] } }),
      })
    );
    expect(mocks.activityCreateMany).toHaveBeenCalledTimes(2);
  });

  it("AC-008 reports an organization-scoped destination as permission denied", async () => {
    mocks.projectFindMany.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      PROJECT_ID,
      ORG_ID,
      request({ destinationProjectId: DESTINATION_ID }),
      { userId: ACTOR_ID, authMethod: "session" }
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        status: Status.NotFound,
        detail: {
          reason: ProjectArtifactPlacementErrorReason.PermissionDenied,
        },
      },
    });
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.activityCreateMany).not.toHaveBeenCalled();
  });
});

function sameProjectParentLink(
  id: string,
  sourceId: string,
  targetId: string,
  createdAt: Date
) {
  return {
    id,
    sourceId,
    targetId,
    linkType: LinkType.Produces,
    sortOrder: 0,
    metadata: null,
    createdAt,
    source: { projectId: PROJECT_ID },
    target: { projectId: PROJECT_ID },
  };
}

function executedSql(): string[] {
  return mocks.executeRaw.mock.calls.map(([statement]) =>
    Array.isArray(statement)
      ? statement.join("?")
      : (statement as { sql: string }).sql
  );
}

function executedUpdateSql(): string[] {
  return executedSql().filter((statement) => statement.includes("UPDATE "));
}
