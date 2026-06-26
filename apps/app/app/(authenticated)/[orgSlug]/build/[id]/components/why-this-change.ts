/**
 * "Why this change" rationale derivation.
 *
 * ClosedLoop links every branch/PR to the Implementation Plan that produced it,
 * so the reason a file changed can be sourced from recorded intent instead of
 * being guessed by an LLM from the diff. The plan body is markdown; for a
 * focused diff file we surface the part of the plan that references that file
 * (the relevant task), falling back to the plan's opening intent when no
 * section mentions the file directly.
 */

export const WhyThisChangeSource = {
  /** A section of the plan that explicitly mentions the focused file. */
  FileMatch: "file-match",
  /** The plan's overall intent, shown when no section references the file. */
  PlanSummary: "plan-summary",
} as const;
export type WhyThisChangeSource =
  (typeof WhyThisChangeSource)[keyof typeof WhyThisChangeSource];

export type WhyThisChangeRationale = {
  source: WhyThisChangeSource;
  excerpt: string;
};

const MAX_EXCERPT_CHARS = 600;
const MAX_BLOCKS = 3;
const BLOCK_SPLIT_PATTERN = /\n\s*\n/;
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/** Returns the final path segment (e.g. `branch-diff-view.tsx`). */
export function fileBasename(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);
  return segments.at(-1) ?? filePath;
}

function escapeRegExp(value: string): string {
  return value.replace(REGEX_METACHARACTERS, "\\$&");
}

/**
 * True when `block` mentions the file's basename on its own (e.g. "update
 * branch-diff-view.tsx") rather than only as the tail of some *other* file's
 * full path. Without this guard, ubiquitous Next.js filenames (page.tsx,
 * route.ts, layout.tsx) would mis-attribute an unrelated file's plan section to
 * the focused file. Blocks containing the focused file's *full* path are
 * matched earlier and never reach this fallback, so any qualified path here
 * necessarily points at a different file.
 */
function mentionsBareBasename(block: string, basename: string): boolean {
  const haystack = block.toLowerCase();
  const needle = basename.toLowerCase();
  if (!haystack.includes(needle)) {
    return false;
  }
  const qualifiedPath = new RegExp(`\\S*/\\S*${escapeRegExp(needle)}`, "g");
  return haystack.replace(qualifiedPath, " ").includes(needle);
}

function splitIntoBlocks(content: string): string[] {
  return content
    .split(BLOCK_SPLIT_PATTERN)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function truncate(text: string): string {
  if (text.length <= MAX_EXCERPT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_EXCERPT_CHARS).trimEnd()}…`;
}

function joinBlocks(blocks: string[]): string {
  return truncate(blocks.slice(0, MAX_BLOCKS).join("\n\n"));
}

/**
 * Derives the change rationale for `filePath` from a producing plan's markdown
 * `planContent`. Returns `null` when there is no plan content to source from
 * (the caller then shows the no-plan fallback). Prefers blocks that mention the
 * full path, then blocks that mention the file's basename, then the plan's
 * opening intent.
 */
export function deriveChangeRationale(
  planContent: string | null | undefined,
  filePath: string
): WhyThisChangeRationale | null {
  const content = planContent?.trim();
  if (!content) {
    return null;
  }
  const blocks = splitIntoBlocks(content);
  if (blocks.length === 0) {
    return null;
  }

  const normalizedPath = filePath.toLowerCase();
  const basename = fileBasename(filePath);

  const fullPathBlocks = blocks.filter((block) =>
    block.toLowerCase().includes(normalizedPath)
  );
  const matchedBlocks =
    fullPathBlocks.length > 0
      ? fullPathBlocks
      : blocks.filter((block) => mentionsBareBasename(block, basename));

  if (matchedBlocks.length > 0) {
    return {
      source: WhyThisChangeSource.FileMatch,
      excerpt: joinBlocks(matchedBlocks),
    };
  }

  return {
    source: WhyThisChangeSource.PlanSummary,
    excerpt: joinBlocks(blocks),
  };
}
