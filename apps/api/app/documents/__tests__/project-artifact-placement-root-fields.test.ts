import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import type { TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitPlacementRootFieldEffects,
  placementRootFieldsAfter,
  readPlacementRootFields,
  validatePlacementRootFields,
  writePlacementRootFields,
} from "../project-artifact-placement-root-fields";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000002";
const TAG_ID = "00000000-0000-4000-8000-000000000003";

const mocks = vi.hoisted(() => ({
  artifactFindMany: vi.fn(),
  artifactUpdateMany: vi.fn(),
  tagCount: vi.fn(),
  tagCreateMany: vi.fn(),
  tagDeleteMany: vi.fn(),
  emitBatchStatusSideEffects: vi.fn(),
  emitBatchPrioritySideEffects: vi.fn(),
}));

vi.mock("../batch-status-side-effects", async () => {
  const actual = await vi.importActual<
    typeof import("../batch-status-side-effects")
  >("../batch-status-side-effects");
  return {
    ...actual,
    emitBatchStatusSideEffects: mocks.emitBatchStatusSideEffects,
  };
});
vi.mock("../batch-priority-side-effects", async () => {
  const actual = await vi.importActual<
    typeof import("../batch-priority-side-effects")
  >("../batch-priority-side-effects");
  return {
    ...actual,
    emitBatchPrioritySideEffects: mocks.emitBatchPrioritySideEffects,
  };
});

function client(): TransactionClient {
  return {
    artifact: {
      findMany: mocks.artifactFindMany,
      updateMany: mocks.artifactUpdateMany,
    },
    tag: { count: mocks.tagCount },
    tagArtifact: {
      createMany: mocks.tagCreateMany,
      deleteMany: mocks.tagDeleteMany,
    },
  } as unknown as TransactionClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.artifactFindMany.mockImplementation(
    ({ select }: { select: { subtype?: boolean } }) =>
      select.subtype
        ? [
            {
              id: ARTIFACT_ID,
              type: ArtifactType.Document,
              subtype: ArtifactSubtype.Feature,
            },
          ]
        : [
            {
              id: ARTIFACT_ID,
              status: IssueStatus.Todo,
              assigneeId: null,
              priority: null,
              tagArtifacts: [],
            },
          ]
  );
  mocks.artifactUpdateMany.mockResolvedValue({ count: 1 });
  mocks.tagCount.mockResolvedValue(1);
});

describe("placement root fields", () => {
  it("reads canonical tags and commits tag replacement with scalar group fields", async () => {
    const tx = client();
    const before = await readPlacementRootFields(tx, ORGANIZATION_ID, [
      ARTIFACT_ID,
    ]);
    const after = placementRootFieldsAfter(before, {
      status: IssueStatus.InProgress,
      tagIds: [TAG_ID],
    });

    expect(
      await validatePlacementRootFields(
        tx,
        ORGANIZATION_ID,
        [ARTIFACT_ID],
        before,
        after,
        { canApply: true, canRemove: true }
      )
    ).toBeNull();
    await writePlacementRootFields(tx, ORGANIZATION_ID, before, after);

    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [ARTIFACT_ID] },
        organizationId: ORGANIZATION_ID,
        type: ArtifactType.Document,
      },
      data: {
        status: IssueStatus.InProgress,
        assigneeId: null,
        priority: null,
      },
    });
    expect(mocks.tagDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.tagCreateMany).toHaveBeenCalledWith({
      data: [{ artifactId: ARTIFACT_ID, tagId: TAG_ID }],
    });
  });

  it("refuses tag application and removal independently before writing", async () => {
    const tx = client();
    const untagged = await readPlacementRootFields(tx, ORGANIZATION_ID, [
      ARTIFACT_ID,
    ]);
    const tagged = placementRootFieldsAfter(untagged, { tagIds: [TAG_ID] });

    const cannotApply = await validatePlacementRootFields(
      tx,
      ORGANIZATION_ID,
      [ARTIFACT_ID],
      untagged,
      tagged,
      { canApply: false, canRemove: true }
    );
    const cannotRemove = await validatePlacementRootFields(
      tx,
      ORGANIZATION_ID,
      [ARTIFACT_ID],
      tagged,
      untagged,
      { canApply: true, canRemove: false }
    );

    expect(cannotApply?.status).toBe(403);
    expect(cannotRemove?.status).toBe(403);
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
    expect(mocks.tagDeleteMany).not.toHaveBeenCalled();
  });

  it("does not make a tag-only update depend on a legacy status spelling", async () => {
    const tx = client();
    const current = await readPlacementRootFields(tx, ORGANIZATION_ID, [
      ARTIFACT_ID,
    ]);
    const before = current.map((row) => ({ ...row, status: "LEGACY_STATUS" }));
    const after = placementRootFieldsAfter(before, { tagIds: [TAG_ID] });

    expect(
      await validatePlacementRootFields(
        tx,
        ORGANIZATION_ID,
        [ARTIFACT_ID],
        before,
        after,
        { canApply: true, canRemove: true }
      )
    ).toBeNull();
  });

  it("rejects an unavailable tag before a partial field write", async () => {
    mocks.tagCount.mockResolvedValue(0);
    const tx = client();
    const before = await readPlacementRootFields(tx, ORGANIZATION_ID, [
      ARTIFACT_ID,
    ]);
    const after = placementRootFieldsAfter(before, {
      status: IssueStatus.InProgress,
      tagIds: [TAG_ID],
    });

    const refusal = await validatePlacementRootFields(
      tx,
      ORGANIZATION_ID,
      [ARTIFACT_ID],
      before,
      after,
      { canApply: true, canRemove: true }
    );

    expect(refusal?.status).toBe(400);
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
    expect(mocks.tagDeleteMany).not.toHaveBeenCalled();
  });

  it("emits status and priority side effects only after a committed field change", async () => {
    const tx = client();
    const before = await readPlacementRootFields(tx, ORGANIZATION_ID, [
      ARTIFACT_ID,
    ]);
    const after = placementRootFieldsAfter(before, {
      status: IssueStatus.InProgress,
      priority: Priority.High,
    });

    await emitPlacementRootFieldEffects({
      before,
      after,
      actor: { userId: ARTIFACT_ID, authMethod: "session" },
      organizationId: ORGANIZATION_ID,
      transactionId: TAG_ID,
      surface: ArtifactStatusEditSurface.Board,
    });

    expect(mocks.emitBatchStatusSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        status: IssueStatus.InProgress,
        surface: ArtifactStatusEditSurface.Board,
        changedIds: [ARTIFACT_ID],
      })
    );
    expect(mocks.emitBatchPrioritySideEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: Priority.High,
        changedIds: [ARTIFACT_ID],
      })
    );
    expect(mocks.emitBatchStatusSideEffects).toHaveBeenCalledTimes(1);
  });

  it("does not emit document priority side effects for a changed Branch root", async () => {
    const tx = client();
    const before = await readPlacementRootFields(tx, ORGANIZATION_ID, [
      ARTIFACT_ID,
    ]);
    const after = placementRootFieldsAfter(before, {
      priority: Priority.High,
    });

    await emitPlacementRootFieldEffects({
      before,
      after,
      actor: { userId: ARTIFACT_ID, authMethod: "session" },
      organizationId: ORGANIZATION_ID,
      transactionId: TAG_ID,
      documentArtifactIds: [],
    });

    expect(mocks.emitBatchPrioritySideEffects).not.toHaveBeenCalled();
    expect(mocks.emitBatchStatusSideEffects).not.toHaveBeenCalled();
  });
});
