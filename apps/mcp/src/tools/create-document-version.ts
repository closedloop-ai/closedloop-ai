import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

export function registerCreateDocumentVersion(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-document-version",
    {
      description:
        "Append a new version to a document by ID or slug. Older versions stay in history.",
      inputSchema: {
        documentId: z
          .string()
          .describe(describeIdOrSlug("Document", ["PRD-7", "PLAN-12"])),
        content: z.string().describe("Full content for the new version"),
      },
    },
    ({ documentId, content }) =>
      withErrorHandling(async () => {
        const result = await apiClient.post<unknown>(
          `/documents/${encodePathSegment(documentId)}/versions`,
          { content }
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
