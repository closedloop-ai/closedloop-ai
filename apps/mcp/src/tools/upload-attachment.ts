import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AttachmentPurpose,
  type CreateAttachmentResponse,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
  MAX_MEDIA_FILE_SIZE_BYTES,
  MEDIA_MIME_TYPES,
} from "@repo/api/src/types/attachment.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  encodePathSegment,
  requiredIdOrSlug,
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
        "Create a presigned upload URL for a document attachment. Use the returned uploadUrl immediately with the exact declared MIME type and sizeBytes, then rediscover the attachment with list-attachments. For inline images, view them with get-document using includeContent=true (which resolves attachment:// refs server-side; add includeImages=true to also return the image content blocks). Pass the user's document slug verbatim for entityId.",
      inputSchema: {
        entityId: requiredIdOrSlug(
          "Document",
          ["PRD-7", "PLN-12", "FEA-42"],
          "Use list-documents to find one."
        ),
        filename: z.string().min(1).describe("Original filename to store"),
        mimeType: z
          .string()
          .min(1)
          .describe("MIME type that the S3 PUT must use exactly"),
        // ISS-10415: bounded by the LARGER of the two ceilings, because a tool
        // schema is per field and cannot see `mimeType` to narrow per type.
        // Capping at the document ceiling here made the media path unreachable
        // through MCP entirely; the API's own validator still refuses a
        // non-media file over `MAX_ATTACHMENT_FILE_SIZE_BYTES`, so the narrower
        // limit is enforced, it is just enforced by its owner.
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(MAX_MEDIA_FILE_SIZE_BYTES)
          .describe(
            `Declared byte size that the S3 PUT must match. Up to ${MAX_MEDIA_FILE_SIZE_BYTES} bytes for ${MEDIA_MIME_TYPES.join(
              ", "
            )}; every other type is limited to ${MAX_ATTACHMENT_FILE_SIZE_BYTES} bytes.`
          ),
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
