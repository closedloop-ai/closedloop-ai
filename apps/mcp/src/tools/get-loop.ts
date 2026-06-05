import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerGetLoop(server: McpServer, apiClient: ApiClient): void {
  server.registerTool(
    "get-loop",
    {
      description: "Get one automation run, called a loop, by ID.",
      inputSchema: {
        loopId: z.string().describe("ID of the loop to retrieve"),
      },
    },
    ({ loopId }) =>
      withErrorHandling(async () => {
        const loop = await apiClient.get<unknown>(
          `/loops/${encodePathSegment(loopId)}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(loop, null, 2),
            },
          ],
        };
      })
  );
}
