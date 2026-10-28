import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;
const enabledFlags = vi.hoisted(() => new Set<unknown>());

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/lib/identifier-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/identifier-utils")>(
    "@/lib/identifier-utils"
  );
  return { ...actual, resolveProjectId: vi.fn() };
});
vi.mock("@/lib/feature-flag-identity", () => ({
  isFeatureFlagEnabledForAnyIdentity: (flag: unknown) =>
    Promise.resolve(enabledFlags.has(flag)),
}));
vi.mock("@/app/documents/project-artifact-placement-service", () => ({
  projectArtifactPlacementService: { getProjectPlacementState: vi.fn() },
}));
vi.mock("@/app/artifacts/project-artifact-board-placement", () => ({
  placeProjectArtifactsWithLanePatch: vi.fn(),
}));
vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { Result, Status } from "@repo/api/src/types/result";
import { placeProjectArtifactsWithLanePatch } from "@/app/artifacts/project-artifact-board-placement";
import { MANUAL_ARTIFACT_ORDERING_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../../__tests__/utils/auth-helpers";
import { POST } from "./route";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ID = "00000000-0000-4000-8000-000000000002";
const TARGET_ID = "00000000-0000-4000-8000-000000000003";

const placeWithLanePatch = vi.mocked(placeProjectArtifactsWithLanePatch);

/** The request shape the board sends for a drop into another status lane. */
function boardDrag() {
  return {
    destinationProjectId: PROJECT_ID,
    expectedProjectVersions: { [PROJECT_ID]: "board-version" },
    idempotencyKey: "board-drag-1",
    kind: ProjectArtifactPlacementKind.Place,
    lanePatch: {
      field: ProjectArtifactPlacementGroupField.Status,
      value: IssueStatus.Done,
    },
    position: ProjectArtifactPlacementPosition.After,
    source: ProjectArtifactPlacementSource.Pointer,
    sourceArtifactIds: [SOURCE_ID],
    targetArtifactId: TARGET_ID,
  };
}

function postBoardDrag() {
  return POST(
    createMockRequest({ body: boardDrag(), method: "POST" }),
    createMockRouteContext({ id: PROJECT_ID })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  enabledFlags.clear();
  mockAuthContext = createTestAuthContext();
  vi.mocked(resolveProjectId).mockResolvedValue(PROJECT_ID);
  placeWithLanePatch.mockResolvedValue(
    Result.ok({
      affectedArtifactIds: [SOURCE_ID],
      affectedProjectIds: [PROJECT_ID],
      placed: true,
      placement: {
        destinationProjectId: PROJECT_ID,
        position: ProjectArtifactPlacementPosition.After,
        sourceArtifactIds: [SOURCE_ID],
        targetArtifactId: TARGET_ID,
      },
      projectVersions: { [PROJECT_ID]: "board-version-2" },
      replayed: false,
      transactionId: TARGET_ID,
      undoAvailable: true,
    })
  );
});

describe("board drag through the placement route gate", () => {
  it("admits a board drag with manual-artifact-ordering on", async () => {
    enabledFlags.add(MANUAL_ARTIFACT_ORDERING_SERVER_FLAG);

    const response = await postBoardDrag();

    expect(response.status).toBe(200);
    expect(placeWithLanePatch).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      expect.objectContaining({
        lanePatch: {
          field: ProjectArtifactPlacementGroupField.Status,
          value: IssueStatus.Done,
        },
      }),
      expect.objectContaining({ userId: mockAuthContext.user.id }),
      { recordPlaced: undefined }
    );
  });

  it("refuses the board drag with manual-artifact-ordering off", async () => {
    const response = await postBoardDrag();

    expect(response.status).toBe(Status.NotFound);
    expect(placeWithLanePatch).not.toHaveBeenCalled();
  });
});
