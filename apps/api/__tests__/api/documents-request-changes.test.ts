import { v7 as uuidv7 } from "uuid";
import { vi } from "vitest";
import { POST } from "@/app/documents/[id]/request-changes/route";
import { documentsService } from "@/app/documents/service";
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
vi.mock("@/app/documents/service");

describe("POST /api/artifacts/[id]/request-changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuthContext = createTestAuthContext({
      user: { id: "user-123", organizationId: "org-123" } as any,
    });
  });

  it("requests plan changes successfully", async () => {
    const artifactId = uuidv7();

    vi.mocked(documentsService.requestPlanChanges).mockResolvedValue({
      success: true,
      message: "Changes requested successfully",
      documentId: artifactId,
    });

    const request = createMockRequest({
      method: "POST",
      body: {
        changes: "Please add error handling for edge cases",
      },
    });
    const routeContext = createMockRouteContext({ id: artifactId });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.success).toBe(true);
    expect(json.data.message).toBe("Changes requested successfully");
    expect(documentsService.requestPlanChanges).toHaveBeenCalledWith(
      artifactId,
      "org-123",
      "user-123",
      "Please add error handling for edge cases"
    );
  });

  it("returns 400 when changes field is missing", async () => {
    const request = createMockRequest({
      method: "POST",
      body: {},
    });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBeDefined();
  });

  it("returns 400 when changes field is empty", async () => {
    const request = createMockRequest({
      method: "POST",
      body: {
        changes: "",
      },
    });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBeDefined();
  });

  it("returns 404 when artifact not found", async () => {
    vi.mocked(documentsService.requestPlanChanges).mockResolvedValue({
      success: false,
      error: "Artifact not found",
      status: 404,
    });

    const request = createMockRequest({
      method: "POST",
      body: {
        changes: "Update the plan",
      },
    });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Artifact not found");
  });

  it("returns 400 when plan is not approved", async () => {
    vi.mocked(documentsService.requestPlanChanges).mockResolvedValue({
      success: false,
      error: "Only APPROVED plans can have changes requested",
      status: 400,
    });

    const request = createMockRequest({
      method: "POST",
      body: {
        changes: "Add more tests",
      },
    });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Only APPROVED plans can have changes requested");
  });

  it("returns 400 when workstream is missing", async () => {
    vi.mocked(documentsService.requestPlanChanges).mockResolvedValue({
      success: false,
      error: "Artifact must belong to a workstream",
      status: 400,
    });

    const request = createMockRequest({
      method: "POST",
      body: {
        changes: "Update implementation",
      },
    });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Artifact must belong to a workstream");
  });

  it("returns 500 on GitHub API failure", async () => {
    vi.mocked(documentsService.requestPlanChanges).mockResolvedValue({
      success: false,
      error: "Failed to trigger workflow",
      status: 500,
    });

    const request = createMockRequest({
      method: "POST",
      body: {
        changes: "Fix the bug",
      },
    });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to trigger workflow");
  });

  it("returns 500 on service exception", async () => {
    vi.mocked(documentsService.requestPlanChanges).mockRejectedValue(
      new Error("Database connection failed")
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        changes: "Improve code quality",
      },
    });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBeDefined();
  });
});
