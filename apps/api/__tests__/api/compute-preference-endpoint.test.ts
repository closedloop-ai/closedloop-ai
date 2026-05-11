/**
 * T-6.1 — GET /settings/compute-preference endpoint
 *
 * Verifies:
 * 1. Fast-path: when user.preferredComputeMode is set (LOCAL or CLOUD),
 *    the endpoint returns it immediately without calling resolveEffectiveComputePreference.
 * 2. NULL-fallback: when user.preferredComputeMode is NULL, delegates to
 *    resolveEffectiveComputePreference which inspects registered compute targets.
 *    - NULL + online registered targets → LOCAL
 *    - NULL + no online registered targets → CLOUD
 *    - NULL + no registered targets → CLOUD
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));

// Mock withDb so we can control what preferredComputeMode is returned per test
const mockUserFindUnique = vi.fn();
const mockUserUpdate = vi.fn();
vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
      })
    ),
    { tx: vi.fn() }
  ),
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

// Mock computeTargetsService used by resolveEffectiveComputePreference
vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
      register: vi.fn(),
      listByOwner: vi.fn(),
      listAvailableForOrg: vi.fn(),
      heartbeat: vi.fn(),
      updateOwned: vi.fn(),
      deleteOwned: vi.fn(),
      markStaleTargetsOffline: vi.fn(),
      findOwnedById: vi.fn(),
      findAccessibleById: vi.fn(),
    },
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// --- Imports (after mocks) ---

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { GET, PUT } from "@/app/settings/compute-preference/route";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const makeTarget = (overrides: Partial<ComputeTarget> = {}): ComputeTarget => ({
  id: "target-1",
  organizationId: "org-1",
  userId: "user-1",
  machineName: "Test-MBP",
  platform: "darwin",
  capabilities: {},
  supportedOperations: [],
  lastSeenAt: new Date(),
  isOnline: true,
  isSharedWithOrg: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext({
    user: {
      id: "user-1",
      organizationId: "org-1",
    } as any,
  });
});

describe("GET /settings/compute-preference — fast-path (explicit preference set)", () => {
  it("returns LOCAL immediately when user.preferredComputeMode is LOCAL", async () => {
    mockUserFindUnique.mockResolvedValue({ preferredComputeMode: "LOCAL" });

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/settings/compute-preference",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.preferredComputeMode).toBe("LOCAL");
    expect(json.data.isExplicit).toBe(true);
    // Fast-path: should not call the targets service
    expect(computeTargetsService.listAvailableForOrg).not.toHaveBeenCalled();
  });

  it("returns CLOUD immediately when user.preferredComputeMode is CLOUD", async () => {
    mockUserFindUnique.mockResolvedValue({ preferredComputeMode: "CLOUD" });

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/settings/compute-preference",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.preferredComputeMode).toBe("CLOUD");
    expect(json.data.isExplicit).toBe(true);
    // Fast-path: should not call the targets service
    expect(computeTargetsService.listAvailableForOrg).not.toHaveBeenCalled();
  });
});

describe("GET /settings/compute-preference — NULL-fallback (delegates to resolveEffectiveComputePreference)", () => {
  it("returns LOCAL when user has no preference but has online compute targets", async () => {
    mockUserFindUnique.mockResolvedValue({ preferredComputeMode: null });
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      makeTarget({ isOnline: true }),
    ]);

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/settings/compute-preference",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.preferredComputeMode).toBe("LOCAL");
    expect(json.data.isExplicit).toBe(false);
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledWith(
      "org-1",
      "user-1"
    );
  });

  it("returns CLOUD when user has no preference and only has offline compute targets", async () => {
    mockUserFindUnique.mockResolvedValue({ preferredComputeMode: null });
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      makeTarget({ isOnline: false }),
    ]);

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/settings/compute-preference",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.preferredComputeMode).toBe("CLOUD");
    expect(json.data.isExplicit).toBe(false);
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledWith(
      "org-1",
      "user-1"
    );
  });

  it("returns CLOUD when user has no preference and has no registered compute targets", async () => {
    mockUserFindUnique.mockResolvedValue({ preferredComputeMode: null });
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([]);

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/settings/compute-preference",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.preferredComputeMode).toBe("CLOUD");
    expect(json.data.isExplicit).toBe(false);
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledWith(
      "org-1",
      "user-1"
    );
  });

  it("returns CLOUD when user record is not found (NULL-fallback with empty target list)", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([]);

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/settings/compute-preference",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.preferredComputeMode).toBe("CLOUD");
    expect(json.data.isExplicit).toBe(false);
  });
});

describe("PUT /settings/compute-preference", () => {
  it("marks the persisted preference response as explicit", async () => {
    mockUserUpdate.mockResolvedValue({});

    const response = await PUT(
      createMockRequest({
        body: {
          mode: "LOCAL",
          computeTargetId: "11111111-1111-4111-8111-111111111111",
        },
        method: "PUT",
        url: "http://localhost:3002/settings/compute-preference",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      preferredComputeMode: "LOCAL",
      computeTargetId: "11111111-1111-4111-8111-111111111111",
      isExplicit: true,
    });
  });
});
