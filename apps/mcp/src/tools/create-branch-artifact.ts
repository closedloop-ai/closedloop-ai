import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { asRecord, readString, withErrorHandling } from "./tool-utils.js";

/**
 * Register the write-only branch artifact creation tool. The MCP server hides
 * this registration unless the verified key has write scope.
 */
export function registerCreateBranchArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create_branch_artifact",
    {
      description:
        "Create or update a branch artifact for a project repository. Requires write scope.",
      inputSchema: {
        projectId: z.string().uuid().describe("Project UUID"),
        sourceArtifactId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe("Optional same-org source artifact UUID to link"),
        branchName: z.string().min(1).describe("Exact Git branch name"),
        defaultBranch: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "Repository default branch, used to reject default-branch materialization"
          ),
        baseBranch: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("Known base branch"),
        baseBranchSource: z
          .enum(BranchBaseBranchSource)
          .nullable()
          .optional()
          .describe("Base branch provenance"),
        headSha: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("Known branch head SHA"),
        headShaSource: z
          .enum(BranchHeadShaSource)
          .nullable()
          .optional()
          .describe("Head SHA provenance"),
      },
    },
    (input) =>
      withErrorHandling(async () => {
        const artifact = await apiClient.post<unknown>(
          "/artifact-links/branches",
          input
        );
        const shaped = shapeCreateBranchArtifactResponse(artifact);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(shaped, null, 2),
            },
          ],
        };
      })
  );
}

function shapeCreateBranchArtifactResponse(value: unknown): {
  id: string | null;
} {
  const record = asRecord(value);
  return { id: readString(record.id) };
}
