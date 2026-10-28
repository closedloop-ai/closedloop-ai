import {
  DOCUMENT_ROUTE_PREFIX,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document.js";
import { SearchMode } from "@repo/api/src/types/search.js";
import {
  PHASE_1_SEARCH_ENTITY_TYPES,
  SearchEntityType,
} from "@repo/api/src/types/search-entity-kind.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerSearch } from "../tools/search.js";
import { MAX_CURSOR_CHARS } from "../tools/tool-utils.js";
import {
  createToolHarness,
  createToolHarnessWithMock,
  parseToolPayload,
  registeredInputSchema,
} from "./fixtures/tool-harness.js";

describe("search MCP tool", () => {
  it("forwards q to GET /search and shapes documents + projects", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      documents: [
        {
          id: "doc-1",
          title: "Auth plan",
          slug: "PLN-4",
          type: "IMPLEMENTATION_PLAN",
          status: "IN_PROGRESS",
          priority: "HIGH",
          projectName: "Platform",
          assignee: {
            id: "user-1",
            email: "a@b.com",
            firstName: "Ada",
            lastName: "Lovelace",
            avatarUrl: null,
          },
          updatedAt: "2026-05-14T04:11:39.337Z",
        },
      ],
      projects: [
        {
          id: "proj-1",
          name: "Auth",
          slug: "PRO-2",
          status: "ACTIVE",
          priority: null,
          teamName: "Core",
          teamId: "team-1",
          assignee: null,
          updatedAt: "2026-05-13T16:31:44.128Z",
        },
      ],
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({ q: "auth" }));

    expect(get).toHaveBeenCalledWith("/search", { q: "auth" });
    expect(payload.query).toBe("auth");
    expect(payload.documentCount).toBe(1);
    expect(payload.projectCount).toBe(1);
    expect(payload.documents[0]).toMatchObject({
      id: "doc-1",
      title: "Auth plan",
      slug: "PLN-4",
      type: "IMPLEMENTATION_PLAN",
      status: "IN_PROGRESS",
      projectName: "Platform",
    });
    // webUrl is derived from slug + type via the shared document URL builder.
    expect(payload.documents[0].webUrl).toContain("PLN-4");
    expect(payload.documents[0].assignee).toMatchObject({ id: "user-1" });
    expect(payload.projects[0]).toMatchObject({
      id: "proj-1",
      name: "Auth",
      slug: "PRO-2",
      teamName: "Core",
      teamId: "team-1",
      assignee: null,
    });
  });

  it("tolerates a response with missing documents/projects arrays", async () => {
    const get = vi.fn().mockResolvedValue({ query: "nothing" });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({ q: "nothing" }));

    expect(payload).toEqual({
      query: "nothing",
      documentCount: 0,
      projectCount: 0,
      documents: [],
      projects: [],
    });
  });

  it("surfaces API errors as tool errors", async () => {
    const get = vi.fn().mockRejectedValue(new Error("boom"));
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const result = await handler({ q: "auth" });

    expect(result.isError).toBe(true);
  });

  it("runs the unified corpus search when mode is supplied and shapes ranked hits (incl. sessions)", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: "fulltext",
      results: [
        {
          entityType: SearchEntityType.AgentSession,
          entityId: "session-1",
          title: "plan",
          snippet: "make an <b>auth</b> plan",
          rank: 0.9,
          updatedAt: "2026-05-14T04:11:39.337Z",
          deepLink: "/sessions/session-1",
        },
        {
          entityType: "document",
          entityId: "doc-1",
          title: "Auth PRD",
          snippet: "<b>auth</b>",
          rank: 0.4,
          updatedAt: "2026-05-13T16:31:44.128Z",
          deepLink: "/documents/doc-1",
        },
      ],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ q: "auth", mode: "fulltext" })
    );

    // Unified path: mode passed through, ranked heterogeneous results returned.
    expect(get).toHaveBeenCalledWith("/search", {
      q: "auth",
      mode: "fulltext",
    });
    expect(payload.mode).toBe("fulltext");
    expect(payload.resultCount).toBe(2);
    // A session appears in the corpus alongside documents.
    const sessionHit = payload.results.find(
      (r: { entityType: string }) =>
        r.entityType === SearchEntityType.AgentSession
    );
    expect(sessionHit).toBeDefined();
    expect(sessionHit.webUrl).toContain("/sessions/session-1");
    // The wire `updatedAt` (an ISO string, not a Date) passes through verbatim.
    expect(sessionHit.updatedAt).toBe("2026-05-14T04:11:39.337Z");
    expect(sessionHit.rank).toBe(0.9);
  });

  it("falls back to the shared deep-link builder when the API omits deepLink", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: "fulltext",
      results: [
        {
          entityType: SearchEntityType.AgentSession,
          entityId: "session-9",
          title: "plan",
          snippet: "plan",
          rank: 0.5,
          updatedAt: "2026-05-14T04:11:39.337Z",
          // deepLink intentionally absent — the shaper reconstructs it.
        },
      ],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ q: "auth", mode: "fulltext" })
    );

    expect(payload.results[0].webUrl).toContain("/sessions/session-9");
  });

  it("prefers the Phase-2 route (type + slug) over the legacy deepLink for a document", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: "fulltext",
      results: [
        {
          entityType: "document",
          entityId: "doc-1",
          title: "Auth PRD",
          snippet: "<b>auth</b>",
          rank: 0.4,
          updatedAt: "2026-05-13T16:31:44.128Z",
          // Legacy UUID-only locator...
          deepLink: "/documents/doc-1",
          // ...but the Phase-2 route fields build the real web route.
          slug: "auth-prd",
          entitySubtype: "PRD",
        },
      ],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ q: "auth", mode: "fulltext" })
    );

    // The routable `/documents/<slug>` path wins over the UUID-only `/documents/<id>`.
    expect(payload.results[0].webUrl).toContain(
      `/${DOCUMENT_ROUTE_PREFIX}/auth-prd`
    );
    expect(payload.results[0].webUrl).not.toContain("doc-1");
  });

  it("forwards repeated types[] on the unified path", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: "fulltext",
      results: [],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    await handler({ q: "auth", types: ["document", "loop"] });

    expect(get).toHaveBeenCalledWith("/search", {
      q: "auth",
      mode: "fulltext",
      types: ["document", "loop"],
    });
  });

  // ISS-12435: `type:loop` stays an accepted filter for old callers; the API
  // holds no loop rows, so the unified path answers with no hits.
  it("routes a structured `q=type:loop` (no mode/types) through the unified path", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "type:loop",
      mode: SearchMode.Fulltext,
      results: [],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({ q: "type:loop" }));

    // The raw `q` is forwarded so the route re-parses the inline `type:` filter;
    // a `mode` is added so the unified path is taken deterministically. Crucially
    // NO `types[]` is re-extracted client-side (the route lifts it from `q`).
    expect(get).toHaveBeenCalledWith("/search", {
      q: "type:loop",
      mode: SearchMode.Fulltext,
    });
    // The unified (ranked-hits) shape is decoded, not the legacy empty
    // documents/projects payload the pre-fix code silently returned.
    expect(payload.mode).toBe(SearchMode.Fulltext);
    expect(payload.resultCount).toBe(0);
    expect(payload.results).toEqual([]);
    // No legacy fields leaked into the unified payload.
    expect(payload.documents).toBeUndefined();
    expect(payload.projects).toBeUndefined();
  });

  // ISS-12435: the `types` field still accepts `loop` from old callers, but its
  // description offers agents only the kinds that can return hits.
  it("accepts a `loop` type but does not offer it in the types description", () => {
    const { registerTool } = createToolHarnessWithMock(registerSearch, {
      get: vi.fn(),
    } as unknown as ApiClient);
    const schema = registeredInputSchema(registerTool);

    expect(
      schema.safeParse({ q: "auth", types: [SearchEntityType.Loop] }).success
    ).toBe(true);
    const description = schema.shape.types.description ?? "";
    expect(description).toContain(SearchEntityType.Document);
    expect(description).not.toContain(SearchEntityType.Loop);
  });

  it("routes a structured `q=status:TODO auth` through the unified path, forwarding the raw q", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: SearchMode.Fulltext,
      results: [
        {
          entityType: SearchEntityType.Document,
          entityId: "doc-5",
          title: "Auth PRD",
          snippet: "<b>auth</b>",
          rank: 0.6,
          updatedAt: "2026-05-13T16:31:44.128Z",
          deepLink: "/documents/doc-5",
          slug: "auth-prd",
          entitySubtype: DocumentType.Prd,
        },
      ],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({ q: "status:TODO auth" }));

    // The whole raw query (filter token + free text) is forwarded verbatim; the
    // route strips `status:TODO` into a predicate and runs FTS over `auth`.
    expect(get).toHaveBeenCalledWith("/search", {
      q: "status:TODO auth",
      mode: SearchMode.Fulltext,
    });
    expect(payload.resultCount).toBe(1);
    expect(payload.results[0].webUrl).toContain(
      `/${DOCUMENT_ROUTE_PREFIX}/auth-prd`
    );
  });

  it("forwards limit and cursor to GET /search on the unified path", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: SearchMode.Fulltext,
      results: [],
      nextCursor: "eyJyYW5rIjowfQ",
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    await handler({
      q: "auth",
      mode: SearchMode.Fulltext,
      limit: 50,
      cursor: "PAGE-1-CURSOR",
    });

    // limit is stringified for the query param; the opaque cursor passes verbatim.
    expect(get).toHaveBeenCalledWith("/search", {
      q: "auth",
      mode: SearchMode.Fulltext,
      limit: "50",
      cursor: "PAGE-1-CURSOR",
    });
  });

  it("routes a bare `q` + `cursor` (no mode/types) through the unified path", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: SearchMode.Fulltext,
      results: [],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ q: "auth", cursor: "PAGE-1-CURSOR" })
    );

    // A continuation token alone opts into the unified corpus search: a `mode` is
    // added so the route takes the unified path deterministically, and the cursor
    // is forwarded so paging continues instead of dead-ending on the legacy path.
    expect(get).toHaveBeenCalledWith("/search", {
      q: "auth",
      mode: SearchMode.Fulltext,
      cursor: "PAGE-1-CURSOR",
    });
    expect(payload.mode).toBe(SearchMode.Fulltext);
    expect(payload.results).toEqual([]);
  });

  it("keeps a plain-text `q` (no inline filters) on the legacy documents+projects path", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth service",
      documents: [
        {
          id: "doc-1",
          title: "Auth service",
          slug: "PRD-9",
          type: DocumentType.Prd,
          status: DocumentStatus.Approved,
          priority: null,
          projectName: null,
          assignee: null,
          updatedAt: "2026-05-14T04:11:39.337Z",
        },
      ],
      projects: [],
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({ q: "auth service" }));

    // No `mode`/`types` sent — the legacy `{ q }`-only call shape is preserved.
    expect(get).toHaveBeenCalledWith("/search", { q: "auth service" });
    expect(payload.documentCount).toBe(1);
    expect(payload.documents[0].id).toBe("doc-1");
    // Legacy shape, not the unified one.
    expect(payload.results).toBeUndefined();
  });

  it("keeps `q` + `limit` (no mode/types/cursor) on the legacy path, sending only `q`", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      documents: [],
      projects: [],
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({ q: "auth", limit: 50 }));

    // `limit` is a page-size modifier, not a response-shape switch: it does NOT
    // opt into the unified path (mirroring the route), and the legacy path cannot
    // page — so `GET /search` receives only `{ q }`, never `limit`.
    expect(get).toHaveBeenCalledWith("/search", { q: "auth" });
    // Legacy documents+projects shape, not the unified ranked-hits shape.
    expect(payload.results).toBeUndefined();
    expect(payload.documentCount).toBe(0);
    expect(payload.projectCount).toBe(0);
  });

  it("rejects a cursor exceeding MAX_CURSOR_CHARS at the schema level", () => {
    const get = vi.fn();
    const { registerTool } = createToolHarnessWithMock(registerSearch, {
      get,
    } as unknown as ApiClient);
    const schema = registeredInputSchema(registerTool);

    const result = schema.safeParse({
      q: "auth",
      mode: SearchMode.Fulltext,
      cursor: "A".repeat(MAX_CURSOR_CHARS + 1),
    });

    expect(result.success).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it("accepts a realistic ~60-character cursor", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: SearchMode.Fulltext,
      results: [],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    const realisticCursor =
      "eyJyYW5rIjowLjUsImlkIjoiMDFhMDZjMTAtYmY2Ny03NzliIn0";
    await handler({
      q: "auth",
      mode: SearchMode.Fulltext,
      cursor: realisticCursor,
    });

    expect(get).toHaveBeenCalledWith("/search", {
      q: "auth",
      mode: SearchMode.Fulltext,
      cursor: realisticCursor,
    });
  });

  it("collapses a repeated types array to the distinct kinds on the wire", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: SearchMode.Fulltext,
      results: [],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    // `GET /search` folds repeats to one predicate, so this call is valid today
    // and must stay valid; deduping here is what keeps the request line bounded
    // by the enum size instead of by the caller's array length (ISS-9177).
    await handler({
      q: "auth",
      types: Array.from({ length: 5000 }, () => PHASE_1_SEARCH_ENTITY_TYPES[0]),
    });

    expect(get).toHaveBeenCalledWith("/search", {
      q: "auth",
      mode: SearchMode.Fulltext,
      types: [PHASE_1_SEARCH_ENTITY_TYPES[0]],
    });
  });

  it("preserves first-seen order when deduping types, matching the route", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: SearchMode.Fulltext,
      results: [],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    await handler({
      q: "auth",
      types: [
        PHASE_1_SEARCH_ENTITY_TYPES[1],
        PHASE_1_SEARCH_ENTITY_TYPES[0],
        PHASE_1_SEARCH_ENTITY_TYPES[1],
      ],
    });

    expect(get).toHaveBeenCalledWith("/search", {
      q: "auth",
      mode: SearchMode.Fulltext,
      types: [PHASE_1_SEARCH_ENTITY_TYPES[1], PHASE_1_SEARCH_ENTITY_TYPES[0]],
    });
  });

  it("accepts a types array naming every kind exactly once", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: SearchMode.Fulltext,
      results: [],
      nextCursor: null,
    });
    const handler = createToolHarness(registerSearch, {
      get,
    } as unknown as ApiClient);

    await handler({
      q: "auth",
      types: [...PHASE_1_SEARCH_ENTITY_TYPES],
    });

    expect(get).toHaveBeenCalledWith("/search", {
      q: "auth",
      mode: SearchMode.Fulltext,
      types: [...PHASE_1_SEARCH_ENTITY_TYPES],
    });
  });
});
