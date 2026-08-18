import { SearchMode } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  legacySearch: vi.fn(),
  searchByTag: vi.fn(),
  searchUnified: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (ctx: unknown, req: Request) => unknown) => (req: Request) =>
      handler({ user: { organizationId: "org-1", id: "user-1" } }, req),
}));

vi.mock("./service", () => ({
  searchService: {
    search: mocks.legacySearch,
    searchByTag: mocks.searchByTag,
  },
}));

vi.mock("./search-fts-service", async () => {
  const actual = await vi.importActual<typeof import("./search-fts-service")>(
    "./search-fts-service"
  );
  return {
    ...actual,
    searchFtsService: { searchUnified: mocks.searchUnified },
  };
});

import { GET } from "./route";

// The mocked withAnyAuth returns a single-arg handler; the real generic types
// GET as (req, ctx). Narrow to the mocked runtime shape for the test.
const invoke = GET as unknown as (req: Request) => Promise<Response>;

function get(url: string): Promise<Response> {
  return invoke(new Request(url));
}

describe("GET /search — legacy contract preserved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.legacySearch.mockResolvedValue({
      query: "acme",
      documents: [],
      projects: [],
    });
  });

  it("routes a bare ?q= to the legacy substring search (not the FTS path)", async () => {
    const res = await get("https://x/search?q=acme");
    expect(res.status).toBe(200);
    expect(mocks.legacySearch).toHaveBeenCalledWith("org-1", "acme");
    expect(mocks.searchUnified).not.toHaveBeenCalled();
  });

  it("keeps a bare ?q=<slug> on the legacy path so q-only callers get the GlobalSearchResponse shape", async () => {
    // Regression: `q=FEA-123` with no FTS opt-in must NOT flip the response
    // envelope to UnifiedSearchResponse — the mobile overlay and MCP default
    // search read documents/projects and would otherwise show zero results.
    const res = await get("https://x/search?q=FEA-123");
    expect(res.status).toBe(200);
    expect(mocks.legacySearch).toHaveBeenCalledWith("org-1", "FEA-123");
    expect(mocks.searchUnified).not.toHaveBeenCalled();
  });

  it("rejects a query shorter than 2 chars", async () => {
    const res = await get("https://x/search?q=a");
    expect(res.status).toBe(400);
  });

  it("routes ?tagId= to the tag search", async () => {
    mocks.searchByTag.mockResolvedValue({
      query: "",
      documents: [],
      projects: [],
    });
    const res = await get(
      "https://x/search?tagId=22222222-2222-4222-8222-222222222222"
    );
    expect(res.status).toBe(200);
    expect(mocks.searchByTag).toHaveBeenCalled();
    expect(mocks.legacySearch).not.toHaveBeenCalled();
  });
});

describe("GET /search — unified FTS contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchUnified.mockResolvedValue({
      query: "acme",
      mode: SearchMode.Fulltext,
      results: [],
      nextCursor: null,
    });
  });

  it("routes to the unified search when mode is present", async () => {
    const res = await get("https://x/search?q=acme&mode=fulltext");
    expect(res.status).toBe(200);
    expect(mocks.searchUnified).toHaveBeenCalledTimes(1);
    expect(mocks.legacySearch).not.toHaveBeenCalled();
    const params = mocks.searchUnified.mock.calls[0][0];
    expect(params.mode).toBe(SearchMode.Fulltext);
  });

  it("parses repeated types[] and forwards the Phase-1 corpus filter", async () => {
    await get("https://x/search?q=acme&types=document&types=loop");
    const params = mocks.searchUnified.mock.calls[0][0];
    expect(params.types).toEqual([
      SearchEntityType.Document,
      SearchEntityType.Loop,
    ]);
  });

  it("accepts the FEA-3930 corpus types[] (comment/pull_request/branch)", async () => {
    await get(
      "https://x/search?q=acme&types=comment&types=pull_request&types=branch"
    );
    const params = mocks.searchUnified.mock.calls[0][0];
    expect(params.types).toEqual([
      SearchEntityType.Comment,
      SearchEntityType.PullRequest,
      SearchEntityType.Branch,
    ]);
  });

  it("rejects an unsupported types[] value with 400 (not silently dropped)", async () => {
    const res = await get("https://x/search?q=acme&types=bogus");
    expect(res.status).toBe(400);
    expect(mocks.searchUnified).not.toHaveBeenCalled();
  });

  it("forwards an inline type: filter as the corpus predicate (FEA-4134)", async () => {
    await get("https://x/search?q=acme%20type:document%20type:loop");
    const params = mocks.searchUnified.mock.calls[0][0];
    expect(params.types).toEqual([
      SearchEntityType.Document,
      SearchEntityType.Loop,
    ]);
    // The inline type: tokens are stripped from the FTS text.
    expect(params.query).toBe("acme");
  });

  it("unions the types[] alias with the inline type: filter, deduped (FEA-4134)", async () => {
    await get(
      "https://x/search?q=acme%20type:document&types=loop&types=document"
    );
    const params = mocks.searchUnified.mock.calls[0][0];
    // Inline kinds first (first-seen), then the alias's new kind; the duplicate
    // `types=document` is dropped.
    expect(params.types).toEqual([
      SearchEntityType.Document,
      SearchEntityType.Loop,
    ]);
  });

  it("rejects an unknown inline type: value with 400 on the unified path (never silently dropped)", async () => {
    // The real search UI always opts into the unified path via `mode`, so a
    // malformed inline filter surfaces as a 400 there. (A bare q-only request
    // with no FTS opt-in and no VALID structured filter stays on the legacy
    // substring path by contract — the errored token can't divert it.)
    const res = await get(
      "https://x/search?q=acme%20type:widget&mode=fulltext"
    );
    expect(res.status).toBe(400);
    expect(mocks.searchUnified).not.toHaveBeenCalled();
  });

  it("takes the unified path for a type:-only query with no FTS opt-in", async () => {
    await get("https://x/search?q=type:loop");
    expect(mocks.searchUnified).toHaveBeenCalledTimes(1);
    expect(mocks.legacySearch).not.toHaveBeenCalled();
    const params = mocks.searchUnified.mock.calls[0][0];
    expect(params.types).toEqual([SearchEntityType.Loop]);
  });

  it("rejects an unsupported mode with 400", async () => {
    const res = await get("https://x/search?q=acme&mode=fuzzy");
    expect(res.status).toBe(400);
  });

  it("passes mode=prefix through for typeahead", async () => {
    await get("https://x/search?q=ac&mode=prefix");
    expect(mocks.searchUnified.mock.calls[0][0].mode).toBe(SearchMode.Prefix);
  });

  it("rejects an unparseable since date with 400", async () => {
    const res = await get("https://x/search?q=acme&since=not-a-date");
    expect(res.status).toBe(400);
  });

  it("forwards a valid since window", async () => {
    await get("https://x/search?q=acme&since=2026-01-01T00:00:00.000Z");
    const params = mocks.searchUnified.mock.calls[0][0];
    expect(params.since).toBeInstanceOf(Date);
  });

  it("forwards idLookup on a slug query once the unified path is opted into", async () => {
    // A bare `?q=FEA-123` stays legacy (see the legacy-contract suite); the
    // exact-lookup boost reaches the unified path only when the caller opts in
    // (here via `mode`), matching how the real search UI (`useUnifiedSearch`)
    // always sends `mode`.
    const res = await get("https://x/search?q=FEA-123&mode=fulltext");
    expect(res.status).toBe(200);
    expect(mocks.searchUnified).toHaveBeenCalledTimes(1);
    expect(mocks.legacySearch).not.toHaveBeenCalled();
    const params = mocks.searchUnified.mock.calls[0][0];
    expect(params.idLookup).toEqual({ slug: "FEA-123" });
    // The slug token is lifted out of the FTS text.
    expect(params.query).toBe("");
  });

  it("forwards idLookup on a uuid query once the unified path is opted into", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await get(`https://x/search?q=${uuid}&mode=fulltext`);
    const params = mocks.searchUnified.mock.calls[0][0];
    expect(params.idLookup).toEqual({ uuid });
    expect(mocks.legacySearch).not.toHaveBeenCalled();
  });

  it("forwards idLookup AND the remaining free text for a mixed id + words query", async () => {
    await get("https://x/search?q=FEA-7%20rocket&mode=fulltext");
    const params = mocks.searchUnified.mock.calls[0][0];
    expect(params.idLookup).toEqual({ slug: "FEA-7" });
    expect(params.query).toBe("rocket");
  });
});
