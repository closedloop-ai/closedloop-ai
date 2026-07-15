import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoopCommand } from "@repo/api/src/types/loop";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildLoopUrl,
  describeIdOrSlug,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

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
        "Call this when starting manual feature implementation so the work appears on the Closedloop dashboard.\n\n" +
        "IMPORTANT: Before calling this tool, verify you are NOT already inside a platform-managed loop. " +
        "Run `echo $CLOSEDLOOP_LOOP_ID` — if it returns a value, you are inside a managed loop and MUST NOT " +
        "create a manual loop. This tool is only for developer-initiated local work.\n\n" +
        "Best practice: Create a manual loop whenever you begin work on any Closedloop document (FEA-*, PLN-*, PRD-*). " +
        "Always include repoFullName and repoBranch so the loop links to the correct repository context. " +
        "Post progress events via add-loop-event at meaningful milestones throughout the work — don't just create and complete.",
      // inputSchema must be a ZodRawShape (a plain field map), not a built
      // ZodObject/ZodEffects — the MCP SDK builds the object itself, so a
      // z.object().refine() here is rejected. The cross-field "both or neither"
      // rule can't be expressed on a raw shape, so it lives in the handler below.
      inputSchema: {
        documentId: z
          .string()
          .describe(describeIdOrSlug("Document", ["FEA-42", "PLN-7", "PRD-3"])),
        prompt: z
          .string()
          .optional()
          .describe(
            "Description of the work being performed (e.g. 'Implement FEA-653 per the implementation plan')"
          ),
        repoFullName: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Repository in owner/repo format (e.g. 'closedloop-ai/symphony-alpha'). Must be provided together with repoBranch."
          ),
        repoBranch: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Git branch name (e.g. 'feature/fea-653'). Must be provided together with repoFullName."
          ),
      },
    },
    ({ documentId, prompt, repoFullName, repoBranch }) =>
      withErrorHandling(async () => {
        // Cross-field validation (see inputSchema note): repoFullName/repoBranch
        // are both-or-neither so the loop links to the correct repo context.
        if ((repoFullName === undefined) !== (repoBranch === undefined)) {
          throw new Error(
            "repoFullName and repoBranch must be provided together (both or neither) so the loop links to the correct repository context."
          );
        }
        const body: Record<string, unknown> = {
          command: LoopCommand.Manual,
          documentId,
        };
        if (prompt !== undefined) {
          body.prompt = prompt;
        }
        if (repoFullName && repoBranch) {
          body.repo = { fullName: repoFullName, branch: repoBranch };
        }

        const result = await apiClient.post<unknown>("/loops", body);
        const record = asRecord(result);
        const resolvedId = readString(record.id) ?? readString(record.loopId);
        const webUrl = resolvedId ? buildLoopUrl(resolvedId) : null;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...record, webUrl }, null, 2),
            },
          ],
        };
      })
  );
}
