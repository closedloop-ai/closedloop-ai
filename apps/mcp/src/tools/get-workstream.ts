import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerGetWorkstream(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "get-workstream",
    "Get a workstream's detail including state and artifacts",
    {
      workstreamId: z.string().describe("ID of the workstream to retrieve"),
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
