import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerCreateArtifactThread(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-artifact-thread",
    {
      description: "Create a comment thread on an artifact by ID or slug",
      inputSchema: {
        artifactId: z
          .string()
          .describe("ID or slug of the artifact (e.g., PRD-7)"),
        body: z.string().min(1).describe("Comment body text"),
        anchorText: z
          .string()
          .min(1)
          .describe(
            "Exact text in the document to anchor this comment to. Case-sensitive. Must be unique within the document. May span inline formatting (bold/italic) within a single textblock (paragraph, heading, list item, etc.), but cannot cross textblock boundaries."
          ),
      },
    },
    ({ artifactId, body, anchorText }) =>
      withErrorHandling(async () => {
        const result = await apiClient.post<unknown>(
          `/artifacts/${encodePathSegment(artifactId)}/threads`,
          { body, anchorText }
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
