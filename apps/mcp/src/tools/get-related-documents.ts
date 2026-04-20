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
        "List documents linked to a document (e.g. PRD-to-plan, plan-to-feature relationships) by UUID or slug (PRD-*, PLN-*, FEA-*). Pass the user's slug verbatim.",
      inputSchema: {
        documentId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
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
