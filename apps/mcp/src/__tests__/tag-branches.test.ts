import { DocumentType } from "@repo/api/src/types/document.js";
import { TAG_LIST_DEFAULT_LIMIT, TagColor } from "@repo/api/src/types/tag.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpApiError } from "../api-error.js";
import { registerTagArtifact } from "../tools/tag-artifact.js";
import { fetchOrgTagPage, resolveArtifactId } from "../tools/tag-resolution.js";
import { createToolHarness } from "./fixtures/tool-harness.js";

const ARTIFACT_ID = "01a010cc-42ad-7422-8d1d-8a35bf07e344";
const TAG_ID = "019fae2d-27f1-7702-9921-5db4096cbcca";
const TAG_NAME = "DSP";
const CREATED_NOTE = `tag "${TAG_NAME}" was created by this call`;
const tagRow = { id: TAG_ID, name: TAG_NAME, color: TagColor.Green };

const get = vi.fn();
const post = vi.fn();
const apiClient = { get, post } as never;

/**
 * Route reads by path. `existing` decides whether the exact-name lookup finds
 * the tag (created: false) or misses (the tool creates it: created: true).
 */
function routeReads(existing: boolean) {
  get.mockImplementation((path: string) => {
    if (path.startsWith("/documents/")) {
      return Promise.resolve({ id: ARTIFACT_ID, type: DocumentType.Feature });
    }
    const items = existing ? [tagRow] : [];
    return Promise.resolve({ items, total: items.length, hasMore: false });
  });
}

/** POST /tags creates the row; POST /entity-tags fails with `applyError`. */
function routeWrites(applyError: unknown) {
  post.mockImplementation((path: string) =>
    path === "/tags" ? Promise.resolve(tagRow) : Promise.reject(applyError)
  );
}

const TECHNICAL_DETAILS_MARKER = "Technical details:\n";

/** The `message` the tool error surfaces in its technical-details JSON. */
function technicalMessage(text: string | undefined): unknown {
  const raw = text ?? "";
  const start = raw.indexOf(TECHNICAL_DETAILS_MARKER);
  return JSON.parse(raw.slice(start + TECHNICAL_DETAILS_MARKER.length)).message;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tag-artifact apply failure context", () => {
  const handler = createToolHarness(registerTagArtifact, apiClient);

  it("surfaces the apply error unchanged when the tag already existed", async () => {
    routeReads(true);
    routeWrites(new McpApiError("Entity not found", { status: 404 }));

    const result = await handler({ documentId: "ISS-1", tagName: TAG_NAME });

    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalledWith("/tags", expect.anything());
    expect(technicalMessage(result.content[0]?.text)).toBe("Entity not found");
  });

  it("adds the created-tag note to a plain Error raised after this call created the tag", async () => {
    routeReads(false);
    routeWrites(new Error("apply exploded"));

    const result = await handler({ documentId: "ISS-1", tagName: TAG_NAME });

    expect(result.isError).toBe(true);
    expect(post).toHaveBeenCalledWith("/tags", { name: TAG_NAME });
    expect(technicalMessage(result.content[0]?.text)).toContain(
      `apply exploded — note: ${CREATED_NOTE}`
    );
  });

  it("uses 'Unknown error' as the reason when a non-Error is thrown after creating the tag", async () => {
    routeReads(false);
    routeWrites("not an error object");

    const result = await handler({ documentId: "ISS-1", tagName: TAG_NAME });

    expect(result.isError).toBe(true);
    expect(technicalMessage(result.content[0]?.text)).toContain(
      `Unknown error — note: ${CREATED_NOTE}`
    );
  });
});

describe("resolveArtifactId", () => {
  it("throws when the document resolves without an id", async () => {
    get.mockResolvedValueOnce({ slug: "ISS-1", type: DocumentType.Feature });

    await expect(resolveArtifactId(apiClient, "ISS-1")).rejects.toThrow(
      'Document "ISS-1" resolved without an id.'
    );
  });
});

describe("fetchOrgTagPage query params", () => {
  it("floors a missing limit to the shared default and omits offset", async () => {
    get.mockResolvedValueOnce({ items: [], total: 0, hasMore: false });

    await fetchOrgTagPage(apiClient, {});

    expect(get).toHaveBeenCalledWith("/tags", {
      limit: String(TAG_LIST_DEFAULT_LIMIT),
      includeTotal: "true",
    });
  });

  it("forwards an explicit limit and offset as strings", async () => {
    get.mockResolvedValueOnce({ items: [], total: 0, hasMore: false });

    await fetchOrgTagPage(apiClient, { limit: 5, offset: 10 });

    expect(get).toHaveBeenCalledWith("/tags", {
      limit: "5",
      includeTotal: "true",
      offset: "10",
    });
  });
});
