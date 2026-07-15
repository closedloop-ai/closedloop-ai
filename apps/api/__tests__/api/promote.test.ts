/**
 * Route tests for POST /agent-components/promote (FEA-2923 PR2).
 *
 * Exercises the real route handler (not a mock self-check):
 * - admin caller → 200 { catalogItemId, distributionId } and both creates
 *   happen inside a single `withDb.tx` invocation (atomicity);
 * - non-admin caller (isOrgAdmin=false) → 403 forbiddenResponse;
 * - unknown agentComponentId → 404.
 */
import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  isOrgAdmin: vi.fn(),
}));

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (ctx: AuthContext, req: unknown, params: unknown) => unknown) =>
    (request: unknown, context: { params: unknown }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: mocks.isOrgAdmin,
}));

import { POST } from "@/app/agent-components/promote/route";

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

const VALID_AC_ID = "11111111-1111-4111-8111-111111111111";

describe("POST /agent-components/promote", () => {
  it("promotes an AgentComponent to CatalogItem + Distribution (admin)", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);

    const catalogCreate = vi.fn().mockResolvedValue({ id: "new-item-1" });
    const versionCreate = vi.fn().mockResolvedValue({ id: "new-version-1" });
    const distributionCreate = vi.fn().mockResolvedValue({ id: "new-dist-1" });
    const txDb = {
      catalogItem: { create: catalogCreate },
      // Promotion snapshots an installable initial version so the auto-install
      // Distribution has non-null content (FEA-2923 §J).
      catalogItemVersion: { create: versionCreate },
      distribution: { create: distributionCreate },
    };

    mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({
        agentComponent: {
          findFirst: vi.fn().mockResolvedValue({
            id: VALID_AC_ID,
            componentKind: "skill",
            name: "My Skill",
            description: "A skill",
          }),
        },
        // FEA-3050 idempotency pre-check: promoteAgentComponent reads
        // catalogItem.findFirst for a prior promotion before creating. null =
        // none exists → the create (200) path runs.
        catalogItem: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );
    mocks.withDb.tx.mockImplementation((cb: (db: unknown) => unknown) =>
      cb(txDb)
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/agent-components/promote",
        body: { agentComponentId: VALID_AC_ID },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      catalogItemId: "new-item-1",
      distributionId: "new-dist-1",
    });

    // Both creates ran inside the SAME withDb.tx invocation (atomicity).
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    // An installable initial version is snapshotted for the promoted item so
    // the auto-install Distribution has non-null content.
    expect(versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          catalogItemId: "new-item-1",
          version: 1,
          content: expect.any(String),
        }),
      })
    );
    expect(catalogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "org_custom",
          scope: "org",
          targetKind: "skill",
        }),
      })
    );
    expect(distributionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mode: DistributionMode.AutoInstall,
          targetingType: DistributionTargetingType.All,
          catalogItemId: "new-item-1",
        }),
      })
    );
  });

  it("returns 403 for a non-admin caller (isOrgAdmin=false)", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/agent-components/promote",
        body: { agentComponentId: VALID_AC_ID },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(403);
    // Admin gate short-circuits before any DB work.
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(mocks.withDb.tx).not.toHaveBeenCalled();
  });

  it("returns 404 when the AgentComponent is not found in the org", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({
        agentComponent: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/agent-components/promote",
        body: { agentComponentId: VALID_AC_ID },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
    // No promotion transaction is opened for an unknown component.
    expect(mocks.withDb.tx).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body (non-uuid agentComponentId)", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/agent-components/promote",
        body: { agentComponentId: "not-a-uuid" },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
  });
});
