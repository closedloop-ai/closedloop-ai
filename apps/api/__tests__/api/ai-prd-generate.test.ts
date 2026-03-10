import { keys } from "@repo/ai/keys";
import { generateText } from "@repo/ai/server";
import { ArtifactType as PrismaArtifactType } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import { vi } from "vitest";
import { POST } from "@/app/ai/prd/generate/route";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { artifactsService } from "@/app/artifacts/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const AI_SERVICE_NOT_CONFIGURED_REGEX = /AI service not configured/i;
const AI_GENERATION_FAILED_REGEX = /AI generation failed/i;
const FAILED_TO_PERSIST_REGEX = /Failed to persist generated content/i;

let mockAuthContext: AuthContext = {
  user: { id: "test-user", organizationId: "test-org" } as any,
  clerkUserId: "clerk_test",
  clerkOrgId: "org_test",
  authMethod: "session",
  apiKeyScopes: undefined,
};

vi.mock("@repo/ai/server", () => ({
  generateText: vi.fn(),
  models: { sonnet: "mock-model" },
}));
vi.mock("@/app/artifacts/service");
vi.mock("@/app/artifacts/artifact-version-service");
vi.mock("@repo/ai/keys", () => ({
  keys: vi.fn(() => ({ ANTHROPIC_API_KEY: "sk-test" })),
}));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (req: any, ctx: any) =>
    handler(mockAuthContext, req, ctx.params),
}));

const artifactId = uuidv7();

describe("POST /api/ai/prd/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuthContext = createTestAuthContext({
      user: { id: "user-123", organizationId: "org-123" } as any,
    });

    vi.mocked(artifactsService.findByIdSimple).mockResolvedValue({
      id: artifactId,
      type: PrismaArtifactType.PRD,
    } as any);

    vi.mocked(artifactsService.buildPRDContext).mockReturnValue("mock prompt");

    vi.mocked(artifactsService.createNewVersion).mockResolvedValue({
      id: artifactId,
    } as any);

    vi.mocked(artifactVersionService.getLatest).mockResolvedValue(null);
  });

  it("returns 200 with generated content on success", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "generated content",
    } as any);

    const request = createMockRequest({
      method: "POST",
      body: { artifactId },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.artifactId).toBe(artifactId);
    expect(json.data.content).toBe("generated content");
  });

  it("returns 404 when artifact is not found", async () => {
    vi.mocked(artifactsService.findByIdSimple).mockResolvedValue(null);

    const request = createMockRequest({
      method: "POST",
      body: { artifactId },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(404);
  });

  it("returns 400 when artifact type is not PRD", async () => {
    vi.mocked(artifactsService.findByIdSimple).mockResolvedValue({
      id: artifactId,
      type: PrismaArtifactType.IMPLEMENTATION_PLAN,
    } as any);

    const request = createMockRequest({
      method: "POST",
      body: { artifactId },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
  });

  it("returns 500 when API key is missing", async () => {
    vi.mocked(keys).mockReturnValue({ ANTHROPIC_API_KEY: undefined } as any);

    const request = createMockRequest({
      method: "POST",
      body: { artifactId },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toMatch(AI_SERVICE_NOT_CONFIGURED_REGEX);
  });

  it("returns 500 when generateText throws", async () => {
    vi.mocked(keys).mockReturnValue({ ANTHROPIC_API_KEY: "sk-test" } as any);
    vi.mocked(generateText).mockRejectedValue(new Error("API quota exceeded"));

    const request = createMockRequest({
      method: "POST",
      body: { artifactId },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toMatch(AI_GENERATION_FAILED_REGEX);
  });

  it("returns 500 when createNewVersion throws", async () => {
    vi.mocked(keys).mockReturnValue({ ANTHROPIC_API_KEY: "sk-test" } as any);
    vi.mocked(generateText).mockResolvedValue({
      text: "generated content",
    } as any);
    vi.mocked(artifactsService.createNewVersion).mockRejectedValue(
      new Error("DB write failed")
    );

    const request = createMockRequest({
      method: "POST",
      body: { artifactId },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toMatch(FAILED_TO_PERSIST_REGEX);
  });
});
