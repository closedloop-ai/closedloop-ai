import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-6966 converted `GET /teams` from `withAuth` (Clerk session only) to
 * `withAnyAuth`, so the `list-teams` MCP tool — which authenticates with an
 * `sk_live_` API key — can read the org's complete team set.
 *
 * This suite deliberately does NOT stub `withAnyAuth`: the thing under test is
 * which auth wrapper each verb dispatches to, and a stubbed `withAnyAuth`
 * answers that question by assumption. The three auth primitives underneath it
 * are mocked instead, so the real dispatch in `with-any-auth.ts` runs and the
 * assertions below fail if `GET` is moved back to `withAuth` — or if `POST` is
 * ever widened to accept an API key.
 */

const API_KEY_ORG_ID = "org-from-api-key";

const { withApiKeyAuthMock, withAuthMock, withDesktopSessionAuthMock } =
  vi.hoisted(() => ({
    withApiKeyAuthMock: vi.fn(
      (
        handler: (...args: unknown[]) => Promise<unknown>,
        _options?: { requiredScopes?: string[] }
      ) =>
        async (request: unknown, context: { params?: unknown }) =>
          handler(
            {
              user: { id: "user-from-api-key", organizationId: API_KEY_ORG_ID },
            },
            request,
            context?.params
          )
    ),
    withAuthMock: vi.fn(
      (handler: (...args: unknown[]) => Promise<unknown>) =>
        async (request: unknown, context: { params?: unknown }) =>
          handler(
            { user: { id: "user-1", organizationId: "org-session" } },
            request,
            context?.params
          )
    ),
    withDesktopSessionAuthMock: vi.fn(
      () => async () => ({}) as unknown as Promise<never>
    ),
  }));

vi.mock("@/lib/auth/with-api-key-auth", () => ({
  withApiKeyAuth: withApiKeyAuthMock,
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: withAuthMock,
}));

vi.mock("@/lib/auth/with-desktop-session-auth", () => ({
  withDesktopSessionAuth: withDesktopSessionAuthMock,
}));

vi.mock("@repo/auth/desktop-session-jwt", () => ({
  isDesktopSessionToken: () => false,
}));

vi.mock("@/app/teams/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/teams/service")>();
  return {
    ...original,
    teamsService: {
      findByOrganization: vi.fn(),
      createWithOwner: vi.fn(),
      findById: vi.fn(),
    },
  };
});

import { GET, POST } from "@/app/teams/route";
import { teamsService } from "@/app/teams/service";

function createRequest(method: string, authorization?: string) {
  const headers = new Map<string, string>();
  if (authorization) {
    headers.set("authorization", authorization);
  }
  return {
    method,
    url: "http://localhost:3002/teams",
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: () => Promise.resolve({ name: "New Team" }),
  } as never;
}

const routeContext = { params: Promise.resolve({}) } as never;

function teamRow(id: string, organizationId: string) {
  return {
    id,
    name: "Platform",
    slug: "platform",
    organizationId,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-15T10:00:00Z"),
    _count: { members: 3, projects: 2 },
  };
}

describe("GET /teams auth dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(teamsService.findByOrganization).mockResolvedValue([
      teamRow("team-1", API_KEY_ORG_ID),
    ] as never);
  });

  it("routes an sk_live_ bearer to API-key auth", async () => {
    await GET(createRequest("GET", "Bearer sk_live_test"), routeContext);

    expect(withApiKeyAuthMock).toHaveBeenCalledWith(expect.any(Function), {
      requiredScopes: ["read"],
    });
  });

  it("requires only the read scope of an API-key caller", async () => {
    await GET(createRequest("GET", "Bearer sk_live_test"), routeContext);

    const options = withApiKeyAuthMock.mock.calls[0]?.[1];
    expect(options?.requiredScopes).toEqual(["read"]);
    expect(options?.requiredScopes).not.toContain("write");
  });

  it("scopes the read to the API key's own organization", async () => {
    const response = await GET(
      createRequest("GET", "Bearer sk_live_test"),
      routeContext
    );

    // The org comes from the authenticated principal, never from the request,
    // so an API key cannot list another organization's teams.
    expect(teamsService.findByOrganization).toHaveBeenCalledWith(
      API_KEY_ORG_ID
    );
    const json = await (response as unknown as Response).json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      id: "team-1",
      memberCount: 3,
      projectCount: 2,
    });
  });

  it("still serves a Clerk session caller", async () => {
    await GET(createRequest("GET"), routeContext);

    expect(withApiKeyAuthMock).not.toHaveBeenCalled();
    expect(withAuthMock).toHaveBeenCalled();
    expect(teamsService.findByOrganization).toHaveBeenCalledWith("org-session");
  });
});

describe("POST /teams stays session-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(teamsService.createWithOwner).mockResolvedValue(
      Result.ok({ id: "team-1" } as never)
    );
    vi.mocked(teamsService.findById).mockResolvedValue(
      teamRow("team-1", "org-session") as never
    );
  });

  it("does not accept an sk_live_ bearer", async () => {
    await POST(createRequest("POST", "Bearer sk_live_test"), routeContext);

    // The `project_team_required` 400 tells callers "API keys cannot create
    // teams". Widening POST to `withAnyAuth` would make that sentence a lie.
    expect(withApiKeyAuthMock).not.toHaveBeenCalled();
  });
});
