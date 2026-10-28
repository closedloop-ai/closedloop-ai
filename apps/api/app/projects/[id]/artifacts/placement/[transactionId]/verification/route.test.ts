import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;
const mocks = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  recover: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@/lib/identifier-utils", () => ({
  resolveProjectId: vi.fn(),
}));
vi.mock("@/lib/manual-artifact-ordering-feature", () => ({
  isManualArtifactOrderingEnabled: mocks.featureEnabled,
}));
vi.mock(
  "@/app/documents/project-artifact-placement-verification-service",
  () => ({
    projectArtifactPlacementVerificationService: {
      recoverProjectArtifactPlacement: mocks.recover,
      verifyProjectArtifactPlacement: mocks.verify,
    },
  })
);
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

import {
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementVerificationStatus,
} from "@repo/api/src/types/project-artifact-placement";
import { Result, Status } from "@repo/api/src/types/result";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../../../../__tests__/utils/auth-helpers";
import { GET, POST } from "./route";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000002";
const PROJECT_VERSION = "version-1";

function routeContext() {
  return createMockRouteContext({
    id: PROJECT_ID,
    transactionId: TRANSACTION_ID,
  });
}

function verificationResponse() {
  return {
    transactionId: TRANSACTION_ID,
    status: ProjectArtifactPlacementVerificationStatus.Consistent,
    affectedProjectIds: [PROJECT_ID],
    projectVersions: { [PROJECT_ID]: PROJECT_VERSION },
    driftedArtifactIds: [],
    canRecover: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mocks.featureEnabled.mockResolvedValue(true);
  vi.mocked(resolveProjectId).mockResolvedValue(PROJECT_ID);
});

describe("project artifact placement verification route", () => {
  it("hides verification when manual ordering is not enabled", async () => {
    mocks.featureEnabled.mockResolvedValue(false);

    const response = await GET(
      createMockRequest({ method: "GET" }),
      routeContext()
    );

    expect(response.status).toBe(Status.NotFound);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("verifies a receipt through the authenticated project scope", async () => {
    mocks.verify.mockResolvedValue(Result.ok(verificationResponse()));

    const response = await GET(
      createMockRequest({ method: "GET" }),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: verificationResponse(),
    });
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        routeProjectId: PROJECT_ID,
        organizationId: mockAuthContext.user.organizationId,
        transactionId: TRANSACTION_ID,
        actor: expect.objectContaining({
          userId: mockAuthContext.user.id,
          authMethod: mockAuthContext.authMethod,
        }),
      })
    );
  });

  it("passes fresh project versions to atomic recovery", async () => {
    mocks.recover.mockResolvedValue(Result.ok(verificationResponse()));

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { expectedProjectVersions: { [PROJECT_ID]: PROJECT_VERSION } },
      }),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledWith(
      expect.objectContaining({
        routeProjectId: PROJECT_ID,
        organizationId: mockAuthContext.user.organizationId,
        transactionId: TRANSACTION_ID,
        expectedProjectVersions: { [PROJECT_ID]: PROJECT_VERSION },
      }),
      undefined
    );
  });

  it("preserves stale-version details in the recovery conflict", async () => {
    mocks.recover.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        message: "Project hierarchy changed since it was read",
        detail: {
          reason: ProjectArtifactPlacementErrorReason.StaleVersion,
          actualProjectVersions: { [PROJECT_ID]: "version-2" },
        },
      })
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { expectedProjectVersions: { [PROJECT_ID]: PROJECT_VERSION } },
      }),
      routeContext()
    );

    expect(response.status).toBe(Status.Conflict);
    expect(await response.json()).toEqual({
      success: false,
      error: "Project hierarchy changed since it was read",
      data: {
        reason: ProjectArtifactPlacementErrorReason.StaleVersion,
        actualProjectVersions: { [PROJECT_ID]: "version-2" },
      },
    });
  });
});
