import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import {
  registerListDocuments,
  shapeListDocumentItem,
} from "../tools/list-documents.js";
import {
  createToolHarness,
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
