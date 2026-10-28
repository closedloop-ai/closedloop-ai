/**
 * ISS-7461: `GET /tags` 4-way branch dispatch.
 *
 * The route stays a bare `Tag[]` by default (three independent deploy
 * boundaries — `useTags()`, `apps/mcp`, and installed pre-PRD-797 Desktop
 * builds' crewd client — all read it as an array), and opts into
 * filtering/paging/exact-lookup only when the caller asks. These tests assert WHICH service method ran for a given query,
 * not just the status code — a route that answers 200 from the wrong branch
 * (e.g. silently paging a legacy caller) is exactly the regression this
 * ticket exists to prevent. Modeled on `branches/route.test.ts` (auth
 * passthrough + `parseQueryParams`) and `documents/route.test.ts` (the
 * bare-array-vs-envelope branch assertions).
 */

import { TAG_LIST_DEFAULT_LIMIT } from "@repo/api/src/types/tag";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "user-1", organizationId: "org-1" } },
  findByOrg: vi.fn(),
  findManyByOrg: vi.fn(),
  findPageByOrg: vi.fn(),
  findByExactName: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: unknown) =>
      handler(mocks.auth, request, context),
}));

vi.mock("./service", () => ({
  tagService: {
    findByOrg: mocks.findByOrg,
    findManyByOrg: mocks.findManyByOrg,
    findPageByOrg: mocks.findPageByOrg,
    findByExactName: mocks.findByExactName,
  },
  DuplicateNameError: class DuplicateNameError extends Error {},
}));

import { GET } from "./route";

function request(url: string) {
  return new NextRequest(url, { method: "GET" });
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

function tagRow(overrides?: Record<string, unknown>) {
  return {
    id: "tag-1",
    organizationId: "org-1",
    name: "Bug",
    color: "red",
    ...overrides,
  };
}

describe("GET /tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByOrg.mockResolvedValue([tagRow()]);
    mocks.findManyByOrg.mockResolvedValue([tagRow()]);
    mocks.findPageByOrg.mockResolvedValue({
      items: [tagRow()],
      total: 1,
      hasMore: false,
    });
    mocks.findByExactName.mockResolvedValue(tagRow({ name: "DSP" }));
  });

  it("with no query params returns the bare array from the unbounded org read", async () => {
    const rows = Array.from(
      { length: TAG_LIST_DEFAULT_LIMIT * 2 + 1 },
      (_, index) => tagRow({ id: `tag-${index}` })
    );
    mocks.findByOrg.mockResolvedValue(rows);

    const response = await GET(
      request("https://api.example.test/tags"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(rows.length);
    expect(body.data).toEqual(rows);
    expect(mocks.findByOrg).toHaveBeenCalledWith("org-1");
    expect(mocks.findManyByOrg).not.toHaveBeenCalled();
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
  });

  it("routes ?projectId=<slug> to the SAME unbounded org read as no params (crewd compatibility, ISS-7461)", async () => {
    // Installed pre-PRD-797 Desktop builds' crewd client sends
    // `?projectId=<slug>` and has always gotten the unbounded array back — there has never been a project-scoped tag
    // predicate behind this route. Routing this case to a paged/filtered
    // read would silently truncate what crewd tags against.
    const response = await GET(
      request("https://api.example.test/tags?projectId=some-slug"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.findByOrg).toHaveBeenCalledWith("org-1");
    expect(mocks.findManyByOrg).not.toHaveBeenCalled();
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
  });

  it("accepts a blank ?projectId= as a no-op rather than a validation error", async () => {
    const response = await GET(
      request("https://api.example.test/tags?projectId="),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.findByOrg).toHaveBeenCalledWith("org-1");
  });

  it("routes ?includeTotal=false to the unbounded array read, not a truncated page", async () => {
    const response = await GET(
      request("https://api.example.test/tags?includeTotal=false"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(mocks.findByOrg).toHaveBeenCalledWith("org-1");
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
  });

  it("routes ?limit=&offset= to findManyByOrg and returns a bare array, not an envelope", async () => {
    const response = await GET(
      request("https://api.example.test/tags?limit=2&offset=0"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(mocks.findManyByOrg).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ limit: 2, offset: 0 })
    );
    expect(mocks.findByOrg).not.toHaveBeenCalled();
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
  });

  it("rejects ?search= without a limit with 400, no service call (the filter must stay bounded)", async () => {
    const response = await GET(
      request("https://api.example.test/tags?search=ds"),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findByOrg).not.toHaveBeenCalled();
    expect(mocks.findManyByOrg).not.toHaveBeenCalled();
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
    expect(mocks.findByExactName).not.toHaveBeenCalled();
  });

  it("routes ?search=&limit= to findManyByOrg with both forwarded", async () => {
    const response = await GET(
      request("https://api.example.test/tags?search=ds&limit=5"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.findManyByOrg).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ search: "ds", limit: 5 })
    );
    expect(mocks.findByOrg).not.toHaveBeenCalled();
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
  });

  it("routes ?limit=&includeTotal=true to findPageByOrg and returns the paged envelope", async () => {
    const response = await GET(
      request("https://api.example.test/tags?limit=2&includeTotal=true"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      items: [tagRow()],
      total: 1,
      hasMore: false,
    });
    expect(mocks.findPageByOrg).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ limit: 2 })
    );
    expect(mocks.findByOrg).not.toHaveBeenCalled();
  });

  it("never forwards includeTotal or projectId into a service call's query object", async () => {
    await GET(
      request(
        "https://api.example.test/tags?limit=2&includeTotal=true&projectId=some-slug"
      ),
      routeContext()
    );

    const [, forwarded] = mocks.findPageByOrg.mock.calls.at(-1) ?? [];
    expect(forwarded).toEqual(
      expect.not.objectContaining({ includeTotal: expect.anything() })
    );
    expect(forwarded).toEqual(
      expect.not.objectContaining({ projectId: expect.anything() })
    );
  });

  it("rejects ?includeTotal=true without a limit with 400, no service call", async () => {
    const response = await GET(
      request("https://api.example.test/tags?includeTotal=true"),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findByOrg).not.toHaveBeenCalled();
    expect(mocks.findManyByOrg).not.toHaveBeenCalled();
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
    expect(mocks.findByExactName).not.toHaveBeenCalled();
  });

  it("rejects ?offset= without a limit with 400, no service call", async () => {
    const response = await GET(
      request("https://api.example.test/tags?offset=5"),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findByOrg).not.toHaveBeenCalled();
    expect(mocks.findManyByOrg).not.toHaveBeenCalled();
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
    expect(mocks.findByExactName).not.toHaveBeenCalled();
  });

  it("routes ?name= to findByExactName with the org id and the raw name, wrapped as a single-element array", async () => {
    const response = await GET(
      request("https://api.example.test/tags?name=DSP"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.findByExactName).toHaveBeenCalledWith("org-1", "DSP");
    expect(body.data).toEqual([tagRow({ name: "DSP" })]);
  });

  // The envelope is the signal a client uses to tell "the server applied my
  // `name` filter" from "the server is too old to know the param and handed
  // back the whole catalogue". A bare 0-or-1 array is indistinguishable from
  // the latter, which made the MCP re-filter a server match locally and fail on
  // any name where Postgres `lower()` and JS `toLowerCase()` disagree.
  it("wraps ?name= in the envelope when includeTotal=true, without requiring a limit", async () => {
    const response = await GET(
      request("https://api.example.test/tags?name=DSP&includeTotal=true"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.findByExactName).toHaveBeenCalledWith("org-1", "DSP");
    expect(body.data).toEqual({
      items: [tagRow({ name: "DSP" })],
      total: 1,
      hasMore: false,
    });
  });

  it("reports total 0 in the ?name= envelope when nothing matches", async () => {
    mocks.findByExactName.mockResolvedValue(null);

    const response = await GET(
      request("https://api.example.test/tags?name=nope&includeTotal=true"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ items: [], total: 0, hasMore: false });
  });

  it("returns an empty array from ?name= when the service finds no match", async () => {
    mocks.findByExactName.mockResolvedValue(null);

    const response = await GET(
      request("https://api.example.test/tags?name=nope"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("rejects ?name= combined with ?limit= with 400 (name is an exclusive exact lookup), no service call", async () => {
    const response = await GET(
      request("https://api.example.test/tags?name=DSP&limit=5"),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findByOrg).not.toHaveBeenCalled();
    expect(mocks.findManyByOrg).not.toHaveBeenCalled();
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
    expect(mocks.findByExactName).not.toHaveBeenCalled();
  });

  it("rejects an unknown query param (?limt=5 typo) with 400, no service call", async () => {
    const response = await GET(
      request("https://api.example.test/tags?limt=5"),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findByOrg).not.toHaveBeenCalled();
    expect(mocks.findManyByOrg).not.toHaveBeenCalled();
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
    expect(mocks.findByExactName).not.toHaveBeenCalled();
  });

  it.each([
    ["limit=0", "?limit=0"],
    ["limit above the max", "?limit=101"],
    ["offset above the max", "?limit=1&offset=10001"],
    ["an unsupported includeTotal value", "?limit=1&includeTotal=yes"],
  ])("rejects %s with 400, no service call", async (_label, query) => {
    const response = await GET(
      request(`https://api.example.test/tags${query}`),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findByOrg).not.toHaveBeenCalled();
    expect(mocks.findManyByOrg).not.toHaveBeenCalled();
    expect(mocks.findPageByOrg).not.toHaveBeenCalled();
    expect(mocks.findByExactName).not.toHaveBeenCalled();
  });
});
