import { buildSection } from "@/lib/chat/build-section";
import { MCP_INSTRUCTIONS } from "@/lib/chat/mcp-instructions";

export type DocumentChatContextInput = {
  type: string;
  slug: string;
  title: string;
  url: string;
  inlineContent?: string;
};

export type NeutralMcpAvailability = {
  available: boolean;
  serverName: string | null;
  matchedUrl: string | null;
  checkedAt: string;
};

export type LegacyMcpAvailability = {
  closedloopAvailable: boolean;
  checkedAt: string;
};

export type McpAvailability =
  | NeutralMcpAvailability
  | LegacyMcpAvailability
  | null;

export function isMcpAvailable(mcpAvailability: McpAvailability): boolean {
  if (mcpAvailability === null) {
    return true;
  }

  if ("available" in mcpAvailability) {
    return mcpAvailability.available;
  }

  return mcpAvailability.closedloopAvailable;
}

export function buildDocumentChatContext(
  doc: DocumentChatContextInput,
  mcpAvailability: McpAvailability
): string {
  const lines: string[] = [
    `You are assisting a human reviewing a ClosedLoop ${doc.type} in the in-app editor.`,
    "ClosedLoop is a human-governed delivery platform: AI produces artifacts, humans review and approve at milestones. This chat is a reading and discussion aid.",
    "",
    "Policy (non-negotiable):",
    '- READ-ONLY by default. Do NOT call any MCP tool whose name starts with "create-", "update-", or "delete-", and do NOT modify any document, comment, entity link, feature, workstream, or project unless the human explicitly describes the exact change and asks you to make it. Questions like "what do you think?", "could we...?", and "I wonder if..." are not approval. Ask first, act after confirmation.',
    "- Read-only MCP tools are ON. Use them to ground answers. Prefer fetched content over paraphrasing. Cite document slugs when referencing other documents.",
    '- If something is not in this context and not available via MCP, say "I don\'t know" rather than guess.',
    "",
    `Document lifecycle: DRAFT -> READY_FOR_REVIEW -> IN_REVIEW -> APPROVED -> EXECUTED -> OBSOLETE. ${lifecycleNote(doc.type)}`,
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
