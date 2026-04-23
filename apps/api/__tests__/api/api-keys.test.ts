import { vi } from "vitest";
import { GET, POST } from "@/app/api-keys/route";
import { apiKeysService } from "@/app/api-keys/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext = createTestAuthContext();

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/api-keys/service");

describe("POST /api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("creates API key with no scopes field and calls generate without scopes", async () => {
    const mockResult = {
      id: "key-1",
      organizationId: "test-org-id",
      userId: "test-user-id",
      name: "Test",
      keyPrefix: "sk_live_",
      expiresAt: null,
      scopes: ["read", "write", "delete"],
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
      plaintext: "sk_live_abc123",
    };

    vi.mocked(apiKeysService.generate).mockResolvedValue(mockResult as any);

    const request = createMockRequest({
      method: "POST",
      body: { name: "Test" },
    });
    const response = await POST(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    expect(apiKeysService.generate).toHaveBeenCalledWith(
      "test-org-id",
      "test-user-id",
      expect.not.objectContaining({ scopes: expect.anything() })
    );
  });

  it("returns 400 when scopes is ['read'] only with error about read-only keys", async () => {
    const request = createMockRequest({
      method: "POST",
      body: { name: "Legacy", scopes: ["read"] },
    });
    const response = await POST(request, createMockRouteContext({}));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(JSON.stringify(json)).toContain(
      "Read-only API keys are no longer supported"
    );
  });

  it("returns 200 when scopes contains read, write, and delete", async () => {
    const mockResult = {
      id: "key-2",
      organizationId: "test-org-id",
      userId: "test-user-id",
      name: "Explicit Full",
      keyPrefix: "sk_live_",
      expiresAt: null,
      scopes: ["read", "write", "delete"],
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
      plaintext: "sk_live_def456",
    };

    vi.mocked(apiKeysService.generate).mockResolvedValue(mockResult as any);

    const request = createMockRequest({
      method: "POST",
      body: { name: "Explicit Full", scopes: ["read", "write", "delete"] },
    });
    const response = await POST(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
  });

  it("returns 400 when scopes contains an invalid value like 'superuser'", async () => {
    const request = createMockRequest({
      method: "POST",
      body: { name: "Bad", scopes: ["superuser"] },
    });
    const response = await POST(request, createMockRouteContext({}));

    expect(response.status).toBe(400);
  });
});

describe("GET /api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with API keys including scopes from service", async () => {
    const mockKey = {
      id: "key-existing",
      organizationId: "test-org-id",
      userId: "test-user-id",
      name: "Existing Key",
      keyPrefix: "sk_live_",
      expiresAt: null,
      scopes: ["read"],
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
    };

    vi.mocked(apiKeysService.list).mockResolvedValue([mockKey as any]);

    const request = createMockRequest({
      url: "http://localhost:3002/api-keys",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].scopes).toEqual(["read"]);
  });
});
