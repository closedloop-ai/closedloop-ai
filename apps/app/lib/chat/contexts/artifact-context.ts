import { buildSection } from "@/lib/chat/build-section";
import { MCP_INSTRUCTIONS } from "@/lib/chat/mcp-instructions";

export type ArtifactChatContextInput = {
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

export function buildArtifactChatContext(
  artifact: ArtifactChatContextInput,
  mcpAvailability: McpAvailability
): string {
  const lines: string[] = [
    `You are assisting a human reviewing a ClosedLoop ${artifact.type} in the in-app editor.`,
    "ClosedLoop is a human-governed delivery platform: AI produces artifacts, humans review and approve at milestones. This chat is a reading and discussion aid.",
    "",
    "Policy (non-negotiable):",
    '- READ-ONLY by default. Do NOT call any MCP tool whose name starts with "create-", "update-", or "delete-", and do NOT modify any artifact, comment, entity link, feature, workstream, or project unless the human explicitly describes the exact change and asks you to make it. Questions like "what do you think?", "could we...?", and "I wonder if..." are not approval. Ask first, act after confirmation.',
    "- Read-only MCP tools are ON. Use them to ground answers. Prefer fetched content over paraphrasing. Cite artifact slugs when referencing other artifacts.",
    '- If something is not in this context and not available via MCP, say "I don\'t know" rather than guess.',
    "",
    `Artifact lifecycle: DRAFT -> READY_FOR_REVIEW -> IN_REVIEW -> APPROVED -> EXECUTED -> OBSOLETE. ${lifecycleNote(artifact.type)}`,
    "",
    "You are looking at:",
    `- Artifact type: ${artifact.type}`,
    `- Title: ${artifact.title}`,
    `- Slug: ${artifact.slug}`,
    `- URL: ${artifact.url}`,
  ];

  const mcpOptimistic = isMcpAvailable(mcpAvailability);

  if (mcpOptimistic) {
    lines.push("", MCP_INSTRUCTIONS);
    return lines.join("\n");
  }

  if (artifact.inlineContent) {
    lines.push(
      ...buildSection("Artifact Content", ["", artifact.inlineContent])
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    "(Full artifact content could not be loaded -- MCP server unavailable)"
  );
  return lines.join("\n");
}

function lifecycleNote(artifactType: string): string {
  if (artifactType === "plan") {
    return "Plans unlock the Execute action (which creates a PR) only after APPROVED.";
  }
  if (artifactType === "prd") {
    return "PRDs can be Decomposed into features and produce downstream Implementation Plans.";
  }
  return "";
}
