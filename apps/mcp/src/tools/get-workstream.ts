import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

export function registerGetWorkstream(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-workstream",
    {
      description:
        "Get one workstream, meaning an initiative, by ID or slug, including state and artifacts.",
      inputSchema: {
        workstreamId: z
          .string()
          .describe(describeIdOrSlug("Workstream", "WORK-5")),
      },
    },
    ({ workstreamId }) =>
      withErrorHandling(async () => {
        const workstream = await apiClient.get<unknown>(
          `/workstreams/${encodePathSegment(workstreamId)}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(workstream, null, 2),
            },
          ],
        };
      })
  );
}
