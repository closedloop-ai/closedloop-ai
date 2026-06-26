import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  } as {
    user: { id: string; organizationId: string };
    authMethod: "session" | "api_key";
  },
  listOrganizationPublicKeys: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) =>
      handler(
        {
          user: mocks.auth.user,
          authMethod: mocks.auth.authMethod,
        },
        request,
        context.params
      ),
}));

vi.mock("./service", () => ({
  publicKeysService: {
    listOrganizationPublicKeys: mocks.listOrganizationPublicKeys,
  },
}));

import { GET } from "./route";

function request(path = "/public-keys") {
  return new NextRequest(`http://localhost${path}`, { method: "GET" });
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

describe("GET /public-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.auth.authMethod = "session";
    mocks.listOrganizationPublicKeys.mockResolvedValue([]);
  });

  it("uses the authenticated user as the owner scope when target context is absent", async () => {
    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.listOrganizationPublicKeys).toHaveBeenCalledWith({
      organizationId: "org-1",
      requesterUserId: "user-1",
      computeTargetId: undefined,
      gatewayId: undefined,
    });
  });

  it("passes exact target query fields through for an API-key authenticated requester", async () => {
    mocks.auth.user = { id: "api-key-user", organizationId: "org-1" };
    mocks.auth.authMethod = "api_key";

    await GET(
      request(
        "/public-keys?computeTargetId=11111111-1111-4111-8111-111111111111&gatewayId=22222222-2222-4222-8222-222222222222"
      ),
      routeContext()
    );

    expect(mocks.listOrganizationPublicKeys).toHaveBeenCalledWith({
      organizationId: "org-1",
      requesterUserId: "api-key-user",
      computeTargetId: "11111111-1111-4111-8111-111111111111",
      gatewayId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("rejects repeated target query parameters before service lookup", async () => {
    const response = await GET(
      request(
        "/public-keys?computeTargetId=11111111-1111-4111-8111-111111111111&computeTargetId=22222222-2222-4222-8222-222222222222"
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(mocks.listOrganizationPublicKeys).not.toHaveBeenCalled();
  });

  it("rejects gateway-only target context before service lookup", async () => {
    const response = await GET(
      request("/public-keys?gatewayId=22222222-2222-4222-8222-222222222222"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(mocks.listOrganizationPublicKeys).not.toHaveBeenCalled();
  });

  it("rejects malformed target query values before service lookup", async () => {
    const response = await GET(
      request("/public-keys?computeTargetId=not-a-uuid"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(mocks.listOrganizationPublicKeys).not.toHaveBeenCalled();
  });
});
