/**
 * Route tests for the admin distributions endpoints (FEA-2923 PR2).
 *
 * Exercises the real route handlers (not service-only mocks):
 * - GET /distributions — happy path returns the org list;
 * - POST /distributions — admin 200, non-admin 403 (service returns 403),
 *   invalid catalogItemId 400 (service returns 400), and schema rejection of a
 *   "specific" distribution with no targeting entries (400).
 */
import type { DistributionDto } from "@repo/api/src/types/distribution";
import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (ctx: AuthContext, req: unknown, params: unknown) => unknown) =>
    (request: unknown, context: { params: unknown }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@/app/distributions/service", () => ({
  distributionsService: {
    listForOrg: vi.fn(),
    create: vi.fn(),
  },
}));

import { GET, POST } from "@/app/distributions/route";
import { distributionsService } from "@/app/distributions/service";

const VALID_CATALOG_ID = "22222222-2222-4222-8222-222222222222";
const VALID_CT_ID = "33333333-3333-4333-8333-333333333333";

const mockDto = {
  id: "dist-1",
  organizationId: "org-1",
  catalogItemId: VALID_CATALOG_ID,
  catalogItem: {
    id: VALID_CATALOG_ID,
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

describe("GET /distributions", () => {
  it("returns the org distribution list", async () => {
    vi.mocked(distributionsService.listForOrg).mockResolvedValue([mockDto]);

    const response = await GET(
      createMockRequest({ url: "http://localhost:3002/distributions" }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(distributionsService.listForOrg).toHaveBeenCalledWith("org-1");
  });
});

describe("POST /distributions", () => {
  it("creates a distribution for an admin caller", async () => {
    vi.mocked(distributionsService.create).mockResolvedValue(
      Result.ok(mockDto)
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/distributions",
        body: {
          catalogItemId: VALID_CATALOG_ID,
          mode: DistributionMode.AutoInstall,
          targetingType: DistributionTargetingType.All,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("dist-1");
    expect(distributionsService.create).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "clerk-org-1",
      "clerk-user-1",
      expect.objectContaining({ catalogItemId: VALID_CATALOG_ID })
    );
  });

  it("returns 403 when the service reports the caller is not an admin", async () => {
    vi.mocked(distributionsService.create).mockResolvedValue(
      Result.err(Status.Forbidden)
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/distributions",
        body: {
          catalogItemId: VALID_CATALOG_ID,
          mode: DistributionMode.AutoInstall,
          targetingType: DistributionTargetingType.All,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(403);
  });

  it("returns 400 when the service reports an invalid catalogItemId", async () => {
    vi.mocked(distributionsService.create).mockResolvedValue(
      Result.err(Status.BadRequest)
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/distributions",
        body: {
          catalogItemId: VALID_CATALOG_ID,
          mode: DistributionMode.AutoInstall,
          targetingType: DistributionTargetingType.All,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
  });

  it("rejects a 'specific' distribution with no targeting entries (schema 400)", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/distributions",
        body: {
          catalogItemId: VALID_CATALOG_ID,
          mode: DistributionMode.AutoInstall,
          targetingType: DistributionTargetingType.Specific,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    // Schema rejects before the service is ever consulted.
    expect(distributionsService.create).not.toHaveBeenCalled();
  });

  it("accepts a 'specific' distribution with at least one target", async () => {
    vi.mocked(distributionsService.create).mockResolvedValue(
      Result.ok({
        ...mockDto,
        targetingType: DistributionTargetingType.Specific,
        targetingEntries: [{ computeTargetId: VALID_CT_ID, userId: null }],
      })
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/distributions",
        body: {
          catalogItemId: VALID_CATALOG_ID,
          mode: DistributionMode.AutoInstall,
          targetingType: DistributionTargetingType.Specific,
          targetComputeTargetIds: [VALID_CT_ID],
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(distributionsService.create).toHaveBeenCalledTimes(1);
  });
});
