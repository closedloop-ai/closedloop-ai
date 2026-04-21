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
        'Get one workstream (an initiative or track of work) by UUID or slug (WRK-*), including state and attached documents. When the user references a workstream by its slug (e.g. "show me WRK-5"), pass that slug as workstreamId directly.',
      inputSchema: {
        workstreamId: z
          .string()
          .describe(describeIdOrSlug("Workstream", "WRK-5")),
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
