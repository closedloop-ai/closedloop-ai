/**
 * T-6.1 — GET /settings/compute-preference endpoint
 *
 * Verifies:
 * 1. Fast-path: when user.preferredComputeMode is set (LOCAL or CLOUD),
 *    the endpoint returns it immediately without calling resolveEffectiveComputePreference.
 * 2. NULL-fallback: when user.preferredComputeMode is NULL, delegates to
 *    resolveEffectiveComputePreference which inspects online compute targets.
 *    - NULL + online targets → LOCAL
 *    - NULL + no online targets → CLOUD
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
vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        user: { findUnique: mockUserFindUnique },
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
      heartbeat: vi.fn(),
      updateOwned: vi.fn(),
      deleteOwned: vi.fn(),
      markStaleTargetsOffline: vi.fn(),
      findOwnedById: vi.fn(),
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
import { GET } from "@/app/settings/compute-preference/route";
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
    // Fast-path: should not call the targets service
    expect(computeTargetsService.listByOwner).not.toHaveBeenCalled();
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
    // Fast-path: should not call the targets service
    expect(computeTargetsService.listByOwner).not.toHaveBeenCalled();
  });
});

describe("GET /settings/compute-preference — NULL-fallback (delegates to resolveEffectiveComputePreference)", () => {
  it("returns LOCAL when user has no preference but has online compute targets", async () => {
    mockUserFindUnique.mockResolvedValue({ preferredComputeMode: null });
    vi.mocked(computeTargetsService.listByOwner).mockResolvedValue([
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
    expect(computeTargetsService.listByOwner).toHaveBeenCalledWith(
      "org-1",
      "user-1"
    );
  });

  it("returns CLOUD when user has no preference and has no online compute targets", async () => {
    mockUserFindUnique.mockResolvedValue({ preferredComputeMode: null });
    vi.mocked(computeTargetsService.listByOwner).mockResolvedValue([]);

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
    expect(computeTargetsService.listByOwner).toHaveBeenCalledWith(
      "org-1",
      "user-1"
    );
  });

  it("returns CLOUD when user record is not found (NULL-fallback with empty target list)", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    vi.mocked(computeTargetsService.listByOwner).mockResolvedValue([]);

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
  });
});
