import { buildSection } from "@repo/app/chat/lib/build-section";
import {
  isMcpAvailable,
  type McpAvailability,
} from "@repo/app/chat/lib/contexts/document-context";
import { MCP_INSTRUCTIONS } from "@repo/app/chat/lib/mcp-instructions";

export type BranchChatContextInput = {
  externalLinkId: string;
  prTitle: string;
  prHtmlUrl: string;
  repoFullName: string;
  headBranch: string;
  baseBranch: string;
  featureSlug?: string | null;
  featureTitle?: string | null;
  producedByPlanSlug?: string | null;
  producedByPlanTitle?: string | null;
  worktreePath?: string | null;
};

function featureSectionLines(branch: BranchChatContextInput): string[] {
  const body: string[] = [];
  if (branch.featureTitle) {
    body.push(`Title: ${branch.featureTitle}`);
  }
  if (branch.featureSlug) {
    body.push(`Slug: ${branch.featureSlug}`);
  }
  return buildSection("Linked Feature", body);
}

function planSectionLines(branch: BranchChatContextInput): string[] {
  const body: string[] = [];
  if (branch.producedByPlanTitle) {
    body.push(`Title: ${branch.producedByPlanTitle}`);
  }
  if (branch.producedByPlanSlug) {
    body.push(`Slug: ${branch.producedByPlanSlug}`);
  }
  return buildSection("Implementation Plan", body);
}

export function buildBranchChatContext(
  branch: BranchChatContextInput,
  mcpAvailability: McpAvailability
): string {
  const lines: string[] = [
    "You are assisting a human reviewing a GitHub pull request on Closedloop.",
    "Closedloop is a human-governed delivery platform: AI produces code, humans review and approve PRs before merge. This chat is a reading and discussion aid.",
    "",
    "Policy (non-negotiable):",
    '- READ-ONLY by default. Do NOT call any MCP tool whose name starts with "create-", "update-", or "delete-", do NOT modify, create, or delete files, do NOT run git commands that change repo state, and do NOT run shell commands with side effects, unless the human explicitly describes the exact change and asks you to make it. Explain proposed changes first and wait for confirmation before acting.',
    "- Read-only MCP tools are ON. Use them to ground answers about the linked plan, feature, or artifact graph.",
    '- If something is not available, say "I don\'t know" rather than guess.',
    "",
    ...filesystemPolicyLines(branch.worktreePath),
    "",
    "The human is viewing the PR diff, comments, and metadata in the in-app Branch View. When they select a specific PR comment it is attached to their next message as a context card.",
    "",
    `Pull Request: ${branch.prTitle}`,
    `URL: ${branch.prHtmlUrl}`,
    `Repository: ${branch.repoFullName}`,
    `Branch: ${branch.headBranch} -> ${branch.baseBranch}`,
    ...featureSectionLines(branch),
    ...planSectionLines(branch),
  ];

  const mcpOptimistic = isMcpAvailable(mcpAvailability);
  const hasLinkedArtifact = Boolean(
    branch.featureSlug || branch.producedByPlanSlug
  );
  if (mcpOptimistic && hasLinkedArtifact) {
    lines.push("", MCP_INSTRUCTIONS);
  }

  return lines.join("\n");
}

function filesystemPolicyLines(
  worktreePath: string | null | undefined
): string[] {
  if (worktreePath) {
    return [
      "Filesystem:",
      `- You are running inside the PR's worktree at ${worktreePath}.`,
      "- You MAY read files using relative paths from that directory.",
      "- You may NOT modify, create, or delete files, run git commands, or run shell commands that change repo state without the human's explicit approval for each change.",
    ];
  }
  return [
    "Filesystem:",
    "- You do NOT have filesystem access in this session. Discuss the PR using only the context below and MCP tools.",
  ];
}
