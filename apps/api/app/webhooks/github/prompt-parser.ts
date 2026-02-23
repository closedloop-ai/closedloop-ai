import { computeGitBlobSha } from "@repo/github/git-blob-sha";
import { log } from "@repo/observability/log";
import type { PromptInfo } from "./prompt-types";
import { PromptType } from "./prompt-types";

/** Folder that contains all agent prompt files. */
const AGENTS_SNAPSHOT_DIR = "agents-snapshot/";

/** Subfolder within agents-snapshot that contains judge prompt files. */
const JUDGES_SUBDIR = "agents-snapshot/judges/";

/** Regex to strip runs/<id>/ prefix from entry names */
const RUNS_PREFIX_REGEX = /^runs\/[^/]+\//;

/**
 * Strip any leading `runs/<id>/` prefix from a zip entry name so that paths
 * can be matched uniformly regardless of whether the artifact was zipped from
 * the repo root (bare `agents-snapshot/…`) or from the runs/ directory
 * (`runs/20240223-123456/agents-snapshot/…`).
 */
export function normalizeEntryName(entryName: string): string {
  return entryName.replace(RUNS_PREFIX_REGEX, "");
}

/**
 * Parse YAML frontmatter from a markdown file.
 *
 * Extracts the block delimited by leading `---` lines and returns a flat
 * key→value map. Multi-value fields (e.g. `tools: Read, Write`) are returned
 * as-is strings — callers split them as needed.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  if (!content.startsWith("---")) {
    return result;
  }

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return result;
  }

  const frontmatter = content.slice(3, endIndex).trim();

  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Determine the PromptType from the entry's path within the zip.
 * Files directly under agents-snapshot/ are AGENT; files under
 * agents-snapshot/judges/ are JUDGE.
 */
function resolvePromptType(entryName: string): PromptType {
  if (entryName.startsWith(JUDGES_SUBDIR)) {
    return PromptType.JUDGE;
  }
  return PromptType.AGENT;
}

/**
 * Parse a single prompt file (Buffer + zip entry name) into a PromptInfo.
 * Returns null when the file cannot be parsed.
 *
 * Exported for direct use in unit tests.
 */
export function parsePromptFile(
  data: Buffer,
  entryName: string
): PromptInfo | null {
  try {
    const content = data.toString("utf-8");
    const frontmatter = parseFrontmatter(content);

    const name = frontmatter.name ?? "";
    const description = frontmatter.description ?? "";
    const model = frontmatter.model ?? "";
    const toolsRaw = frontmatter.tools ?? "";
    const tools = toolsRaw
      ? toolsRaw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    const normalized = normalizeEntryName(entryName);
    const promptType = resolvePromptType(normalized);
    const file_path = normalized;
    const sha = computeGitBlobSha(data);

    log.info(
      `Found prompt file: ${entryName} (type=${promptType}, name="${name}", sha=${sha})`
    );

    return {
      promptType,
      name,
      description,
      model,
      tools,
      file_path,
      content,
      sha,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(`Failed to parse prompt file ${entryName}: ${message}`);
    return null;
  }
}

export function isPromptFileEntry(entryName: string): boolean {
  const normalized = normalizeEntryName(entryName);
  return (
    normalized.startsWith(AGENTS_SNAPSHOT_DIR) &&
    normalized.endsWith(".md") &&
    !normalized.endsWith("/")
  );
}
