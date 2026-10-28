import { DocumentType } from "@repo/api/src/types/document.js";
import {
  TAG_NAME_MAX_LENGTH,
  TAG_NAME_RULE_MESSAGE,
  TagColor,
  TagEntityType,
} from "@repo/api/src/types/tag.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import { registerTagArtifact } from "../tools/tag-artifact.js";
import { MAX_TAG_CREATE_ATTEMPTS } from "../tools/tag-resolution.js";
import {
  createToolHarnessWithMock,
  parseToolPayload,
  registeredInputSchema,
  registeredToolConfig,
} from "./fixtures/tool-harness.js";
import {
  expectIssue,
  NON_EMPTY_STRING_REJECTION,
} from "./fixtures/zod-issues.js";

const DOCUMENT_SLUG = "ISS-6967";
const ARTIFACT_ID = "01a010cc-42ad-7422-8d1d-8a35bf07e344";
const TAG_ID = "019fae2d-27f1-7702-9921-5db4096cbcca";
const OTHER_TAG_ID = "019fae2d-27f1-7702-9921-5db4096cbccc";
const TEMPLATE_ID = "019fae2d-27f1-7702-9921-5db4096cbccb";
const DOCUMENT_PATH = `/documents/${DOCUMENT_SLUG}`;
const CONFLICT = new McpApiError("Tag with this name already exists", {
  status: 409,
});

const existingTag = { id: TAG_ID, name: "DSP", color: TagColor.Green };

describe("tag-artifact MCP tool", () => {
  const apiClient = {
    get: vi.fn(),
    post: vi.fn(),
  } as unknown as ApiClient;
  const get = apiClient.get as ReturnType<typeof vi.fn>;
  const post = apiClient.post as ReturnType<typeof vi.fn>;

  function harness() {
    return createToolHarnessWithMock(registerTagArtifact, apiClient);
  }

  /** Route reads by path so a test never depends on call ordering. */
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

  it("registers the exact tool name and discloses the GitHub label side effect", () => {
    const { registerTool } = harness();
    const { description } = registeredToolConfig(registerTool);

    expect(registerTool.mock.calls[0]?.[0]).toBe("tag-artifact");
    expect(description).toContain("READABLE AND WRITABLE");
    expect(description).toContain("GitHub");
    // The asymmetry is the part an agent cannot predict, so it is pinned.
    expect(description).toContain("does NOT retract");
  });

  it("applies an existing tag case-insensitively without creating one", async () => {
    respondWith([existingTag]);
    post.mockResolvedValue({ applied: true });
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "dsp",
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/entity-tags", {
      tagId: TAG_ID,
      entityType: TagEntityType.Artifact,
      entityId: ARTIFACT_ID,
    });
    expect(parseToolPayload(result as never)).toEqual({
      applied: true,
      artifactId: ARTIFACT_ID,
      tag: existingTag,
      created: false,
    });
  });

  it("resolves a slug to the artifact uuid before tagging", async () => {
    respondWith([existingTag]);
    post.mockResolvedValue({ applied: true });
    const { handler } = harness();

    await handler({ documentId: DOCUMENT_SLUG, tagName: "DSP" });

    expect(get).toHaveBeenCalledWith(DOCUMENT_PATH);
    const [, body] = post.mock.calls[0] as [string, { entityId: string }];
    expect(body.entityId).toBe(ARTIFACT_ID);
    expect(body.entityId).not.toBe(DOCUMENT_SLUG);
  });

  // ISS-7461: an exact-name lookup is a single indexed request, not the
  // whole catalogue filtered client-side.
  it("looks up the tag by an exact-name query argument", async () => {
    respondWith([existingTag]);
    post.mockResolvedValue({ applied: true });
    const { handler } = harness();

    await handler({ documentId: DOCUMENT_SLUG, tagName: "DSP" });

    // `includeTotal` rides along deliberately: the envelope it asks for is the
    // only reliable signal that the server understood `name`, rather than
    // ignoring it and returning the whole catalogue as a bare array.
    expect(get).toHaveBeenCalledWith("/tags", {
      name: "DSP",
      includeTotal: "true",
    });
  });

  // The local `findTagByName` matcher must run ONLY on the legacy bare-array
  // branch. `lower(name)` in Postgres and `toLowerCase()` in JavaScript do
  // not agree on every input — e.g. the Turkish dotless-I family, where
  // `"İstanbul".toLowerCase()` keeps a combining dot and never equals
  // "istanbul" — so post-filtering an envelope match with the JS matcher
  // could drop a row the server already matched and cause a spurious
  // duplicate create.
  // The other half of the same contract: an API too old to know `name` ignores
  // it and answers with the whole catalogue as a BARE ARRAY. There the local
  // matcher is not optional — it is the only thing that finds the tag — so the
  // tool must still resolve rather than create a duplicate.
  it("still resolves an existing tag when an older API ignores ?name= and returns the whole catalogue", async () => {
    const wanted = { id: TAG_ID, name: "DSP", color: TagColor.Green };
    get.mockImplementation((path: string) => {
      if (path.startsWith("/documents/")) {
        return Promise.resolve({
          id: ARTIFACT_ID,
          slug: DOCUMENT_SLUG,
          type: DocumentType.Feature,
        });
      }
      // Legacy shape: unfiltered, and not an envelope.
      return Promise.resolve([
        { id: OTHER_TAG_ID, name: "unrelated", color: TagColor.Blue },
        wanted,
      ]);
    });
    post.mockResolvedValue({ applied: true });
    const { handler } = harness();

    const payload = parseToolPayload(
      (await handler({ documentId: DOCUMENT_SLUG, tagName: "dsp" })) as never
    ) as { applied: boolean; created: boolean; tag: { id: string } };

    expect(payload.applied).toBe(true);
    expect(payload.created).toBe(false);
    expect(payload.tag.id).toBe(TAG_ID);
    // No create: the tag was found locally, so the catalogue must not grow.
    expect(post.mock.calls.map(([path]) => path)).not.toContain("/tags");
  });

  it("trusts the server's envelope match without re-filtering it locally", async () => {
    const serverMatchedTag = {
      id: TAG_ID,
      name: "istanbul",
      color: TagColor.Green,
    };
    get.mockImplementation((path: string) => {
      if (path.startsWith("/documents/")) {
        return Promise.resolve({
          id: ARTIFACT_ID,
          slug: DOCUMENT_SLUG,
          type: DocumentType.Feature,
        });
      }
      return Promise.resolve({
        items: [serverMatchedTag],
        total: 1,
        hasMore: false,
      });
    });
    post.mockResolvedValue({ applied: true });
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "İstanbul",
    });

    expect(parseToolPayload(result as never)).toMatchObject({
      created: false,
      tag: serverMatchedTag,
    });
    expect(post.mock.calls.filter(([path]) => path === "/tags")).toHaveLength(
      0
    );
  });

  // `findTagByName` matches the database's `lower(name)`, with no trimming.
  // A padded name and its trimmed twin are distinct under the
  // `(organization_id, lower(name))` unique index, so the legacy fallback
  // must not treat them as the same tag.
  it("does not trim a padded name to match an existing tag on the legacy branch", async () => {
    respondWith([existingTag]);
    const createdTag = {
      id: OTHER_TAG_ID,
      name: " DSP ",
      color: TagColor.Blue,
    };
    post.mockImplementation((path: string) => {
      if (path === "/tags") {
        return Promise.resolve(createdTag);
      }
      return Promise.resolve({ applied: true });
    });
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: " DSP ",
    });

    expect(post.mock.calls[0]?.[0]).toBe("/tags");
    expect(parseToolPayload(result as never)).toMatchObject({
      created: true,
      tag: createdTag,
    });
  });

  it("creates an unknown tag without choosing a color, then applies it", async () => {
    respondWith([]);
    post.mockImplementation((path: string) => {
      if (path === "/tags") {
        return Promise.resolve({ ...existingTag, name: "DSP" });
      }
      return Promise.resolve({ applied: true });
    });
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "DSP",
    });

    const [createPath, createBody] = post.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(createPath).toBe("/tags");
    // The service cycles the palette itself; sending a color would override it.
    expect(createBody).toEqual({ name: "DSP" });
    expect(post.mock.calls[1]?.[0]).toBe("/entity-tags");
    expect(parseToolPayload(result as never)).toMatchObject({ created: true });
  });

  it("never routes the write through the artifact-only batch endpoint", async () => {
    respondWith([existingTag]);
    post.mockResolvedValue({ applied: true });
    const { handler } = harness();

    await handler({ documentId: DOCUMENT_SLUG, tagName: "DSP" });

    for (const [path] of post.mock.calls as [string][]) {
      expect(path).not.toContain("/entity-tags/batch");
    }
  });

  // The race the ticket calls out: another writer wins between the read and
  // the create. The call must still succeed, applying the winner's tag.
  it("recovers from a create conflict by re-reading and applying the winner", async () => {
    let tagsSeen = 0;
    get.mockImplementation((path: string) => {
      if (path === DOCUMENT_PATH) {
        return Promise.resolve({ id: ARTIFACT_ID });
      }
      tagsSeen += 1;
      return Promise.resolve(tagsSeen === 1 ? [] : [existingTag]);
    });
    post.mockImplementation((path: string) => {
      if (path === "/tags") {
        return Promise.reject(CONFLICT);
      }
      return Promise.resolve({ applied: true });
    });
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "DSP",
    });

    expect(tagsSeen).toBe(2);
    // One rejected create, then the apply — the retry must not create twice.
    expect(post.mock.calls.filter(([path]) => path === "/tags")).toHaveLength(
      1
    );
    expect(
      post.mock.calls.filter(([path]) => path === "/entity-tags")
    ).toHaveLength(1);
    expect(parseToolPayload(result as never)).toMatchObject({
      applied: true,
      tag: existingTag,
      created: false,
    });
  });

  it("stops after the attempt budget when the conflicting tag stays absent", async () => {
    respondWith([]);
    post.mockRejectedValue(CONFLICT);
    const { handler } = harness();

    const result = (await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "DSP",
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(post).toHaveBeenCalledTimes(MAX_TAG_CREATE_ATTEMPTS);
    expect(result.content[0]?.text).toContain("DSP");
  });

  // Retry is 409-only: a rejected name must fail fast, not be posted twice.
  it("does not retry a create failure that is not a conflict", async () => {
    respondWith([]);
    post.mockRejectedValue(
      new McpApiError("Name may only contain letters", { status: 400 })
    );
    const { handler } = harness();

    const result = (await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "DSP",
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("fails when a created tag comes back without a usable id", async () => {
    respondWith([]);
    post.mockResolvedValue({ color: TagColor.Green });
    const { handler } = harness();

    const result = (await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "DSP",
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });

  // Ordering guarantee: a bad documentId must not leave a tag behind.
  it("fails on an unresolvable document without reading or creating tags", async () => {
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
    expect(post).not.toHaveBeenCalled();
  });

  // `GET /documents/:id` serves every document subtype, and `list-templates`
  // hands an agent template UUIDs, so a template reaches this tool. It has no
  // user-facing slug and no product surface that would show the tag, so the
  // tag would be invisible and unremovable from the UI.
  it("refuses a template without reading or creating tags", async () => {
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
    expect(post).not.toHaveBeenCalled();
  });

  // The guard is a deny-list of one, NOT an allow-list of slug prefixes:
  // evergreen Documents (DOC-*, FEA-3949) are user-facing, have their own
  // index and editor, and stay taggable.
  it("tags an evergreen DOC document", async () => {
    respondWith([existingTag], { id: ARTIFACT_ID, type: DocumentType.Doc });
    post.mockResolvedValue({ applied: true });
    const { handler } = harness();

    const result = await handler({ documentId: "DOC-3", tagName: "DSP" });

    expect(post).toHaveBeenCalledWith("/entity-tags", {
      tagId: TAG_ID,
      entityType: TagEntityType.Artifact,
      entityId: ARTIFACT_ID,
    });
    expect(parseToolPayload(result as never)).toMatchObject({ applied: true });
  });

  // Version skew: an API build that does not project `type` must keep working
  // rather than fail every call closed.
  it("tags a document whose response omits the subtype", async () => {
    respondWith([existingTag], { id: ARTIFACT_ID });
    post.mockResolvedValue({ applied: true });
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "DSP",
    });

    expect(post).toHaveBeenCalledWith("/entity-tags", {
      tagId: TAG_ID,
      entityType: TagEntityType.Artifact,
      entityId: ARTIFACT_ID,
    });
    expect(parseToolPayload(result as never)).toMatchObject({ applied: true });
  });

  // A tag created by this call survives an apply failure, so the agent is told.
  it("reports that it created the tag when the apply then fails", async () => {
    respondWith([]);
    post.mockImplementation((path: string) => {
      if (path === "/tags") {
        return Promise.resolve(existingTag);
      }
      return Promise.reject(new McpApiError("Tag not found", { status: 404 }));
    });
    const { handler } = harness();

    const result = (await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "DSP",
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("was created by this call");
  });

  // The lookup input must NOT enforce the create-time charset. `tags.name` is
  // an unconstrained column, so a legacy or directly-written row can hold a
  // name the regex rejects; gating the input here would list such a tag and
  // then refuse to apply it — the same dead end `TagWireRow` avoids on `color`.
  // A bad name for a NEW tag is still refused, by the API, one call later.
  it("accepts a stored name the create-time rule would reject", () => {
    const { registerTool } = harness();
    const inputSchema = registeredInputSchema(registerTool);
    const valid = { documentId: DOCUMENT_SLUG };

    expect(inputSchema.safeParse({ ...valid, tagName: "P0_bug" }).success).toBe(
      true
    );
    expect(
      inputSchema.safeParse({ ...valid, tagName: "tech-debt/infra" }).success
    ).toBe(true);
    expect(
      inputSchema.safeParse({
        ...valid,
        tagName: "x".repeat(TAG_NAME_MAX_LENGTH + 1),
      }).success
    ).toBe(true);
    // An empty name identifies nothing, so it is still refused up front.
    expectIssue(
      inputSchema.safeParse({ ...valid, tagName: "" }),
      ["tagName"],
      NON_EMPTY_STRING_REJECTION
    );
  });

  it("applies a stored tag whose name the create-time rule would reject", async () => {
    const legacyTag = { id: TAG_ID, name: "P0_bug", color: TagColor.Amber };
    respondWith([legacyTag]);
    post.mockResolvedValue({ applied: true });
    const { handler } = harness();

    const result = await handler({
      documentId: DOCUMENT_SLUG,
      tagName: "p0_bug",
    });

    // Matched, not re-created — the create path is never touched.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe("/entity-tags");
    expect(parseToolPayload(result as never)).toMatchObject({
      applied: true,
      tag: legacyTag,
      created: false,
    });
  });

  it("states the create-time name rule in the tagName description", () => {
    const { registerTool } = harness();
    const { inputSchema } = registeredToolConfig(registerTool);

    expect(inputSchema.tagName?.description).toContain(
      String(TAG_NAME_MAX_LENGTH)
    );
    expect(inputSchema.tagName?.description).toContain(TAG_NAME_RULE_MESSAGE);
  });
});
