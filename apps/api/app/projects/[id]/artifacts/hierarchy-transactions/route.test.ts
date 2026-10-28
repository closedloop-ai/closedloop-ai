import { ProjectArtifactPlacementErrorReason } from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectHierarchyOperation,
  ProjectHierarchyPlacement,
  ProjectHierarchySource,
} from "@repo/api/src/types/project-hierarchy-transaction";
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

let authContext: import("@/lib/auth/with-auth").AuthContext;
const mocks = vi.hoisted(() => ({
  getRevision: vi.fn(),
  transact: vi.fn(),
  resolveProjectId: vi.fn(),
}));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(authContext, request, context?.params),
}));
vi.mock("@/lib/identifier-utils", async () => ({
  ...(await vi.importActual<typeof import("@/lib/identifier-utils")>(
    "@/lib/identifier-utils"
  )),
  resolveProjectId: mocks.resolveProjectId,
}));
vi.mock("@/app/projects/project-hierarchy-compatibility-service", () => ({
  projectHierarchyCompatibilityService: mocks,
}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() },
}));

import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../../__tests__/utils/auth-helpers";
import { GET, POST } from "./route";

const projectId = "00000000-0000-4000-8000-000000000001";
const artifactId = "00000000-0000-4000-8000-000000000002";
const transactionId = "00000000-0000-4000-8000-000000000003";

beforeEach(() => {
  vi.clearAllMocks();
  authContext = createTestAuthContext();
  mocks.resolveProjectId.mockResolvedValue(projectId);
  mocks.getRevision.mockResolvedValue({ projectId, revision: "v1" });
  mocks.transact.mockResolvedValue(
    Result.ok({
      transactionId,
      changedArtifactIds: [artifactId],
      descendantCount: 0,
      projectRevisions: [{ projectId, revision: "v2" }],
      inverse: { transactionId },
      replayed: false,
    })
  );
});

describe("ungated hierarchy compatibility route", () => {
  it("reads the flag-off project revision", async () => {
    const response = await GET(
      createMockRequest({ method: "GET" }),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(200);
    expect(mocks.getRevision).toHaveBeenCalledWith(
      projectId,
      authContext.user.organizationId,
      expect.objectContaining({ userId: authContext.user.id })
    );
  });

  it("accepts one selected-set transaction without the manual flag gate", async () => {
    const body = {
      operation: ProjectHierarchyOperation.Move,
      artifactIds: [artifactId],
      placement: ProjectHierarchyPlacement.End,
      expectedRevisions: [{ projectId, revision: "v1" }],
      idempotencyKey: transactionId,
      source: ProjectHierarchySource.Api,
    };
    const response = await POST(
      createMockRequest({ method: "POST", body }),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(200);
    expect(mocks.transact).toHaveBeenCalledOnce();
    expect(mocks.transact).toHaveBeenCalledWith(
      projectId,
      authContext.user.organizationId,
      expect.objectContaining({ userId: authContext.user.id }),
      body,
      undefined
    );
  });

  it("responds 409 when the rendered hierarchy revision is stale", async () => {
    mocks.transact.mockResolvedValueOnce(
      Result.err({
        status: Status.Conflict,
        message: "Project hierarchy changed since it was read",
        detail: { reason: ProjectArtifactPlacementErrorReason.StaleVersion },
      })
    );
    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          operation: ProjectHierarchyOperation.Move,
          artifactIds: [artifactId],
          placement: ProjectHierarchyPlacement.Start,
          expectedRevisions: [{ projectId, revision: "rendered-v1" }],
          idempotencyKey: transactionId,
          source: ProjectHierarchySource.Api,
        },
      }),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(409);
    expect(mocks.transact).toHaveBeenCalledWith(
      projectId,
      authContext.user.organizationId,
      expect.anything(),
      expect.objectContaining({
        expectedRevisions: [{ projectId, revision: "rendered-v1" }],
      }),
      undefined
    );
  });
});
