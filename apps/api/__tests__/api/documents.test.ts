import { DocumentType } from "@repo/api/src/types/document";
import { v7 as uuidv7 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentService } from "@/app/documents/document-service";
import { GET, POST } from "@/app/documents/route";
import { projectsService } from "@/app/projects/service";
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
vi.mock("@/app/documents/document-service");
vi.mock("@/app/projects/service");
vi.mock("@/app/custom-fields/values-service", () => ({
  customFieldValuesService: {
    getValuesForEntity: vi.fn().mockResolvedValue([]),
  },
}));
describe("GET /api/artifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Configure mock auth context for this test suite
    mockAuthContext = createTestAuthContext({
      user: { organizationId: "test-org-id" } as any,
    });
  });

  it("returns all latest artifacts for user org", async () => {
    const mockArtifacts = [
      {
        id: "1",
        title: "PRD 1",
        project: null,
        type: "PRD",
      },
      {
        id: "2",
        title: "PLAN 1",
        project: null,
        type: "IMPLEMENTATION_PLAN",
      },
    ];

    vi.mocked(documentService.findAllWithCustomFields).mockResolvedValue(
      mockArtifacts as any
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockArtifacts);
  });

  it("filters by type query param", async () => {
    vi.mocked(documentService.findAllWithCustomFields).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts?type=PRD",
    });
    const routeContext = createMockRouteContext({});
    await GET(request, routeContext);

    expect(documentService.findAllWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PRD" })
    );
  });

  it("returns error response on service failure", async () => {
    vi.mocked(documentService.findAllWithCustomFields).mockRejectedValue(
      new Error("Database connection failed")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to fetch documents");
  });

  it("returns empty array when no artifacts exist", async () => {
    vi.mocked(documentService.findAllWithCustomFields).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual([]);
  });

  it("validates response includes correct Content-Type header", async () => {
    vi.mocked(documentService.findAllWithCustomFields).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("filters by type and projectId together", async () => {
    vi.mocked(documentService.findAllWithCustomFields).mockResolvedValue([]);

    const projectId = uuidv7();
    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts?type=IMPLEMENTATION_PLAN&projectId=${projectId}`,
    });
    const routeContext = createMockRouteContext({});
    await GET(request, routeContext);

    expect(documentService.findAllWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "IMPLEMENTATION_PLAN",
        projectId,
      })
    );
  });
});

describe("POST /api/artifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Configure mock auth context for this test suite
    mockAuthContext = createTestAuthContext({
      user: { organizationId: "test-org-id" } as any,
    });
  });

  it("creates artifact with valid data", async () => {
    const mockArtifact = {
      id: "new-artifact-id",
      title: "New PRD",
      type: "PRD",
    };

    vi.mocked(documentService.create).mockResolvedValue(mockArtifact as any);

    const request = createMockRequest({
      method: "POST",
      body: {
        type: "PRD",
        title: "New PRD",
        content: "# Content",
        projectId: uuidv7(),
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockArtifact);
  });

  it("returns validation error for missing title", async () => {
    const request = createMockRequest({
      method: "POST",
      body: {
        type: "PRD",
        // missing title
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns null when projectId does not exist", async () => {
    vi.mocked(documentService.create).mockResolvedValue(null);

    const request = createMockRequest({
      method: "POST",
      body: {
        type: "PRD",
        title: "Test",
        content: "# Test",
        projectId: uuidv7(),
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to create document");
  });

  it("passes organizationId and userId to service when creating artifact", async () => {
    mockAuthContext = createTestAuthContext({
      user: { id: "user-123", organizationId: "test-org-id" } as any,
    });

    vi.mocked(documentService.create).mockResolvedValue({
      id: "artifact-id",
    } as any);

    const request = createMockRequest({
      method: "POST",
      body: {
        type: "PRD",
        title: "Test PRD",
        content: "# My PRD",
        fileName: "my-prd.md",
        projectId: uuidv7(),
      },
    });
    const routeContext = createMockRouteContext({});
    await POST(request, routeContext);

    expect(documentService.create).toHaveBeenCalledWith(
      "test-org-id",
      "user-123",
      expect.objectContaining({
        type: "PRD",
        title: "Test PRD",
        content: "# My PRD",
        fileName: "my-prd.md",
      })
    );
  });

  it("returns 400 when missing projectId or workstreamId", async () => {
    const request = createMockRequest({
      method: "POST",
      body: {
        type: DocumentType.Prd,
        title: "Standalone PRD",
        content: "# Standalone",
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 when service returns null", async () => {
    vi.mocked(documentService.create).mockResolvedValue(null);

    const request = createMockRequest({
      method: "POST",
      body: {
        type: DocumentType.Prd,
        title: "Test PRD",
        content: "# Test",
        projectId: uuidv7(),
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to create document");
  });

  it("returns 500 when service throws error", async () => {
    vi.mocked(documentService.create).mockRejectedValue(
      new Error("Transaction deadlock detected")
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        type: DocumentType.Prd,
        title: "Test PRD",
        content: "# Test",
        projectId: uuidv7(),
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBeDefined();
  });

  it("creates artifact without checking project ownership", async () => {
    const projectId = uuidv7();
    mockAuthContext = createTestAuthContext({
      user: { id: "user-123", organizationId: "test-org-id" } as any,
    });

    vi.mocked(documentService.create).mockResolvedValue({
      id: "artifact-id",
    } as any);

    const request = createMockRequest({
      method: "POST",
      body: {
        type: DocumentType.Prd,
        title: "Test PRD",
        content: "# Test",
        projectId,
      },
    });
    const routeContext = createMockRouteContext({});
    await POST(request, routeContext);

    // Project ownership verification was removed - service handles validation
    expect(projectsService.findById).not.toHaveBeenCalled();
    expect(documentService.create).toHaveBeenCalledWith(
      "test-org-id",
      "user-123",
      expect.objectContaining({
        type: DocumentType.Prd,
        title: "Test PRD",
        content: "# Test",
        projectId,
      })
    );
  });
});
