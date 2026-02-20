import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerCreateExternalLink(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "create-external-link",
    "Create an external link (PR, Figma, preview deployment) attached to a workstream or project",
    {
      workstreamId: z
        .string()
        .optional()
        .describe("ID of the workstream to attach the link to"),
      projectId: z
        .string()
        .optional()
        .describe("ID of the project to attach the link to"),
      externalUrl: z.string().url().describe("URL of the external link"),
      type: z
        .nativeEnum(ExternalLinkType)
        .describe("Type of the external link"),
      title: z.string().describe("Display title for the external link"),
    },
    ({ workstreamId, projectId, externalUrl, type, title }) =>
      withErrorHandling(async () => {
        if (!(workstreamId || projectId)) {
          throw new Error("Either workstreamId or projectId is required");
        }
        const body: Record<string, unknown> = { externalUrl, type, title };
        if (workstreamId !== undefined) {
          body.workstreamId = workstreamId;
        }
        if (projectId !== undefined) {
          body.projectId = projectId;
        }
        const link = await apiClient.post<unknown>("/external-links", body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(link, null, 2),
            },
          ],
        };
      })
  );
}
