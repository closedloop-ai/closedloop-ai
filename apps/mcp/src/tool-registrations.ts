import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiKeyScope } from "@repo/api/src/types/api-key.js";
import type { ApiClient } from "./api-client.js";
import { DELETE_SCOPE, READ_SCOPE, WRITE_SCOPE } from "./oauth-scopes.js";
import {
  registerGetAgentComponent,
  registerListAgentComponents,
} from "./tools/agent-component-read.js";
import {
  registerGetAgentSessionTranscript,
  registerListAgentSessions,
} from "./tools/agent-session-read.js";
import {
  registerGetAgentSessionAnalytics,
  registerGetAgentSessionUsage,
} from "./tools/agent-session-reporting.js";
import { registerCreateArtifactLink } from "./tools/create-artifact-link.js";
import { registerCreateBranchArtifact } from "./tools/create-branch-artifact.js";
import { registerCreateDocument } from "./tools/create-document.js";
import { registerCreateDocumentThread } from "./tools/create-document-thread.js";
import { registerCreateDocumentVersion } from "./tools/create-document-version.js";
import { registerCreateInlineImageAttachment } from "./tools/create-inline-image-attachment.js";
import { registerCreateProject } from "./tools/create-project.js";
import { registerDeleteArtifactLink } from "./tools/delete-artifact-link.js";
import { registerDeleteAttachment } from "./tools/delete-attachment.js";
import { registerDownloadAttachment } from "./tools/download-attachment.js";
import { registerGetDocument } from "./tools/get-document.js";
import { registerGetDocumentComments } from "./tools/get-document-comments.js";
import { registerGetDocumentContent } from "./tools/get-document-content.js";
import { registerGetGithubStatus } from "./tools/get-github-status.js";
import { registerGetGoogleStatus } from "./tools/get-google-status.js";
import { registerGetLinearStatus } from "./tools/get-linear-status.js";
import { registerGetMe } from "./tools/get-me.js";
import { registerGetProject } from "./tools/get-project.js";
import { registerListArtifactLinks } from "./tools/list-artifact-links.js";
import { registerListAttachments } from "./tools/list-attachments.js";
import { registerListDocumentVersions } from "./tools/list-document-versions.js";
import { registerListDocuments } from "./tools/list-documents.js";
import { registerListProjects } from "./tools/list-projects.js";
import { registerListSessionComments } from "./tools/list-session-comments.js";
import { registerListTags } from "./tools/list-tags.js";
import { registerListTeams } from "./tools/list-teams.js";
import { registerListTemplates } from "./tools/list-templates.js";
import { registerListUsers } from "./tools/list-users.js";
import { registerMoveArtifact } from "./tools/move-artifact.js";
import { registerSearch } from "./tools/search.js";
import { registerTagArtifact } from "./tools/tag-artifact.js";
import type { McpUrlBuilder } from "./tools/tool-utils.js";
import { registerUntagArtifact } from "./tools/untag-artifact.js";
import { registerUpdateDocument } from "./tools/update-document.js";
import { registerUpdateProject } from "./tools/update-project.js";
import { registerUploadAttachment } from "./tools/upload-attachment.js";
import { registerVerifyAuditLedger } from "./tools/verify-audit-ledger.js";

/**
 * The tool catalog: every MCP tool this server can register, and the scopes a
 * session must hold before it is offered one.
 *
 * Split out of `index.ts` (ISS-4424) because the catalog is a table that grows
 * with every new tool, while `index.ts` owns transport, OAuth, and session
 * lifecycle. Keeping them together meant adding one tool touched a file that
 * is grandfathered under the `noExcessiveLinesPerFile` ceiling; the two
 * responsibilities now sit in separate modules and the catalog can grow on its
 * own budget.
 */
export type ToolRegistration = {
  name: string;
  register: (
    server: McpServer,
    apiClient: ApiClient,
    urls: McpUrlBuilder
  ) => void;
  /**
   * Scopes the grant must carry for this tool to be registered. Omitted means
   * `toolRequiredScopes` supplies the default-deny fallback (ISS-4905), so a
   * new tool is never public by accident; pass `[]` to opt out deliberately.
   */
  requiredScopes?: ApiKeyScope[];
  requiresWrite?: boolean;
};

export const TOOL_REGISTRATIONS: ToolRegistration[] = [
  {
    name: "ping",
    // Connectivity probe only — it reaches no platform data, so it is the one
    // deliberate opt-out from the read default (ISS-4905).
    requiredScopes: [],
    register: (server) => {
      server.registerTool(
        "ping",
        { description: "Check MCP server connectivity" },
        () =>
          Promise.resolve({
            content: [{ type: "text" as const, text: "pong" }],
          })
      );
    },
  },
  { name: "search", register: registerSearch },
  { name: "list-projects", register: registerListProjects },
  { name: "get-project", register: registerGetProject },
  // Read-only, so no `requiresWrite`: `toolRequiredScopes` supplies the
  // `[READ_SCOPE]` default. Sits with the project tools because that is what it
  // is for — a project must name a team, and this is where the id comes from.
  { name: "list-teams", register: registerListTeams },
  {
    name: "create-project",
    register: registerCreateProject,
    requiresWrite: true,
  },
  {
    name: "update-project",
    register: registerUpdateProject,
    requiresWrite: true,
  },
  { name: "list-documents", register: registerListDocuments },
  { name: "get-document", register: registerGetDocument },
  {
    name: "get-document-content",
    register: registerGetDocumentContent,
    requiredScopes: [READ_SCOPE],
  },
  {
    name: "create-document",
    register: registerCreateDocument,
    requiresWrite: true,
  },
  {
    name: "create-document-thread",
    register: registerCreateDocumentThread,
    requiresWrite: true,
  },
  { name: "get-document-comments", register: registerGetDocumentComments },
  {
    name: "update-document",
    register: registerUpdateDocument,
    requiresWrite: true,
  },
  {
    name: "move-artifact",
    register: registerMoveArtifact,
    requiresWrite: true,
  },
  {
    name: "create-document-version",
    register: registerCreateDocumentVersion,
    requiresWrite: true,
  },
  { name: "list-document-versions", register: registerListDocumentVersions },
  { name: "list-attachments", register: registerListAttachments },
  {
    name: "upload-attachment",
    register: registerUploadAttachment,
    requiresWrite: true,
  },
  {
    name: "create-inline-image-attachment",
    register: registerCreateInlineImageAttachment,
    requiresWrite: true,
  },
  { name: "download-attachment", register: registerDownloadAttachment },
  {
    name: "delete-attachment",
    register: registerDeleteAttachment,
    requiredScopes: [DELETE_SCOPE],
  },
  { name: "get-me", register: registerGetMe },
  { name: "list-users", register: registerListUsers },
  { name: "list-artifact-links", register: registerListArtifactLinks },
  {
    name: "create-artifact-link",
    register: registerCreateArtifactLink,
    requiresWrite: true,
  },
  {
    name: "delete-artifact-link",
    register: registerDeleteArtifactLink,
    requiredScopes: [DELETE_SCOPE],
  },
  // ISS-6967. The two write tools name `read` explicitly because each resolves
  // the document and the tag list before it writes, and scope matching is flat
  // — `write` does not imply `read`, so a grant missing it would be offered a
  // tool that fails on its first call. `requiresWrite` is deliberately absent:
  // an explicit `requiredScopes` is returned verbatim by `toolRequiredScopes`,
  // which makes the flag unreachable AND would let the scope tests pass with
  // WRITE_SCOPE deleted.
  {
    name: "list-tags",
    register: registerListTags,
    requiredScopes: [READ_SCOPE],
  },
  {
    name: "tag-artifact",
    register: registerTagArtifact,
    requiredScopes: [READ_SCOPE, WRITE_SCOPE],
  },
  {
    name: "untag-artifact",
    register: registerUntagArtifact,
    requiredScopes: [READ_SCOPE, DELETE_SCOPE],
  },
  {
    name: "create_branch_artifact",
    register: registerCreateBranchArtifact,
    requiresWrite: true,
  },
  { name: "list-templates", register: registerListTemplates },
  { name: "get-github-status", register: registerGetGithubStatus },
  { name: "get-linear-status", register: registerGetLinearStatus },
  { name: "get-google-status", register: registerGetGoogleStatus },
  { name: "verify-audit-ledger", register: registerVerifyAuditLedger },
  {
    name: "get-agent-session-usage",
    register: registerGetAgentSessionUsage,
    requiredScopes: [READ_SCOPE],
  },
  {
    name: "get-agent-session-analytics",
    register: registerGetAgentSessionAnalytics,
    requiredScopes: [READ_SCOPE],
  },
  {
    name: "list-agent-sessions",
    register: registerListAgentSessions,
    requiredScopes: [READ_SCOPE],
  },
  {
    name: "get-agent-session-transcript",
    register: registerGetAgentSessionTranscript,
    requiredScopes: [READ_SCOPE],
  },
  {
    name: "list-session-comments",
    register: registerListSessionComments,
    requiredScopes: [READ_SCOPE],
  },
  {
    name: "list-agent-components",
    register: registerListAgentComponents,
    requiredScopes: [READ_SCOPE],
  },
  {
    name: "get-agent-component",
    register: registerGetAgentComponent,
    requiredScopes: [READ_SCOPE],
  },
];

export const TOOL_NAMES = TOOL_REGISTRATIONS.map((entry) => entry.name);
