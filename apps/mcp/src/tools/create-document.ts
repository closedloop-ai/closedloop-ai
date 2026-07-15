import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Priority } from "@repo/api/src/types/common.js";
import {
  DocumentStatus,
  DocumentType,
  FeatureStatus,
} from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildDocumentUrlFromRecord,
  DOCUMENT_DOC_HELP,
  describeIdOrSlug,
  pickDefined,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the create-document tool on the given MCP server.
 * Calls POST /documents to create a new document.
 */
export function registerCreateDocument(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-document",
    {
      description:
        "Create a document — a PRD, implementation plan, feature, or template — and attach it to a project. The assigned slug (PRD-*, PLN-*, FEA-*) is returned in the response and is the preferred handle for future calls.\n\nEditable fields (assignee, approver, priority, fileName, status, repositorySelection) can be set at creation in the same operation. Features default to TRIAGE when status is omitted; other types default to DRAFT. Repository context becomes an immutable snapshot after creation.",
      inputSchema: {
        title: z.string().describe("Title of the document"),
        type: z
          .enum(DocumentType)
          .describe(`${DOCUMENT_DOC_HELP} Choose the document type.`),
        projectId: z.string().describe(describeIdOrSlug("Project", "PRO-7")),
        content: z.string().describe("Initial document content/body"),
        assigneeId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe(
            "UUID of the user to assign this document to. Use list-users to find valid user IDs."
          ),
        approverId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe(
            "UUID of the user to set as approver. Use list-users to find valid user IDs."
          ),
        priority: z
          .enum(Priority)
          .optional()
          .describe("Initial priority: LOW, MEDIUM, HIGH, or URGENT."),
        fileName: z.string().optional().describe("File name for the document."),
        status: z
          .enum({ ...DocumentStatus, ...FeatureStatus })
          .optional()
          .describe(
            "Initial status. Documents use DRAFT/IN_REVIEW/CHANGES_REQUESTED/APPROVED/EXECUTED/OBSOLETE; Features use TRIAGE/BACKLOG/TODO/IN_PROGRESS/IN_REVIEW/BLOCKED/DONE/CANCELED. When omitted, Features default to TRIAGE and other types to DRAFT."
          ),
        repositorySelection: z
          .object({
            primary: z.object({
              fullName: z.string(),
              branch: z.string().nullable().optional(),
            }),
            additional: z
              .array(
                z.object({
                  fullName: z.string(),
                  branch: z.string().nullable().optional(),
                })
              )
              .optional(),
          })
          .optional()
          .describe(
            "Repositories this document is created against (owner/repo full names, optional branches). Exact full-name/branch/count constraints are enforced by the API; the snapshot is read-only after creation."
          ),
      },
    },
    ({
      title,
      type,
      projectId,
      content,
      assigneeId,
      approverId,
      priority,
      fileName,
      status,
      repositorySelection,
    }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = {
          title,
          type,
          content,
          ...pickDefined({
            projectId,
            assigneeId,
            approverId,
            priority,
            fileName,
            repositorySelection,
            status,
          }),
        };
        // Agent-created Features land in TRIAGE so a human assesses them
        // before they enter the delivery flow (PRD-495); an explicit caller
        // status overrides this. Other document types use the server's
        // DRAFT default.
        if (body.status === undefined && type === DocumentType.Feature) {
          body.status = FeatureStatus.Triage;
        }
        const response = await apiClient.post<unknown>("/documents", body);
        const envelope = asRecord(response);
        const row = asRecord(envelope.data ?? response);
        const webUrl = buildDocumentUrlFromRecord(row);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...row, webUrl }, null, 2),
            },
          ],
        };
      })
  );
}
