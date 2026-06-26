import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AttachmentPurpose,
  type CreateAttachmentResponse,
} from "@repo/api/src/types/attachment.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the upload-attachment tool on the given MCP server. The tool only
 * requests an API-owned presigned upload URL; clients still PUT the bytes to
 * S3 using the returned URL and declared metadata.
 */
export function registerUploadAttachment(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "upload-attachment",
    {
      description:
        "Create a presigned upload URL for a document attachment. Use the returned uploadUrl immediately with the exact declared MIME type and sizeBytes, then rediscover the attachment with list-attachments. For inline images, render through POST /documents/[id]/attachments/resolve after upload. Pass the user's document slug verbatim for entityId.",
      inputSchema: {
        entityId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        filename: z.string().min(1).describe("Original filename to store"),
        mimeType: z
          .string()
          .min(1)
          .describe("MIME type that the S3 PUT must use exactly"),
        sizeBytes: z
          .number()
          .int()
          .positive()
          .describe("Declared byte size that the S3 PUT must match"),
        purpose: z
          .enum([AttachmentPurpose.Context, AttachmentPurpose.Inline])
          .optional()
          .describe("Attachment purpose. Defaults to context."),
      },
    },
    ({ entityId, filename, mimeType, purpose, sizeBytes }) =>
      withErrorHandling(async () => {
        const path = `/documents/${encodePathSegment(entityId)}/attachments`;
        const result = await apiClient.post<CreateAttachmentResponse>(path, {
          filename,
          mimeType,
          sizeBytes,
          ...(purpose ? { purpose } : {}),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      })
  );
}
