import { DocumentType } from "@repo/api/src/types/document.js";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import { registerUntagArtifact } from "../tools/untag-artifact.js";
import {
  createToolHarnessWithMock,
  parseToolPayload,
  registeredToolConfig,
} from "./fixtures/tool-harness.js";

const DOCUMENT_SLUG = "ISS-6967";
const ARTIFACT_ID = "01a010cc-42ad-7422-8d1d-8a35bf07e344";
const TAG_ID = "019fae2d-27f1-7702-9921-5db4096cbcca";
const TEMPLATE_ID = "019fae2d-27f1-7702-9921-5db4096cbccb";
const DOCUMENT_PATH = `/documents/${DOCUMENT_SLUG}`;

const existingTag = { id: TAG_ID, name: "DSP", color: TagColor.Green };

describe("untag-artifact MCP tool", () => {
  const apiClient = {
    get: vi.fn(),
    delete: vi.fn(),
  } as unknown as ApiClient;
  const get = apiClient.get as ReturnType<typeof vi.fn>;
  const del = apiClient.delete as ReturnType<typeof vi.fn>;

  function harness() {
    return createToolHarnessWithMock(registerUntagArtifact, apiClient);
  }

  function respondWith(
    tags: unknown[],
    document: unknown = {
      id: ARTIFACT_ID,
      slug: DOCUMENT_SLUG,
      type: DocumentType.Feature,
    }
  ) {
    get.mockImplementation((path: string) => {
      if (path.startsWith("/documents/")) {
        return Promise.resolve(document);
      }
      return Promise.resolve(tags);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the exact tool name and states the surface is writable", () => {
    const { registerTool } = harness();
    const { description } = registeredToolConfig(registerTool);

    expect(registerTool.mock.calls[0]?.[0]).toBe("untag-artifact");
    expect(description).toContain("READABLE AND WRITABLE");
    expect(description).toContain("does NOT retract");
  });

  // `tagService.removeTag` deletes the link and THEN reconciles the artifact's
  // remaining tags additively, so the only GitHub write a removal can make is
  // an ADD for a different tag. An agent reading "remove" as subtractive would
  // not expect an external write at all; the description has to say so, and
  // this case fails if that disclosure is dropped back to the retract-only
  // sentence it replaced.
  it("discloses that removal reconciles the remaining tags and can add labels", () => {
    const { registerTool } = harness();
    const { description } = registeredToolConfig(registerTool);

    expect(description).toContain("not purely subtractive");
    expect(description).toContain("REMAINING tags");
    expect(description).toContain("can ADD a missing GitHub label");
  });

  it("removes an existing tag through the entity-tags query contract", async () => {
    respondWith([existingTag]);
    del.mockResolvedValue({ deleted: true });
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "dsp",
    });

    const [path] = del.mock.calls[0] as [string];
    const query = new URLSearchParams(path.split("?")[1]);
    expect(path.startsWith("/entity-tags?")).toBe(true);
    // Pin every key by name AND value — the route reads these three verbatim.
    expect(query.get("tagId")).toBe(TAG_ID);
    expect(query.get("entityType")).toBe(TagEntityType.Artifact);
    expect(query.get("entityId")).toBe(ARTIFACT_ID);
    expect(parseToolPayload(result as never)).toEqual({
      removed: true,
      artifactId: ARTIFACT_ID,
      tag: existingTag,
    });
  });

  it("resolves a slug to the artifact uuid before deleting", async () => {
    respondWith([existingTag]);
    del.mockResolvedValue({ deleted: true });
    const { handler } = harness();

    await handler({ documentId: DOCUMENT_SLUG, tagName: "DSP" });

    expect(get).toHaveBeenCalledWith(DOCUMENT_PATH);
    const query = new URLSearchParams(
      (del.mock.calls[0] as [string])[0].split("?")[1]
    );
    expect(query.get("entityId")).not.toBe(DOCUMENT_SLUG);
  });

  // ISS-7461: an exact-name lookup is a single indexed request, not the
  // whole catalogue filtered client-side.
  it("looks up the tag by an exact-name query argument", async () => {
    respondWith([existingTag]);
    del.mockResolvedValue({ deleted: true });
    const { handler } = harness();

    await handler({ documentId: DOCUMENT_SLUG, tagName: "DSP" });

    expect(get).toHaveBeenCalledWith("/tags", {
      name: "DSP",
      includeTotal: "true",
    });
  });

  // The end state the caller asked for already holds, so this is not an error
  // — but it must not claim a removal either.
  it("reports removed:false without issuing a delete for an unknown tag name", async () => {
    respondWith([existingTag]);
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "nonexistent",
    });

    expect(del).not.toHaveBeenCalled();
    const payload = parseToolPayload(result as never) as {
      removed: boolean;
      artifactId: string;
      tagName: string;
      reason: string;
    };
    expect(payload).toMatchObject({
      removed: false,
      artifactId: ARTIFACT_ID,
      tagName: "nonexistent",
    });
    // The reason is the whole point of not erroring — pin it, or deleting it
    // leaves an agent with a bare `removed:false` and no explanation.
    expect(payload.reason).toContain("nonexistent");
  });

  // A legacy or directly-written row can hold a name the create-time regex
  // rejects. If the input schema enforced that rule, such a tag would be
  // listed by list-tags and then impossible to remove.
  it("removes a stored tag whose name the create-time rule would reject", async () => {
    const legacyTag = { id: TAG_ID, name: "P0_bug", color: TagColor.Amber };
    respondWith([legacyTag]);
    del.mockResolvedValue({ deleted: true });
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "P0_bug",
    });

    expect(del).toHaveBeenCalledTimes(1);
    expect(parseToolPayload(result as never)).toMatchObject({
      removed: true,
      tag: legacyTag,
    });
  });

  it("fails on an unresolvable document without reading tags or deleting", async () => {
    get.mockRejectedValue(
      new McpApiError("Artifact not found", { status: 404 })
    );
    const { handler } = harness();

    const result = (await handler({
      documentId: "ISS-999999",
      tagName: "DSP",
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    // `get` now always takes a query-params second argument (even an exact
    // `{name}` lookup), so `not.toHaveBeenCalledWith("/tags")` — a one-arg
    // call shape — would never match any real call and pass vacuously
    // regardless of whether "/tags" was actually read. Assert on the path
    // alone instead.
    expect(get.mock.calls.map(([path]) => path)).not.toContain("/tags");
    expect(del).not.toHaveBeenCalled();
  });

  // Symmetric with tag-artifact: a template UUID resolves as a document, but a
  // template has no product surface a tag could appear on.
  it("refuses a template without reading tags or deleting", async () => {
    respondWith([existingTag], {
      id: TEMPLATE_ID,
      type: DocumentType.Template,
    });
    const { handler } = harness();

    const result = (await handler({
      documentId: TEMPLATE_ID,
      tagName: "DSP",
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("template");
    // See the comment on the same assertion above: `get` always takes a
    // query-params second argument now, so the one-arg
    // `not.toHaveBeenCalledWith("/tags")` shape would pass whether or not
    // "/tags" was read.
    expect(get.mock.calls.map(([path]) => path)).not.toContain("/tags");
    expect(del).not.toHaveBeenCalled();
  });

  // Deny-list of one, not an allow-list: evergreen Documents (DOC-*) stay
  // removable, so a tag applied to one is never stranded.
  it("removes a tag from an evergreen DOC document", async () => {
    respondWith([existingTag], { id: ARTIFACT_ID, type: DocumentType.Doc });
    del.mockResolvedValue({ deleted: true });
    const { handler } = harness();

    const result = await handler({ documentId: "DOC-3", tagName: "DSP" });

    const query = new URLSearchParams(
      (del.mock.calls[0] as [string])[0].split("?")[1]
    );
    expect(query.get("entityId")).toBe(ARTIFACT_ID);
    expect(parseToolPayload(result as never)).toMatchObject({ removed: true });
  });

  // Version skew: a response without `type` must keep working.
  it("removes a tag from a document whose response omits the subtype", async () => {
    respondWith([existingTag], { id: ARTIFACT_ID });
    del.mockResolvedValue({ deleted: true });
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "DSP",
    });

    expect(del).toHaveBeenCalledTimes(1);
    expect(parseToolPayload(result as never)).toMatchObject({ removed: true });
  });

  it("surfaces a delete failure as an error result", async () => {
    respondWith([existingTag]);
    del.mockRejectedValue(new McpApiError("Tag not found", { status: 404 }));
    const { handler } = harness();

    const result = (await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "DSP",
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Tag not found");
  });
});
