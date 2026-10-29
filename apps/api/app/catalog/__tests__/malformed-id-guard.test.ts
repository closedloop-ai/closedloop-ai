/**
 * ISS-8880 §1 — a malformed `[id]` path segment must be answered at the
 * boundary, not handed to a `@db.Uuid` lookup.
 *
 * `CatalogItem.id` is `@db.Uuid`, so Postgres RAISES on a non-uuid comparand
 * rather than returning no row. Every handler here wraps its service call in a
 * catch-all that reports that raise as a 500 — and `errorResponse` records a
 * `SpanErrorSource.RouteHandler` span, so a caller's typo pages whoever owns the
 * route's error rate.
 *
 * Each case therefore asserts BOTH halves: the 404, and that the service was
 * never reached. A 404 alone would still pass if the guard were missing and the
 * mocked service happened to report "not found", so the never-called assertion
 * is what proves the answer came from the boundary.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  archiveCatalogItem: vi.fn(),
  getCatalogItemDetail: vi.fn(),
  getOrgAdminStatus: vi.fn(),
  importPackRepoComponents: vi.fn(),
  importPackZipComponents: vi.fn(),
  requireOrgAdmin: vi.fn(),
  updateCatalogItem: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
  requireOrgAdmin: mocks.requireOrgAdmin,
}));

vi.mock("@/app/catalog/service", () => ({
  archiveCatalogItem: mocks.archiveCatalogItem,
  getCatalogItemDetail: mocks.getCatalogItemDetail,
  importPackRepoComponents: mocks.importPackRepoComponents,
  importPackZipComponents: mocks.importPackZipComponents,
  updateCatalogItem: mocks.updateCatalogItem,
}));

import { POST as IMPORT_REPO } from "../[id]/import-repo/route";
import { POST as IMPORT_ZIP } from "../[id]/import-zip/route";
import { DELETE, GET, PATCH } from "../[id]/route";

/** Not a uuid in any shape a caller can plausibly send. */
const MALFORMED_IDS = [
  "not-a-uuid",
  "PRD-42",
  "12345",
  "0199a000-0000-7000-8000",
  "0199a000-0000-7000-8000-0000000000zz",
];

/** `CatalogItem.id` is `@default(uuid(7))`, so v7 is the format in production. */
const VALID_UUID_V7 = "0199a000-0000-7000-8000-00000000000a";

const VALID_REPO_BODY = { repoFullName: "owner/name" };

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function request(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/catalog/x", {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

function call(handler: unknown, id: string, body?: unknown): Promise<Response> {
  return (handler as (req: NextRequest, ctx: unknown) => Promise<Response>)(
    request(body),
    routeContext(id)
  );
}

/** Every service the five handlers can reach. */
const ALL_SERVICE_CALLS = [
  mocks.archiveCatalogItem,
  mocks.getCatalogItemDetail,
  mocks.importPackRepoComponents,
  mocks.importPackZipComponents,
  mocks.updateCatalogItem,
];

/** Every call any of the five handlers made, flattened for one assertion. */
function serviceCalls(): unknown[] {
  return ALL_SERVICE_CALLS.flatMap((serviceCall) => serviceCall.mock.calls);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Admitted, so a 404 below can only come from the id guard and never from an
  // authorization refusal wearing the same status.
  mocks.requireOrgAdmin.mockResolvedValue(null);
  mocks.getOrgAdminStatus.mockResolvedValue({ isAdmin: true });
  // Every service is wired to SUCCEED. If the guard were missing, each case
  // below would get a 200 — so these assertions cannot pass vacuously.
  mocks.getCatalogItemDetail.mockResolvedValue({
    ok: true,
    value: { id: "x" },
  });
  mocks.updateCatalogItem.mockResolvedValue({ ok: true, value: { id: "x" } });
  mocks.archiveCatalogItem.mockResolvedValue({ ok: true, value: { id: "x" } });
  mocks.importPackRepoComponents.mockResolvedValue({
    ok: true,
    value: { created: 0, skipped: 0, invalid: 0 },
  });
  mocks.importPackZipComponents.mockResolvedValue({
    ok: true,
    value: { created: 0, skipped: 0, invalid: 0 },
  });
});

describe("GET /catalog/[id] — malformed id", () => {
  it.each(MALFORMED_IDS)("answers 404 for %j without a query", async (id) => {
    const response = await call(GET, id);

    expect(response.status).toBe(404);
    expect(serviceCalls()).toHaveLength(0);
  });

  it("still reaches the service for a uuid v7", async () => {
    const response = await call(GET, VALID_UUID_V7);

    expect(response.status).toBe(200);
    expect(mocks.getCatalogItemDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: VALID_UUID_V7 })
    );
  });
});

describe("PATCH /catalog/[id] — malformed id", () => {
  it.each(MALFORMED_IDS)("answers 404 for %j without a query", async (id) => {
    const response = await call(PATCH, id, { name: "renamed" });

    expect(response.status).toBe(404);
    expect(serviceCalls()).toHaveLength(0);
  });

  it("still reaches the service for a uuid v7", async () => {
    const response = await call(PATCH, VALID_UUID_V7, { name: "renamed" });

    expect(response.status).toBe(200);
    expect(mocks.updateCatalogItem).toHaveBeenCalled();
  });
});

describe("DELETE /catalog/[id] — malformed id", () => {
  it.each(MALFORMED_IDS)("answers 404 for %j without a query", async (id) => {
    const response = await call(DELETE, id);

    expect(response.status).toBe(404);
    expect(serviceCalls()).toHaveLength(0);
  });

  it("still reaches the service for a uuid v7", async () => {
    await call(DELETE, VALID_UUID_V7);

    expect(mocks.archiveCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: VALID_UUID_V7 }),
      undefined
    );
  });
});

describe("POST /catalog/[id]/import-repo — malformed id", () => {
  it.each(MALFORMED_IDS)("answers 404 for %j without a query", async (id) => {
    const response = await call(IMPORT_REPO, id, VALID_REPO_BODY);

    // The body is valid, so a 404 here isolates the id guard from body validation.
    expect(response.status).toBe(404);
    expect(serviceCalls()).toHaveLength(0);
  });

  it("still reaches the service for a uuid v7", async () => {
    const response = await call(IMPORT_REPO, VALID_UUID_V7, VALID_REPO_BODY);

    expect(response.status).toBe(200);
    expect(mocks.importPackRepoComponents).toHaveBeenCalledWith(
      expect.objectContaining({ id: VALID_UUID_V7 }),
      undefined
    );
  });
});

describe("POST /catalog/[id]/import-zip — malformed id", () => {
  it.each(MALFORMED_IDS)("answers 404 for %j without a query", async (id) => {
    const response = await call(IMPORT_ZIP, id);

    expect(response.status).toBe(404);
    expect(serviceCalls()).toHaveLength(0);
  });

  it("still reaches the service for a uuid v7", async () => {
    const response = await call(IMPORT_ZIP, VALID_UUID_V7);

    expect(response.status).toBe(200);
    expect(mocks.importPackZipComponents).toHaveBeenCalledWith(
      expect.objectContaining({ id: VALID_UUID_V7 }),
      undefined
    );
  });
});
