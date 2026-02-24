import { v7 as uuidv7 } from "uuid";
import { vi } from "vitest";
import { POST } from "@/app/artifacts/[id]/regenerate/route";
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
vi.mock("@repo/database", () => ({
  ArtifactType: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    ISSUE: "ISSUE",
  },
}));
vi.mock("@/app/artifacts/service");

describe("POST /api/artifacts/[id]/regenerate", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuthContext = createTestAuthContext({
      user: { id: "user-123", organizationId: "org-123" } as any,
    });
  });

  it("dispatches to regenerateImplementationPlan for plans", async () => {
    const artifactId = uuidv7();
    const mockArtifact = {
      id: artifactId,
      title: "Implementation Plan",
      type: "IMPLEMENTATION_PLAN",
      status: "DRAFT",
    };

    vi.mocked(artifactsService.findByIdSimple).mockResolvedValue(
      mockArtifact as any
    );
    vi.mocked(artifactsService.regenerateImplementationPlan).mockResolvedValue({
      success: true,
      artifact: mockArtifact as any,
    });

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: artifactId });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockArtifact);
    expect(artifactsService.regenerateImplementationPlan).toHaveBeenCalledWith(
      artifactId,
      "org-123",
      "user-123"
    );
    expect(artifactsService.generatePRD).not.toHaveBeenCalled();
  });

  it("dispatches to generatePRD for PRD artifacts", async () => {
    const artifactId = uuidv7();
    const mockArtifact = {
      id: artifactId,
      title: "My PRD",
      type: "PRD",
      status: "DRAFT",
    };

    vi.mocked(artifactsService.findByIdSimple).mockResolvedValue(
      mockArtifact as any
    );
    vi.mocked(artifactsService.generatePRD).mockResolvedValue({
      success: true,
      artifact: mockArtifact as any,
    });

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: artifactId });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(artifactsService.generatePRD).toHaveBeenCalledWith(
      artifactId,
      "org-123",
      "user-123",
      null
    );
    expect(
      artifactsService.regenerateImplementationPlan
    ).not.toHaveBeenCalled();
  });

  it("passes reverseSynthesisLink to generatePRD when provided", async () => {
    const artifactId = uuidv7();
    const mockArtifact = {
      id: artifactId,
      title: "My PRD",
      type: "PRD",
      status: "DRAFT",
    };

    vi.mocked(artifactsService.findByIdSimple).mockResolvedValue(
      mockArtifact as any
    );
    vi.mocked(artifactsService.generatePRD).mockResolvedValue({
      success: true,
      artifact: mockArtifact as any,
    });

    const request = createMockRequest({
      method: "POST",
      body: { reverseSynthesisLink: "https://github.com/example/repo" },
    });
    const routeContext = createMockRouteContext({ id: artifactId });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    expect(artifactsService.generatePRD).toHaveBeenCalledWith(
      artifactId,
      "org-123",
      "user-123",
      "https://github.com/example/repo"
    );
  });

  it("returns 404 when artifact not found", async () => {
    vi.mocked(artifactsService.findByIdSimple).mockResolvedValue(null);

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: uuidv7() });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Artifact not found");
  });

  it("returns error status from service failure", async () => {
    const artifactId = uuidv7();
    vi.mocked(artifactsService.findByIdSimple).mockResolvedValue({
      id: artifactId,
      type: "IMPLEMENTATION_PLAN",
    } as any);
    vi.mocked(artifactsService.regenerateImplementationPlan).mockResolvedValue({
      success: false,
      error: "Plan generation already in progress",
      status: 409,
    });

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: artifactId });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Plan generation already in progress");
  });

  it("returns 400 for invalid reverseSynthesisLink", async () => {
    const artifactId = uuidv7();
    vi.mocked(artifactsService.findByIdSimple).mockResolvedValue({
      id: artifactId,
      type: "PRD",
    } as any);

    const request = createMockRequest({
      method: "POST",
      body: { reverseSynthesisLink: "not-a-url" },
    });
    const routeContext = createMockRouteContext({ id: artifactId });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 500 on service exception", async () => {
    const artifactId = uuidv7();
    vi.mocked(artifactsService.findByIdSimple).mockResolvedValue({
      id: artifactId,
      type: "IMPLEMENTATION_PLAN",
    } as any);
    vi.mocked(artifactsService.regenerateImplementationPlan).mockRejectedValue(
      new Error("GitHub API timeout")
    );

    const request = createMockRequest({ method: "POST" });
    const routeContext = createMockRouteContext({ id: artifactId });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBeDefined();
  });
});
