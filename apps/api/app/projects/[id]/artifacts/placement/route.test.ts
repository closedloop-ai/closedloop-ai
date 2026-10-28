import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;
const withProjectArtifactPlacementGate = vi.hoisted(() => vi.fn());

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
vi.mock("@/lib/manual-artifact-ordering-feature", () => ({
  withProjectArtifactPlacementGate,
}));
vi.mock("@/app/projects/service", () => ({
  projectsService: { findById: vi.fn() },
}));
vi.mock("@/app/documents/project-artifact-placement-service", () => ({
  projectArtifactPlacementService: {
    getProjectPlacementState: vi.fn(),
  },
}));
vi.mock("@/app/artifacts/project-artifact-board-placement", () => ({
  placeProjectArtifactsWithLanePatch: vi.fn(),
}));
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

import { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { Result, Status } from "@repo/api/src/types/result";
import { placeProjectArtifactsWithLanePatch } from "@/app/artifacts/project-artifact-board-placement";
import { projectArtifactPlacementService } from "@/app/documents/project-artifact-placement-service";
import { projectsService } from "@/app/projects/service";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../../__tests__/utils/auth-helpers";
import { GET, POST } from "./route";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ID = "00000000-0000-4000-8000-000000000002";
const TARGET_ID = "00000000-0000-4000-8000-000000000003";

const getProjectPlacementState = vi.mocked(
  projectArtifactPlacementService.getProjectPlacementState
);
const placeProjectArtifacts = vi.mocked(placeProjectArtifactsWithLanePatch);
const resolveProjectIdMock = vi.mocked(resolveProjectId);
const findProject = vi.mocked(projectsService.findById);

function body(overrides: Record<string, unknown> = {}) {
  return {
    kind: ProjectArtifactPlacementKind.Place,
    sourceArtifactIds: [SOURCE_ID],
    destinationProjectId: PROJECT_ID,
    position: ProjectArtifactPlacementPosition.Before,
    targetArtifactId: TARGET_ID,
    expectedProjectVersions: { [PROJECT_ID]: "v1" },
    idempotencyKey: "placement-1",
    source: ProjectArtifactPlacementSource.Pointer,
    ...overrides,
  };
}

function postRequest(requestBody: unknown) {
  return POST(
    createMockRequest({ method: "POST", body: requestBody }),
    createMockRouteContext({ id: PROJECT_ID })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  withProjectArtifactPlacementGate.mockImplementation(
    async (_auth: unknown, onEnabled: () => unknown): Promise<unknown> =>
      onEnabled()
  );
  resolveProjectIdMock.mockResolvedValue(PROJECT_ID);
  findProject.mockResolvedValue({ id: PROJECT_ID } as never);
});

describe("project artifact placement route", () => {
  it.each([
    {
      manualArtifactOrdering: false,
      expectedStatus: Status.NotFound,
    },
    {
      manualArtifactOrdering: true,
      expectedStatus: 200,
    },
  ])(
    "gates GET with manual ordering=$manualArtifactOrdering",
    async ({ manualArtifactOrdering, expectedStatus }) => {
      withProjectArtifactPlacementGate.mockImplementation(
        async (
          _auth: unknown,
          onEnabled: () => unknown,
          onDisabled: () => unknown
        ): Promise<unknown> =>
          manualArtifactOrdering ? onEnabled() : onDisabled()
      );
      getProjectPlacementState.mockResolvedValue({
        projectVersion: "version-current",
        canPlaceArtifacts: true,
      });

      const response = await GET(
        createMockRequest({ method: "GET" }),
        createMockRouteContext({ id: PROJECT_ID })
      );

      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === Status.NotFound) {
        expect(getProjectPlacementState).not.toHaveBeenCalled();
      } else {
        expect(getProjectPlacementState).toHaveBeenCalledTimes(1);
      }
    }
  );

  it.each([
    {
      manualArtifactOrdering: false,
      expectedStatus: Status.NotFound,
    },
    {
      manualArtifactOrdering: true,
      expectedStatus: 200,
    },
  ])(
    "gates POST with manual ordering=$manualArtifactOrdering",
    async ({ manualArtifactOrdering, expectedStatus }) => {
      withProjectArtifactPlacementGate.mockImplementation(
        async (
          _auth: unknown,
          onEnabled: () => unknown,
          onDisabled: () => unknown
        ): Promise<unknown> =>
          manualArtifactOrdering ? onEnabled() : onDisabled()
      );
      placeProjectArtifacts.mockResolvedValue(
        Result.ok({
          placed: true,
          transactionId: TARGET_ID,
          affectedArtifactIds: [SOURCE_ID],
          affectedProjectIds: [PROJECT_ID],
          projectVersions: { [PROJECT_ID]: "v2" },
          placement: {
            sourceArtifactIds: [SOURCE_ID],
            destinationProjectId: PROJECT_ID,
            position: ProjectArtifactPlacementPosition.Before,
            targetArtifactId: TARGET_ID,
          },
          replayed: false,
          undoAvailable: true,
        })
      );

      const response = await postRequest(body());

      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === Status.NotFound) {
        expect(placeProjectArtifacts).not.toHaveBeenCalled();
      } else {
        expect(placeProjectArtifacts).toHaveBeenCalledTimes(1);
      }
    }
  );

  it("AC-009 returns the opaque current version", async () => {
    getProjectPlacementState.mockResolvedValue({
      projectVersion: "version-current",
      canPlaceArtifacts: true,
    });
    const response = await GET(
      createMockRequest({ method: "GET" }),
      createMockRouteContext({ id: PROJECT_ID })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        projectId: PROJECT_ID,
        projectVersion: "version-current",
        canPlaceArtifacts: true,
      },
    });
  });

  it("reports read-only API-key placement authority", async () => {
    mockAuthContext = createTestAuthContext({
      authMethod: "api_key",
      apiKeyScopes: [ApiKeyScope.Read],
    });
    getProjectPlacementState.mockResolvedValue({
      projectVersion: "version-current",
      canPlaceArtifacts: false,
    });

    const response = await GET(
      createMockRequest({ method: "GET" }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        projectId: PROJECT_ID,
        projectVersion: "version-current",
        canPlaceArtifacts: false,
      },
    });
  });

  it("AC-008 rejects malformed placement before the service", async () => {
    const response = await postRequest(body({ sourceArtifactIds: [] }));
    expect(response.status).toBe(400);
    expect(placeProjectArtifacts).not.toHaveBeenCalled();
  });

  it("AC-008 preserves a structured cycle reason in the 400 envelope", async () => {
    placeProjectArtifacts.mockResolvedValue(
      Result.err({
        status: Status.BadRequest,
        message: "Placement would create a cycle",
        detail: { reason: ProjectArtifactPlacementErrorReason.Cycle },
      })
    );
    const response = await postRequest(body());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Placement would create a cycle",
      code: ProjectArtifactPlacementErrorReason.Cycle,
    });
  });

  it("AC-009 preserves current versions in the 409 conflict body", async () => {
    placeProjectArtifacts.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        message: "Project hierarchy changed since it was read",
        detail: {
          reason: ProjectArtifactPlacementErrorReason.StaleVersion,
          actualProjectVersions: { [PROJECT_ID]: "v2" },
        },
      })
    );
    const response = await postRequest(body());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: "Project hierarchy changed since it was read",
      data: {
        reason: ProjectArtifactPlacementErrorReason.StaleVersion,
        actualProjectVersions: { [PROJECT_ID]: "v2" },
      },
    });
  });

  it("AC-008 resolves and scopes the route project before placement", async () => {
    placeProjectArtifacts.mockResolvedValue(
      Result.ok({
        placed: true,
        transactionId: TARGET_ID,
        affectedArtifactIds: [SOURCE_ID],
        affectedProjectIds: [PROJECT_ID],
        projectVersions: { [PROJECT_ID]: "v2" },
        placement: {
          sourceArtifactIds: [SOURCE_ID],
          destinationProjectId: PROJECT_ID,
          position: ProjectArtifactPlacementPosition.Before,
          targetArtifactId: TARGET_ID,
        },
        replayed: false,
        undoAvailable: true,
      })
    );
    const response = await postRequest(body());
    expect(response.status).toBe(200);
    expect(placeProjectArtifacts).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      body(),
      {
        userId: mockAuthContext.user.id,
        authMethod: mockAuthContext.authMethod,
        apiKeyId: undefined,
        desktopSessionId: undefined,
        tagPermissions: { canApply: true, canRemove: true },
      },
      { recordPlaced: undefined }
    );
  });
});
