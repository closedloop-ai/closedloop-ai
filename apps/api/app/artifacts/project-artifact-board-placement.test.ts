import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  type ProjectArtifactPlacementRequest,
  type ProjectArtifactPlacementResponse,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyLaneWrite: vi.fn(),
  applyPlacement: vi.fn(),
  emitStatusSideEffects: vi.fn(),
  laneStatusTransitions: vi.fn(),
  prepareLaneWrite: vi.fn(),
  readAllKindsPlacementState: vi.fn(),
  txCommitted: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  return {
    ...actual,
    withDb: Object.assign(vi.fn(), {
      tx: async (run: (tx: unknown) => Promise<unknown>) => {
        const value = await run({});
        mocks.txCommitted(value);
        return value;
      },
    }),
  };
});
vi.mock("@/app/documents/project-artifact-placement-service", () => ({
  applyProjectArtifactPlacementInTransaction: mocks.applyPlacement,
}));
vi.mock("@/app/documents/project-artifact-placement-service-support", () => ({
  readAllKindsPlacementState: mocks.readAllKindsPlacementState,
}));
vi.mock("@/app/artifacts/project-artifact-placement-lane-write", () => ({
  applyPreparedProjectArtifactPlacementLaneWrite: mocks.applyLaneWrite,
  preparedLaneStatusTransitions: mocks.laneStatusTransitions,
  prepareProjectArtifactPlacementLaneWrite: mocks.prepareLaneWrite,
}));
vi.mock("@/app/documents/batch-status-side-effects", () => ({
  emitBatchStatusSideEffects: mocks.emitStatusSideEffects,
}));

import { placeProjectArtifactsWithLanePatch } from "./project-artifact-board-placement";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";
const ROOT_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_ROOT_ID = "00000000-0000-4000-8000-000000000006";
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000004";
const UNDO_TRANSACTION_ID = "00000000-0000-4000-8000-000000000005";
const ACTOR = { authMethod: "session", userId: "user" } as const;

const PREPARED_PATCH = { kind: "patch" } as const;
const STALE_LANE = {
  detail: { reason: ProjectArtifactPlacementErrorReason.StaleVersion },
  message: "Project hierarchy changed since it was read",
  status: Status.Conflict,
};

function placed(
  overrides: Partial<ProjectArtifactPlacementResponse> = {}
): ProjectArtifactPlacementResponse {
  return {
    affectedArtifactIds: [ROOT_ID],
    affectedProjectIds: [PROJECT_ID],
    placed: true,
    placement: {
      destinationProjectId: PROJECT_ID,
      position: ProjectArtifactPlacementPosition.Root,
      sourceArtifactIds: [ROOT_ID],
    },
    projectVersions: { [PROJECT_ID]: "v2" },
    replayed: false,
    transactionId: TRANSACTION_ID,
    undoAvailable: true,
    ...overrides,
  } as ProjectArtifactPlacementResponse;
}

function placeRequest(): ProjectArtifactPlacementRequest {
  return {
    destinationProjectId: PROJECT_ID,
    expectedProjectVersions: { [PROJECT_ID]: "v1" },
    idempotencyKey: "key-1",
    kind: ProjectArtifactPlacementKind.Place,
    lanePatch: {
      field: ProjectArtifactPlacementGroupField.Status,
      value: IssueStatus.Done,
    },
    position: ProjectArtifactPlacementPosition.Root,
    source: ProjectArtifactPlacementSource.Pointer,
    sourceArtifactIds: [ROOT_ID],
  } as ProjectArtifactPlacementRequest;
}

function undoRequest(): ProjectArtifactPlacementRequest {
  return {
    expectedProjectVersions: { [PROJECT_ID]: "v2" },
    idempotencyKey: "key-2",
    kind: ProjectArtifactPlacementKind.Undo,
    source: ProjectArtifactPlacementSource.Undo,
    undoOfTransactionId: UNDO_TRANSACTION_ID,
  } as ProjectArtifactPlacementRequest;
}

/** Run the placement core like PRD-725 does: the validator gates writes. */
function placementCoreRunsValidator(response = placed()) {
  mocks.applyPlacement.mockImplementation(
    async (
      _tx: unknown,
      params: {
        input: ProjectArtifactPlacementRequest;
        validatePlacement?: (context: unknown) => Promise<unknown>;
      }
    ) => {
      if (params.input.kind === ProjectArtifactPlacementKind.Place) {
        const refusal = await params.validatePlacement?.({
          affectedProjectIds: [PROJECT_ID],
          input: params.input,
          sourceArtifactIds: [ROOT_ID],
        });
        if (refusal) {
          return Result.err(refusal);
        }
      }
      return Result.ok(response);
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readAllKindsPlacementState.mockResolvedValue({ projectVersions: {} });
  mocks.applyLaneWrite.mockResolvedValue(undefined);
  mocks.emitStatusSideEffects.mockResolvedValue(undefined);
  mocks.laneStatusTransitions.mockReturnValue([]);
});

describe("placeProjectArtifactsWithLanePatch", () => {
  it("applies the prepared lane write under the placement transaction id", async () => {
    placementCoreRunsValidator();
    mocks.prepareLaneWrite.mockResolvedValue(Result.ok(PREPARED_PATCH));

    const result = await placeProjectArtifactsWithLanePatch(
      PROJECT_ID,
      ORGANIZATION_ID,
      placeRequest(),
      ACTOR
    );

    expect(result.ok).toBe(true);
    expect(mocks.applyLaneWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        prepared: PREPARED_PATCH,
        transactionId: TRANSACTION_ID,
      })
    );
    expect(mocks.applyPlacement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fieldRevisions: false, includeAllTypes: true })
    );
    expect(mocks.readAllKindsPlacementState).toHaveBeenCalledWith(
      expect.anything(),
      ORGANIZATION_ID,
      [PROJECT_ID]
    );
  });

  it("emits the board status side effects once the transaction commits", async () => {
    placementCoreRunsValidator();
    mocks.prepareLaneWrite.mockResolvedValue(Result.ok(PREPARED_PATCH));
    mocks.laneStatusTransitions.mockReturnValue([
      {
        after: IssueStatus.Done,
        before: IssueStatus.Todo,
        documentId: ROOT_ID,
      },
    ]);
    mocks.emitStatusSideEffects.mockImplementation(() => {
      expect(mocks.txCommitted).toHaveBeenCalledTimes(1);
      return Promise.resolve();
    });

    const result = await placeProjectArtifactsWithLanePatch(
      PROJECT_ID,
      ORGANIZATION_ID,
      placeRequest(),
      ACTOR
    );

    expect(result.ok).toBe(true);
    expect(mocks.emitStatusSideEffects).toHaveBeenCalledWith({
      authMethod: ACTOR.authMethod,
      changedIds: [ROOT_ID],
      status: IssueStatus.Done,
      surface: ArtifactStatusEditSurface.Board,
      transactionId: TRANSACTION_ID,
      transitions: [
        {
          after: IssueStatus.Done,
          before: IssueStatus.Todo,
          documentId: ROOT_ID,
        },
      ],
      user: { id: ACTOR.userId, organizationId: ORGANIZATION_ID },
    });
  });

  it("emits one status side effect per restored status on Undo", async () => {
    placementCoreRunsValidator(placed({ undoAvailable: false }));
    mocks.prepareLaneWrite.mockResolvedValue(Result.ok({ kind: "restore" }));
    mocks.laneStatusTransitions.mockReturnValue([
      {
        after: IssueStatus.Todo,
        before: IssueStatus.Done,
        documentId: ROOT_ID,
      },
      {
        after: IssueStatus.Backlog,
        before: IssueStatus.Done,
        documentId: OTHER_ROOT_ID,
      },
    ]);

    await placeProjectArtifactsWithLanePatch(
      PROJECT_ID,
      ORGANIZATION_ID,
      undoRequest(),
      ACTOR
    );

    expect(mocks.emitStatusSideEffects).toHaveBeenCalledTimes(2);
    expect(mocks.emitStatusSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        changedIds: [OTHER_ROOT_ID],
        status: IssueStatus.Backlog,
        undoOfTransactionId: UNDO_TRANSACTION_ID,
      })
    );
  });

  it("returns a lane refusal from the validator without a lane write", async () => {
    placementCoreRunsValidator();
    mocks.prepareLaneWrite.mockResolvedValue(Result.err(STALE_LANE));

    const result = await placeProjectArtifactsWithLanePatch(
      PROJECT_ID,
      ORGANIZATION_ID,
      placeRequest(),
      ACTOR
    );

    expect(result).toEqual(Result.err(STALE_LANE));
    expect(mocks.applyLaneWrite).not.toHaveBeenCalled();
  });

  it("leaves a Place without a lane patch to the placement core alone", async () => {
    placementCoreRunsValidator();
    const { lanePatch: _lanePatch, ...listPlacement } =
      placeRequest() as Extract<
        ProjectArtifactPlacementRequest,
        { kind: typeof ProjectArtifactPlacementKind.Place }
      >;

    const result = await placeProjectArtifactsWithLanePatch(
      PROJECT_ID,
      ORGANIZATION_ID,
      listPlacement,
      ACTOR
    );

    expect(result.ok).toBe(true);
    expect(mocks.prepareLaneWrite).not.toHaveBeenCalled();
    expect(mocks.readAllKindsPlacementState).not.toHaveBeenCalled();
  });

  it("does not write the lane again for a replayed receipt", async () => {
    placementCoreRunsValidator(placed({ replayed: true }));
    mocks.prepareLaneWrite.mockResolvedValue(Result.ok(PREPARED_PATCH));

    const result = await placeProjectArtifactsWithLanePatch(
      PROJECT_ID,
      ORGANIZATION_ID,
      placeRequest(),
      ACTOR
    );

    expect(result.ok).toBe(true);
    expect(mocks.applyLaneWrite).not.toHaveBeenCalled();
  });

  it("rolls the Undo transaction back when the lane restore is refused", async () => {
    placementCoreRunsValidator(placed({ undoAvailable: false }));
    mocks.prepareLaneWrite.mockResolvedValue(Result.err(STALE_LANE));

    const result = await placeProjectArtifactsWithLanePatch(
      PROJECT_ID,
      ORGANIZATION_ID,
      undoRequest(),
      ACTOR
    );

    expect(result).toEqual(Result.err(STALE_LANE));
    expect(mocks.txCommitted).not.toHaveBeenCalled();
    expect(mocks.applyLaneWrite).not.toHaveBeenCalled();
    expect(mocks.emitStatusSideEffects).not.toHaveBeenCalled();
    expect(mocks.prepareLaneWrite).toHaveBeenCalledWith(
      expect.objectContaining({ placement: undoRequest() })
    );
  });

  it("restores the lane fields after an Undo restores the hierarchy", async () => {
    placementCoreRunsValidator(placed({ undoAvailable: false }));
    const restore = { kind: "restore" } as const;
    mocks.prepareLaneWrite.mockResolvedValue(Result.ok(restore));

    const result = await placeProjectArtifactsWithLanePatch(
      PROJECT_ID,
      ORGANIZATION_ID,
      undoRequest(),
      ACTOR
    );

    expect(result.ok).toBe(true);
    expect(mocks.txCommitted).toHaveBeenCalledTimes(1);
    expect(mocks.applyLaneWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        prepared: restore,
        transactionId: TRANSACTION_ID,
      })
    );
  });
});
