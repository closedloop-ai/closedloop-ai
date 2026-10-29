import { ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import { BranchStatus } from "@repo/api/src/types/branch";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactBoardDropPosition,
  projectArtifactBoardMoveIntent,
} from "@repo/api/src/types/project-artifact-board-move";
import {
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { Status } from "@repo/api/src/types/result";
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
  CREATED_AT,
  currentVersion,
  installPlacementHarness,
  ORG_ID,
  PROJECT_ID,
  request,
  SOURCE_ID,
  TARGET_ID,
  TRANSACTION_ID,
} from "@/__tests__/support/documents/project-artifact-placement-service.test-harness";
import { placeProjectArtifactsWithLanePatch } from "@/app/artifacts/project-artifact-board-placement";

installPlacementHarness();

describe("placeProjectArtifactsWithLanePatch through the placement service", () => {
  it("PRD-724 accepts the board's cross-lane drop and records a status change", async () => {
    const twoLaneRows = mocks.artifactFindMany.getMockImplementation();
    mocks.artifactFindMany.mockImplementation(async (args: unknown) => {
      const rows: Array<{ id: string; status: string }> =
        (await twoLaneRows?.(args)) ?? [];
      return rows.map((row) =>
        row.id === TARGET_ID ? { ...row, status: IssueStatus.Done } : row
      );
    });
    const version = await currentVersion();
    // The request the board builds for a drop at the end of the Done lane,
    // assembled the way the placement hook sends it.
    const intent = projectArtifactBoardMoveIntent({
      destinationProjectId: PROJECT_ID,
      laneField: ProjectArtifactPlacementGroupField.Status,
      laneId: IssueStatus.Done,
      position: ProjectArtifactBoardDropPosition.End,
      rootIds: [SOURCE_ID],
      source: ProjectArtifactPlacementSource.Pointer,
      targetLaneRootIds: [TARGET_ID],
    });
    const result = await placeProjectArtifactsWithLanePatch(
      PROJECT_ID,
      ORG_ID,
      {
        ...intent,
        expectedProjectVersions: { [PROJECT_ID]: version },
        idempotencyKey: "board-drop-1",
        kind: ProjectArtifactPlacementKind.Place,
      },
      { authMethod: "session", userId: ACTOR_ID }
    );

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: IssueStatus.Done },
        where: { id: SOURCE_ID, organizationId: ORG_ID },
      })
    );
    expect(mocks.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: ArtifactActivityAction.StatusChange,
          artifactId: SOURCE_ID,
          transactionId: TRANSACTION_ID,
        }),
      })
    );
  });

  it.each([
    [
      "an invalid status",
      {
        field: ProjectArtifactPlacementGroupField.Status,
        value: "not-a-status",
      },
      Status.BadRequest,
    ],
    [
      "an unknown assignee",
      {
        field: ProjectArtifactPlacementGroupField.AssigneeId,
        value: "00000000-0000-4000-8000-000000000099",
      },
      Status.NotFound,
    ],
  ])(
    "PRD-724 refuses %s before any placement or lane write",
    async (_label, lanePatch, status) => {
      mocks.userFindFirst.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve(where.id === ACTOR_ID ? { id: ACTOR_ID } : null)
      );
      const version = await currentVersion();
      const result = await placeProjectArtifactsWithLanePatch(
        PROJECT_ID,
        ORG_ID,
        request({
          expectedProjectVersions: { [PROJECT_ID]: version },
          lanePatch,
        }),
        { authMethod: "session", userId: ACTOR_ID }
      );

      expect(result).toMatchObject({ ok: false, error: { status } });
      expect(
        mocks.executeRaw.mock.calls.map(([query]) =>
          JSON.stringify(query).includes("pg_advisory_xact_lock")
        )
      ).not.toContain(false);
      expect(mocks.artifactLinkCreate).not.toHaveBeenCalled();
      expect(mocks.artifactLinkCreateMany).not.toHaveBeenCalled();
      expect(mocks.artifactLinkDeleteMany).not.toHaveBeenCalled();
      expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
      expect(mocks.artifactUpdate).not.toHaveBeenCalled();
      expect(mocks.activityCreate).not.toHaveBeenCalled();
      expect(mocks.activityCreateMany).not.toHaveBeenCalled();
    }
  );
  it("ISS-12929 keeps a receipt and Undo for a lane move whose rank does not change", async () => {
    const version = await currentVersion();
    const result = await placeProjectArtifactsWithLanePatch(
      PROJECT_ID,
      ORG_ID,
      request({
        expectedProjectVersions: { [PROJECT_ID]: version },
        idempotencyKey: "board-lane-end-1",
        lanePatch: {
          field: ProjectArtifactPlacementGroupField.Status,
          value: IssueStatus.Done,
        },
        position: ProjectArtifactPlacementPosition.Root,
        sourceArtifactIds: [TARGET_ID],
        targetArtifactId: undefined,
      }),
      { authMethod: "session", userId: ACTOR_ID }
    );

    expect(result).toMatchObject({
      ok: true,
      value: { transactionId: TRANSACTION_ID, undoAvailable: true },
    });
    expect(mocks.artifactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: IssueStatus.Done },
        where: { id: TARGET_ID, organizationId: ORG_ID },
      })
    );
  });

  it.each([
    ["a Branch root", [BRANCH_ID]],
    ["a mixed Document and Branch selection", [SOURCE_ID, BRANCH_ID]],
  ])(
    "ISS-12929 places %s on the version the placement GET reports",
    async (_label, sourceArtifactIds) => {
      withBranchRow();
      const version = await currentVersion();
      const result = await placeProjectArtifactsWithLanePatch(
        PROJECT_ID,
        ORG_ID,
        request({
          expectedProjectVersions: { [PROJECT_ID]: version },
          position: ProjectArtifactPlacementPosition.After,
          sourceArtifactIds,
          targetArtifactId: TARGET_ID,
        }),
        { authMethod: "session", userId: ACTOR_ID }
      );

      expect(result).toMatchObject({ ok: true });
    }
  );
});

const BRANCH_ID = "00000000-0000-4000-8000-00000000000b";

/** Add a Branch root that only an all-kind read returns, as Prisma would. */
function withBranchRow() {
  const documentRows = mocks.artifactFindMany.getMockImplementation();
  mocks.artifactFindMany.mockImplementation(
    async (args: { where: { id?: { in: string[] }; type?: string } }) => {
      const rows: Array<{ type: string }> = (await documentRows?.(args)) ?? [];
      const branch = {
        assigneeId: null,
        createdAt: CREATED_AT,
        dueDate: null,
        id: BRANCH_ID,
        name: "Branch",
        organizationId: ORG_ID,
        priority: null,
        projectId: PROJECT_ID,
        sortOrder: 2048,
        status: BranchStatus.Open,
        subtype: null,
        tagArtifacts: [],
        type: ArtifactType.Branch,
        updatedAt: CREATED_AT,
      };
      const candidates =
        !args.where.id?.in || args.where.id.in.includes(BRANCH_ID)
          ? [...rows, branch]
          : rows;
      return args.where.type
        ? candidates.filter((row) => row.type === args.where.type)
        : candidates;
    }
  );
}
