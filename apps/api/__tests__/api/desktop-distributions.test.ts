/**
 * Route tests for the desktop distribution pull/report endpoints (FEA-2923 PR2).
 *
 * These routes are the primary org-isolation boundary for the desktop
 * distribution flow (ComputeTarget ownership gate). Exercises the real handlers:
 *
 * GET /desktop/distributions/assigned
 * - owned computeTargetId → 200 distribution list;
 * - computeTargetId owned by a different org (findOwnedById → null) → 403;
 * - missing computeTargetId query param → 400.
 *
 * POST /desktop/distributions/status
 * - owned computeTarget + valid body → 200 { accepted };
 * - computeTarget not owned (service → Result.err('forbidden')) → 403;
 * - empty reports array (fails schema min(1)) → 400.
 */
import type { DistributionDto } from "@repo/api/src/types/distribution";
import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const mocks = vi.hoisted(() => ({
  findOwnedById: vi.fn(),
  getAssignedForTarget: vi.fn(),
  upsertStatusReports: vi.fn(),
}));

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (ctx: AuthContext, req: unknown, params: unknown) => unknown) =>
    (request: unknown, context: { params: unknown }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: mocks.findOwnedById,
  },
}));

vi.mock("@/app/distributions/service", () => ({
  distributionsService: {
    getAssignedForTarget: mocks.getAssignedForTarget,
    upsertStatusReports: mocks.upsertStatusReports,
  },
}));

import { GET as assignedGET } from "@/app/desktop/distributions/assigned/route";
import { POST as statusPOST } from "@/app/desktop/distributions/status/route";

const VALID_CT_ID = "44444444-4444-4444-8444-444444444444";
const VALID_DIST_ID = "55555555-5555-4555-8555-555555555555";

const ownedTarget = {
  id: VALID_CT_ID,
  organizationId: "org-1",
  userId: "user-1",
};

const mockDto = {
  id: VALID_DIST_ID,
  organizationId: "org-1",
  catalogItemId: "item-1",
  catalogItem: {
    id: "item-1",
    name: "My Plugin",
    targetKind: "plugin",
    source: "org_custom",
  },
  mode: DistributionMode.AutoInstall,
  targetingType: DistributionTargetingType.All,
  desiredEnabled: true,
  targetingEntries: [],
  targetStatuses: [],
  assetDownloadUrl: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
} satisfies DistributionDto;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext({
    user: {
      id: "user-1",
      clerkId: "clerk-user-1",
      organizationId: "org-1",
    } as never,
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
  });
});

describe("GET /desktop/distributions/assigned", () => {
  it("returns the assigned distributions for an owned compute target", async () => {
    mocks.findOwnedById.mockResolvedValue(ownedTarget);
    mocks.getAssignedForTarget.mockResolvedValue([mockDto]);

    const response = await assignedGET(
      createMockRequest({
        url: `http://localhost:3002/desktop/distributions/assigned?computeTargetId=${VALID_CT_ID}`,
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(mocks.findOwnedById).toHaveBeenCalledWith(
      VALID_CT_ID,
      "org-1",
      "user-1",
      "clerk-user-1"
    );
    expect(mocks.getAssignedForTarget).toHaveBeenCalledWith(
      "org-1",
      VALID_CT_ID,
      "user-1"
    );
  });

  it("returns 403 when the compute target is owned by a different org", async () => {
    mocks.findOwnedById.mockResolvedValue(null);

    const response = await assignedGET(
      createMockRequest({
        url: `http://localhost:3002/desktop/distributions/assigned?computeTargetId=${VALID_CT_ID}`,
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(403);
    // Ownership gate short-circuits before any distribution read.
    expect(mocks.getAssignedForTarget).not.toHaveBeenCalled();
  });

  it("returns 400 when computeTargetId is missing", async () => {
    const response = await assignedGET(
      createMockRequest({
        url: "http://localhost:3002/desktop/distributions/assigned",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.findOwnedById).not.toHaveBeenCalled();
  });
});

describe("POST /desktop/distributions/status", () => {
  it("accepts status reports for an owned compute target", async () => {
    mocks.upsertStatusReports.mockResolvedValue(Result.ok(1));

    const response = await statusPOST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/desktop/distributions/status",
        body: {
          computeTargetId: VALID_CT_ID,
          reports: [
            {
              distributionId: VALID_DIST_ID,
              status: DistributionTargetStatusValue.Installed,
            },
          ],
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ accepted: 1 });
    expect(mocks.upsertStatusReports).toHaveBeenCalledWith(
      "org-1",
      VALID_CT_ID,
      "user-1",
      "clerk-user-1",
      expect.arrayContaining([
        expect.objectContaining({ distributionId: VALID_DIST_ID }),
      ])
    );
  });

  it("returns 403 when the service reports the compute target is not owned", async () => {
    mocks.upsertStatusReports.mockResolvedValue(Result.err("forbidden"));

    const response = await statusPOST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/desktop/distributions/status",
        body: {
          computeTargetId: VALID_CT_ID,
          reports: [
            {
              distributionId: VALID_DIST_ID,
              status: DistributionTargetStatusValue.Installed,
            },
          ],
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(403);
  });

  it("returns 400 for an empty reports array (fails schema min(1))", async () => {
    const response = await statusPOST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/desktop/distributions/status",
        body: { computeTargetId: VALID_CT_ID, reports: [] },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.upsertStatusReports).not.toHaveBeenCalled();
  });
});
