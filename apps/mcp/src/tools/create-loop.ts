import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { describeIdOrSlug, withErrorHandling } from "./tool-utils.js";

/**
 * Register the create-loop tool on the given MCP server.
 * Creates a MANUAL loop in RUNNING status tied to a feature/document.
 */
export function registerCreateLoop(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-loop",
    {
      description:
        "Create a manual loop to give your team visibility into locally-driven Claude Code work. " +
        "Call this when starting manual feature implementation so the work appears on the ClosedLoop dashboard.\n\n" +
        "IMPORTANT: Before calling this tool, verify you are NOT already inside a platform-managed loop. " +
        "Run `echo $CLOSEDLOOP_LOOP_ID` — if it returns a value, you are inside a managed loop and MUST NOT " +
        "create a manual loop. This tool is only for developer-initiated local work.\n\n" +
        "After creating the loop, consider updating the workstream status to IMPLEMENTATION_IN_PROGRESS via update-workstream.",
      inputSchema: {
        documentId: z
          .string()
          .describe(describeIdOrSlug("Document", ["FEA-42", "PLN-7", "PRD-3"])),
        workstreamId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Workstream", "WRK-3")),
        prompt: z
          .string()
          .optional()
          .describe(
            "Description of the work being performed (e.g. 'Implement FEA-653 per the implementation plan')"
          ),
        repoFullName: z
          .string()
          .optional()
          .describe(
            "Repository in owner/repo format (e.g. 'closedloop-ai/symphony-alpha')"
          ),
        repoBranch: z
          .string()
          .optional()
          .describe("Git branch name (e.g. 'feature/fea-653')"),
      },
    },
    ({ documentId, workstreamId, prompt, repoFullName, repoBranch }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = {
          command: "MANUAL",
          documentId,
        };
        if (workstreamId !== undefined) {
          body.workstreamId = workstreamId;
        }
        if (prompt !== undefined) {
          body.prompt = prompt;
        }
        if (repoFullName && repoBranch) {
          body.repo = { fullName: repoFullName, branch: repoBranch };
        }

        const result = await apiClient.post<unknown>("/loops", body);
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
