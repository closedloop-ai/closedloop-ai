import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

type AttachmentActionMethod = "delete" | "get";

type AttachmentActionToolOptions = {
  toolName: string;
  description: string;
  entityIdDescriptionSuffix?: string;
  method: AttachmentActionMethod;
};

const DOCUMENT_ID_EXAMPLES = ["PRD-7", "PLN-12", "FEA-42"];

/**
 * Register an MCP tool that calls a document attachment item endpoint and
 * serializes the API response as text content.
 */
export function registerAttachmentActionTool<TResponse>(
  server: McpServer,
  apiClient: ApiClient,
  options: AttachmentActionToolOptions
): void {
  server.registerTool(
    options.toolName,
    {
      description: options.description,
      inputSchema: {
        entityId: z
          .string()
          .describe(
            buildEntityIdDescription(options.entityIdDescriptionSuffix)
          ),
        attachmentId: z.string().describe("Attachment UUID"),
      },
    },
    ({ entityId, attachmentId }) =>
      withErrorHandling(async () => {
        const path = buildAttachmentItemPath(entityId, attachmentId);
        const result = await callAttachmentItemEndpoint<TResponse>(
          apiClient,
          options.method,
          path
        );
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

function buildAttachmentItemPath(
  entityId: string,
  attachmentId: string
): string {
  return `/documents/${encodePathSegment(entityId)}/attachments/${encodePathSegment(attachmentId)}`;
}

function buildEntityIdDescription(suffix: string | undefined): string {
  const description = describeIdOrSlug("Document", DOCUMENT_ID_EXAMPLES);
  return suffix ? `${description} ${suffix}` : description;
}

function callAttachmentItemEndpoint<TResponse>(
  apiClient: ApiClient,
  method: AttachmentActionMethod,
  path: string
): Promise<TResponse> {
  if (method === "get") {
    return apiClient.get<TResponse>(path);
  }
  return apiClient.delete<TResponse>(path);
}
