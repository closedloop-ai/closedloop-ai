import { createHash } from "node:crypto";
import { PromptType } from "@repo/database";
import { log } from "@repo/observability/log";
import type { PromptInfo, PromptsSnapshot } from "@/lib/prompt-types";

const AGENTS_SNAPSHOT_PATTERN = /^agents-snapshot\/.*\.md$/;
const FRONTMATTER_PATTERN =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

type SnapshotEntry = {
  name: string;
  data: Buffer;
};

/**
 * Compute a deterministic SHA-256 hex digest for prompt content.
 */
export function computePromptSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Parse agent/judge frontmatter from a markdown file in the agents-snapshot directory.
 * Returns a PromptInfo if the frontmatter is valid, null otherwise.
 */
export function parsePromptFrontmatter(
  fileContent: string,
  entryPath: string
): PromptInfo | null {
  const frontmatterMatch = FRONTMATTER_PATTERN.exec(fileContent);
  if (!frontmatterMatch) {
    return null;
  }

  const frontmatterBody = frontmatterMatch[1];
  const fields: Record<string, string> = {};
  const fieldRegex = /^([\w_]+):\s*(.+)$/gm;
  let match = fieldRegex.exec(frontmatterBody);
  while (match !== null) {
    fields[match[1]] = match[2].trim();
    match = fieldRegex.exec(frontmatterBody);
  }

  const name = fields.name;
  const model = fields.model;
  if (!(name && model)) {
    return null;
  }

  const description = fields.description ?? "";
  const toolsRaw = fields.tools;
  const tools = toolsRaw
    ? toolsRaw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const filePath = fields.file_path ?? entryPath;

  const promptType = entryPath.includes("agents-snapshot/judges/")
    ? PromptType.JUDGE
    : PromptType.AGENT;

  const afterFrontmatter = fileContent.slice(
    (frontmatterMatch.index ?? 0) + frontmatterMatch[0].length
  );
  const content = afterFrontmatter.trimStart();

  return {
    promptType,
    name,
    description,
    model,
    tools,
    filePath,
    content,
  };
}

/**
 * Parse prompts snapshot from markdown entries in the agents-snapshot tree.
 */
export function parsePromptsSnapshotFromMarkdownEntries(
  entries: SnapshotEntry[],
  logPrefix = "[prompt-snapshot-ingestion]"
): PromptsSnapshot | null {
  const prompts: PromptInfo[] = [];

  for (const entry of entries) {
    if (!AGENTS_SNAPSHOT_PATTERN.test(entry.name)) {
      continue;
    }

    const content = entry.data.toString("utf-8");
    const promptInfo = parsePromptFrontmatter(content, entry.name);
    if (!promptInfo) {
      log.warn(`${logPrefix} Failed to parse agent frontmatter`, {
        entryName: entry.name,
      });
      continue;
    }
    prompts.push(promptInfo);
  }

  if (prompts.length === 0) {
    return null;
  }

  return { prompts };
}
