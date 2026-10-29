import {
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import type { TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacementPlan } from "../project-artifact-placement-persistence";

const mocks = vi.hoisted(() => ({
  createMany: vi.fn(),
  reportCaptureFailure: vi.fn(),
}));

vi.mock("@/lib/observability/artifact-activity-capture-telemetry", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/observability/artifact-activity-capture-telemetry")
  >("@/lib/observability/artifact-activity-capture-telemetry");
  return {
    ...actual,
    reportArtifactActivityCaptureFailure: mocks.reportCaptureFailure,
  };
});

import { ArtifactActivityCaptureStage } from "@/lib/observability/artifact-activity-capture-telemetry";
import { recordPlacementActivity } from "../project-artifact-placement-activity";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const ACTOR_ID = "00000000-0000-4000-8000-000000000003";
const ROOT_IDS = [
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
];
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000006";
const UNDO_TRANSACTION_ID = "00000000-0000-4000-8000-000000000007";

function plan(): PlacementPlan {
  return {
    mode: "place",
    affectedArtifactIds: ROOT_IDS,
    affectedProjectIds: [PROJECT_ID],
    beforeState: [],
    receiptBeforeState: { version: 2, rankRows: [], movedRootParents: [] },
    destinationParentId: null,
    createdParentIds: new Map(),
    resultParentIds: new Map(),
    currentParentIds: new Map(),
    movedArtifactIds: ROOT_IDS,
    sourceArtifactIds: ROOT_IDS,
    sourceRootMappings: [],
    parentProjections: new Map(),
    placement: {
      sourceArtifactIds: ROOT_IDS,
      destinationProjectId: PROJECT_ID,
      position: ProjectArtifactPlacementPosition.Root,
    },
    rankOrders: new Map(),
  };
}

function client(): TransactionClient {
  return {
    artifactActivityEvent: { createMany: mocks.createMany },
  } as unknown as TransactionClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("placement activity rollback telemetry", () => {
  it("reports a short receipt count with actor and commit lineage before refusing the transaction", async () => {
    mocks.createMany.mockResolvedValue({ count: 1 });

    await expect(
      recordPlacementActivity(
        client(),
        ORGANIZATION_ID,
        { userId: ACTOR_ID, authMethod: "session" },
        TRANSACTION_ID,
        UNDO_TRANSACTION_ID,
        plan(),
        ProjectArtifactPlacementSource.Undo
      )
    ).rejects.toThrow("Placement activity receipts did not reconcile");

    expect(mocks.reportCaptureFailure).toHaveBeenCalledExactlyOnceWith({
      stage: ArtifactActivityCaptureStage.BatchProject,
      organizationId: ORGANIZATION_ID,
      userId: ACTOR_ID,
      rolledBackReceiptCount: 2,
      commitGroupId: TRANSACTION_ID,
      undoOfCommitGroupId: UNDO_TRANSACTION_ID,
      error: expect.any(Error),
    });
  });

  it("reports a rejected insert and omits undo lineage for a forward placement", async () => {
    const failure = new Error("activity unavailable");
    mocks.createMany.mockRejectedValue(failure);

    await expect(
      recordPlacementActivity(
        client(),
        ORGANIZATION_ID,
        { userId: ACTOR_ID, authMethod: "session" },
        TRANSACTION_ID,
        undefined,
        plan(),
        ProjectArtifactPlacementSource.Pointer
      )
    ).rejects.toBe(failure);

    expect(mocks.reportCaptureFailure).toHaveBeenCalledExactlyOnceWith({
      stage: ArtifactActivityCaptureStage.BatchProject,
      organizationId: ORGANIZATION_ID,
      userId: ACTOR_ID,
      rolledBackReceiptCount: 2,
      commitGroupId: TRANSACTION_ID,
      error: failure,
    });
  });
});
