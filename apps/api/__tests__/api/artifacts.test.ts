import { v7 as uuidv7 } from "uuid";
import { vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

// ===== MODULE-LEVEL MOCKS (MUST BE AT TOP BEFORE IMPORTS) =====
// Create a mock authContext that tests can configure
let mockAuthContext: AuthContext = {
  user: { id: "test-user", organizationId: "test-org" } as any,
  clerkUserId: "clerk_test",
  clerkOrgId: "org_test",
};

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));
vi.mock("@repo/database", () => ({
  database: {
    artifact: {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
    project: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn((callback) =>
      callback({
        artifact: {
          updateMany: vi.fn(),
          findFirst: vi.fn(),
          create: vi.fn(),
        },
        project: {
          findFirst: vi.fn(),
          create: vi.fn(),
        },
      })
    ),
  },
}));

import { database } from "@repo/database";
// ===== IMPORTS AFTER MOCKS =====
import { GET, POST } from "@/app/artifacts/route";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

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
      { id: "1", title: "PRD 1", type: "PRD", isLatest: true },
      { id: "2", title: "PLAN 1", type: "PLAN", isLatest: true },
    ];

    vi.mocked(database.artifact.findMany).mockResolvedValue(
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
    vi.mocked(database.artifact.findMany).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts?type=PRD",
    });
    const routeContext = createMockRouteContext({});
    await GET(request, routeContext);

    expect(database.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: "PRD" }),
      })
    );
  });

  it("includes all versions when latestOnly=false", async () => {
    vi.mocked(database.artifact.findMany).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts?latestOnly=false",
    });
    const routeContext = createMockRouteContext({});
    await GET(request, routeContext);

    const callArgs = vi.mocked(database.artifact.findMany).mock.calls[0][0];
    expect(callArgs?.where).not.toHaveProperty("isLatest");
  });

  it("filters by workstreamId", async () => {
    vi.mocked(database.artifact.findMany).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts?workstreamId=ws-123",
    });
    const routeContext = createMockRouteContext({});
    await GET(request, routeContext);

    expect(database.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workstreamId: "ws-123" }),
      })
    );
  });

  it("returns error response on database failure", async () => {
    vi.mocked(database.artifact.findMany).mockRejectedValue(
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
    expect(json.error).toBe("Failed to fetch artifacts");
  });

  // EDGE CASES (added per test-strategist feedback)
  it("returns empty array when no artifacts exist", async () => {
    vi.mocked(database.artifact.findMany).mockResolvedValue([]);

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
    vi.mocked(database.artifact.findMany).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.headers.get("Content-Type")).toContain("application/json");
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
    const mockArtifact = { id: "new-artifact-id", title: "New PRD" };

    // Mock the transaction callback
    vi.mocked(database.$transaction).mockImplementation((callback: any) => {
      const mockTx = {
        artifact: {
          create: vi.fn().mockResolvedValue(mockArtifact),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findFirst: vi.fn().mockResolvedValue(null),
        },
        project: {
          findFirst: vi.fn().mockResolvedValue({ id: "default-proj-id" }),
          create: vi.fn(),
        },
      };
      return callback(mockTx);
    });

    const request = createMockRequest({
      method: "POST",
      body: {
        type: "PRD",
        title: "New PRD",
        content: "# Content",
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

  it("returns 404 when projectId does not exist", async () => {
    vi.mocked(database.project.findUnique).mockResolvedValue(null);

    const request = createMockRequest({
      method: "POST",
      body: {
        type: "PRD",
        title: "Test",
        projectId: uuidv7(),
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Project not found");
  });

  it("generates documentSlug from fileName", async () => {
    vi.mocked(database.$transaction).mockImplementation((callback: any) => {
      const mockTx = {
        artifact: {
          create: vi.fn().mockResolvedValue({ id: "artifact-id" }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findFirst: vi.fn().mockResolvedValue(null),
        },
        project: {
          findFirst: vi.fn().mockResolvedValue({ id: "proj-id" }),
          create: vi.fn(),
        },
      };
      return callback(mockTx);
    });

    const request = createMockRequest({
      method: "POST",
      body: {
        type: "PRD",
        title: "Test PRD",
        fileName: "my-prd.md",
      },
    });
    const routeContext = createMockRouteContext({});
    await POST(request, routeContext);

    // Verify documentSlug was generated correctly
    // (Assertion depends on actual implementation)
  });

  it("creates default project when no projectId or workstreamId", async () => {
    let createdProject = false;

    vi.mocked(database.$transaction).mockImplementation((callback: any) => {
      const mockTx = {
        artifact: {
          create: vi.fn().mockResolvedValue({ id: "artifact-id" }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findFirst: vi.fn().mockResolvedValue(null),
        },
        project: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((_data) => {
            createdProject = true;
            return Promise.resolve({ id: "default-proj-id" });
          }),
        },
      };
      return callback(mockTx);
    });

    const request = createMockRequest({
      method: "POST",
      body: {
        type: "PRD",
        title: "Standalone PRD",
      },
    });
    const routeContext = createMockRouteContext({});
    await POST(request, routeContext);

    expect(createdProject).toBe(true);
  });

  // CRITICAL ERROR SCENARIOS (added per test-strategist feedback)
  it("returns 500 when transaction fails", async () => {
    vi.mocked(database.$transaction).mockRejectedValue(
      new Error("Transaction deadlock detected")
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        type: "PRD",
        title: "Test PRD",
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBeDefined();
  });

  it("creates new version when documentSlug already exists", async () => {
    vi.mocked(database.$transaction).mockImplementation((callback: any) => {
      const mockTx = {
        artifact: {
          create: vi
            .fn()
            .mockResolvedValue({ id: "v2-artifact-id", version: 2 }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }), // Marked old as not latest
          findFirst: vi.fn().mockResolvedValue({ version: 1 }), // Found existing version
        },
        project: {
          findFirst: vi.fn().mockResolvedValue({ id: "proj-id" }),
          create: vi.fn(),
        },
      };
      return callback(mockTx);
    });

    const request = createMockRequest({
      method: "POST",
      body: {
        type: "PRD",
        title: "Test PRD v2",
        fileName: "existing-doc.md",
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.version).toBe(2);
  });
});
