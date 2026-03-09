import {
  extractVerdictTag,
  parseClaudeReviewOutput,
  type ReviewFinding,
  type ReviewVerdict,
} from "@/lib/engineer/codex-review-parser";

export type AnnotatedFinding = ReviewFinding & { originalIndex: number };

const FINDINGS_HEADER = /^(?:Full )?[Rr]eview comments?:\s*$/m;

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
  // Split on blank lines then filter out empty chunks
  const chunks = text.split(/\n{2,}/).filter((c) => c.trim());
  const findings: ReviewFinding[] = [];

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

    findings.push({
      severity,
      priority,
      file: fileMatch?.[1] ?? fileRef,
      line: fileMatch?.[2] ? Number.parseInt(fileMatch[2], 10) : undefined,
      message: description ? `${title}\n${description}` : title,
    });
  }

  return findings;
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
