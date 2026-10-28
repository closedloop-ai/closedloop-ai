import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { TagColor } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
} from "@/__tests__/utils/auth-helpers";

/**
 * ISS-7538: the `PATCH`/`DELETE` catch blocks in `app/tags/[id]/route.ts` map
 * `EntityNotFoundError` to 404 and `DuplicateNameError` to 409, and nothing pinned
 * either. API-DOMAIN-02 proposes copying that shape into `/teams`, so it is pinned
 * here before it becomes a template.
 *
 * As in `tags.test.ts`, the three auth primitives are mocked rather than `withAnyAuth`
 * itself so the real dispatch runs and the scope gate is proven, not assumed. The
 * hoisted block is duplicated between the two files because Vitest module mocks are
 * file-scoped and `vi.hoisted` runs before every import.
 */

const {
  API_KEY_ORG_ID,
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
// `instanceof` checks match the classes this file throws. These two mocks keep that
// import from reaching Prisma and the GitHub App, as `tags-service.test.ts` does.
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
    tagService: { update: vi.fn(), delete: vi.fn() },
  };
});

import { DELETE, PATCH } from "@/app/tags/[id]/route";
import {
  DuplicateNameError,
  EntityNotFoundError,
  tagService,
} from "@/app/tags/service";

describe("PATCH /tags/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates the tag from a valid body", async () => {
    vi.mocked(tagService.update).mockResolvedValue(
      tagRow({ name: "Defect" }) as never
    );

    const response = await PATCH(
      patchRequest({ name: "Defect" }),
      tagRouteContext()
    );

    expect(response.status).toBe(200);
    const json = await readJson(response);
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("Defect");
    expect(tagService.update).toHaveBeenCalledWith(
      TAG_ID,
      SESSION_ORG_ID,
      { name: "Defect" },
      undefined
    );
  });

  it("returns 400 for an invalid body", async () => {
    const response = await PATCH(patchRequest({ name: "" }), tagRouteContext());

    expect(response.status).toBe(400);
    const json = await readJson(response);
    expect(json.success).toBe(false);
    expect(tagService.update).not.toHaveBeenCalled();
  });

  it("maps EntityNotFoundError to 404", async () => {
    vi.mocked(tagService.update).mockRejectedValue(
      new EntityNotFoundError("Tag", TAG_ID)
    );

    const response = await PATCH(
      patchRequest({ name: "Defect" }),
      tagRouteContext()
    );

    expect(response.status).toBe(404);
    const json = await readJson(response);
    expect(json.success).toBe(false);
    expect(json.error).toBe("Tag not found");
  });

  it("maps DuplicateNameError to 409", async () => {
    vi.mocked(tagService.update).mockRejectedValue(
      new DuplicateNameError("Defect")
    );

    const response = await PATCH(
      patchRequest({ name: "Defect" }),
      tagRouteContext()
    );

    expect(response.status).toBe(409);
    const json = await readJson(response);
    expect(json.error).toBe("Tag with this name already exists");
  });

  it("maps an unrecognised failure to 500, not 404 or 409", async () => {
    vi.mocked(tagService.update).mockRejectedValue(new Error("Database error"));

    const response = await PATCH(
      patchRequest({ name: "Defect" }),
      tagRouteContext()
    );

    expect(response.status).toBe(500);
    const json = await readJson(response);
    expect(json.error).toBe("Failed to update tag");
  });
});

describe("DELETE /tags/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the tag", async () => {
    vi.mocked(tagService.delete).mockResolvedValue(undefined as never);

    const response = await DELETE(deleteRequest(), tagRouteContext());

    expect(response.status).toBe(200);
    const json = await readJson(response);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ deleted: true });
    expect(tagService.delete).toHaveBeenCalledWith(
      TAG_ID,
      SESSION_ORG_ID,
      undefined
    );
  });

  it("maps EntityNotFoundError to 404", async () => {
    vi.mocked(tagService.delete).mockRejectedValue(
      new EntityNotFoundError("Tag", TAG_ID)
    );

    const response = await DELETE(deleteRequest(), tagRouteContext());

    expect(response.status).toBe(404);
    const json = await readJson(response);
    expect(json.success).toBe(false);
    expect(json.error).toBe("Tag not found");
  });

  it("maps an unrecognised failure to 500, not 404", async () => {
    vi.mocked(tagService.delete).mockRejectedValue(new Error("Database error"));

    const response = await DELETE(deleteRequest(), tagRouteContext());

    expect(response.status).toBe(500);
    const json = await readJson(response);
    expect(json.error).toBe("Failed to delete tag");
  });
});

/**
 * What these cases can and cannot catch — same limit as `tags.test.ts`.
 *
 * `withAnyAuth` falls back to a method-derived scope when a route passes no options,
 * and for these two verbs the fallback equals what the route declares (PATCH/write,
 * DELETE/delete). So a case here cannot tell a declared scope from an inherited one;
 * what it does catch is the gate being WIDENED, e.g. a DELETE that settles for `write`.
 */
describe("/tags/[id] API-key scope gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tagService.update).mockResolvedValue(tagRow() as never);
    vi.mocked(tagService.delete).mockResolvedValue(undefined as never);
  });

  it("requires the write scope of a PATCH caller", async () => {
    await PATCH(
      patchRequest({ name: "Defect" }, API_KEY_AUTHORIZATION),
      tagRouteContext()
    );

    expect(withApiKeyAuthMock).toHaveBeenCalledWith(expect.any(Function), {
      requiredScopes: [ApiKeyScope.Write],
    });
  });

  it("requires the delete scope of a DELETE caller", async () => {
    await DELETE(deleteRequest(API_KEY_AUTHORIZATION), tagRouteContext());

    const options = withApiKeyAuthMock.mock.calls[0]?.[1];
    expect(options?.requiredScopes).toEqual([ApiKeyScope.Delete]);
    expect(options?.requiredScopes).not.toContain(ApiKeyScope.Write);
  });

  it("reads the organization off the authenticated principal, never the request", async () => {
    await DELETE(deleteRequest(API_KEY_AUTHORIZATION), tagRouteContext());

    // The service is mocked, so this proves only that the handler forwards the
    // API key's own org — NOT that the delete predicate filters by it. Org-scoping
    // itself stays proven in `__tests__/unit/tags-service.test.ts`.
    expect(tagService.delete).toHaveBeenCalledWith(
      TAG_ID,
      API_KEY_ORG_ID,
      undefined
    );
  });

  it("still serves a Clerk session caller", async () => {
    await DELETE(deleteRequest(), tagRouteContext());

    expect(withApiKeyAuthMock).not.toHaveBeenCalled();
    expect(withAuthMock).toHaveBeenCalled();
    expect(tagService.delete).toHaveBeenCalledWith(
      TAG_ID,
      SESSION_ORG_ID,
      undefined
    );
  });
});

const TAG_ID = "tag-1";
const TAG_URL = `http://localhost:3002/tags/${TAG_ID}`;
const API_KEY_AUTHORIZATION = { authorization: "Bearer sk_live_test" };

function tagRow(overrides?: Record<string, unknown>) {
  return {
    id: TAG_ID,
    name: "Bug",
    color: TagColor.Red,
    organizationId: SESSION_ORG_ID,
    createdById: SESSION_USER_ID,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

function readJson(response: unknown) {
  return (response as Response).json();
}

function patchRequest(body: unknown, headers?: Record<string, string>) {
  return createMockRequest({ url: TAG_URL, method: "PATCH", body, headers });
}

function deleteRequest(headers?: Record<string, string>) {
  return createMockRequest({ url: TAG_URL, method: "DELETE", headers });
}

const tagRouteContext = () => createMockRouteContext({ id: TAG_ID });
