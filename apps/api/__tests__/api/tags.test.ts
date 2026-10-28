import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { TagColor } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
} from "@/__tests__/utils/auth-helpers";

/**
 * ISS-7538: pins what the `/tags` handlers themselves own and nothing else did — the
 * error-to-status mapping (`DuplicateNameError` -> 409) and the API-key scope each verb
 * demands. `__tests__/unit/tags-service.test.ts` drives `tagService` directly and never
 * the route; `POST` had no route-layer coverage at all.
 *
 * `GET` branch dispatch is NOT re-pinned here. `app/tags/route.test.ts` (ISS-7461) is its
 * canonical owner and covers all four branches plus the 400s; duplicating those cases
 * would give the same contract two owners and let them drift. What remains below is the
 * one GET behaviour that file does not asserts — the 500 mapping — while the GET path
 * through the real `withAnyAuth` dispatch is proven once, in the scope-gate block.
 *
 * The three auth primitives are mocked here rather than `withAnyAuth` itself, so the
 * real dispatch in `lib/auth/with-any-auth.ts` runs on every case below. Stubbing
 * `withAnyAuth` (the `teams.test.ts` shape) answers "which wrapper, under which scopes"
 * by assumption, and that is half of what this suite exists to prove.
 *
 * The hoisted mock block is duplicated in `tags-id.test.ts` rather than shared: Vitest
 * module mocks are file-scoped and `vi.hoisted` runs before every import, so a shared
 * helper module cannot be reached from inside it.
 */

const {
  API_KEY_ORG_ID,
  API_KEY_USER_ID,
  SESSION_ORG_ID,
  SESSION_USER_ID,
  withApiKeyAuthMock,
  withAuthMock,
  withDesktopSessionAuthMock,
} = vi.hoisted(() => {
  const apiKeyUser = {
    id: "user-from-api-key",
    organizationId: "org-from-api-key",
  };
  const sessionUser = { id: "user-session", organizationId: "org-session" };
  const dispatch =
    (user: { id: string; organizationId: string }) =>
    (handler: (...args: unknown[]) => Promise<unknown>) =>
    (request: unknown, context: { params?: unknown }) =>
      handler({ user }, request, context?.params);

  return {
    API_KEY_ORG_ID: apiKeyUser.organizationId,
    API_KEY_USER_ID: apiKeyUser.id,
    SESSION_ORG_ID: sessionUser.organizationId,
    SESSION_USER_ID: sessionUser.id,
    withApiKeyAuthMock: vi.fn(
      (
        handler: (...args: unknown[]) => Promise<unknown>,
        _options?: { requiredScopes?: string[] }
      ) => dispatch(apiKeyUser)(handler)
    ),
    withAuthMock: vi.fn((handler: (...args: unknown[]) => Promise<unknown>) =>
      dispatch(sessionUser)(handler)
    ),
    withDesktopSessionAuthMock: vi.fn(
      () => () => Promise.resolve({} as unknown)
    ),
  };
});

vi.mock("@/lib/auth/with-api-key-auth", () => ({
  withApiKeyAuth: withApiKeyAuthMock,
}));

vi.mock("@/lib/auth/with-auth", () => ({ withAuth: withAuthMock }));

vi.mock("@/lib/auth/with-desktop-session-auth", () => ({
  withDesktopSessionAuth: withDesktopSessionAuthMock,
}));

vi.mock("@repo/auth/desktop-session-jwt", () => ({
  isDesktopSessionToken: () => false,
}));

// `importOriginal` below executes the real `app/tags/service.ts` so the handlers'
// `instanceof DuplicateNameError` checks match the class this file throws. These two
// mocks keep that import from reaching Prisma and the GitHub App, exactly as
// `tags-service.test.ts` does.
vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/lib/github/artifact-tag-label-reconciliation", () => ({
  reconcileLinkedPullRequestLabelsForArtifact: vi.fn(),
  reconcileLinkedPullRequestLabelsForArtifacts: vi.fn(),
}));

vi.mock("@/app/tags/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/tags/service")>();
  return {
    ...original,
    tagService: {
      findByOrg: vi.fn(),
      findManyByOrg: vi.fn(),
      findPageByOrg: vi.fn(),
      findByExactName: vi.fn(),
      create: vi.fn(),
    },
  };
});

import { GET, POST } from "@/app/tags/route";
import { DuplicateNameError, tagService } from "@/app/tags/service";

describe("GET /tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 500 when the read fails", async () => {
    vi.mocked(tagService.findByOrg).mockRejectedValue(
      new Error("Database error")
    );

    const response = await GET(
      createMockRequest({ url: TAGS_URL }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    const json = await readJson(response);
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to fetch tags");
  });
});

describe("POST /tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a tag from a valid body", async () => {
    vi.mocked(tagService.create).mockResolvedValue(tagRow() as never);

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { name: "Bug", color: TagColor.Red },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await readJson(response);
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("Bug");
    expect(tagService.create).toHaveBeenCalledWith(
      SESSION_ORG_ID,
      SESSION_USER_ID,
      { name: "Bug", color: TagColor.Red },
      undefined
    );
  });

  it("returns 400 for a missing name", async () => {
    const response = await POST(
      createMockRequest({ method: "POST", body: {} }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    const json = await readJson(response);
    expect(json.success).toBe(false);
    expect(tagService.create).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty name", async () => {
    const response = await POST(
      createMockRequest({ method: "POST", body: { name: "" } }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(tagService.create).not.toHaveBeenCalled();
  });

  it("maps DuplicateNameError to 409", async () => {
    vi.mocked(tagService.create).mockRejectedValue(
      new DuplicateNameError("Bug")
    );

    const response = await POST(
      createMockRequest({ method: "POST", body: { name: "Bug" } }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(409);
    const json = await readJson(response);
    expect(json.success).toBe(false);
    expect(json.error).toBe("Tag with this name already exists");
  });

  it("maps an unrecognised failure to 500, not 409", async () => {
    vi.mocked(tagService.create).mockRejectedValue(new Error("Database error"));

    const response = await POST(
      createMockRequest({ method: "POST", body: { name: "Bug" } }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    const json = await readJson(response);
    expect(json.error).toBe("Failed to create tag");
  });
});

/**
 * What these cases can and cannot catch.
 *
 * `withAnyAuth` derives a fallback scope from the HTTP method when a route passes no
 * options, and for `/tags` those fallbacks happen to equal what the routes declare —
 * GET/read, POST/write. So a case here cannot tell "the route declared its scope" from
 * "the route declared nothing and inherited the method default"; the two are the same
 * behaviour today. What it does catch is the mapping being WIDENED — a POST that only
 * demands `read` would let any read-only API key create tags, and that fails here.
 */
describe("/tags API-key scope gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tagService.findByOrg).mockResolvedValue([] as never);
    vi.mocked(tagService.create).mockResolvedValue(tagRow() as never);
  });

  it("requires only the read scope of a GET caller", async () => {
    await GET(
      createMockRequest({ url: TAGS_URL, headers: API_KEY_AUTHORIZATION }),
      createMockRouteContext({})
    );

    const options = withApiKeyAuthMock.mock.calls[0]?.[1];
    expect(options?.requiredScopes).toEqual([ApiKeyScope.Read]);
    expect(options?.requiredScopes).not.toContain(ApiKeyScope.Write);
    expect(options?.requiredScopes).not.toContain(ApiKeyScope.Delete);
  });

  it("requires the write scope of a POST caller", async () => {
    await POST(
      createMockRequest({
        method: "POST",
        body: { name: "Bug" },
        headers: API_KEY_AUTHORIZATION,
      }),
      createMockRouteContext({})
    );

    expect(withApiKeyAuthMock).toHaveBeenCalledWith(expect.any(Function), {
      requiredScopes: [ApiKeyScope.Write],
    });
  });

  it("reads the organization off the authenticated principal, never the request", async () => {
    await POST(
      createMockRequest({
        method: "POST",
        body: { name: "Bug" },
        headers: API_KEY_AUTHORIZATION,
      }),
      createMockRouteContext({})
    );

    // The service is mocked, so this proves only that the handler forwards the
    // API key's own org — NOT that the query filters by it. Org-scoping itself
    // stays proven in `__tests__/unit/tags-service.test.ts` (the ISS-6748 shape).
    expect(tagService.create).toHaveBeenCalledWith(
      API_KEY_ORG_ID,
      API_KEY_USER_ID,
      { name: "Bug" },
      undefined
    );
  });

  it("still serves a Clerk session caller", async () => {
    await GET(createMockRequest({ url: TAGS_URL }), createMockRouteContext({}));

    expect(withApiKeyAuthMock).not.toHaveBeenCalled();
    expect(withAuthMock).toHaveBeenCalled();
    expect(tagService.findByOrg).toHaveBeenCalledWith(SESSION_ORG_ID);
  });
});

const TAGS_URL = "http://localhost:3002/tags";
const API_KEY_AUTHORIZATION = { authorization: "Bearer sk_live_test" };

function tagRow(overrides?: Record<string, unknown>) {
  return {
    id: "tag-1",
    name: "Bug",
    color: TagColor.Red,
    organizationId: SESSION_ORG_ID,
    createdById: SESSION_USER_ID,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    createdBy: {
      id: SESSION_USER_ID,
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      avatarUrl: null,
    },
    _count: { tagProjects: 0, tagArtifacts: 2 },
    ...overrides,
  };
}

function readJson(response: unknown) {
  return (response as Response).json();
}
