/**
 * ISS-9559: the capability a DETAIL READ actually serves.
 *
 * Deliberately does NOT mock `document-status-mutation-capability` — the point
 * is that the real builder and the real fail-closed scope check run through the
 * production route. With the helper mocked, deleting the route's call site
 * leaves an assertion about the mock still green.
 *
 * BOTH artifact lookup paths are held to it in one file, for the same reason:
 * `by-slug/[slug]/route.test.ts` does mock the helper, so dropping the
 * permissions argument from that route alone stayed green there and the two
 * paths could serve different capabilities. Each case below asserts the
 * response of both routes, so a divergence cannot pass.
 *
 * The api-key half of each case is a WIRING pin on `by-slug`, not a production
 * story. That route is wrapped in `withAuth`, which hard-codes
 * `authMethod: "session"` and leaves `apiKeyScopes` undefined, so it never
 * serves an api-key `AuthContext` in prod; the read-only-key story below only
 * actually reaches a caller on the `[id]` route, which is `withAnyAuth`. What
 * the by-slug assertions pin is that the route hands its own `AuthContext` to
 * the same resolver rather than dropping the argument — so the answer stays
 * correct for whatever context its wrapper does produce.
 */
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import { createTestAuthContext } from "../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockFindById = vi.hoisted(() => vi.fn());
const mockFindBySlug = vi.hoisted(() => vi.fn());
const mockGetLatestVersion = vi.hoisted(() => vi.fn());
const mockGetByVersion = vi.hoisted(() => vi.fn());
const mockMergeCustomFieldsIntoResponse = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, ctx: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, ctx.params),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, ctx: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, ctx.params),
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveDocumentId: vi.fn(async (id: string) => id),
    resolveProjectId: vi.fn(async (id: string) => id),
  };
});

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    delete: vi.fn(),
    findById: mockFindById,
    findBySlug: mockFindBySlug,
  },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getByVersion: mockGetByVersion,
    getLatest: mockGetLatestVersion,
  },
}));

vi.mock("../../custom-fields/route-helpers", () => ({
  customFieldsPreflightResponse: vi.fn(() => Promise.resolve(null)),
  mergeCustomFieldsIntoResponse: (...args: unknown[]) =>
    mockMergeCustomFieldsIntoResponse(...args),
}));

import { GET } from "../[id]/route";
import { GET as GET_BY_SLUG } from "../by-slug/[slug]/route";

const ARTIFACT = {
  id: "a1",
  status: "TODO",
  slug: "iss-1",
  latestVersion: 1,
  type: "FEATURE",
  projectId: "p1",
};

const VERSION = {
  id: "version-1",
  documentId: "a1",
  version: 1,
  content: "version content",
  createdById: null,
  createdAt: new Date("2026-09-11T12:00:00Z"),
};

async function readCapability(res: Response) {
  const json = await res.json();
  return { status: res.status, capability: json.data?.statusMutation };
}

/**
 * Serves the SAME artifact through both detail lookups, so every case below
 * asserts the by-slug response as well as the by-id one and the two cannot
 * drift apart unasserted.
 */
async function serveBothLookups() {
  const byId = await GET(new NextRequest("http://localhost/documents/a1"), {
    params: Promise.resolve({ id: "a1" }),
  });
  const bySlug = await GET_BY_SLUG(
    new NextRequest("http://localhost/documents/by-slug/iss-1"),
    { params: Promise.resolve({ slug: "iss-1" }) }
  );

  return {
    byId: await readCapability(byId),
    bySlug: await readCapability(bySlug),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue(ARTIFACT);
  mockFindBySlug.mockResolvedValue(ARTIFACT);
  mockGetLatestVersion.mockResolvedValue(VERSION);
  mockGetByVersion.mockResolvedValue(VERSION);
  mockMergeCustomFieldsIntoResponse.mockImplementation(
    async (doc: unknown) => doc
  );
});

describe("artifact detail status-mutation permissions", () => {
  it("tells a read-only api key it may make neither status write", async () => {
    mockAuthContext = createTestAuthContext({
      authMethod: "api_key",
      apiKeyScopes: [ApiKeyScope.Read],
    });

    const { byId, bySlug } = await serveBothLookups();

    expect(byId.status).toBe(200);
    expect(byId.capability.permissions).toEqual({ single: false, bulk: false });
    expect(bySlug.status).toBe(200);
    expect(bySlug.capability.permissions).toEqual({
      single: false,
      bulk: false,
    });
  });

  it("tells a write-scoped api key it may make both", async () => {
    mockAuthContext = createTestAuthContext({
      authMethod: "api_key",
      apiKeyScopes: [ApiKeyScope.Read, ApiKeyScope.Write],
    });

    const { byId, bySlug } = await serveBothLookups();

    expect(byId.status).toBe(200);
    expect(byId.capability.permissions).toEqual({ single: true, bulk: true });
    expect(bySlug.status).toBe(200);
    expect(bySlug.capability.permissions).toEqual({ single: true, bulk: true });
  });

  it("still serves the subtype vocabulary it did before the permission axis", async () => {
    mockAuthContext = createTestAuthContext({
      authMethod: "api_key",
      apiKeyScopes: [ApiKeyScope.Read],
    });

    const { byId, bySlug } = await serveBothLookups();

    expect(byId.status).toBe(200);
    expect(byId.capability.allowedStatuses).toEqual([
      "TRIAGE",
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "BLOCKED",
      "DONE",
      "CANCELED",
    ]);
    expect(byId.capability.expectedStatusField).toBe("expectedStatus");
    expect(byId.capability.expectedStatusByIdField).toBe("expectedStatusById");
    expect(bySlug.status).toBe(200);
    expect(bySlug.capability).toEqual(byId.capability);
  });
});
