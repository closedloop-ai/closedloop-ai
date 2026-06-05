import { v7 as uuidv7 } from "uuid";
import { vi } from "vitest";
import { POST } from "@/app/artifacts/[id]/execute/route";
import { artifactsService } from "@/app/artifacts/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext = {
  user: { id: "test-user", organizationId: "test-org" } as any,
  clerkUserId: "clerk_test",
  clerkOrgId: "org_test",
  authMethod: "session",
  apiKeyScopes: undefined,
};

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/artifacts/service");

describe("POST /api/artifacts/[id]/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuthContext = createTestAuthContext({
      user: { id: "user-123", organizationId: "org-123" } as any,
    });
  });

  it("executes implementation plan successfully", async () => {
    const artifactId = uuidv7();
    const correlationId = uuidv7();

    vi.mocked(artifactsService.executeImplementationPlan).mockResolvedValue({
      success: true,
      correlationId,
    });

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: artifactId });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.success).toBe(true);
    expect(json.data.correlationId).toBe(correlationId);
    expect(artifactsService.executeImplementationPlan).toHaveBeenCalledWith(
      artifactId,
      "org-123",
      "user-123"
    );
  });

  it("returns 404 when artifact not found", async () => {
    vi.mocked(artifactsService.executeImplementationPlan).mockResolvedValue({
      success: false,
      error: "Artifact not found",
      status: 404,
    });

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Artifact not found");
  });

  it("returns 400 when artifact is not an implementation plan", async () => {
    vi.mocked(artifactsService.executeImplementationPlan).mockResolvedValue({
      success: false,
      error: "Only implementation plans can be executed",
      status: 400,
    });

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Only implementation plans can be executed");
  });

  it("returns 400 when plan is not approved", async () => {
    vi.mocked(artifactsService.executeImplementationPlan).mockResolvedValue({
      success: false,
      error: "Only APPROVED plans can be executed",
      status: 400,
    });

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Only APPROVED plans can be executed");
  });

  it("returns 400 when repository is not configured", async () => {
    vi.mocked(artifactsService.executeImplementationPlan).mockResolvedValue({
      success: false,
      error: "No repository configured for project",
      status: 400,
    });

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("No repository configured for project");
  });

  it("returns 409 when execution is already running", async () => {
    vi.mocked(artifactsService.executeImplementationPlan).mockResolvedValue({
      success: false,
      error: "Execution already in progress",
      status: 409,
    });

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Execution already in progress");
  });

  it("returns 500 on GitHub API failure", async () => {
    vi.mocked(artifactsService.executeImplementationPlan).mockResolvedValue({
      success: false,
      error: "Failed to trigger workflow",
      status: 500,
    });

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to trigger workflow");
  });

  it("returns 500 on service exception", async () => {
    vi.mocked(artifactsService.executeImplementationPlan).mockRejectedValue(
      new Error("Database connection lost")
    );

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBeDefined();
  });
});
