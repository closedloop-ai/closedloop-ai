import { LinkType } from "@repo/api/src/types/artifact";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  artifactFindMany: vi.fn(),
  artifactFindUnique: vi.fn(),
  findTargetLinks: vi.fn(),
  findOperationallyActiveLoop: vi.fn(),
  findWithRegenerationContext: vi.fn(),
  withDb: vi.fn(),
  withDbTx: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: { DOCUMENT: "DOCUMENT" },
  withDb: Object.assign(mocks.withDb, { tx: mocks.withDbTx }),
}));

vi.mock("@repo/github", () => ({
  triggerWorkflowDispatch: vi.fn(),
}));

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: { findTargetLinks: mocks.findTargetLinks },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findOperationallyActiveLoop: mocks.findOperationallyActiveLoop,
  },
}));

vi.mock("@/app/documents/generation-service", () => ({
  documentGenerationService: {
    findPendingWorkflowRun: vi.fn(),
    findWithRegenerationContext: mocks.findWithRegenerationContext,
  },
}));

import { artifactLinksService } from "@/app/artifact-links/service";
import { documentExecutionService } from "@/app/documents/execution-service";
import { documentGenerationService } from "@/app/documents/generation-service";
import { LoopAlreadyActiveError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const FEATURE_ID = "feature-1";
const PROJECT_ID = "project-1";
const PLAN_DOCUMENT_ID = "plan-1";
const PLAN_DOCUMENT_SLUG = "plan-slug";
const REQUEST_COMPUTE_TARGET_ID = "target-request";
const OTHER_COMPUTE_TARGET_ID = "target-other";
const LOCAL_REPO_PATH = "/tmp/current-repo";
const EXISTING_LOCAL_REPO_PATH = "/tmp/existing-repo";

function buildActivePlanLoop(computeTargetId: string | null) {
  return {
    id: "loop-active",
    command: LoopCommand.Plan,
    status: LoopStatus.Running,
    computeTargetId,
    metadata: { localRepoPath: EXISTING_LOCAL_REPO_PATH },
  };
}

function startPlanLoopFromLocal() {
  return documentExecutionService.startPlanLoopFromLocal(
    ORGANIZATION_ID,
    USER_ID,
    {
      computeTargetId: REQUEST_COMPUTE_TARGET_ID,
      featureId: FEATURE_ID,
      localRepoPath: LOCAL_REPO_PATH,
    }
  );
}

describe("documentExecutionService.startPlanLoopFromLocal", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: mocks.artifactFindFirst,
          findMany: mocks.artifactFindMany,
          findUnique: mocks.artifactFindUnique,
        },
      })
    );
    mocks.artifactFindFirst.mockResolvedValue({
      id: FEATURE_ID,
      name: "Feature",
      projectId: PROJECT_ID,
    });
    mocks.artifactFindMany.mockResolvedValue([
      { id: PLAN_DOCUMENT_ID, name: "Plan" },
    ]);
    mocks.artifactFindUnique.mockResolvedValue({ slug: PLAN_DOCUMENT_SLUG });
    mocks.findTargetLinks.mockResolvedValue([
      { targetId: PLAN_DOCUMENT_ID, linkType: LinkType.Produces },
    ]);
    mocks.findWithRegenerationContext.mockResolvedValue(null);
  });

  it("returns already-running for an active plan loop on the same compute target", async () => {
    mocks.findOperationallyActiveLoop.mockResolvedValue(
      buildActivePlanLoop(REQUEST_COMPUTE_TARGET_ID)
    );

    const result = await startPlanLoopFromLocal();

    expect(result).toEqual({
      outcome: "already-running",
      loopId: "loop-active",
      documentId: PLAN_DOCUMENT_ID,
      documentSlug: PLAN_DOCUMENT_SLUG,
      localRepoPath: EXISTING_LOCAL_REPO_PATH,
    });
    expect(artifactLinksService.findTargetLinks).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      FEATURE_ID,
      LinkType.Produces
    );
    expect(loopsService.findOperationallyActiveLoop).toHaveBeenCalledWith(
      PLAN_DOCUMENT_ID,
      LoopCommand.Plan,
      ORGANIZATION_ID
    );
    expect(
      documentGenerationService.findWithRegenerationContext
    ).not.toHaveBeenCalled();
  });

  it("throws LoopAlreadyActiveError for an active plan loop on a different compute target", async () => {
    mocks.findOperationallyActiveLoop.mockResolvedValue(
      buildActivePlanLoop(OTHER_COMPUTE_TARGET_ID)
    );

    const result = startPlanLoopFromLocal();

    await expect(result).rejects.toBeInstanceOf(LoopAlreadyActiveError);
    await expect(result).rejects.toMatchObject({
      existingCommand: LoopCommand.Plan,
      existingLoopId: "loop-active",
      existingStatus: LoopStatus.Running,
    });
    expect(mocks.artifactFindUnique).not.toHaveBeenCalled();
    expect(
      documentGenerationService.findWithRegenerationContext
    ).not.toHaveBeenCalled();
  });
});
