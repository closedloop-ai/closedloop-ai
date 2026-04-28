import { vi } from "vitest";
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
      mockTarget as any
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
    vi.mocked(computeTargetsService.updateOwned).mockResolvedValue({
      ...mockTarget,
      machineName: "Renamed-Machine",
    } as any);

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
