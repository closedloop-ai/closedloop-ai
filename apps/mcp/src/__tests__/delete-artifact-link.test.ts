import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { registerDeleteArtifactLink } from "../tools/delete-artifact-link.js";

const LINK_ID = "019fab70-1b64-700a-9f59-e5ed36b238c4";

const registerTool = vi.fn();
const apiClient = {
  delete: vi.fn(),
};

function registeredHandler() {
  return registerTool.mock.calls[0]?.[2] as
    | ((input: Record<string, unknown>) => Promise<{
        content: { type: string; text: string }[];
        isError?: boolean;
      }>)
    | undefined;
}

function registeredLinkIdSchema() {
  const config = registerTool.mock.calls[0]?.[1] as {
    inputSchema: { linkId: z.ZodTypeAny };
  };
  return config.inputSchema.linkId;
}

describe("delete-artifact-link MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerDeleteArtifactLink({ registerTool } as never, apiClient as never);
  });

  it("registers the exact tool name and warns that lineage changes", () => {
    expect(registerTool).toHaveBeenCalledWith(
      "delete-artifact-link",
      expect.objectContaining({
        description: expect.stringContaining("PRODUCES"),
        inputSchema: expect.objectContaining({
          linkId: expect.anything(),
        }),
      }),
      expect.any(Function)
    );
  });

  // ISS-4424 requires the description to state the lineage consequence and the
  // quiet-success semantics outright. Pinning phrases unique to each sentence
  // rather than the bare word "PRODUCES", which also appears in the surrounding
  // prose and so would survive the warning being deleted.
  it("states the lineage consequence and the idempotence guarantee", () => {
    const { description } = registerTool.mock.calls[0]?.[1] as {
      description: string;
    };

    expect(description).toContain("changes lineage");
    expect(description).toContain("roll-ups");
    expect(description).toContain("succeeds quietly");
  });

  it("deletes the link by id at the artifact-link item route", async () => {
    apiClient.delete.mockResolvedValue({ deleted: true });

    const response = await registeredHandler()?.({ linkId: LINK_ID });

    expect(apiClient.delete).toHaveBeenCalledWith(`/artifact-links/${LINK_ID}`);
    expect(response).toMatchObject({
      content: [
        { type: "text", text: JSON.stringify({ deleted: true }, null, 2) },
      ],
    });
    expect(response?.isError).toBeUndefined();
  });

  it("rejects an id that is not a UUID before it can reach the API", () => {
    const schema = registeredLinkIdSchema();

    // The API column is `@db.Uuid`, so a slug or malformed id would surface as
    // an opaque server error rather than a usable message.
    expect(schema.safeParse("PRD-42").success).toBe(false);
    expect(schema.safeParse("../documents/PRD-42").success).toBe(false);
    expect(schema.safeParse(LINK_ID).success).toBe(true);
  });

  // Deliberately NOT tested here: feeding the handler a path-traversal id to
  // watch `encodePathSegment` escape it. The MCP SDK validates against the
  // registered `inputSchema` before the handler runs, so such an id cannot
  // reach this code — driving the handler directly would assert a reachability
  // the production path forbids, and would contradict the case above. The
  // encoding call itself is enforced repo-wide by `tool-path-encoding.test.ts`.

  it("surfaces an API failure as an error result instead of a false success", async () => {
    apiClient.delete.mockRejectedValue(new Error("boom"));

    const response = await registeredHandler()?.({ linkId: LINK_ID });

    expect(response?.isError).toBe(true);
    expect(response?.content[0]?.text).toContain("boom");
  });
});
