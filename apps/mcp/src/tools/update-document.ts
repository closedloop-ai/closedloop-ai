import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Priority } from "@repo/api/src/types/common.js";
import { DocumentStatus, FeatureStatus } from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildDocumentUrlFromRecord,
  describeIdOrSlug,
  encodePathSegment,
  pickDefined,
  withErrorHandling,
} from "./tool-utils.js";

export function registerUpdateDocument(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "update-document",
    {
      description:
        "Update a document's editable fields — title, status, project, assignee, approver, priority, or fileName — by UUID or slug (PRD-*, PLN-*, FEA-*). Pass the user's slug verbatim. Use create-document-version for content edits.\n\nDocuments and Features have separate status vocabularies; the server rejects a status that doesn't belong to the target artifact's type.\nDocuments (PRD/PLN): DRAFT → IN_REVIEW → APPROVED (or CHANGES_REQUESTED, EXECUTED, OBSOLETE).\nFeatures (FEA): TRIAGE → BACKLOG → TODO → IN_PROGRESS → IN_REVIEW → DONE (or BLOCKED, CANCELED).\n\nRead-only fields cannot be updated and are rejected by the API: id, slug, tokenUsage, timestamps, createdBy metadata, latestVersion, and repositorySnapshot (repository context is fixed at creation).",
      inputSchema: {
        documentId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        projectId: z
          .string()
          .optional()
          .describe(
            describeIdOrSlug("Project", "PRO-7") +
              ". Moves the document to this project."
          ),
        title: z.string().optional().describe("New title for the document"),
        status: z
          // Accept either vocabulary; the server enforces the subset valid for
          // the target artifact's type (PRD-495).
          .enum({ ...DocumentStatus, ...FeatureStatus })
          .optional()
          .describe(
            "New status. Documents use DRAFT/IN_REVIEW/CHANGES_REQUESTED/APPROVED/EXECUTED/OBSOLETE; Features use TRIAGE/BACKLOG/TODO/IN_PROGRESS/IN_REVIEW/BLOCKED/DONE/CANCELED."
          ),
        assigneeId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe(
            "UUID of the user to assign this document to. Use list-users to find valid user IDs. Pass null to unassign."
          ),
        approverId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe(
            "UUID of the user to set as approver. Use list-users to find valid user IDs. Pass null to clear the approver."
          ),
        priority: z
          .enum(Priority)
          .optional()
          .describe("New priority: LOW, MEDIUM, HIGH, or URGENT."),
        fileName: z
          .string()
          .optional()
          .describe("New file name for the document."),
      },
    },
    ({
      documentId,
      projectId,
      title,
      status,
      assigneeId,
      approverId,
      priority,
      fileName,
    }) =>
      withErrorHandling(async () => {
        const body = pickDefined({
          projectId,
          title,
          status,
          assigneeId,
          approverId,
          priority,
          fileName,
        });

        const document = asRecord(
          await apiClient.put<unknown>(
            `/documents/${encodePathSegment(documentId)}`,
            body
          )
        );
        const webUrl = buildDocumentUrlFromRecord(document);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...document, webUrl }, null, 2),
            },
          ],
        };
      })
  );
}
