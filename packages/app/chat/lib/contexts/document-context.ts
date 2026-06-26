import {
  isMcpProviderAvailable,
  type McpProviderAvailability,
} from "@repo/api/src/types/compute-target";
import { buildSection } from "@repo/app/chat/lib/build-section";
import { MCP_INSTRUCTIONS } from "@repo/app/chat/lib/mcp-instructions";

export type DocumentChatContextInput = {
  type: string;
  slug: string;
  title: string;
  url: string;
  inlineContent?: string;
};

/**
 * Chat-side MCP availability: the shared provider-availability union from
 * @repo/api plus `null` for the "not yet checked" case, which chat treats
 * optimistically as available. The neutral/legacy provider shapes are owned by
 * @repo/api (`McpProviderAvailability`) — do not redefine them here.
 */
export type McpAvailability = McpProviderAvailability | null;

export function isMcpAvailable(mcpAvailability: McpAvailability): boolean {
  if (mcpAvailability === null) {
    return true;
  }
  return isMcpProviderAvailable(mcpAvailability);
}

export function buildDocumentChatContext(
  doc: DocumentChatContextInput,
  mcpAvailability: McpAvailability
): string {
  const lines: string[] = [
    `You are assisting a human reviewing a Closedloop ${doc.type} in the in-app editor.`,
    "Closedloop is a human-governed delivery platform: AI produces artifacts, humans review and approve at milestones. This chat is a reading and discussion aid.",
    "",
    "Policy (non-negotiable):",
    '- READ-ONLY by default. Do NOT call any MCP tool whose name starts with "create-", "update-", or "delete-", and do NOT modify any document, comment, entity link, feature, workstream, or project unless the human explicitly describes the exact change and asks you to make it. Questions like "what do you think?", "could we...?", and "I wonder if..." are not approval. Ask first, act after confirmation.',
    "- Read-only MCP tools are ON. Use them to ground answers. Prefer fetched content over paraphrasing. Cite document slugs when referencing other documents.",
    '- If something is not in this context and not available via MCP, say "I don\'t know" rather than guess.',
    "",
    `Document lifecycle: DRAFT -> IN_PROGRESS -> IN_REVIEW -> APPROVED -> EXECUTED -> DONE -> OBSOLETE. ${lifecycleNote(doc.type)}`,
    "",
    "You are looking at:",
    `- Document type: ${doc.type}`,
    `- Title: ${doc.title}`,
    `- Slug: ${doc.slug}`,
    `- URL: ${doc.url}`,
  ];

  const mcpOptimistic = isMcpAvailable(mcpAvailability);

  if (mcpOptimistic) {
    lines.push("", MCP_INSTRUCTIONS);
    return lines.join("\n");
  }

  if (doc.inlineContent) {
    lines.push(...buildSection("Document Content", ["", doc.inlineContent]));
    return lines.join("\n");
  }

  lines.push(
    "",
    "(Full document content could not be loaded -- MCP server unavailable)"
  );
  return lines.join("\n");
}

function lifecycleNote(documentType: string): string {
  if (documentType === "plan") {
    return "Plans unlock the Execute action (which creates a PR) only after APPROVED.";
  }
  if (documentType === "prd") {
    return "PRDs can be Decomposed into features and produce downstream Implementation Plans.";
  }
  return "";
}
