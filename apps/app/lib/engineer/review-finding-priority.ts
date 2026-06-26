/** Supported priority tags emitted by first-party AI review parsers. */
export const ReviewFindingPriority = {
  P0: "P0",
  P1: "P1",
  P2: "P2",
  P3: "P3",
} as const;
export type ReviewFindingPriority =
  (typeof ReviewFindingPriority)[keyof typeof ReviewFindingPriority];

/** Severity values shared by AI review parsing, posting, and Branch View UI. */
export const ReviewFindingSeverity = {
  Critical: "critical",
  Warning: "warning",
  Info: "info",
  Success: "success",
} as const;
export type ReviewFindingSeverity =
  (typeof ReviewFindingSeverity)[keyof typeof ReviewFindingSeverity];

/** Hidden Markdown/HTML metadata tag used to preserve finding identity in natural-voice comments. */
export const REVIEW_FINDING_METADATA_TAG = "closedloop-review-finding";

/**
 * Narrow an untrusted priority marker to the repo-supported P0-P3 contract.
 * Unsupported markers such as P4 intentionally return null instead of being
 * cast into the shared review-finding type.
 */
export function toReviewFindingPriority(
  value: string | null | undefined
): ReviewFindingPriority | null {
  const normalized = value?.toUpperCase();
  if (normalized === ReviewFindingPriority.P0) {
    return ReviewFindingPriority.P0;
  }
  if (normalized === ReviewFindingPriority.P1) {
    return ReviewFindingPriority.P1;
  }
  if (normalized === ReviewFindingPriority.P2) {
    return ReviewFindingPriority.P2;
  }
  if (normalized === ReviewFindingPriority.P3) {
    return ReviewFindingPriority.P3;
  }
  return null;
}

/**
 * Build a non-rendered metadata comment for humanized first-party review bodies.
 * GitHub/ReactMarkdown hide HTML comments from readers, while Branch View can
 * still recover priority and severity without treating arbitrary bot prose as a finding.
 */
export function buildReviewFindingMetadataComment(input: {
  priority?: ReviewFindingPriority;
  severity: ReviewFindingSeverity;
}): string {
  const priorityAttribute = input.priority ? ` priority=${input.priority}` : "";
  return `<!-- ${REVIEW_FINDING_METADATA_TAG}${priorityAttribute} severity=${input.severity} -->`;
}

/** Map the repo's AI-review priority tags to the severity labels shown in review UIs. */
export function reviewFindingPriorityToSeverity(
  priority: ReviewFindingPriority
): ReviewFindingSeverity {
  if (
    priority === ReviewFindingPriority.P0 ||
    priority === ReviewFindingPriority.P1
  ) {
    return ReviewFindingSeverity.Critical;
  }
  if (priority === ReviewFindingPriority.P2) {
    return ReviewFindingSeverity.Warning;
  }
  return ReviewFindingSeverity.Info;
}
