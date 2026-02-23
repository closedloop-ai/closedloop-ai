import type { PromptInfo, PromptsSnapshot } from "@repo/api/src/types/prompt";
import { PromptType } from "@repo/api/src/types/prompt";
import { log } from "@repo/observability/log";
import { computeGitBlobSha } from "@/lib/git-utils";
import { CONTENT_KEYS } from "./keys";
import type { ZipContentExtractor } from "./types";
import { ExtractorOutputType } from "./types";

/** Folder that contains all agent prompt files. */
const AGENTS_SNAPSHOT_DIR = "agents-snapshot/";

/** Subfolder within agents-snapshot that contains judge prompt files. */
const JUDGES_SUBDIR = "agents-snapshot/judges/";

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
 * Returns null when the file cannot be parsed or has no recognisable frontmatter.
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

    const promptType = resolvePromptType(entryName);

    // Compute file_path relative to the workdir by stripping any leading run
    // directory prefix. Within the zip the path is already relative to the
    // artifact root, so we use it as-is (e.g. "agents-snapshot/my-agent.md").
    const file_path = entryName;

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

/**
 * Accumulating extractor for agent and judge prompt files stored under the
 * `agents-snapshot/` folder inside Symphony run zip artifacts.
 *
 * Because a zip may contain many prompt files, this extractor uses the
 * `mergeWith` hook so that every matching entry is parsed and merged into a
 * single PromptsSnapshot rather than replacing the previous result.
 */
export const promptsExtractor: ZipContentExtractor<
  PromptsSnapshot,
  typeof ExtractorOutputType.PromptsSnapshot
> = {
  key: CONTENT_KEYS.promptsSnapshot,
  outputType: ExtractorOutputType.PromptsSnapshot,
  priority: 0,

  matches(entryName: string): boolean {
    return (
      entryName.startsWith(AGENTS_SNAPSHOT_DIR) &&
      entryName.endsWith(".md") &&
      !entryName.endsWith("/")
    );
  },

  parse(data: Buffer, entryName: string): PromptsSnapshot | null {
    const prompt = parsePromptFile(data, entryName);
    if (prompt === null) {
      return null;
    }
    return { prompts: [prompt] };
  },

  mergeWith(existing: PromptsSnapshot, next: PromptsSnapshot): PromptsSnapshot {
    return { prompts: [...existing.prompts, ...next.prompts] };
  },
};
