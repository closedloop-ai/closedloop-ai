/**
 * FEA-3704: route tests for the org-scoped, paginated source-occurrences read
 * (`GET /agent-components/source-occurrences`).
 *
 * Hard gate: cross-org isolation (the route passes the AUTH user's org, never a
 * client value), pagination (limit/offset forwarded; hasMore derived), auth
 * scope (withAnyAuth read), and validation (400 on a missing/invalid
 * definitionVersionId or a bad limit).
 *
 * Service-backed unit tests (Prisma mocked); DB-backed org-scoping is proven in
 * the definition-registry realdb integration test.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockGetSourceOccurrencePageForOrg = vi.fn();
  const authCtx = {
    userId: "user-1",
    organizationId: "org-1",
    clerkUserId: "clerk-user-1",
  };
  return { mockGetSourceOccurrencePageForOrg, authCtx };
});

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) =>
      handler(
        {
          user: {
            id: mocks.authCtx.userId,
            organizationId: mocks.authCtx.organizationId,
          },
          clerkUserId: mocks.authCtx.clerkUserId,
          authMethod: "session",
        },
        request,
        context.params
      ),
}));

vi.mock("../service", () => ({
  agentComponentsService: {
    getSourceOccurrencePageForOrg: mocks.mockGetSourceOccurrencePageForOrg,
  },
}));

import { GET as occurrencesRoute } from "../source-occurrences/route";

/** A syntactically valid UUID the query-schema `.uuid()` validator accepts. */
const VALID_DEFINITION_VERSION_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(query = "") {
  return new NextRequest(
    `http://localhost/agent-components/source-occurrences${query}`,
    { method: "GET" }
  );
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

function buildOccurrence(overrides: Record<string, unknown> = {}) {
  return {
    occurrenceType: "local",
    accessState: "accessible",
    repoFullName: null,
    repoPath: null,
    repoCommit: null,
    computeTargetId: "target-1",
    localPath: "/home/u/.claude/skills/x",
    packId: null,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("GET /agent-components/source-occurrences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authCtx.organizationId = "org-1";
    mocks.authCtx.userId = "user-1";
  });

  it("passes the AUTH user's org to the service (cross-org isolation)", async () => {
    mocks.mockGetSourceOccurrencePageForOrg.mockResolvedValue({
      items: [],
      total: 0,
      hasMore: false,
    });

    await occurrencesRoute(
      makeRequest(`?definitionVersionId=${VALID_DEFINITION_VERSION_ID}`),
      routeContext()
    );

    expect(mocks.mockGetSourceOccurrencePageForOrg).toHaveBeenCalledWith(
      "org-1",
      VALID_DEFINITION_VERSION_ID,
      0,
      50
    );
  });

  it("uses the caller's org (org-2), never a client-supplied one", async () => {
    mocks.authCtx.organizationId = "org-2";
    mocks.mockGetSourceOccurrencePageForOrg.mockResolvedValue({
      items: [buildOccurrence()],
      total: 1,
      hasMore: false,
    });

    // Even if an attacker tries to smuggle an organizationId query param, the
    // route only ever forwards the authenticated org (the schema drops it).
    const response = await occurrencesRoute(
      makeRequest(
        `?definitionVersionId=${VALID_DEFINITION_VERSION_ID}&organizationId=org-1`
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.mockGetSourceOccurrencePageForOrg).toHaveBeenCalledWith(
      "org-2",
      VALID_DEFINITION_VERSION_ID,
      0,
      50
    );
    expect(body.data.items).toHaveLength(1);
  });

  it("forwards limit/offset and returns the paginated payload", async () => {
    mocks.mockGetSourceOccurrencePageForOrg.mockResolvedValue({
      items: [buildOccurrence()],
      total: 12,
      hasMore: true,
    });

    const response = await occurrencesRoute(
      makeRequest(
        `?definitionVersionId=${VALID_DEFINITION_VERSION_ID}&limit=5&offset=5`
      ),
      routeContext()
    );
    const body = await response.json();

    expect(mocks.mockGetSourceOccurrencePageForOrg).toHaveBeenCalledWith(
      "org-1",
      VALID_DEFINITION_VERSION_ID,
      5,
      5
    );
    expect(response.status).toBe(200);
    expect(body.data.total).toBe(12);
    expect(body.data.hasMore).toBe(true);
  });

  it("returns 400 when definitionVersionId is missing", async () => {
    const response = await occurrencesRoute(makeRequest(), routeContext());
    expect(response.status).toBe(400);
    expect(mocks.mockGetSourceOccurrencePageForOrg).not.toHaveBeenCalled();
  });

  it("returns 400 when limit exceeds the max", async () => {
    const response = await occurrencesRoute(
      makeRequest(
        `?definitionVersionId=${VALID_DEFINITION_VERSION_ID}&limit=999999`
      ),
      routeContext()
    );
    expect(response.status).toBe(400);
    expect(mocks.mockGetSourceOccurrencePageForOrg).not.toHaveBeenCalled();
  });

  it("returns 400 when limit is not a number", async () => {
    const response = await occurrencesRoute(
      makeRequest(
        `?definitionVersionId=${VALID_DEFINITION_VERSION_ID}&limit=not-a-number`
      ),
      routeContext()
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when definitionVersionId is not a valid uuid", async () => {
    const response = await occurrencesRoute(
      makeRequest("?definitionVersionId=dv-1"),
      routeContext()
    );
    expect(response.status).toBe(400);
    expect(mocks.mockGetSourceOccurrencePageForOrg).not.toHaveBeenCalled();
  });
});
