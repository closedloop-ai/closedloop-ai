import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import {
  PROJECT_ARTIFACT_LANE_POLICY_VERSION,
  type ProjectArtifactLanePolicy,
} from "@repo/api/src/types/project-artifact-lane-policy";
import {
  type PlaceProjectArtifactsRequest,
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import {
  type Artifact,
  type ArtifactActivityEvent,
  ArtifactSubtype,
  ArtifactType,
  Priority,
  type TransactionClient,
} from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { PlacementState } from "@/app/documents/project-artifact-placement-service-support";
import {
  applyPreparedProjectArtifactPlacementLaneWrite,
  preparedLaneStatusTransitions,
  prepareProjectArtifactPlacementLaneWrite,
} from "./project-artifact-placement-lane-write";

const captureArtifactUpdate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactUpdate,
}));

const ORGANIZATION_ID = "11111111-1111-7111-8111-111111111111";
const PROJECT_ID = "22222222-2222-7222-8222-222222222222";
const ROOT_ID = "33333333-3333-7333-8333-333333333333";
const SECOND_ROOT_ID = "55555555-5555-7555-8555-555555555555";
const OTHER_ROOT_ID = "33333333-3333-7333-8333-333333333334";
const ACTOR = { authMethod: "session", userId: ROOT_ID } as const;
const TRANSACTION_ID = "44444444-4444-7444-8444-444444444444";

describe("PRD-724 board lane write inside canonical placement", () => {
  beforeEach(() => {
    captureArtifactUpdate.mockReset();
  });

  it("writes status and activity on the placement transaction", async () => {
    const tx = mockDeep<TransactionClient>();
    tx.artifact.findMany.mockResolvedValue([artifact(IssueStatus.Todo)]);
    tx.artifact.update.mockResolvedValue(artifact(IssueStatus.InProgress));
    const prepared = await prepareProjectArtifactPlacementLaneWrite({
      actor: ACTOR,
      destinationProjectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      placement: place(IssueStatus.InProgress),
      policy: null,
      sourceArtifactIds: [ROOT_ID],
      state: placementState(),
      tx,
    });
    if (!prepared.ok) {
      throw new Error(prepared.error.message);
    }

    await applyPreparedProjectArtifactPlacementLaneWrite({
      organizationId: ORGANIZATION_ID,
      prepared: prepared.value,
      transactionId: TRANSACTION_ID,
      tx,
    });

    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: IssueStatus.InProgress } })
    );
    expect(captureArtifactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: TRANSACTION_ID,
        tx,
      })
    );
  });

  it("writes distinct Issue and Document raw targets in one placement and reports both transitions", async () => {
    const tx = mockDeep<TransactionClient>();
    const issue = artifact(IssueStatus.InProgress);
    const document = {
      ...artifact(IssueStatus.Todo),
      id: SECOND_ROOT_ID,
      status: DocumentStatus.Draft,
      subtype: ArtifactSubtype.PRD,
    };
    tx.artifact.findMany.mockResolvedValue([issue, document]);
    tx.artifact.update.mockResolvedValue(issue);
    const request = place(IssueStatus.InReview);
    request.sourceArtifactIds = [ROOT_ID, SECOND_ROOT_ID];
    request.lanePatch = {
      field: ProjectArtifactPlacementGroupField.Status,
      value: IssueStatus.InReview,
      valuesByRootId: {
        [ROOT_ID]: IssueStatus.InReview,
        [SECOND_ROOT_ID]: DocumentStatus.InReview,
      },
    };

    const prepared = await prepareProjectArtifactPlacementLaneWrite({
      actor: ACTOR,
      destinationProjectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      placement: request,
      policy: null,
      sourceArtifactIds: request.sourceArtifactIds,
      state: placementState(),
      tx,
    });
    if (!prepared.ok) {
      throw new Error(prepared.error.message);
    }
    expect(preparedLaneStatusTransitions(prepared.value)).toEqual([
      {
        after: IssueStatus.InReview,
        before: IssueStatus.InProgress,
        documentId: ROOT_ID,
      },
      {
        after: DocumentStatus.InReview,
        before: DocumentStatus.Draft,
        documentId: SECOND_ROOT_ID,
      },
    ]);
    await applyPreparedProjectArtifactPlacementLaneWrite({
      organizationId: ORGANIZATION_ID,
      prepared: prepared.value,
      transactionId: TRANSACTION_ID,
      tx,
    });
    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: IssueStatus.InReview },
        where: { id: ROOT_ID, organizationId: ORGANIZATION_ID },
      })
    );
    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: DocumentStatus.InReview },
        where: { id: SECOND_ROOT_ID, organizationId: ORGANIZATION_ID },
      })
    );
  });

  it("refuses an incomplete per-root map before writing any selected artifact", async () => {
    const tx = mockDeep<TransactionClient>();
    tx.artifact.findMany.mockResolvedValue([
      artifact(IssueStatus.InProgress),
      { ...artifact(IssueStatus.Todo), id: SECOND_ROOT_ID },
    ]);
    const request = place(IssueStatus.Todo);
    request.sourceArtifactIds = [ROOT_ID, SECOND_ROOT_ID];
    request.lanePatch = {
      field: ProjectArtifactPlacementGroupField.Status,
      value: IssueStatus.Todo,
      valuesByRootId: { [ROOT_ID]: IssueStatus.Todo },
    };
    const result = await prepareProjectArtifactPlacementLaneWrite({
      actor: ACTOR,
      destinationProjectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      placement: request,
      policy: null,
      sourceArtifactIds: request.sourceArtifactIds,
      state: placementState(),
      tx,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        detail: { reason: ProjectArtifactPlacementErrorReason.InvalidRequest },
      },
    });
    expect(tx.artifact.update).not.toHaveBeenCalled();
  });

  it.each([
    [IssueStatus.InProgress, [IssueStatus.InProgress]],
    [IssueStatus.Todo, []],
  ])(
    "reports the status transition the lane write commits (to %s)",
    async (target, expected) => {
      const tx = mockDeep<TransactionClient>();
      tx.artifact.findMany.mockResolvedValue([artifact(IssueStatus.Todo)]);
      const prepared = await prepareProjectArtifactPlacementLaneWrite({
        actor: ACTOR,
        destinationProjectId: PROJECT_ID,
        organizationId: ORGANIZATION_ID,
        placement: place(target),
        policy: null,
        sourceArtifactIds: [ROOT_ID],
        state: placementState(),
        tx,
      });
      if (!prepared.ok) {
        throw new Error(prepared.error.message);
      }

      expect(
        preparedLaneStatusTransitions(prepared.value).map(
          (transition) => transition.after
        )
      ).toEqual(expected);
    }
  );

  it("refuses an unsupported transition before any write", async () => {
    const tx = mockDeep<TransactionClient>();
    tx.artifact.findMany.mockResolvedValue([artifact(IssueStatus.Todo)]);
    const policy: ProjectArtifactLanePolicy = {
      field: ProjectArtifactPlacementGroupField.Status,
      revision: "policy-v1",
      transitions: { [IssueStatus.Todo]: [IssueStatus.InProgress] },
      version: PROJECT_ARTIFACT_LANE_POLICY_VERSION,
    };

    const prepared = await prepareProjectArtifactPlacementLaneWrite({
      actor: ACTOR,
      destinationProjectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      placement: place(IssueStatus.Done),
      policy,
      sourceArtifactIds: [ROOT_ID],
      state: placementState(),
      tx,
    });

    expect(prepared).toMatchObject({
      error: {
        detail: {
          reason: ProjectArtifactPlacementErrorReason.UnsupportedTransition,
        },
      },
      ok: false,
    });
    expect(tx.artifact.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Branch ownership",
      ArtifactType.BRANCH,
      ProjectArtifactPlacementGroupField.AssigneeId,
      null,
    ],
    [
      "Deployment priority",
      ArtifactType.DEPLOYMENT,
      ProjectArtifactPlacementGroupField.Priority,
      Priority.HIGH,
    ],
  ] as const)(
    "refuses unsupported %s before any write",
    async (_label, type, field, value) => {
      const tx = mockDeep<TransactionClient>();
      tx.artifact.findMany.mockResolvedValue([
        artifact(IssueStatus.Todo, { type }),
      ]);

      const prepared = await prepareProjectArtifactPlacementLaneWrite({
        actor: ACTOR,
        destinationProjectId: PROJECT_ID,
        organizationId: ORGANIZATION_ID,
        placement: placeWithLanePatch(field, value),
        policy: null,
        sourceArtifactIds: [ROOT_ID],
        state: placementState(),
        tx,
      });

      expect(prepared).toMatchObject({
        error: {
          detail: {
            reason: ProjectArtifactPlacementErrorReason.InvalidRequest,
          },
        },
        ok: false,
      });
      expect(tx.artifact.update).not.toHaveBeenCalled();
    }
  );

  it("refuses a mixed ownership selection atomically when any root lacks authority", async () => {
    const tx = mockDeep<TransactionClient>();
    tx.artifact.findMany.mockResolvedValue([
      artifact(IssueStatus.Todo),
      artifact(IssueStatus.Todo, {
        id: OTHER_ROOT_ID,
        type: ArtifactType.BRANCH,
      }),
    ]);

    const prepared = await prepareProjectArtifactPlacementLaneWrite({
      actor: ACTOR,
      destinationProjectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      placement: placeWithLanePatch(
        ProjectArtifactPlacementGroupField.AssigneeId,
        null,
        [ROOT_ID, OTHER_ROOT_ID]
      ),
      policy: null,
      sourceArtifactIds: [ROOT_ID, OTHER_ROOT_ID],
      state: placementState(),
      tx,
    });

    expect(prepared).toMatchObject({
      error: {
        detail: {
          reason: ProjectArtifactPlacementErrorReason.InvalidRequest,
        },
      },
      ok: false,
    });
    expect(tx.artifact.update).not.toHaveBeenCalled();
  });

  it("restores the lane from activity while placement Undo owns ordering", async () => {
    const tx = mockDeep<TransactionClient>();
    tx.artifactActivityEvent.findMany.mockResolvedValue([
      activityEvent(IssueStatus.Todo, IssueStatus.InProgress),
    ]);
    tx.artifact.findMany.mockResolvedValue([artifact(IssueStatus.InProgress)]);
    tx.artifact.update.mockResolvedValue(artifact(IssueStatus.Todo));
    const prepared = await prepareProjectArtifactPlacementLaneWrite({
      actor: ACTOR,
      destinationProjectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      placement: {
        expectedProjectVersions: { [PROJECT_ID]: "version-2" },
        idempotencyKey: "undo-1",
        kind: ProjectArtifactPlacementKind.Undo,
        source: ProjectArtifactPlacementSource.Undo,
        undoOfTransactionId: TRANSACTION_ID,
      },
      policy: null,
      sourceArtifactIds: [ROOT_ID],
      state: placementState(),
      tx,
    });
    if (!prepared.ok) {
      throw new Error(prepared.error.message);
    }

    await applyPreparedProjectArtifactPlacementLaneWrite({
      organizationId: ORGANIZATION_ID,
      prepared: prepared.value,
      transactionId: "55555555-5555-7555-8555-555555555555",
      tx,
    });

    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: IssueStatus.Todo } })
    );
    expect(captureArtifactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ undoOfTransactionId: TRANSACTION_ID })
    );
  });

  it("restores distinct selected raw statuses from one placement receipt", async () => {
    const tx = mockDeep<TransactionClient>();
    tx.artifactActivityEvent.findMany.mockResolvedValue([
      activityEvent(IssueStatus.InProgress, IssueStatus.InReview),
      {
        ...activityEvent(IssueStatus.Todo, IssueStatus.InReview),
        artifactId: SECOND_ROOT_ID,
      },
    ]);
    tx.artifact.findMany.mockResolvedValue([
      artifact(IssueStatus.InReview),
      { ...artifact(IssueStatus.InReview), id: SECOND_ROOT_ID },
    ]);
    tx.artifact.update.mockResolvedValue(artifact(IssueStatus.Todo));
    const prepared = await prepareProjectArtifactPlacementLaneWrite({
      actor: ACTOR,
      destinationProjectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      placement: {
        expectedProjectVersions: { [PROJECT_ID]: "version-2" },
        idempotencyKey: "undo-two-roots",
        kind: ProjectArtifactPlacementKind.Undo,
        source: ProjectArtifactPlacementSource.Undo,
        undoOfTransactionId: TRANSACTION_ID,
      },
      policy: null,
      sourceArtifactIds: [ROOT_ID, SECOND_ROOT_ID],
      state: placementState(),
      tx,
    });
    if (!prepared.ok) {
      throw new Error(prepared.error.message);
    }

    await applyPreparedProjectArtifactPlacementLaneWrite({
      organizationId: ORGANIZATION_ID,
      prepared: prepared.value,
      transactionId: "77777777-7777-7777-8777-777777777777",
      tx,
    });
    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: IssueStatus.InProgress },
        where: { id: ROOT_ID, organizationId: ORGANIZATION_ID },
      })
    );
    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: IssueStatus.Todo },
        where: { id: SECOND_ROOT_ID, organizationId: ORGANIZATION_ID },
      })
    );
  });
});

function place(status: IssueStatus): PlaceProjectArtifactsRequest {
  return {
    destinationProjectId: PROJECT_ID,
    expectedProjectVersions: { [PROJECT_ID]: "version-1" },
    idempotencyKey: "placement-1",
    kind: ProjectArtifactPlacementKind.Place,
    lanePatch: {
      field: ProjectArtifactPlacementGroupField.Status,
      value: status,
    },
    position: ProjectArtifactPlacementPosition.Root,
    source: ProjectArtifactPlacementSource.Pointer,
    sourceArtifactIds: [ROOT_ID],
  };
}

function placeWithLanePatch(
  field: ProjectArtifactPlacementGroupField,
  value: string | null,
  sourceArtifactIds = [ROOT_ID]
): PlaceProjectArtifactsRequest {
  return {
    ...place(IssueStatus.Todo),
    lanePatch: { field, value },
    sourceArtifactIds,
  };
}

function artifact(
  status: IssueStatus,
  overrides: Partial<Pick<Artifact, "id" | "type">> = {}
): Artifact {
  const timestamp = new Date("2026-10-19T00:00:00.000Z");
  return {
    assigneeId: null,
    createdAt: timestamp,
    createdById: null,
    dueDate: null,
    externalUrl: null,
    id: overrides.id ?? ROOT_ID,
    name: "Board root",
    organizationId: ORGANIZATION_ID,
    priority: Priority.MEDIUM,
    projectId: PROJECT_ID,
    slug: "ISS-724",
    sortOrder: 0,
    status,
    subtype: ArtifactSubtype.FEATURE,
    templateForType: null,
    type: overrides.type ?? ArtifactType.DOCUMENT,
    updatedAt: timestamp,
  };
}

function activityEvent(
  before: IssueStatus,
  after: IssueStatus
): ArtifactActivityEvent {
  return {
    action: ArtifactActivityAction.StatusChange,
    actorId: ACTOR.userId,
    actorType: ArtifactActivityActorType.User,
    after,
    artifactId: ROOT_ID,
    before,
    createdAt: new Date("2026-10-19T00:00:00.000Z"),
    id: "66666666-6666-7666-8666-666666666666",
    organizationId: ORGANIZATION_ID,
    transactionId: TRANSACTION_ID,
    undoOfTransactionId: null,
  };
}

function placementState(): PlacementState {
  const row = {
    createdAt: new Date("2026-10-19T00:00:00.000Z"),
    id: ROOT_ID,
    projectId: PROJECT_ID,
    sortOrder: 0,
  };
  return {
    allParentIds: new Map(),
    parentProjectIds: new Map(),
    artifacts: [row],
    artifactsById: new Map([[ROOT_ID, row]]),
    canonicalParents: new Map(),
    childrenByParent: new Map(),
    incomingProduces: new Map(),
    projectVersions: { [PROJECT_ID]: "version-1" },
  };
}
