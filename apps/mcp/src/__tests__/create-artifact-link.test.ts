import { LinkType } from "@repo/api/src/types/artifact.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerCreateArtifactLink } from "../tools/create-artifact-link.js";
import {
  createToolHarnessWithMock,
  firstIssue,
  parseToolPayload,
  registeredToolConfig,
  registeredToolName,
} from "./fixtures/tool-harness.js";

const LINK_ID = "019fab70-1b64-700a-9f59-e5ed36b238c4";
const SOURCE_SLUG = "PRD-7";
const TARGET_SLUG = "PLN-12";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const apiClient = { post: vi.fn() };

const { handler, registerTool } = createToolHarnessWithMock(
  registerCreateArtifactLink,
  apiClient as unknown as ApiClient
);

const registeredName = registeredToolName(registerTool);
const registeredConfig = registeredToolConfig(registerTool);

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    linkType: LinkType.Produces,
    createdAt: CREATED_AT,
    sourceId: "019fab70-1b64-700a-9f59-000000000001",
    targetId: "019fab70-1b64-700a-9f59-000000000002",
    ...overrides,
  };
}

describe("create-artifact-link tool registration", () => {
  it("registers the tool as create-artifact-link", () => {
    expect(registeredName).toBe("create-artifact-link");
  });

  // The direction of the link is the field an agent gets wrong, and the
  // description is the only place the tool states which endpoint is the parent.
  it("states link direction and the lineage each type carries", () => {
    expect(registeredConfig.description).toContain("source → target");
    expect(registeredConfig.description).toContain(
      "parent→child lineage and drives the project tree"
    );
    expect(registeredConfig.description).toContain(
      "cannot proceed until the source is done"
    );
    expect(registeredConfig.description).toContain(
      "non-hierarchical association between peers"
    );
  });

  it("accepts every declared link type", () => {
    for (const linkType of Object.values(LinkType)) {
      expect(
        registeredConfig.inputSchema.linkType.safeParse(linkType).success
      ).toBe(true);
    }
  });

  it("rejects a link type outside the declared set", () => {
    const issue = firstIssue(registeredConfig.inputSchema.linkType, "PRODUCE");

    expect(issue?.code).toBe("invalid_value");
    expect(issue?.path).toEqual([]);
  });

  it("rejects a non-string source or target id", () => {
    expect(firstIssue(registeredConfig.inputSchema.sourceId, 42)?.code).toBe(
      "invalid_type"
    );
    expect(firstIssue(registeredConfig.inputSchema.targetId, null)?.code).toBe(
      "invalid_type"
    );
  });
});

describe("create-artifact-link MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the caller's ids and link type verbatim to /artifact-links", async () => {
    // Slugs are body fields, not path segments — the REST route resolves them
    // server-side, so the tool must not rewrite or encode them.
    apiClient.post.mockResolvedValue(linkRow());

    await handler({
      sourceId: SOURCE_SLUG,
      targetId: TARGET_SLUG,
      linkType: LinkType.Produces,
    });

    expect(apiClient.post).toHaveBeenCalledWith("/artifact-links", {
      sourceId: SOURCE_SLUG,
      targetId: TARGET_SLUG,
      linkType: LinkType.Produces,
    });
  });

  it("forwards a non-lineage link type instead of coercing it to PRODUCES", async () => {
    apiClient.post.mockResolvedValue(linkRow({ linkType: LinkType.Blocks }));

    const payload = parseToolPayload(
      await handler({
        sourceId: SOURCE_SLUG,
        targetId: TARGET_SLUG,
        linkType: LinkType.Blocks,
      })
    ) as { linkType: string | null };

    expect(apiClient.post).toHaveBeenCalledWith(
      "/artifact-links",
      expect.objectContaining({ linkType: LinkType.Blocks })
    );
    expect(payload.linkType).toBe(LinkType.Blocks);
  });

  it("returns the created link shaped to the five contract fields", async () => {
    apiClient.post.mockResolvedValue(linkRow());

    const payload = parseToolPayload(
      await handler({
        sourceId: SOURCE_SLUG,
        targetId: TARGET_SLUG,
        linkType: LinkType.Produces,
      })
    );

    expect(payload).toEqual({
      id: LINK_ID,
      linkType: LinkType.Produces,
      createdAt: CREATED_AT,
      sourceId: "019fab70-1b64-700a-9f59-000000000001",
      targetId: "019fab70-1b64-700a-9f59-000000000002",
    });
  });

  it("drops API fields outside the declared response shape", async () => {
    apiClient.post.mockResolvedValue(
      linkRow({
        organizationId: "org-1",
        createdById: "user-1",
        internalNote: "do-not-surface",
      })
    );

    const payload = parseToolPayload(
      await handler({
        sourceId: SOURCE_SLUG,
        targetId: TARGET_SLUG,
        linkType: LinkType.Produces,
      })
    ) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      "createdAt",
      "id",
      "linkType",
      "sourceId",
      "targetId",
    ]);
  });

  it("reports null for a field the API omitted rather than inventing one", async () => {
    // A version-skewed server that stops sending createdAt must degrade to
    // "unknown", never to an empty string that reads as a real timestamp.
    apiClient.post.mockResolvedValue({
      id: LINK_ID,
      linkType: LinkType.Produces,
      sourceId: 42,
    });

    const payload = parseToolPayload(
      await handler({
        sourceId: SOURCE_SLUG,
        targetId: TARGET_SLUG,
        linkType: LinkType.Produces,
      })
    );

    expect(payload).toEqual({
      id: LINK_ID,
      linkType: LinkType.Produces,
      createdAt: null,
      sourceId: null,
      targetId: null,
    });
  });

  // A caller cannot act on a link it cannot name, so "created, id unknown" is
  // not a success it can distinguish from a write that never landed.
  it.each([
    ["null", null],
    ["a bare string", "created"],
  ])(
    "errors rather than reporting an all-null link for %s",
    async (_label, response) => {
      apiClient.post.mockResolvedValue(response);

      const result = await handler({
        sourceId: SOURCE_SLUG,
        targetId: TARGET_SLUG,
        linkType: LinkType.Produces,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "API response missing the created artifact link"
      );
    }
  );

  it("surfaces an API failure as an error result instead of a false success", async () => {
    apiClient.post.mockRejectedValue(new Error("boom"));

    const result = await handler({
      sourceId: SOURCE_SLUG,
      targetId: TARGET_SLUG,
      linkType: LinkType.Produces,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("boom");
  });
});
