/**
 * T-10.2: Cloud API route integration tests for agent-components routes and
 * the desktop component-sync ingest.
 *
 * Tests:
 * - GET /agent-components: returns only calling org's components (cross-org isolation).
 * - GET /agent-components/{slug}: 200 when found, 404 when not found.
 * - POST /desktop/components/sync: rejects computeTargetId from another org (403),
 *   idempotent upsert.
 *
 * AC-009, AC-011, AC-013
 *
 * Note: These are service-backed unit tests (Prisma mocked). DB-backed integration
 * tests run in CI with a live database.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — all top-level variables used inside vi.mock() factories
// must be declared here so they are available when factories are hoisted.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockListForOrg = vi.fn();
  const mockGetDetailForOrg = vi.fn();
  const mockSync = vi.fn();

  // Mutable auth context — mutated in beforeEach per test
  const authCtx = {
    userId: "user-1",
    organizationId: "org-1",
    clerkUserId: "clerk-user-1",
  };

  return { mockListForOrg, mockGetDetailForOrg, mockSync, authCtx };
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
    listForOrg: mocks.mockListForOrg,
    getDetailForOrg: mocks.mockGetDetailForOrg,
  },
}));

vi.mock("@/app/desktop/components/sync/service", () => ({
  desktopComponentsSyncService: {
    sync: mocks.mockSync,
  },
}));

// Bypass schema validation in route tests — we test the schema separately.
vi.mock("@/lib/desktop-agent-sessions-schema", () => ({
  desktopAgentComponentsPayloadSchema: {
    safeParse: (data: unknown) => ({ success: true, data }),
  },
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION: 1,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { POST as syncRoute } from "@/app/desktop/components/sync/route";
import { GET as detailRoute } from "../[slug]/route";
import { GET as listRoute } from "../route";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeListRequest(query = "") {
  return new NextRequest(`http://localhost/agent-components${query}`, {
    method: "GET",
  });
}

function makeDetailRequest(slug: string) {
  return new NextRequest(
    `http://localhost/agent-components/${encodeURIComponent(slug)}`,
    { method: "GET" }
  );
}

function makeSyncRequest(computeTargetId: string, body: unknown) {
  return new NextRequest(
    `http://localhost/desktop/components/sync?computeTargetId=${computeTargetId}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
}

function listRouteContext() {
  return { params: Promise.resolve({}) };
}

function detailRouteContext(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function buildComponentItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "ac-uuid-1",
    name: "My Skill",
    kind: "skill",
    sourceType: "repo",
    source: "my-skill",
    harness: "claude",
    invocations: 5,
    sessions: 2,
    klocPerDollar: null,
    trend: [],
    owner: "Ada Lovelace",
    collaborators: [],
    computeTargetIds: ["target-1"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-10T00:00:00.000Z",
    ...overrides,
  };
}

function buildSyncPayload() {
  return {
    schemaVersion: 1,
    batchId: "11111111-1111-4111-8111-111111111111",
    syncMode: "incremental",
    componentCount: 1,
    components: [
      {
        externalId: "skill::my-skill",
        componentKind: "skill",
        harness: "claude",
        name: "My Skill",
        componentKey: "my-skill",
        version: null,
        description: null,
        sourceUrl: null,
        installPath: null,
        packId: null,
        scope: null,
        projectPath: null,
        metadata: null,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-10T00:00:00.000Z",
        uninstalledAt: null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// GET /agent-components — list route tests
// ---------------------------------------------------------------------------

describe("GET /agent-components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authCtx.organizationId = "org-1";
    mocks.authCtx.userId = "user-1";
  });

  it("passes organizationId from auth context to listForOrg (cross-org isolation)", async () => {
    mocks.mockListForOrg.mockResolvedValue({
      items: [],
      total: 0,
      hasMore: false,
    });

    await listRoute(makeListRequest(), listRouteContext());

    expect(mocks.mockListForOrg).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({})
    );
  });

  it("returns 200 with items from the service", async () => {
    const item = buildComponentItem();
    mocks.mockListForOrg.mockResolvedValue({
      items: [item],
      total: 1,
      hasMore: false,
    });

    const response = await listRoute(makeListRequest(), listRouteContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe("ac-uuid-1");
  });

  it("returns 200 with empty items when no components exist for org-1", async () => {
    mocks.mockListForOrg.mockResolvedValue({
      items: [],
      total: 0,
      hasMore: false,
    });

    const response = await listRoute(makeListRequest(), listRouteContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.items).toHaveLength(0);
  });

  it("uses the caller's org even when org-2 data exists in the service", async () => {
    // When org-2 is authenticated, listForOrg should be called with "org-2",
    // not "org-1" — demonstrating cross-org isolation via auth context.
    mocks.authCtx.organizationId = "org-2";
    const org2Item = buildComponentItem({ id: "ac-org2", owner: "Bob" });
    mocks.mockListForOrg.mockResolvedValue({
      items: [org2Item],
      total: 1,
      hasMore: false,
    });

    const response = await listRoute(makeListRequest(), listRouteContext());
    const body = await response.json();

    // listForOrg must be called with the auth user's org (org-2), not org-1
    expect(mocks.mockListForOrg).toHaveBeenCalledWith(
      "org-2",
      expect.anything()
    );
    expect(body.data.items[0].id).toBe("ac-org2");
  });

  it("returns 400 when query params are invalid", async () => {
    // Pass an invalid limit value to trigger Zod validation failure
    const response = await listRoute(
      makeListRequest("?limit=not-a-number"),
      listRouteContext()
    );
    // Zod coerce will coerce non-number to NaN and fail validation → 400
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /agent-components/{slug} — detail route tests
// ---------------------------------------------------------------------------

describe("GET /agent-components/[slug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authCtx.organizationId = "org-1";
  });

  it("returns 200 with the component detail when found", async () => {
    const detail = {
      ...buildComponentItem(),
      properties: { path: "/path/to/skill", format: "md" },
      prompt: null,
      sessionsTab: [],
      branchesTab: [],
      provenance: [{ computeTargetId: "target-1" }],
      usageSessions: [],
    };
    mocks.mockGetDetailForOrg.mockResolvedValue(detail);

    const slug = "skill::my-skill";
    const response = await detailRoute(
      makeDetailRequest(slug),
      detailRouteContext(slug)
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe("ac-uuid-1");
    expect(mocks.mockGetDetailForOrg).toHaveBeenCalledWith(
      "org-1",
      "skill::my-skill"
    );
  });

  it("returns 404 when the component is not found", async () => {
    mocks.mockGetDetailForOrg.mockResolvedValue(null);

    const slug = "skill::nonexistent";
    const response = await detailRoute(
      makeDetailRequest(slug),
      detailRouteContext(slug)
    );

    expect(response.status).toBe(404);
  });

  it("URL-decodes the slug before passing to the service", async () => {
    mocks.mockGetDetailForOrg.mockResolvedValue(null);

    // The slug contains :: which gets encoded as %3A%3A in the URL
    const encodedSlug = "command%3A%3Acode-review";
    await detailRoute(
      makeDetailRequest(encodedSlug),
      detailRouteContext(encodedSlug)
    );

    expect(mocks.mockGetDetailForOrg).toHaveBeenCalledWith(
      "org-1",
      "command::code-review"
    );
  });
});

// ---------------------------------------------------------------------------
// POST /desktop/components/sync — sync ingest route tests
// ---------------------------------------------------------------------------

describe("POST /desktop/components/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authCtx.organizationId = "org-1";
    mocks.authCtx.userId = "user-1";
  });

  it("returns 200 with synced=true on successful sync", async () => {
    const { Result } = await import("@repo/api/src/types/result");
    mocks.mockSync.mockResolvedValue(Result.ok({ synced: true }));

    const response = await syncRoute(
      makeSyncRequest("target-owned-by-org1", buildSyncPayload()),
      listRouteContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.synced).toBe(true);
  });

  it("passes the auth user's organizationId to the sync service (not the payload's)", async () => {
    const { Result } = await import("@repo/api/src/types/result");
    mocks.mockSync.mockResolvedValue(Result.ok({ synced: true }));

    await syncRoute(
      makeSyncRequest("target-1", buildSyncPayload()),
      listRouteContext()
    );

    expect(mocks.mockSync).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        computeTargetId: "target-1",
        userId: "user-1",
      })
    );
  });

  it("returns 403 when computeTargetId belongs to a different org", async () => {
    // The ownership gate returns the numeric Status.Forbidden (403); the route
    // maps that to a 403 response. (It must NOT be the string "forbidden" — the
    // route compares against Status.Forbidden.)
    const { Result, Status } = await import("@repo/api/src/types/result");
    mocks.mockSync.mockResolvedValue(Result.err(Status.Forbidden));

    const response = await syncRoute(
      makeSyncRequest("target-owned-by-other-org", buildSyncPayload()),
      listRouteContext()
    );

    expect(response.status).toBe(403);
  });

  it("returns 400 when computeTargetId query param is missing", async () => {
    const response = await syncRoute(
      new NextRequest("http://localhost/desktop/components/sync", {
        method: "POST",
        body: JSON.stringify(buildSyncPayload()),
      }),
      listRouteContext()
    );

    expect(response.status).toBe(400);
  });

  it("calls the sync service with the compute target id and payload", async () => {
    const { Result } = await import("@repo/api/src/types/result");
    mocks.mockSync.mockResolvedValue(Result.ok({ synced: true }));
    const payload = buildSyncPayload();

    await syncRoute(makeSyncRequest("target-abc", payload), listRouteContext());

    expect(mocks.mockSync).toHaveBeenCalledWith(
      expect.objectContaining({
        computeTargetId: "target-abc",
      })
    );
  });

  it("returns 413 when the request body exceeds the 256 KiB cap", async () => {
    // Build a body larger than DESKTOP_COMPONENTS_SYNC_REQUEST_MAX_BYTES
    // (262_144 bytes). The size check runs before schema validation, so the
    // sync service must never be invoked.
    const bigDescription = "x".repeat(300_000);
    const oversized = {
      ...buildSyncPayload(),
      components: [
        { ...buildSyncPayload().components[0], description: bigDescription },
      ],
    };

    const response = await syncRoute(
      makeSyncRequest("target-1", oversized),
      listRouteContext()
    );

    expect(response.status).toBe(413);
    expect(mocks.mockSync).not.toHaveBeenCalled();
  });

  it("returns 400 when the request body is invalid JSON", async () => {
    // Send a malformed JSON string (not routed through JSON.stringify) so the
    // route's JSON.parse throws and it returns a 400 before schema validation.
    const request = new NextRequest(
      "http://localhost/desktop/components/sync?computeTargetId=target-1",
      { method: "POST", body: "{not valid json" }
    );

    const response = await syncRoute(request, listRouteContext());

    expect(response.status).toBe(400);
    expect(mocks.mockSync).not.toHaveBeenCalled();
  });
});
