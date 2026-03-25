import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArtifactType } from "@repo/api/src/types/artifact.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  ARTIFACT_DOC_HELP,
  describeIdOrSlug,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the create-artifact tool on the given MCP server.
 * Calls POST /artifacts to create a new artifact.
 */
export function registerCreateArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-artifact",
    {
      description:
        "Create an artifact document, such as a PRD, implementation plan, or template, and attach it to a project or workstream.",
      inputSchema: {
        title: z.string().describe("Title of the artifact"),
        type: z
          .enum(ArtifactType)
          .describe(`${ARTIFACT_DOC_HELP} Choose the artifact type.`),
        projectId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Project", "PROJ-7")),
        workstreamId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Workstream", "WORK-3")),
        content: z.string().describe("Initial document content/body"),
      },
    },
    ({ title, type, projectId, workstreamId, content }) =>
      withErrorHandling(async () => {
        const body: Record<string, string> = {
          title,
          type,
          content,
        };
        if (projectId !== undefined) {
          body.projectId = projectId;
        }
        if (workstreamId !== undefined) {
          body.workstreamId = workstreamId;
        }
        const artifact = await apiClient.post<unknown>("/artifacts", body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(artifact, null, 2),
            },
          ],
        };
      })
  );
}
