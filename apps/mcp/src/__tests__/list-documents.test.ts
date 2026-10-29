import {
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_LIST_MAX_OFFSET,
} from "@repo/api/src/types/document.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import {
  registerListDocuments,
  shapeListDocumentItem,
} from "../tools/list-documents.js";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../tools/tool-utils.js";
import {
  createToolHarness,
  type PaginatedPayload,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

const BASE_DOC = {
  id: "doc-1",
  title: "My Doc",
  slug: "ISS-1",
  type: "ISSUE",
  status: "OPEN",
  projectId: "proj-1",
  dueDate: null,
  priority: null,
  sortOrder: null,
  assigneeId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tags: [],
  assignee: null,
  project: null,
};

describe("shapeListDocumentItem — assignee and project null arms", () => {
  it("returns null assignee when the row has no assignee", () => {
    const shaped = shapeListDocumentItem({ ...BASE_DOC, assignee: null });
    expect(shaped.assignee).toBeNull();
  });

  it("returns hydrated assignee object when the row has an assignee", () => {
    const shaped = shapeListDocumentItem({
      ...BASE_DOC,
      assignee: {
        id: "user-1",
        email: "user@example.com",
        firstName: "Jane",
        lastName: "Doe",
        avatarUrl: null,
      },
    } as Parameters<typeof shapeListDocumentItem>[0]);
    expect(shaped.assignee).not.toBeNull();
    expect((shaped.assignee as Record<string, unknown>).email).toBe(
      "user@example.com"
    );
  });

  it("returns null project when the row has no project", () => {
    const shaped = shapeListDocumentItem({ ...BASE_DOC, project: null });
    expect(shaped.project).toBeNull();
  });

  it("returns hydrated project object when the row has a project", () => {
    const shaped = shapeListDocumentItem({
      ...BASE_DOC,
      project: { name: "Alpha" },
    } as Parameters<typeof shapeListDocumentItem>[0]);
    expect(shaped.project).not.toBeNull();
    expect((shaped.project as Record<string, unknown>).name).toBe("Alpha");
  });
});

describe("list-documents MCP tool — fetchParentProjectionMap arms", () => {
  it("returns an empty map when the page documents list is empty (no ids to fetch)", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    await handler({});

    // get should only have been called for /documents, not /artifact-links/parents
    const paths = get.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/artifact-links/parents");
  });

  it("degrades gracefully to null projection map when /artifact-links/parents returns 404", async () => {
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve([BASE_DOC]);
      }
      if (path === "/artifact-links/parents") {
        return Promise.reject(new McpApiError("Not Found", { status: 404 }));
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({})) as { items: unknown[] };

    // Tool must not throw; item must be shaped with a synthetic empty projection
    expect(payload.items).toHaveLength(1);
    const item = payload.items[0] as Record<string, unknown>;
    expect(item.slug).toBe("ISS-1");
  });

  it("propagates non-404 errors from /artifact-links/parents", async () => {
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve([BASE_DOC]);
      }
      if (path === "/artifact-links/parents") {
        return Promise.reject(
          new McpApiError("Internal Server Error", { status: 500 })
        );
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const result = await handler({});

    expect(result.isError).toBe(true);
  });

  it("skips /artifact-links/parents call when includeParentArtifact is false", async () => {
    const get = vi.fn().mockResolvedValue([BASE_DOC]);
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    await handler({ includeParentArtifact: false });

    const paths = get.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/artifact-links/parents");
  });

  it("includes parentArtifact projection from map when 404 does NOT occur", async () => {
    const parentProjection = {
      targetId: "doc-1",
      linkId: "link-1",
      linkType: "PRODUCES",
      linkCreatedAt: "2026-01-01T00:00:00.000Z",
      parentArtifact: { id: "parent-1", slug: "PRD-1", name: "Parent PRD" },
    };
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve([BASE_DOC]);
      }
      if (path === "/artifact-links/parents") {
        return Promise.resolve([parentProjection]);
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({})) as { items: unknown[] };

    // withParentArtifactProjection should have been applied, merging parentArtifact
    const item = payload.items[0] as Record<string, unknown>;
    expect(item).toHaveProperty("parentArtifact");
  });

  it("uses synthetic empty projection when doc id is absent from the parentProjectionMap", async () => {
    // parentProjectionMap is populated but does NOT contain an entry for "doc-1",
    // so the `?? { targetId: itemId ?? "", ... }` fallback arm fires.
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve([BASE_DOC]);
      }
      if (path === "/artifact-links/parents") {
        // Return a projection for a different id — doc-1 is absent from the map
        return Promise.resolve([
          {
            targetId: "other-doc",
            linkId: null,
            linkType: null,
            linkCreatedAt: null,
            parentArtifact: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({})) as { items: unknown[] };

    expect(payload.items).toHaveLength(1);
    const item = payload.items[0] as Record<string, unknown>;
    // parentArtifact must be null — the synthetic fallback has parentArtifact: null
    expect(item.parentArtifact).toBeNull();
  });

  it("uses empty-string targetId fallback when the document has a null id", async () => {
    // Exercises the `itemId ?? ""` arm inside the synthetic fallback projection.
    const docWithNullId = { ...BASE_DOC, id: null };
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve([docWithNullId]);
      }
      if (path === "/artifact-links/parents") {
        // Return an empty array so the map has no matching entry, triggering
        // the `?? { targetId: itemId ?? "", ... }` path where itemId is null.
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({})) as { items: unknown[] };

    expect(payload.items).toHaveLength(1);
    const item = payload.items[0] as Record<string, unknown>;
    expect(item.parentArtifact).toBeNull();
  });
});

describe("list-documents MCP tool — ISS-6137 bounded server-side read", () => {
  function documentsQuery(get: ReturnType<typeof vi.fn>) {
    const call = get.mock.calls.find((c) => c[0] === "/documents");
    if (!call) {
      throw new Error("The tool never called /documents");
    }
    return call[1] as Record<string, string> | undefined;
  }

  it("sends limit, offset and includeTotal on the wire instead of reading the whole corpus", async () => {
    const get = vi.fn().mockResolvedValue({
      items: [BASE_DOC],
      total: 12_738,
      limit: 10,
      offset: 30,
      hasMore: true,
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    await handler({ limit: 10, offset: 30, includeParentArtifact: false });

    expect(documentsQuery(get)).toMatchObject({
      includeTotal: "true",
      limit: "10",
      offset: "30",
    });
  });

  it("applies the tool's default page size to the wire query when the caller sends no limit", async () => {
    const get = vi.fn().mockResolvedValue([BASE_DOC]);
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    await handler({ includeParentArtifact: false });

    expect(documentsQuery(get)).toMatchObject({
      limit: String(DEFAULT_PAGE_LIMIT),
      offset: "0",
    });
  });

  it("returns a server-paged envelope verbatim, with the server's own total and hasMore", async () => {
    // The page the server already sliced. Re-slicing it at the requested offset
    // — which is what this tool did while it fetched the whole corpus — would
    // read past a three-row array and hand back nothing, so every page after
    // the first would come back empty.
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve({
          items: [
            { ...BASE_DOC, id: "doc-51" },
            { ...BASE_DOC, id: "doc-52" },
            { ...BASE_DOC, id: "doc-53" },
          ],
          total: 12_738,
          limit: 25,
          offset: 50,
          hasMore: true,
        });
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ limit: 25, offset: 50, includeParentArtifact: false })
    ) as PaginatedPayload;

    expect(payload.items).toHaveLength(3);
    expect(payload.total).toBe(12_738);
    expect(payload.hasMore).toBe(true);
    expect(payload.nextOffset).toBe(75);
  });

  it("still slices in memory when a version-skewed API answers with the legacy bare array", async () => {
    // An API predating ISS-4576 strips `includeTotal` and returns the bare
    // array — and ignored `limit` too, so that array is the WHOLE matching set
    // and this tool must bound it exactly as it always did.
    const corpus = Array.from({ length: 5 }, (_, index) => ({
      ...BASE_DOC,
      id: `doc-${index}`,
    }));
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve(corpus);
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ limit: 2, offset: 2, includeParentArtifact: false })
    ) as PaginatedPayload;

    expect(payload.items.map((item) => item.id)).toEqual(["doc-2", "doc-3"]);
    expect(payload.total).toBe(5);
    expect(payload.hasMore).toBe(true);
  });

  it("only asks for parent projections for the page, not the corpus", async () => {
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve({
          items: [BASE_DOC],
          total: 12_738,
          limit: 25,
          offset: 0,
          hasMore: true,
        });
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    await handler({});

    const parentsCall = get.mock.calls.find(
      (c) => c[0] === "/artifact-links/parents"
    );
    if (!parentsCall) {
      throw new Error("The tool never asked for parent projections");
    }
    expect((parentsCall[1] as { targetIds: string[] }).targetIds).toEqual([
      "doc-1",
    ]);
  });

  it("bounds a page past DOCUMENT_LIST_MAX_OFFSET on the server and never reads the whole corpus (ISS-11161)", async () => {
    // An agent that pages by `offset` alone, as every shipped caller does.
    const offset = DOCUMENT_LIST_MAX_OFFSET + 50;
    const get = vi.fn().mockResolvedValue({
      items: [BASE_DOC],
      total: offset + 1,
      limit: 100,
      offset,
      hasMore: false,
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ limit: 100, offset, includeParentArtifact: false })
    ) as PaginatedPayload;

    const documentsCalls = get.mock.calls.filter((c) => c[0] === "/documents");
    expect(documentsCalls).toHaveLength(1);
    expect(documentsCalls[0]?.[1]).toMatchObject({
      limit: "100",
      offset: String(offset),
      includeTotal: "true",
    });
    expect(payload.items.map((item) => item.id)).toEqual([BASE_DOC.id]);
    expect(payload.total).toBe(offset + 1);
  });

  it.each([
    DOCUMENT_LIST_MAX_OFFSET - 1,
    DOCUMENT_LIST_MAX_OFFSET,
    DOCUMENT_LIST_MAX_OFFSET + 1,
    DOCUMENT_LIST_MAX_OFFSET + 100,
  ])(
    "returns the page at offset %i that the whole-corpus slice returned (ISS-11161)",
    async (offset) => {
      const corpus = Array.from(
        { length: DOCUMENT_LIST_MAX_OFFSET + 120 },
        (_, index) => ({ ...BASE_DOC, id: `doc-${index}` })
      );
      const get = vi.fn().mockImplementation((path: string, query) => {
        if (path !== "/documents") {
          return Promise.resolve([]);
        }
        const limit = Number(query.limit);
        const skip = Number(query.offset);
        const items = corpus.slice(skip, skip + limit);
        return Promise.resolve({
          items,
          total: corpus.length,
          limit,
          offset: skip,
          hasMore: skip + items.length < corpus.length,
        });
      });
      const handler = createToolHarness(registerListDocuments, {
        get,
      } as unknown as ApiClient);

      const payload = parseToolPayload(
        await handler({ limit: 100, offset, includeParentArtifact: false })
      ) as PaginatedPayload;

      const expected = corpus.slice(offset, offset + 100);
      expect(payload.items.map((item) => item.id)).toEqual(
        expected.map((document) => document.id)
      );
      expect(payload.total).toBe(corpus.length);
      expect(payload.hasMore).toBe(offset + expected.length < corpus.length);
    }
  );

  it("falls back to the whole-corpus read only when an API older than ISS-11161 refuses the deep offset", async () => {
    const corpus = Array.from({ length: 5 }, (_, index) => ({
      ...BASE_DOC,
      id: `doc-${index}`,
    }));
    const get = vi.fn().mockImplementation((path: string, query) => {
      if (path !== "/documents") {
        return Promise.resolve([]);
      }
      if (query.offset !== undefined) {
        return Promise.reject(
          new McpApiError("Invalid query parameters", { status: 400 })
        );
      }
      return Promise.resolve(corpus);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({
        limit: 2,
        offset: DOCUMENT_LIST_MAX_OFFSET + 1,
        includeParentArtifact: false,
      })
    ) as PaginatedPayload;

    const documentsQueries = get.mock.calls
      .filter((c) => c[0] === "/documents")
      .map((c) => c[1] as Record<string, string>);
    expect(documentsQueries).toHaveLength(2);
    expect(documentsQueries[1]).not.toHaveProperty("offset");
    expect(payload.items).toEqual([]);
    expect(payload.total).toBe(5);
  });

  it.each([
    { offset: 50, status: 400 },
    { offset: DOCUMENT_LIST_MAX_OFFSET + 1, status: 500 },
  ])(
    "surfaces a $status at offset $offset instead of reading the whole corpus",
    async ({ offset, status }) => {
      const get = vi
        .fn()
        .mockRejectedValue(new McpApiError("Request failed", { status }));
      const handler = createToolHarness(registerListDocuments, {
        get,
      } as unknown as ApiClient);

      const result = await handler({ offset, includeParentArtifact: false });

      expect(result.isError).toBe(true);
      expect(get.mock.calls.filter((c) => c[0] === "/documents")).toHaveLength(
        1
      );
    }
  );

  it("surfaces a filter 400 at a deep offset rather than reading the whole corpus", async () => {
    // Against a current API a deep-offset 400 can only come from a filter, and
    // the unbounded retry carries the same filters, so it is refused too and
    // no corpus is ever read.
    const get = vi
      .fn()
      .mockRejectedValue(
        new McpApiError("Invalid query parameters: assigneeId", { status: 400 })
      );
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const result = await handler({
      assigneeId: "not-a-uuid",
      offset: DOCUMENT_LIST_MAX_OFFSET + 1,
      includeParentArtifact: false,
    });

    expect(result.isError).toBe(true);
    const documentsQueries = get.mock.calls
      .filter((c) => c[0] === "/documents")
      .map((c) => c[1] as Record<string, string>);
    expect(documentsQueries).toHaveLength(2);
    expect(documentsQueries[1]).toMatchObject({ assigneeId: "not-a-uuid" });
  });

  it("slices in memory when an envelope reports it applied no bound", async () => {
    // `limit: null` inside an envelope means the server understood
    // `includeTotal` but bounded nothing, so its items are the whole matching
    // set and this tool still owes the slice. Reading that as a server-applied
    // page returned the corpus; falling through to the bare-array arm threw,
    // because the envelope object is not an array.
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve({
          items: Array.from({ length: 5 }, (_, index) => ({
            ...BASE_DOC,
            id: `doc-${index}`,
          })),
          total: 5,
          limit: null,
          offset: 0,
          hasMore: false,
        });
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ limit: 2, offset: 1, includeParentArtifact: false })
    ) as PaginatedPayload;

    expect(payload.items.map((item) => item.id)).toEqual(["doc-1", "doc-2"]);
    expect(payload.total).toBe(5);
    expect(payload.hasMore).toBe(true);
  });

  it("re-reads unbounded for a deep page when a bare array leaves the bound ambiguous", async () => {
    // `limit` (FEA-4373) and `includeTotal` (ISS-4576) landed separately, so a
    // peer between them answers a bounded request with a bare array that is
    // ALREADY the page. Slicing that again at the requested offset returns an
    // empty page and a `total` of the page's own length — a confident wrong
    // count of the corpus. Nothing in the body distinguishes the two readings,
    // so a deep page asks again without the bound rather than guessing.
    const corpus = Array.from({ length: 5 }, (_, index) => ({
      ...BASE_DOC,
      id: `doc-${index}`,
    }));
    const get = vi.fn().mockImplementation((path: string, query?: unknown) => {
      if (path !== "/documents") {
        return Promise.resolve([]);
      }
      const asked = (query ?? {}) as Record<string, string>;
      // The bounded ask comes back as the PAGE, in the legacy bare shape.
      if (asked.limit) {
        return Promise.resolve(corpus.slice(2, 4));
      }
      return Promise.resolve(corpus);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ limit: 2, offset: 2, includeParentArtifact: false })
    ) as PaginatedPayload;

    const documentsCalls = get.mock.calls.filter((c) => c[0] === "/documents");
    expect(documentsCalls).toHaveLength(2);
    expect(documentsCalls[1]?.[1]).not.toHaveProperty("limit");
    expect(payload.items.map((item) => item.id)).toEqual(["doc-2", "doc-3"]);
    expect(payload.total).toBe(5);
    expect(payload.hasMore).toBe(true);
  });

  it("does not re-read for a first page the peer answered SHORT", async () => {
    // One row against a limit of two. No server bound below the one asked for
    // can return fewer rows than requested while more remain, so this array is
    // the whole matching set and its counts are safe to publish.
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve([BASE_DOC]);
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ limit: 2, offset: 0, includeParentArtifact: false })
    ) as PaginatedPayload;

    expect(get.mock.calls.filter((c) => c[0] === "/documents")).toHaveLength(1);
    expect(payload.total).toBe(1);
    expect(payload.hasMore).toBe(false);
  });

  it("does not re-read when a legacy peer returns MORE rows than the limit asked for", async () => {
    // A server honouring `limit` returns at most that many, so an over-limit
    // array proves the peer ignored the bound and the body is already the whole
    // corpus. Re-reading it would cost a second full read to learn nothing —
    // and this is the commonest legacy shape, a peer predating `limit` entirely.
    const corpus = Array.from({ length: 5 }, (_, index) => ({
      ...BASE_DOC,
      id: `doc-${index}`,
    }));
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/documents") {
        return Promise.resolve(corpus);
      }
      return Promise.resolve([]);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ limit: 2, offset: 0, includeParentArtifact: false })
    ) as PaginatedPayload;

    expect(get.mock.calls.filter((c) => c[0] === "/documents")).toHaveLength(1);
    expect(payload.items.map((item) => item.id)).toEqual(["doc-0", "doc-1"]);
    expect(payload.total).toBe(5);
    expect(payload.hasMore).toBe(true);
  });

  it("re-reads unbounded when a legacy peer fills the FIRST page exactly", async () => {
    // The offset-0 case a `page.offset === 0` short circuit gets wrong. A peer
    // after FEA-4373 but before ISS-4576 honours `limit` and drops
    // `includeTotal`, so a full first page comes back as a bare array that is
    // ALREADY bounded. Trusting it publishes `total` = the page's own length
    // and `hasMore` = false, and an agent reading that never asks for page two.
    // Slicing is a no-op at offset 0; the COUNTS are what disagree.
    const corpus = Array.from({ length: 5 }, (_, index) => ({
      ...BASE_DOC,
      id: `doc-${index}`,
    }));
    const get = vi.fn().mockImplementation((path: string, query?: unknown) => {
      if (path !== "/documents") {
        return Promise.resolve([]);
      }
      const asked = (query ?? {}) as Record<string, string>;
      if (asked.limit) {
        return Promise.resolve(corpus.slice(0, Number(asked.limit)));
      }
      return Promise.resolve(corpus);
    });
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ limit: 2, offset: 0, includeParentArtifact: false })
    ) as PaginatedPayload;

    expect(payload.items.map((item) => item.id)).toEqual(["doc-0", "doc-1"]);
    expect(payload.total).toBe(5);
    expect(payload.hasMore).toBe(true);
  });

  it("keeps its own page cap within the one the server will accept", () => {
    // Before ISS-6137 the server's cap was irrelevant here — the tool never sent
    // a `limit`. It does now, and the server REJECTS an over-cap limit rather
    // than clamping it, so these two independently-owned numbers have to stay
    // ordered or every maximum-size page becomes a 400.
    expect(MAX_PAGE_LIMIT).toBeLessThanOrEqual(DOCUMENT_LIST_MAX_LIMIT);
    expect(DEFAULT_PAGE_LIMIT).toBeLessThanOrEqual(DOCUMENT_LIST_MAX_LIMIT);
  });

  it("still bounds the read at the server's offset ceiling itself", async () => {
    const get = vi.fn().mockResolvedValue([BASE_DOC]);
    const handler = createToolHarness(registerListDocuments, {
      get,
    } as unknown as ApiClient);

    await handler({
      offset: DOCUMENT_LIST_MAX_OFFSET,
      includeParentArtifact: false,
    });

    expect(documentsQuery(get)).toMatchObject({
      offset: String(DOCUMENT_LIST_MAX_OFFSET),
    });
  });
});
