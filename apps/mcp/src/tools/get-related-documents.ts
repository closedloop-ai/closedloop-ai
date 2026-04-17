import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

export function registerGetRelatedDocuments(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-related-documents",
    {
      description:
        "List documents linked to a document, such as PRD-to-plan relationships.",
      inputSchema: {
        documentId: z
          .string()
          .describe(describeIdOrSlug("Document", ["PRD-7", "PLAN-12"])),
      },
    },
    ({ documentId }) =>
      withErrorHandling(async () => {
        const related = await apiClient.get<unknown>(
          `/documents/${encodePathSegment(documentId)}/related`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(related, null, 2),
            },
          ],
        };
      })
  );
}
