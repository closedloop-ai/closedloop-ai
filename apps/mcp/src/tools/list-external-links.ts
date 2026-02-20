import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerListExternalLinks(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-external-links",
    "List external links filtered by workstream or project",
    {
      workstreamId: z
        .string()
        .optional()
        .describe("ID of the workstream to list links for"),
      projectId: z
        .string()
        .optional()
        .describe("ID of the project to list links for"),
      type: z
        .nativeEnum(ExternalLinkType)
        .optional()
        .describe("Filter by external link type"),
    },
    ({ workstreamId, projectId, type }) =>
      withErrorHandling(async () => {
        if (!(workstreamId || projectId)) {
          throw new Error("Either workstreamId or projectId is required");
        }
        const query: Record<string, string> = {};
        if (workstreamId !== undefined) {
          query.workstreamId = workstreamId;
        }
        if (projectId !== undefined) {
          query.projectId = projectId;
        }
        if (type !== undefined) {
          query.type = type;
        }

        const links = await apiClient.get<unknown[]>("/external-links", query);
        const text =
          links.length === 0
            ? "No external links found."
            : JSON.stringify(links, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
