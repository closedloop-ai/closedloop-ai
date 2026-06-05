import type { ReviewFinding } from "@/lib/engineer/codex-review-parser";

export function stripWorktreePath(filePath: string): string {
  // Strip worktree prefixes like /Users/.../Source/repo-name-pr-NNN/ → relative path
  const match = /\/Source\/[^/]+-pr-\d+\/(.+)/.exec(filePath);
  if (match) {
    return match[1];
  }
  // Also try standard /Source/repo/ prefix
  const sourceMatch = /\/Source\/[^/]+\/(.+)/.exec(filePath);
  if (sourceMatch) {
    return sourceMatch[1];
  }
  return filePath;
}

/**
 * Resolve a short/relative file path against the PR's changed file list.
 * Returns the full repo-relative path if found, "ambiguous" if multiple matches, or null if not in the PR.
 */
export function resolveFullPath(
  shortName: string,
  prFiles: string[]
): string | "ambiguous" | null {
  if (prFiles.includes(shortName)) {
    return shortName;
  }
  const matches = prFiles.filter(
    (f) => f === shortName || f.endsWith(`/${shortName}`)
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    return "ambiguous";
  }
  return null;
}

export function resolveFindingPath(
  finding: ReviewFinding,
  commitSha: string | undefined,
  prFiles: string[] | undefined
): string | undefined {
  if (!(finding.file && commitSha)) {
    return undefined;
  }
  const shortPath = stripWorktreePath(finding.file);
  if (!prFiles) {
    return undefined;
  }
  const resolved = resolveFullPath(shortPath, prFiles);
  return resolved && resolved !== "ambiguous" ? resolved : undefined;
}

export function buildCommentBody(
  finding: ReviewFinding,
  filePath: string | undefined
): string {
  const [title, ...descParts] = finding.message.split("\n");
  const description = descParts.join("\n").trim();
  const priorityLabel = finding.priority || "P3";

  const bodyParts = [`**[${priorityLabel}]** ${title}`];

  // Only include file:line in body when not posting as inline comment
  // (GitHub already shows the file + line in the diff gutter for inline comments)
  if (!filePath && finding.file) {
    const displayPath = stripWorktreePath(finding.file);
    const location = finding.line
      ? `${displayPath}:${finding.line}`
      : displayPath;
    bodyParts.push(`**${location}**`);
  }
  if (description) {
    bodyParts.push(description);
  }
  if (finding.suggestion) {
    bodyParts.push("", `> **Suggestion:** ${finding.suggestion}`);
  }

  return bodyParts.join("\n\n");
}
