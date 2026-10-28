import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Priority } from "@repo/api/src/types/common.js";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  describeIdOrSlug,
  encodePathSegment,
  type McpUrlBuilder,
  pickDefined,
  requiredIdOrSlug,
  withErrorHandling,
} from "./tool-utils.js";

const dueDateInput = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .nullable()
  .optional();

export function registerUpdateDocument(
  server: McpServer,
  apiClient: ApiClient,
  urls: McpUrlBuilder
): void {
  server.registerTool(
    "update-document",
    {
      description:
        "Update a document's editable fields — title, status, project, assignee, approver, priority, dueDate, or fileName — by UUID or slug (PRD-*, PLN-*, FEA-*). Pass the user's slug verbatim. Use create-document-version for content edits.\n\nDocuments and Features have separate status vocabularies; the server rejects a status that doesn't belong to the target artifact's type. Pass expectedStatus with the status value you previously read to reject stale writes with HTTP 409 instead of overwriting a newer transition; expectedPriority does the same for priority, and null there asserts the artifact currently has no priority.\nDocuments (PRD/PLN): DRAFT → IN_REVIEW → APPROVED (or CHANGES_REQUESTED, EXECUTED, OBSOLETE).\nFeatures (FEA): TRIAGE → BACKLOG → TODO → IN_PROGRESS → IN_REVIEW → DONE (or BLOCKED, CANCELED).\n\nRead-only fields cannot be updated and are rejected by the API: id, slug, tokenUsage, timestamps, createdBy metadata, latestVersion, and repositorySnapshot (repository context is server-owned and not caller-editable).",
      inputSchema: {
        documentId: requiredIdOrSlug(
          "Document",
          ["PRD-7", "PLN-12", "FEA-42"],
          "Use list-documents to find one."
        ),
        // ISS-12858: `null` CLEARS the project and an omitted key leaves it
        // alone; it reaches the API the same way as `priority` below.
        projectId: z
          .string()
          .nullable()
          .optional()
          .describe(
            describeIdOrSlug("Project", "PRO-7") +
              ". Moves the document to this project. Pass null to clear the project."
          ),
        title: z.string().optional().describe("New title for the document"),
        status: z
          // Accept either vocabulary; the server enforces the subset valid for
          // the target artifact's type (PRD-495).
          .enum({ ...DocumentStatus, ...IssueStatus })
          .optional()
          .describe(
            "New status. Documents use DRAFT/IN_REVIEW/CHANGES_REQUESTED/APPROVED/EXECUTED/OBSOLETE; Features use TRIAGE/BACKLOG/TODO/IN_PROGRESS/IN_REVIEW/BLOCKED/DONE/CANCELED."
          ),
        expectedStatus: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional raw stale-write guard. When present, the server rejects the update with HTTP 409 unless the persisted status still equals this value. A status the document already holds is never refused."
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
        // ISS-9665: `.nullable()` before `.optional()`, mirroring `approverId`
        // above and `updateDocumentValidator` on the route. The two are
        // different requests — `null` CLEARS the priority, an omitted key
        // leaves it alone — and `pickDefined` below strips only `undefined`, so
        // an explicit null reaches the API as `priority: null`. Without this an
        // API-key caller could set a priority but never clear one.
        priority: z
          .enum(Priority)
          .nullable()
          .optional()
          .describe(
            "New priority: LOW, MEDIUM, HIGH, or URGENT. Pass null to clear the priority."
          ),
        // ISS-9440: the priority half of the optimistic guard. Three states and
        // all three are load-bearing, so this is `.nullable().optional()` for
        // the same reason `priority` above is — omitted leaves the write
        // unguarded, `null` ASSERTS the artifact currently holds no priority,
        // and a member asserts that member. `pickDefined` strips only
        // `undefined`, so an explicit null reaches the API as
        // `expectedPriority: null` and guards the unset→member write, which is
        // the one this tool makes most often.
        expectedPriority: z
          .enum(Priority)
          .nullable()
          .optional()
          .describe(
            "Optional stale-write guard for priority. When present, the server rejects the update with HTTP 409 unless the persisted priority still equals this value. Pass null to assert the artifact currently has no priority. A priority the document already holds is never refused."
          ),
        dueDate: dueDateInput.describe(
          "New due date as ISO 8601 date (YYYY-MM-DD) or timezone-qualified datetime. Pass null to clear it."
        ),
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
      expectedStatus,
      assigneeId,
      approverId,
      priority,
      expectedPriority,
      dueDate,
      fileName,
    }) =>
      withErrorHandling(async () => {
        const body = pickDefined({
          projectId,
          title,
          status,
          expectedStatus,
          assigneeId,
          approverId,
          priority,
          expectedPriority,
          dueDate,
          fileName,
        });

        const document = asRecord(
          await apiClient.put<unknown>(
            `/documents/${encodePathSegment(documentId)}`,
            body
          )
        );
        const webUrl = urls.buildDocumentUrlFromRecord(document);
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
