import {
  HarnessType,
  PluginUpdateOutcome,
} from "@repo/api/src/types/compute-target";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as healthCheckGET,
  PUT as healthCheckPUT,
} from "@/app/compute-targets/[id]/health-check/route";
import { POST as heartbeatPOST } from "@/app/compute-targets/[id]/heartbeat/route";
import { DELETE, PUT } from "@/app/compute-targets/[id]/route";
import { POST as registerPOST } from "@/app/compute-targets/register/route";
import { GET } from "@/app/compute-targets/route";
import { computeTargetsService } from "@/app/compute-targets/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));

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
      getLatestHealthCheckForTarget: vi.fn(),
      upsertHealthCheckSnapshot: vi.fn(),
      markStaleTargetsOffline: vi.fn(),
      setSharing: vi.fn(),
    },
  };
});

const mockTarget = {
  id: "target-1",
  organizationId: "org-1",
  userId: "user-1",
  machineName: "Daniel-MBP",
  platform: "darwin",
  capabilities: {},
  supportedOperations: ["symphony_chat"],
  lastSeenAt: new Date(),
  isOnline: true,
  isSharedWithOrg: false,
  selectedHarness: HarnessType.Claude,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext({
    user: {
      id: "user-1",
      clerkId: "clerk-user-1",
      organizationId: "org-1",
    } as any,
  });
});

describe("GET /compute-targets", () => {
  it("lists user-owned compute targets", async () => {
    vi.mocked(computeTargetsService.markStaleTargetsOffline).mockResolvedValue(
      0
    );
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      mockTarget,
    ]);

    const response = await GET(
      createMockRequest({ url: "http://localhost:3002/compute-targets" }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(computeTargetsService.markStaleTargetsOffline).toHaveBeenCalledWith({
      organizationId: "org-1",
    });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "clerk-user-1"
    );
  });
});

describe("POST /compute-targets/register", () => {
  it("registers a compute target", async () => {
    vi.mocked(computeTargetsService.register).mockResolvedValue(
      Result.ok(mockTarget)
    );

    const response = await registerPOST(
      createMockRequest({
        method: "POST",
        body: {
          machineName: "Daniel-MBP",
          platform: "darwin",
          capabilities: { shell: "zsh" },
          supportedOperations: ["symphony_chat"],
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      id: "target-1",
      machineName: "Daniel-MBP",
      isOnline: true,
    });
  });

  it("returns 400 for invalid payload", async () => {
    const response = await registerPOST(
      createMockRequest({
        method: "POST",
        body: { machineName: "", platform: "", supportedOperations: [] },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });
});

describe("POST /compute-targets/:id/heartbeat", () => {
  it("updates heartbeat for owned target", async () => {
    vi.mocked(computeTargetsService.heartbeat).mockResolvedValue(true);

    const response = await heartbeatPOST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/compute-targets/target-1/heartbeat",
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ ok: true });
  });

  it("returns not found when target is not user-owned", async () => {
    vi.mocked(computeTargetsService.heartbeat).mockResolvedValue(false);

    const response = await heartbeatPOST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/compute-targets/target-2/heartbeat",
      }),
      createMockRouteContext({ id: "target-2" })
    );

    expect(response.status).toBe(404);
  });
});

describe("PUT /compute-targets/:id", () => {
  it("updates owned compute target", async () => {
    vi.mocked(computeTargetsService.updateOwned).mockResolvedValue(
      Result.ok({
        ...mockTarget,
        machineName: "Renamed-Machine",
      })
    );

    const response = await PUT(
      createMockRequest({
        method: "PUT",
        url: "http://localhost:3002/compute-targets/target-1",
        body: { machineName: "Renamed-Machine" },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.machineName).toBe("Renamed-Machine");
  });
});

describe("DELETE /compute-targets/:id", () => {
  it("deletes owned compute target", async () => {
    vi.mocked(computeTargetsService.deleteOwned).mockResolvedValue(true);

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "http://localhost:3002/compute-targets/target-1",
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ deleted: true });
  });
});

describe("GET /compute-targets/:id/health-check", () => {
  it("returns the latest persisted health-check snapshot", async () => {
    const snapshot = {
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt: new Date("2026-05-08T15:00:00.000Z"),
      expectedMcpUrl: "https://mcp.example.com",
      latestVersion: "1.2.3",
      pluginAutoUpdateEnabled: true,
      result: {
        checks: [{ id: "git", label: "Git", required: true, passed: true }],
        allRequiredPassed: true,
      },
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: 1,
      createdAt: new Date("2026-05-08T15:00:00.000Z"),
      updatedAt: new Date("2026-05-08T15:00:00.000Z"),
    };
    vi.mocked(
      computeTargetsService.getLatestHealthCheckForTarget
    ).mockResolvedValue(snapshot);

    const response = await healthCheckGET(
      createMockRequest({
        url: "http://localhost:3002/compute-targets/target-1/health-check",
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("snapshot-1");
    expect(
      computeTargetsService.getLatestHealthCheckForTarget
    ).toHaveBeenCalledWith("org-1", "user-1", "target-1");
  });
});

describe("PUT /compute-targets/:id/health-check", () => {
  it("persists a health-check snapshot for an accessible target", async () => {
    const snapshot = {
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt: new Date("2026-05-08T15:00:00.000Z"),
      expectedMcpUrl: "https://mcp.example.com",
      latestVersion: "1.2.3",
      pluginAutoUpdateEnabled: true,
      result: {
        checks: [{ id: "git", label: "Git", required: true, passed: true }],
        allRequiredPassed: true,
      },
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: 1,
      createdAt: new Date("2026-05-08T15:00:00.000Z"),
      updatedAt: new Date("2026-05-08T15:00:00.000Z"),
    };
    vi.mocked(
      computeTargetsService.upsertHealthCheckSnapshot
    ).mockResolvedValue(snapshot);

    const response = await healthCheckPUT(
      createMockRequest({
        method: "PUT",
        url: "http://localhost:3002/compute-targets/target-1/health-check",
        body: {
          expectedMcpUrl: "https://mcp.example.com",
          latestVersion: "1.2.3",
          pluginAutoUpdateEnabled: true,
          result: {
            checks: [
              {
                id: "plugin-code",
                label: "Symphony Plugin",
                required: true,
                passed: false,
                enableAttempted: true,
                enableOutcome: PluginUpdateOutcome.Failed,
                enablePluginIds: ["code@closedloop-ai"],
                updateAttempted: true,
                updateOutcome: PluginUpdateOutcome.Failed,
                updatePluginIds: ["plugin-code"],
                remediationLinks: [
                  {
                    label: "Update Closedloop plugins manually",
                    url: "https://github.com/closedloop-ai/claude-plugins#quick-start",
                  },
                ],
              },
            ],
            allRequiredPassed: false,
          },
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    expect(
      computeTargetsService.upsertHealthCheckSnapshot
    ).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "target-1",
      expect.objectContaining({
        expectedMcpUrl: "https://mcp.example.com",
        latestVersion: "1.2.3",
        pluginAutoUpdateEnabled: true,
        result: expect.objectContaining({
          checks: [
            expect.objectContaining({
              enableAttempted: true,
              enableOutcome: PluginUpdateOutcome.Failed,
              enablePluginIds: ["code@closedloop-ai"],
            }),
          ],
        }),
      })
    );
  });

  it("returns not found when the target is inaccessible", async () => {
    vi.mocked(
      computeTargetsService.upsertHealthCheckSnapshot
    ).mockResolvedValue(null);

    const response = await healthCheckPUT(
      createMockRequest({
        method: "PUT",
        url: "http://localhost:3002/compute-targets/target-2/health-check",
        body: {
          result: {
            checks: [{ id: "git", label: "Git", required: true, passed: true }],
            allRequiredPassed: true,
          },
        },
      }),
      createMockRouteContext({ id: "target-2" })
    );

    expect(response.status).toBe(404);
  });

  it("rejects unsafe structured remediation link schemes", async () => {
    const response = await healthCheckPUT(
      createMockRequest({
        method: "PUT",
        url: "http://localhost:3002/compute-targets/target-1/health-check",
        body: {
          result: {
            checks: [
              {
                id: "plugin-code",
                label: "Symphony Plugin",
                required: true,
                passed: false,
                remediation: "Open a safe help page",
                remediationLinks: [
                  {
                    label: "Unsafe link",
                    url: "javascript:alert(1)",
                  },
                ],
              },
            ],
            allRequiredPassed: false,
          },
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(400);
    expect(
      computeTargetsService.upsertHealthCheckSnapshot
    ).not.toHaveBeenCalled();
  });
});
