import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerAttachmentActionTool } from "../tools/attachment-tool-utils.js";
import {
  createToolHarnessWithMock,
  firstIssue,
  registeredToolConfig,
} from "./fixtures/tool-harness.js";

/**
 * The two shipped consumers (download-attachment, delete-attachment) are
 * covered in attachment-tools.test.ts. This suite drives the shared factory
 * directly with synthetic options, so the wiring from an option to the
 * registered tool is pinned independently of either wrapper's current values.
 *
 * Deliberately NOT repeated here: path encoding of slash-bearing ids and
 * withErrorHandling's rejection path. Both run through this same factory on
 * every call attachment-tools.test.ts already makes, so asserting them again
 * would be a second copy of one contract rather than new coverage.
 */

const ENTITY_ID = "PRD-7";
const ATTACHMENT_ID = "019fab70-1b64-700a-9f59-e5ed36b238c4";
const SUFFIX = "Required for org-scoped verification.";

const apiClient = { delete: vi.fn(), get: vi.fn() };

function registerAction(
  options: Parameters<typeof registerAttachmentActionTool>[2]
) {
  return createToolHarnessWithMock(
    (server, client) => registerAttachmentActionTool(server, client, options),
    apiClient as unknown as ApiClient
  );
}

function describeEntityId(registerTool: { mock: { calls: unknown[][] } }) {
  return registeredToolConfig(registerTool).inputSchema.entityId.description;
}

describe("registerAttachmentActionTool registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers under the caller's tool name and description", () => {
    const { registerTool } = registerAction({
      description: "Do the attachment thing.",
      method: "get",
      toolName: "some-attachment-action",
    });

    expect(registerTool.mock.calls[0]?.[0]).toBe("some-attachment-action");
    expect(registeredToolConfig(registerTool).description).toBe(
      "Do the attachment thing."
    );
  });

  // The suffix is how download-attachment states its org-scoping requirement;
  // dropping it would silently strip that warning from the tool's schema.
  it("appends entityIdDescriptionSuffix to the shared entity-id description", () => {
    const withoutSuffix = registerAction({
      description: "Do the attachment thing.",
      method: "get",
      toolName: "no-suffix",
    });
    const withSuffix = registerAction({
      description: "Do the attachment thing.",
      entityIdDescriptionSuffix: SUFFIX,
      method: "get",
      toolName: "with-suffix",
    });

    const base = describeEntityId(withoutSuffix.registerTool);
    expect(base).not.toContain(SUFFIX);
    expect(describeEntityId(withSuffix.registerTool)).toBe(`${base} ${SUFFIX}`);
  });

  it("requires a string entityId and attachmentId", () => {
    const { registerTool } = registerAction({
      description: "Do the attachment thing.",
      method: "get",
      toolName: "typed-inputs",
    });
    const { inputSchema } = registeredToolConfig(registerTool);

    expect(firstIssue(inputSchema.entityId, 42)?.code).toBe("invalid_type");
    expect(firstIssue(inputSchema.attachmentId, null)?.code).toBe(
      "invalid_type"
    );
  });
});

describe("registerAttachmentActionTool handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a get tool to apiClient.get and never to delete", async () => {
    apiClient.get.mockResolvedValue({ downloadUrl: "https://example/dl" });
    const { handler } = registerAction({
      description: "Read it.",
      method: "get",
      toolName: "read-attachment",
    });

    const result = await handler({
      attachmentId: ATTACHMENT_ID,
      entityId: ENTITY_ID,
    });

    expect(apiClient.get).toHaveBeenCalledWith(
      `/documents/${ENTITY_ID}/attachments/${ATTACHMENT_ID}`
    );
    expect(apiClient.delete).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toBe(
      JSON.stringify({ downloadUrl: "https://example/dl" }, null, 2)
    );
  });

  it("routes a delete tool to apiClient.delete and never to get", async () => {
    apiClient.delete.mockResolvedValue({ deleted: true });
    const { handler } = registerAction({
      description: "Remove it.",
      method: "delete",
      toolName: "remove-attachment",
    });

    const result = await handler({
      attachmentId: ATTACHMENT_ID,
      entityId: ENTITY_ID,
    });

    expect(apiClient.delete).toHaveBeenCalledWith(
      `/documents/${ENTITY_ID}/attachments/${ATTACHMENT_ID}`
    );
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toBe(
      JSON.stringify({ deleted: true }, null, 2)
    );
  });

  // entityId is a bare z.string(), so a dot segment passes the registered
  // schema and reaches the handler — unlike the uuid-validated tools, this
  // traversal guard is genuinely reachable in production.
  it.each([
    ["entityId", { attachmentId: ATTACHMENT_ID, entityId: ".." }],
    ["attachmentId", { attachmentId: ".", entityId: ENTITY_ID }],
  ])(
    "rejects a dot segment in %s before any request",
    async (_field, input) => {
      const { handler } = registerAction({
        description: "Read it.",
        method: "get",
        toolName: "read-attachment",
      });

      const result = await handler(input);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("not a valid path segment");
      expect(apiClient.get).not.toHaveBeenCalled();
      expect(apiClient.delete).not.toHaveBeenCalled();
    }
  );
});
