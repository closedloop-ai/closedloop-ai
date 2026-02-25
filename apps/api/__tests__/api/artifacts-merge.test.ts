import { v7 as uuidv7 } from "uuid";
import { vi } from "vitest";
import { ArtifactNotFoundError } from "@/app/artifacts/artifact-utils";
import { POST } from "@/app/artifacts/merge/route";
import { artifactsService } from "@/app/artifacts/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const SAME_PROJECT_REGEX = /same project/i;
const TEMPLATE_REGEX = /TEMPLATE/i;

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
vi.mock("@repo/ai/server", () => ({
  generateText: vi.fn(),
  models: { sonnet: "mock-model" },
}));

describe("POST /api/artifacts/merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuthContext = createTestAuthContext({
      user: { id: "user-123", organizationId: "org-123" } as any,
    });
  });

  it("returns 200 with merged artifact on same-type merge success", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();
    const mockArtifact = {
      id: primaryId,
      title: "Merged PRD",
      type: "PRD",
    };

    vi.mocked(artifactsService.merge).mockResolvedValue(mockArtifact as any);

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryArtifactId: primaryId,
        secondaryArtifactId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockArtifact);
  });

  it("calls merge with correct args for cross-type merge", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();
    const mockArtifact = {
      id: primaryId,
      title: "Merged Artifact",
      type: "PRD",
    };

    vi.mocked(artifactsService.merge).mockResolvedValue(mockArtifact as any);

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryArtifactId: primaryId,
        secondaryArtifactId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    await POST(request, routeContext);

    expect(artifactsService.merge).toHaveBeenCalledWith(
      primaryId,
      secondaryId,
      "org-123",
      "user-123"
    );
  });

  it("returns 404 when artifact is not found", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();

    vi.mocked(artifactsService.merge).mockRejectedValue(
      new ArtifactNotFoundError()
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryArtifactId: primaryId,
        secondaryArtifactId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 when artifacts are from different projects", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();

    vi.mocked(artifactsService.merge).mockRejectedValue(
      new Error("Artifacts must be in the same project")
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryArtifactId: primaryId,
        secondaryArtifactId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(SAME_PROJECT_REGEX);
  });

  it("returns 400 when primaryArtifactId and secondaryArtifactId are the same", async () => {
    const sameId = uuidv7();

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryArtifactId: sameId,
        secondaryArtifactId: sameId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    // merge should not have been called — validation rejected it
    expect(artifactsService.merge).not.toHaveBeenCalled();
  });

  it("returns 400 when a TEMPLATE artifact is involved in the merge", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();

    vi.mocked(artifactsService.merge).mockRejectedValue(
      new Error("Cannot merge TEMPLATE artifacts")
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryArtifactId: primaryId,
        secondaryArtifactId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(TEMPLATE_REGEX);
  });

  it("returns 500 when LLM returns empty content", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();

    vi.mocked(artifactsService.merge).mockRejectedValue(
      new Error("LLM returned empty merged content")
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryArtifactId: primaryId,
        secondaryArtifactId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("passes user organizationId to service for org-scoping", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();
    const mockArtifact = { id: primaryId, title: "Merged", type: "PRD" };

    mockAuthContext = createTestAuthContext({
      user: { id: "user-abc", organizationId: "specific-org-id" } as any,
    });

    vi.mocked(artifactsService.merge).mockResolvedValue(mockArtifact as any);

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryArtifactId: primaryId,
        secondaryArtifactId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    await POST(request, routeContext);

    expect(artifactsService.merge).toHaveBeenCalledWith(
      primaryId,
      secondaryId,
      "specific-org-id",
      "user-abc"
    );
  });
});
