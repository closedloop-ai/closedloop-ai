import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExternalLinkType } from "@repo/api/src/types/external-link.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { describeIdOrSlug, withErrorHandling } from "./tool-utils.js";

export function registerCreateExternalLink(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-external-link",
    {
      description:
        "Attach an external resource, such as a pull request, Figma file, or preview deployment, to a project or workstream.",
      inputSchema: {
        workstreamId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Workstream", "WORK-3")),
        projectId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Project", "PROJ-7")),
        externalUrl: z.url().describe("URL of the external link"),
        type: z.enum(ExternalLinkType).describe("Type of the external link"),
        title: z.string().describe("Display title for the external link"),
      },
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
