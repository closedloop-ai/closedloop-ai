import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AttachmentPurpose,
  AttachmentPurposeSelector,
  CreateInlineImageAttachmentErrorCode,
  INLINE_ATTACHMENT_REF_PREFIX,
} from "@repo/api/src/types/attachment.js";
import { DocumentType } from "@repo/api/src/types/document.js";
import { MAX_DOCUMENT_VERSION_INLINE_IMAGES } from "@repo/api/src/types/document-version.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import { registerCreateDocumentVersion } from "../tools/create-document-version.js";
import { registerCreateInlineImageAttachment } from "../tools/create-inline-image-attachment.js";
import { registerDeleteAttachment } from "../tools/delete-attachment.js";
import { registerDownloadAttachment } from "../tools/download-attachment.js";
import { registerListAttachments } from "../tools/list-attachments.js";
import { createUrlBuilder } from "../tools/tool-utils.js";
import { registerUploadAttachment } from "../tools/upload-attachment.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;
type ToolSchema = z.ZodType;
type ToolConfig = {
  inputSchema?: Record<string, ToolSchema | undefined>;
  outputSchema?: Record<string, ToolSchema | undefined>;
};

const ATTACHMENT_REF = `${INLINE_ATTACHMENT_REF_PREFIX}attachment-1`;

function createToolHarness() {
  const handlers = new Map<string, ToolHandler>();
  const configs = new Map<string, ToolConfig>();
  const server = {
    registerTool: vi.fn(
      (name: string, config: ToolConfig, handler: ToolHandler) => {
        configs.set(name, config);
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

  return { apiClient, configs, handlers, server };
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

  it("create-inline-image-attachment posts the encoded image endpoint and API body only", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.post.mockResolvedValue({
      attachmentId: "attachment-1",
      attachmentRef: ATTACHMENT_REF,
      attachment: {
        id: "attachment-1",
        artifactId: "doc-1",
        filename: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        purpose: AttachmentPurpose.Inline,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdById: "user-1",
      },
    });

    registerCreateInlineImageAttachment(server, apiClient);
    await handlers.get("create-inline-image-attachment")?.({
      altText: "System diagram",
      dataBase64: "VEhJU19JU19USEVfSU1BR0U=",
      entityId: "FEA/42",
      filename: "diagram.png",
      mimeType: "image/png",
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents/FEA%2F42/attachments/images",
      {
        dataBase64: "VEhJU19JU19USEVfSU1BR0U=",
        filename: "diagram.png",
        mimeType: "image/png",
      }
    );
  });

  it("create-inline-image-attachment returns matching text JSON and structuredContent", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.post.mockResolvedValue({
      attachmentId: "attachment-1",
      attachmentRef: ATTACHMENT_REF,
      attachment: {
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
    });

    registerCreateInlineImageAttachment(server, apiClient);
    const result = await handlers.get("create-inline-image-attachment")?.({
      altText: "System diagram",
      dataBase64: "VEhJU19JU19USEVfSU1BR0U=",
      entityId: "FEA-42",
      filename: "diagram.png",
      mimeType: "image/png",
    });

    const textPayload = JSON.parse(result?.content[0].text ?? "{}");
    expect(result?.structuredContent).toEqual(textPayload);
    expect(textPayload).toEqual({
      attachmentId: "attachment-1",
      attachmentRef: ATTACHMENT_REF,
      markdownImage: `![System diagram](${ATTACHMENT_REF})`,
      attachment: {
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
    });
  });

  it("create-inline-image-attachment output schema requires attachment refs", () => {
    const { configs, server } = createToolHarness();

    registerCreateInlineImageAttachment(server, {} as ApiClient);

    const attachmentRefSchema = configs.get("create-inline-image-attachment")
      ?.outputSchema?.attachmentRef;
    expect(attachmentRefSchema?.safeParse(ATTACHMENT_REF).success).toBe(true);
    expect(attachmentRefSchema?.safeParse("attachment-1").success).toBe(false);
  });

  it("create-inline-image-attachment omits base64 bytes and storage keys from output", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.post.mockResolvedValue({
      attachmentId: "attachment-1",
      attachmentRef: ATTACHMENT_REF,
      dataBase64: "VEhJU19NVVNUX05PVF9MRUFL",
      key: "attachments/org/doc/root-key",
      storageKey: "attachments/org/doc/root-storage-key",
      attachment: {
        id: "attachment-1",
        artifactId: "doc-1",
        dataBase64: "VEhJU19NVVNUX05PVF9MRUFL",
        filename: "diagram.png",
        key: "attachments/org/doc/attachment-key",
        mimeType: "image/png",
        sizeBytes: 2048,
        storageKey: "attachments/org/doc/attachment-storage-key",
      },
    });

    registerCreateInlineImageAttachment(server, apiClient);
    const result = await handlers.get("create-inline-image-attachment")?.({
      dataBase64: "VEhJU19NVVNUX05PVF9MRUFL",
      entityId: "FEA-42",
      filename: "diagram.png",
      mimeType: "image/png",
    });

    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain("dataBase64");
    expect(serializedResult).not.toContain("VEhJU19NVVNUX05PVF9MRUFL");
    expect(serializedResult).not.toContain("attachments/org/doc/root-key");
    expect(serializedResult).not.toContain(
      "attachments/org/doc/root-storage-key"
    );
    expect(serializedResult).not.toContain(
      "attachments/org/doc/attachment-key"
    );
    expect(serializedResult).not.toContain(
      "attachments/org/doc/attachment-storage-key"
    );
  });

  it("create-inline-image-attachment surfaces API failures through withErrorHandling", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.post.mockRejectedValue(
      new McpApiError("Inline image is too large", {
        code: CreateInlineImageAttachmentErrorCode.PayloadTooLarge,
        status: 413,
      })
    );

    registerCreateInlineImageAttachment(server, apiClient);
    const result = await handlers.get("create-inline-image-attachment")?.({
      dataBase64: "VEhJU19JU19USEVfSU1BR0U=",
      entityId: "FEA-42",
      filename: "diagram.png",
      mimeType: "image/png",
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents/FEA-42/attachments/images",
      {
        dataBase64: "VEhJU19JU19USEVfSU1BR0U=",
        filename: "diagram.png",
        mimeType: "image/png",
      }
    );
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toBeUndefined();
    expect(result?.content[0].text).toContain("Inline image is too large");
  });

  it("create-document-version posts content-only requests without inline image fields", async () => {
    const { apiClient, configs, handlers, server } = createToolHarness();
    apiClient.post.mockResolvedValue({
      assignee: {
        email: "owner@example.com",
        id: "user-1",
      },
      assigneeId: "user-1",
      createdAt: "2026-07-20T12:00:00.000Z",
      createdById: "user-1",
      id: "doc-1",
      slug: "FEA-42",
      organizationId: "org-1",
      priority: "MEDIUM",
      projectId: "project-1",
      repositorySnapshot: {
        repositories: [{ fullName: "closedloop-ai/symphony-alpha" }],
        source: "loop_selection",
      },
      sortOrder: 10,
      tags: [{ id: "tag-1", name: "MCP" }],
      type: DocumentType.Feature,
      latestVersionContent: "Updated content",
      updatedAt: "2026-07-20T12:01:00.000Z",
    });

    registerCreateDocumentVersion(
      server,
      apiClient,
      createUrlBuilder(() => null)
    );
    const result = await handlers.get("create-document-version")?.({
      content: "Updated content",
      documentId: "FEA/42",
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents/FEA%2F42/versions",
      {
        content: "Updated content",
      }
    );
    const textPayload = JSON.parse(result?.content[0].text ?? "{}");
    expect(result?.structuredContent).toEqual(textPayload);
    expect(
      z
        .object(configs.get("create-document-version")?.outputSchema ?? {})
        .strict()
        .safeParse(result?.structuredContent).success
    ).toBe(true);
    expect(textPayload).toMatchObject({
      assignee: {
        email: "owner@example.com",
        id: "user-1",
      },
      assigneeId: "user-1",
      createdAt: "2026-07-20T12:00:00.000Z",
      createdById: "user-1",
      id: "doc-1",
      organizationId: "org-1",
      priority: "MEDIUM",
      projectId: "project-1",
      repositorySnapshot: {
        repositories: [{ fullName: "closedloop-ai/symphony-alpha" }],
        source: "loop_selection",
      },
      slug: "FEA-42",
      sortOrder: 10,
      tags: [{ id: "tag-1", name: "MCP" }],
      type: DocumentType.Feature,
      updatedAt: "2026-07-20T12:01:00.000Z",
      versionContent: "Updated content",
    });
  });

  it("create-document-version posts inline images and returns sanitized structuredContent", async () => {
    const { apiClient, configs, handlers, server } = createToolHarness();
    apiClient.post.mockResolvedValue({
      dataBase64: "VEhJU19UT1BfTEVWRUxfTVVTVF9OT1RfTEVBSw==",
      id: "doc-1",
      slug: "FEA-42",
      storageKey: "attachments/org/doc/top-level-secret",
      type: DocumentType.Feature,
      versionContent: `Updated ![System \\] diagram](${ATTACHMENT_REF})`,
      inlineImages: [
        {
          placeholder: "[[diagram]]",
          attachmentId: "attachment-1",
          attachmentRef: ATTACHMENT_REF,
          markdownImage: `![System \\] diagram](${ATTACHMENT_REF})`,
          dataBase64: "VEhJU19NVVNUX05PVF9MRUFL",
          storageKey: "attachments/org/doc/inline-secret",
          attachment: {
            id: "attachment-1",
            artifactId: "doc-1",
            filename: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 2048,
            purpose: AttachmentPurpose.Inline,
            createdAt: "2026-07-20T12:00:00.000Z",
            createdById: "user-1",
            key: "attachments/org/doc/attachment-secret",
            previewUrl: "https://s3.example.com/preview",
          },
        },
      ],
    });

    registerCreateDocumentVersion(
      server,
      apiClient,
      createUrlBuilder(() => null)
    );
    const result = await handlers.get("create-document-version")?.({
      content: "Updated [[diagram]]",
      documentId: "FEA-42",
      inlineImages: [
        {
          altText: "System ] diagram",
          dataBase64: "VEhJU19JU19USEVfSU1BR0U=",
          filename: "diagram.png",
          mimeType: "image/png",
          placeholder: "[[diagram]]",
        },
      ],
    });

    expect(apiClient.post).toHaveBeenCalledWith("/documents/FEA-42/versions", {
      content: "Updated [[diagram]]",
      inlineImages: [
        {
          altText: "System ] diagram",
          dataBase64: "VEhJU19JU19USEVfSU1BR0U=",
          filename: "diagram.png",
          mimeType: "image/png",
          placeholder: "[[diagram]]",
        },
      ],
    });
    const textPayload = JSON.parse(result?.content[0].text ?? "{}");
    expect(result?.structuredContent).toEqual(textPayload);
    expect(
      z
        .object(configs.get("create-document-version")?.outputSchema ?? {})
        .strict()
        .safeParse(result?.structuredContent).success
    ).toBe(true);
    expect(textPayload.inlineImages).toEqual([
      {
        placeholder: "[[diagram]]",
        attachmentId: "attachment-1",
        attachmentRef: ATTACHMENT_REF,
        markdownImage: `![System \\] diagram](${ATTACHMENT_REF})`,
        attachment: {
          id: "attachment-1",
          artifactId: "doc-1",
          filename: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          purpose: AttachmentPurpose.Inline,
          createdAt: "2026-07-20T12:00:00.000Z",
          createdById: "user-1",
          previewUrl: "https://s3.example.com/preview",
        },
      },
    ]);
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain("dataBase64");
    expect(serializedResult).not.toContain("VEhJU19NVVNUX05PVF9MRUFL");
    expect(serializedResult).not.toContain(
      "VEhJU19UT1BfTEVWRUxfTVVTVF9OT1RfTEVBSw=="
    );
    expect(serializedResult).not.toContain(
      "attachments/org/doc/top-level-secret"
    );
    expect(serializedResult).not.toContain("attachments/org/doc/inline-secret");
    expect(serializedResult).not.toContain(
      "attachments/org/doc/attachment-secret"
    );
  });

  it("create-document-version input schema caps inline image batches", () => {
    const { configs, server } = createToolHarness();

    registerCreateDocumentVersion(
      server,
      {} as ApiClient,
      createUrlBuilder(() => null)
    );

    const inlineImagesSchema = configs.get("create-document-version")
      ?.inputSchema?.inlineImages;
    const validInlineImage = {
      dataBase64: "VEhJU19JU19USEVfSU1BR0U=",
      filename: "diagram.png",
      mimeType: "image/png",
      placeholder: "[[diagram]]",
    };
    expect(
      inlineImagesSchema?.safeParse(
        Array.from({ length: MAX_DOCUMENT_VERSION_INLINE_IMAGES }, () => ({
          ...validInlineImage,
        }))
      ).success
    ).toBe(true);
    expect(
      inlineImagesSchema?.safeParse(
        Array.from({ length: MAX_DOCUMENT_VERSION_INLINE_IMAGES + 1 }, () => ({
          ...validInlineImage,
        }))
      ).success
    ).toBe(false);
  });

  it("create-document-version surfaces API failures through withErrorHandling", async () => {
    const { apiClient, handlers, server } = createToolHarness();
    apiClient.post.mockRejectedValue(
      new McpApiError("Inline image placeholder must appear in content", {
        code: "missing_inline_image_placeholder",
        status: 400,
      })
    );

    registerCreateDocumentVersion(
      server,
      apiClient,
      createUrlBuilder(() => null)
    );
    const result = await handlers.get("create-document-version")?.({
      content: "Updated content",
      documentId: "FEA-42",
      inlineImages: [
        {
          dataBase64: "VEhJU19JU19USEVfSU1BR0U=",
          filename: "diagram.png",
          mimeType: "image/png",
          placeholder: "[[diagram]]",
        },
      ],
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toBeUndefined();
    expect(result?.content[0].text).toContain(
      "Inline image placeholder must appear in content"
    );
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
