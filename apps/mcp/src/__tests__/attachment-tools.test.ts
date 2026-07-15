import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AttachmentPurpose,
  AttachmentPurposeSelector,
} from "@repo/api/src/types/attachment.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import { registerDeleteAttachment } from "../tools/delete-attachment.js";
import { registerDownloadAttachment } from "../tools/download-attachment.js";
import { registerListAttachments } from "../tools/list-attachments.js";
import { registerUploadAttachment } from "../tools/upload-attachment.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

function createToolHarness() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: vi.fn(
      (name: string, _config: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      }
    ),
  } as unknown as McpServer;
  const apiClient = {
    delete: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  } as unknown as ApiClient & {
    delete: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };

  return { apiClient, handlers, server };
}

describe("attachment MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upload-attachment posts encoded document path, declared metadata, and passes through API fields", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.post.mockResolvedValue({
      attachmentId: "attachment-1",
      expiresAt: "2026-01-01T00:15:00.000Z",
      key: "attachments/org/doc/cuid",
      uploadUrl: "https://s3.example.com/upload",
    });

    registerUploadAttachment(server, apiClient);
    const result = await handlers.get("upload-attachment")?.({
      entityId: "PRD/7",
      filename: "diagram.png",
      mimeType: "image/png",
      purpose: AttachmentPurpose.Inline,
      sizeBytes: 2048,
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents/PRD%2F7/attachments",
      {
        filename: "diagram.png",
        mimeType: "image/png",
        purpose: AttachmentPurpose.Inline,
        sizeBytes: 2048,
      }
    );
    expect(JSON.parse(result?.content[0].text ?? "{}")).toEqual({
      attachmentId: "attachment-1",
      expiresAt: "2026-01-01T00:15:00.000Z",
      key: "attachments/org/doc/cuid",
      uploadUrl: "https://s3.example.com/upload",
    });
  });

  it("list-attachments preserves the default context listing when purpose is omitted", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.get.mockResolvedValue([]);

    registerListAttachments(server, apiClient);
    await handlers.get("list-attachments")?.({ entityId: "FEA-42" });

    expect(apiClient.get).toHaveBeenCalledWith("/documents/FEA-42/attachments");
  });

  it("list-attachments maps purpose to the exact API query selector", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.get.mockResolvedValue([]);

    registerListAttachments(server, apiClient);
    await handlers.get("list-attachments")?.({
      entityId: "FEA/42",
      purpose: AttachmentPurposeSelector.All,
    });

    expect(apiClient.get).toHaveBeenCalledWith(
      "/documents/FEA%2F42/attachments?purpose=all"
    );
  });

  it("list-attachments wraps the API array in a pagination envelope with mapped items", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.get.mockResolvedValue([
      {
        id: "attachment-1",
        artifactId: "doc-1",
        filename: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        purpose: AttachmentPurpose.Inline,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdById: "user-1",
        previewUrl: "https://s3.example.com/preview",
      },
    ]);

    registerListAttachments(server, apiClient);
    const result = await handlers.get("list-attachments")?.({
      entityId: "FEA-42",
    });

    expect(JSON.parse(result?.content[0].text ?? "{}")).toEqual({
      total: 1,
      offset: 0,
      limit: 25,
      returned: 1,
      hasMore: false,
      nextOffset: null,
      items: [
        {
          id: "attachment-1",
          artifactId: "doc-1",
          filename: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          purpose: AttachmentPurpose.Inline,
          createdAt: "2026-01-01T00:00:00.000Z",
          createdById: "user-1",
          previewUrl: "https://s3.example.com/preview",
        },
      ],
    });
  });

  it("list-attachments honors limit and offset pagination params", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.get.mockResolvedValue([
      { id: "a-1" },
      { id: "a-2" },
      { id: "a-3" },
    ]);

    registerListAttachments(server, apiClient);
    const result = await handlers.get("list-attachments")?.({
      entityId: "FEA-42",
      limit: 1,
      offset: 1,
    });

    const payload = JSON.parse(result?.content[0].text ?? "{}");
    expect(payload.total).toBe(3);
    expect(payload.offset).toBe(1);
    expect(payload.limit).toBe(1);
    expect(payload.returned).toBe(1);
    expect(payload.hasMore).toBe(true);
    expect(payload.nextOffset).toBe(2);
    expect(payload.items).toEqual([
      {
        id: "a-2",
        artifactId: null,
        filename: null,
        mimeType: null,
        sizeBytes: null,
        purpose: null,
        createdAt: null,
        createdById: null,
        // previewUrl is omitted (not null) for non-image attachments — see
        // the shaper's mapItem in list-attachments.ts.
      },
    ]);
  });

  it("download-attachment gets the encoded attachment path and returns the download URL", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.get.mockResolvedValue({
      downloadUrl: "https://s3.example.com/download",
    });

    registerDownloadAttachment(server, apiClient);
    const result = await handlers.get("download-attachment")?.({
      attachmentId: "attachment/1",
      entityId: "PRD/7",
    });

    expect(apiClient.get).toHaveBeenCalledWith(
      "/documents/PRD%2F7/attachments/attachment%2F1"
    );
    expect(JSON.parse(result?.content[0].text ?? "{}")).toEqual({
      downloadUrl: "https://s3.example.com/download",
    });
  });

  it("delete-attachment deletes the encoded attachment path and returns API success", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.delete.mockResolvedValue({ deleted: true });

    registerDeleteAttachment(server, apiClient);
    const result = await handlers.get("delete-attachment")?.({
      attachmentId: "attachment/1",
      entityId: "FEA/42",
    });

    expect(apiClient.delete).toHaveBeenCalledWith(
      "/documents/FEA%2F42/attachments/attachment%2F1"
    );
    expect(JSON.parse(result?.content[0].text ?? "{}")).toEqual({
      deleted: true,
    });
  });

  it("delete-attachment surfaces API failures through withErrorHandling", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.delete.mockRejectedValue(
      new McpApiError("Attachment not found", {
        code: "attachment_not_found",
        status: 404,
      })
    );

    registerDeleteAttachment(server, apiClient);
    const result = await handlers.get("delete-attachment")?.({
      attachmentId: "missing-attachment",
      entityId: "FEA-42",
    });

    expect(apiClient.delete).toHaveBeenCalledWith(
      "/documents/FEA-42/attachments/missing-attachment"
    );
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain("Attachment not found");
  });
});
