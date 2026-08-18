import { DocumentStatus, DocumentType } from "@repo/api/src/types/document.js";
import { SearchMode } from "@repo/api/src/types/search.js";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerSearch } from "../tools/search.js";
import {
  createToolHarness,
  parseToolPayload,
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

  it("runs the unified corpus search when mode is supplied and shapes ranked hits (incl. loops)", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: "fulltext",
      results: [
        {
          entityType: "loop",
          entityId: "loop-1",
          title: "plan",
          snippet: "make an <b>auth</b> plan",
          rank: 0.9,
          updatedAt: "2026-05-14T04:11:39.337Z",
          deepLink: "/loops/loop-1",
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
    // A loop appears in the corpus alongside documents.
    const loopHit = payload.results.find(
      (r: { entityType: string }) => r.entityType === "loop"
    );
    expect(loopHit).toBeDefined();
    expect(loopHit.webUrl).toContain("/loops/loop-1");
    // The wire `updatedAt` (an ISO string, not a Date) passes through verbatim.
    expect(loopHit.updatedAt).toBe("2026-05-14T04:11:39.337Z");
    expect(loopHit.rank).toBe(0.9);
  });

  it("falls back to the shared deep-link builder when the API omits deepLink", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      mode: "fulltext",
      results: [
        {
          entityType: "loop",
          entityId: "loop-9",
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

    expect(payload.results[0].webUrl).toContain("/loops/loop-9");
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

    // The routable /prds/<slug> path wins over the UUID-only /documents/<id>.
    expect(payload.results[0].webUrl).toContain("/prds/auth-prd");
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

  it("routes a structured `q=type:loop` (no mode/types) through the unified path", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "type:loop",
      mode: SearchMode.Fulltext,
      results: [
        {
          entityType: SearchEntityType.Loop,
          entityId: "loop-7",
          title: "nightly plan",
          snippet: "nightly plan",
          rank: 0.8,
          updatedAt: "2026-05-14T04:11:39.337Z",
          deepLink: "/loops/loop-7",
        },
      ],
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
    expect(payload.resultCount).toBe(1);
    expect(payload.results[0].entityType).toBe(SearchEntityType.Loop);
    expect(payload.results[0].webUrl).toContain("/loops/loop-7");
    // No legacy fields leaked into the unified payload.
    expect(payload.documents).toBeUndefined();
    expect(payload.projects).toBeUndefined();
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
    expect(payload.results[0].webUrl).toContain("/prds/auth-prd");
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
});
