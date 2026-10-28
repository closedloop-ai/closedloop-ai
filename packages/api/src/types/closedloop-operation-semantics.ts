/**
 * ISS-12552: what each Closedloop MCP tool does to an artifact, from its route
 * semantics rather than its name. Desktop reads it to turn a transcript tool
 * call into an operation claim, and `apps/mcp` reads it to prove every write
 * tool records a receipt. One table, so the two can never disagree.
 *
 * `targetKeys` are the parameters that name the artifact the operation acts on
 * (a slug or a UUID). `relatedKeys` name other artifacts the call mentions,
 * which never receive the target's relationship. `resultKeys` are the response
 * root fields that identify the record a create or revision committed.
 */
import { OperationKind } from "./attribution-evidence.ts";

export type OperationSemantics = {
  readonly kind: OperationKind;
  readonly targetKeys: readonly string[];
  readonly relatedKeys?: readonly string[];
  readonly resultKeys?: readonly string[];
};

const NO_TARGET = { kind: OperationKind.Unsupported, targetKeys: [] } as const;
const DOCUMENT_RESULT = ["id", "slug"] as const;

export const CLOSEDLOOP_MCP_TOOL_SEMANTICS = {
  // Reads, lists and searches.
  "get-document": { kind: OperationKind.Read, targetKeys: ["documentId"] },
  "get-document-content": {
    kind: OperationKind.Read,
    targetKeys: ["documentId"],
  },
  "get-document-comments": {
    kind: OperationKind.Read,
    targetKeys: ["documentId"],
  },
  "list-document-versions": {
    kind: OperationKind.List,
    targetKeys: ["documentId"],
  },
  "list-attachments": { kind: OperationKind.List, targetKeys: ["entityId"] },
  "download-attachment": { kind: OperationKind.Read, targetKeys: ["entityId"] },
  "list-artifact-links": {
    kind: OperationKind.List,
    targetKeys: ["artifactId"],
  },
  "list-documents": { kind: OperationKind.List, targetKeys: [] },
  search: { kind: OperationKind.Search, targetKeys: [] },
  // Writes. Each one's route records an operation receipt.
  "create-document": {
    kind: OperationKind.Create,
    targetKeys: [],
    resultKeys: DOCUMENT_RESULT,
  },
  "create-document-version": {
    kind: OperationKind.CreateVersion,
    targetKeys: ["documentId"],
    resultKeys: DOCUMENT_RESULT,
  },
  "update-document": {
    kind: OperationKind.UpdateFields,
    targetKeys: ["documentId"],
    resultKeys: DOCUMENT_RESULT,
  },
  "create-document-thread": {
    kind: OperationKind.Comment,
    targetKeys: ["documentId"],
  },
  "move-artifact": {
    kind: OperationKind.Move,
    targetKeys: ["artifactId"],
    relatedKeys: ["referenceArtifactId"],
  },
  "create-artifact-link": {
    kind: OperationKind.LinkCreate,
    targetKeys: ["sourceId"],
    relatedKeys: ["targetId"],
  },
  "delete-artifact-link": { kind: OperationKind.LinkDelete, targetKeys: [] },
  "tag-artifact": { kind: OperationKind.Tag, targetKeys: ["entityId"] },
  "untag-artifact": { kind: OperationKind.Untag, targetKeys: ["entityId"] },
  "upload-attachment": { kind: OperationKind.Attach, targetKeys: ["entityId"] },
  "create-inline-image-attachment": {
    kind: OperationKind.Attach,
    targetKeys: ["entityId"],
  },
  "delete-attachment": { kind: OperationKind.Detach, targetKeys: ["entityId"] },
  create_branch_artifact: {
    kind: OperationKind.Create,
    targetKeys: [],
    relatedKeys: ["sourceArtifactId"],
    resultKeys: ["id"],
  },
  "create-project": { kind: OperationKind.ProjectWrite, targetKeys: [] },
  "update-project": { kind: OperationKind.ProjectWrite, targetKeys: [] },
  // Tools that touch no document, issue or plan.
  ping: NO_TARGET,
  "list-projects": NO_TARGET,
  "get-project": NO_TARGET,
  "list-teams": NO_TARGET,
  "get-me": NO_TARGET,
  "list-users": NO_TARGET,
  "list-tags": NO_TARGET,
  "list-templates": NO_TARGET,
  "get-github-status": NO_TARGET,
  "get-linear-status": NO_TARGET,
  "get-google-status": NO_TARGET,
  "verify-audit-ledger": NO_TARGET,
  "get-agent-session-usage": NO_TARGET,
  "get-agent-session-analytics": NO_TARGET,
  "list-agent-sessions": NO_TARGET,
  "get-agent-session-transcript": NO_TARGET,
  "list-session-comments": NO_TARGET,
  "list-agent-components": NO_TARGET,
  "get-agent-component": NO_TARGET,
} as const satisfies Record<string, OperationSemantics>;

export type ClosedloopMcpToolName = keyof typeof CLOSEDLOOP_MCP_TOOL_SEMANTICS;

/**
 * ISS-12552: the kinds an API-key write with no artifact target records. The
 * classifier gives them no relationship and the comparison report counts them
 * with the other API-key writes, by route.
 */
export const MACHINE_OPERATION_KINDS: ReadonlySet<OperationKind> = new Set([
  OperationKind.DesktopSync,
  OperationKind.Telemetry,
  OperationKind.SettingsWrite,
  OperationKind.OrganizationWrite,
  OperationKind.LoopWrite,
  OperationKind.SessionMeshWrite,
]);

/** Operation kinds whose route writes, and therefore records a receipt. */
export const RECEIPTED_OPERATION_KINDS: ReadonlySet<OperationKind> = new Set([
  OperationKind.Create,
  OperationKind.CreateVersion,
  OperationKind.UpdateFields,
  OperationKind.Comment,
  OperationKind.LinkCreate,
  OperationKind.LinkDelete,
  OperationKind.Tag,
  OperationKind.Untag,
  OperationKind.Attach,
  OperationKind.Detach,
  OperationKind.Move,
  OperationKind.ProjectWrite,
  OperationKind.Delete,
  OperationKind.Rate,
  OperationKind.LiveDraftReset,
  ...MACHINE_OPERATION_KINDS,
]);

/**
 * Write tools whose route cannot record a receipt in the write's own
 * transaction. Empty: every write tool's route records its receipt on the
 * transaction that writes, so the two commit or roll back together. The one
 * receipt written apart is a no-op whose write rolled back (re-applying a tag
 * the artifact already has), which gets a transaction of its own.
 */
export const UNSUPPORTED_RECEIPT_TOOLS: readonly ClosedloopMcpToolName[] = [];

export function isClosedloopMcpToolName(
  toolName: string
): toolName is ClosedloopMcpToolName {
  return Object.hasOwn(CLOSEDLOOP_MCP_TOOL_SEMANTICS, toolName);
}

/** The semantics for a tool name, or `unsupported` for a name not in the table. */
export function operationSemanticsFor(toolName: string): OperationSemantics {
  return isClosedloopMcpToolName(toolName)
    ? CLOSEDLOOP_MCP_TOOL_SEMANTICS[toolName]
    : NO_TARGET;
}
