import {
  buildReviewFindingMetadataComment,
  type ReviewFindingPriority,
  type ReviewFindingSeverity,
} from "@/lib/engineer/review-finding-priority";

/**
 * Test-only fixture builder for first-party review comment bodies.
 *
 * Mirrors the comment-body shape that the AI-review posting pipeline produces so
 * Branch View parsing/rendering tests can assert against realistic inputs. The
 * production posting helper that previously lived in
 * `lib/engineer/review-path-utils.ts` was removed as dead code; this fixture keeps
 * the equivalent string formatting local to the tests that need it.
 */
type ReviewCommentFinding = {
  message: string;
  severity: ReviewFindingSeverity;
  priority?: ReviewFindingPriority;
  humanizedBody?: string;
  suggestion?: string;
  file?: string;
  line?: number;
};

export function buildCommentBody(
  finding: ReviewCommentFinding,
  filePath: string | undefined
): string {
  const humanized = finding.humanizedBody?.trim();
  if (humanized) {
    const metadata = buildReviewFindingMetadataComment({
      priority: finding.priority,
      severity: finding.severity,
    });
    if (!filePath && finding.file) {
      const location = finding.line
        ? `${finding.file}:${finding.line}`
        : finding.file;
      return `${metadata}\n\n**${location}**\n\n${humanized}`;
    }
    return `${metadata}\n\n${humanized}`;
  }

  const [title, ...descParts] = finding.message.split("\n");
  const description = descParts.join("\n").trim();
  const priorityLabel = finding.priority || "P3";

  const bodyParts = [`**[${priorityLabel}]** ${title}`];

  if (!filePath && finding.file) {
    const location = finding.line
      ? `${finding.file}:${finding.line}`
      : finding.file;
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
