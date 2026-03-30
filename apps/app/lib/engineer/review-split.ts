import {
  extractVerdictTag,
  parseClaudeReviewOutput,
  type ReviewFinding,
  type ReviewVerdict,
} from "@/lib/engineer/codex-review-parser";

export type AnnotatedFinding = ReviewFinding & { originalIndex: number };

const FINDINGS_HEADER = /(?:Full\s+)?[Rr]eview comments?:\s*/;
const PRIORITY_CHUNK_START_RE = /(^|\n)\s*(?:[-*]\s*)?\[[Pp]\d\]\s+/g;

export function splitReviewOutput(
  output: string,
  provider?: "claude" | "codex"
): { processLog: string; findings: ReviewFinding[]; verdict?: ReviewVerdict } {
  const verdict = extractVerdictTag(output);

  if (provider === "claude") {
    return { ...parseClaudeReviewOutput(output), verdict };
  }

  const match = FINDINGS_HEADER.exec(output);
  if (!match) {
    return { processLog: output, findings: [], verdict };
  }

  const processLog = output.slice(0, match.index).trim();
  const findingsText = output.slice(match.index + match[0].length).trim();
  return {
    processLog,
    findings: parseFullReviewComments(findingsText),
    verdict,
  };
}

/**
 * Parse the "Full review comments:" block.
 * Format: `[P2] Title — path/to/file:lines\nDescription...`
 * Each finding is separated by a blank line.
 */
function parseFullReviewComments(text: string): ReviewFinding[] {
  const chunks = splitPriorityChunks(text);
  const findings: ReviewFinding[] = [];
  const dedupe = new Set<string>();

  for (const chunk of chunks) {
    const headerMatch =
      /^(?:[-*]\s+)?\[([Pp]\d)\]\s+(.+?)(?:\s+—\s+(.+))?$/.exec(
        chunk.split("\n")[0]
      );
    if (!headerMatch) {
      continue;
    }

    const priority = headerMatch[1].toUpperCase() as ReviewFinding["priority"];
    const title = headerMatch[2].trim();
    const fileRef = headerMatch[3]?.trim();

    // Everything after the first line is the description
    const descLines = chunk.split("\n").slice(1);
    const description = descLines.join("\n").trim();

    const severity = priorityToSeverity(priority ?? "P3");
    const fileMatch = fileRef ? /^(.+?):(\d+)/.exec(fileRef) : null;
    const message = description ? `${title}\n${description}` : title;
    const dedupeKey = [
      priority,
      fileMatch?.[1] ?? fileRef ?? "",
      fileMatch?.[2] ?? "",
      message,
    ].join("|");
    if (dedupe.has(dedupeKey)) {
      continue;
    }
    dedupe.add(dedupeKey);

    findings.push({
      severity,
      priority,
      file: fileMatch?.[1] ?? fileRef,
      line: fileMatch?.[2] ? Number.parseInt(fileMatch[2], 10) : undefined,
      message,
    });
  }

  return findings;
}

function splitPriorityChunks(text: string): string[] {
  const starts: number[] = [];
  PRIORITY_CHUNK_START_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  for (;;) {
    match = PRIORITY_CHUNK_START_RE.exec(text);
    if (!match) {
      break;
    }
    // Skip the leading delimiter captured by group 1 (start/newline).
    starts.push(match.index + match[1].length);
  }
  if (starts.length === 0) {
    return text.split(/\n{2,}/).filter((c) => c.trim());
  }
  const chunks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = starts[i + 1] ?? text.length;
    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

function priorityToSeverity(priority: string): ReviewFinding["severity"] {
  if (priority === "P0" || priority === "P1") {
    return "critical";
  }
  if (priority === "P2") {
    return "warning";
  }
  return "info";
}

export function formatReviewSummary(findingCount: number): string {
  if (findingCount === 0) {
    return "No issues found — LGTM!";
  }
  const plural = findingCount === 1 ? "" : "s";
  return `Found **${findingCount}** issue${plural} in the code review.`;
}
