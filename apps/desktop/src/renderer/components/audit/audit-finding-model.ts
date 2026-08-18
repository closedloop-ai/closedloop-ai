/**
 * @file audit-finding-model.ts
 * @description FEA-3848 (PRD-556 M2) — the renderer-side projection of a crewd
 * audit {@link Finding} into the triage-list view model.
 *
 * The M1 audit contract (`@repo/crewd/passes/findings`) emits a deliberately
 * minimal finding — `{ title, description, signature? }`. The reviewer is asked
 * to embed the concrete evidence (a `path:line` for the doc and for the code)
 * and a proposed fix INSIDE the free-text `description`, and — for characters
 * that classify — an optional severity keyword in the title/description. This
 * module derives, purely and without mutating the source finding, the three
 * projected dimensions the triage UI groups and renders by:
 *
 *  - **severity** — a coarse bucket parsed from a `[SEVERITY]` / `severity:`
 *    marker or a leading keyword, falling back to `unclassified` so a finding is
 *    never silently dropped from a group.
 *  - **location** — the first `path:line` (or bare `path`) reference in the
 *    finding text, surfaced as the row's `path:line` affordance.
 *
 * It is a pure, dependency-free module (no React, no `window`) so the grouping /
 * parsing is unit-testable in the node slice and reusable by both the list and
 * the detail panel.
 */
import type { Finding } from "@repo/crewd/passes/findings";

/** Coarse triage severity buckets, ordered most-severe first for display. */
export const AuditSeverity = {
  Blocking: "blocking",
  High: "high",
  Medium: "medium",
  Low: "low",
  Unclassified: "unclassified",
} as const;
export type AuditSeverity = (typeof AuditSeverity)[keyof typeof AuditSeverity];

/** Display order for the severity groups (most severe first). */
export const AUDIT_SEVERITY_ORDER: readonly AuditSeverity[] = [
  AuditSeverity.Blocking,
  AuditSeverity.High,
  AuditSeverity.Medium,
  AuditSeverity.Low,
  AuditSeverity.Unclassified,
];

/** Human label for each severity bucket (group headers, badges, a11y names). */
export const AUDIT_SEVERITY_LABEL: Record<AuditSeverity, string> = {
  [AuditSeverity.Blocking]: "Blocking",
  [AuditSeverity.High]: "High",
  [AuditSeverity.Medium]: "Medium",
  [AuditSeverity.Low]: "Low",
  [AuditSeverity.Unclassified]: "Unclassified",
};

/** The triage view model for one finding — the source plus derived dimensions. */
export type AuditFindingView = {
  /** Stable key for React lists (signature preferred, else derived from title). */
  id: string;
  severity: AuditSeverity;
  /**
   * The title with a leading `[SEVERITY]` marker stripped — the severity is
   * already shown as a Badge, so the title should not repeat it. Falls back to
   * the raw title when there is no leading marker.
   */
  displayTitle: string;
  /** First `path:line` (or bare `path`) reference found in the text, if any. */
  location: string | null;
  finding: Finding;
};

/** One severity group: the bucket plus its findings (source order preserved). */
export type AuditFindingGroup = {
  severity: AuditSeverity;
  findings: AuditFindingView[];
};

// A leading/marker severity token: `[HIGH]`, `severity: high`, `HIGH -`, etc.
// Anchored to the marker forms only so a body that merely mentions the word
// "critical" in prose does not reclassify a finding.
const SEVERITY_MARKER =
  /(?:^|\n)\s*(?:\[\s*(blocking|critical|high|medium|low|minor)\s*\]|severity\s*[:=]\s*(blocking|critical|high|medium|low|minor))/i;

// A `path:line` (or `path:line:col`) reference: a slashed or dotted path token
// followed by `:<digits>`. Kept intentionally conservative so it matches the
// `docPath:line` / `codePath:line` citations Docs Darwin is instructed to emit.
const PATH_LINE = /([\w./-]+\.[\w]+):(\d+)(?::\d+)?/;

// A leading `[SEVERITY]` marker at the very start of the title — stripped for
// display (the severity is rendered as a Badge). Only the bracketed leading
// form is removed so a title's own words are never truncated.
const LEADING_SEVERITY_MARKER =
  /^\s*\[\s*(?:blocking|critical|high|medium|low|minor)\s*\]\s*/i;

function normalizeSeverityKeyword(keyword: string): AuditSeverity {
  const lower = keyword.toLowerCase();
  if (lower === "blocking" || lower === "critical") {
    return AuditSeverity.Blocking;
  }
  if (lower === "high") {
    return AuditSeverity.High;
  }
  if (lower === "medium") {
    return AuditSeverity.Medium;
  }
  if (lower === "low" || lower === "minor") {
    return AuditSeverity.Low;
  }
  return AuditSeverity.Unclassified;
}

/**
 * Derive the coarse severity bucket for a finding from an explicit marker in its
 * title or description. Absent a marker, the finding is `unclassified` (it is
 * still shown — grouping never drops a finding). Never throws.
 */
export function deriveSeverity(finding: Finding): AuditSeverity {
  for (const text of [finding.title, finding.description]) {
    const match = text.match(SEVERITY_MARKER);
    const keyword = match?.[1] ?? match?.[2];
    if (keyword) {
      return normalizeSeverityKeyword(keyword);
    }
  }
  return AuditSeverity.Unclassified;
}

/**
 * Extract the first `path:line` reference from a finding's text (title first,
 * then description), or `null` when the finding cites no concrete location.
 */
export function deriveLocation(finding: Finding): string | null {
  for (const text of [finding.title, finding.description]) {
    const match = text.match(PATH_LINE);
    if (match) {
      return `${match[1]}:${match[2]}`;
    }
  }
  return null;
}

// Everything that is not a lowercase alphanumeric — collapsed for a fallback id.
const NON_ALNUM = /[^a-z0-9]+/g;

/** A stable list key: the signature when present, else a slug of the title. */
function findingId(finding: Finding, index: number): string {
  const signature = finding.signature?.trim();
  if (signature) {
    return signature;
  }
  const slug = finding.title.toLowerCase().replace(NON_ALNUM, "-");
  return `${slug}-${index}`;
}

/** The finding title with a leading `[SEVERITY]` marker stripped for display. */
export function deriveDisplayTitle(finding: Finding): string {
  const stripped = finding.title.replace(LEADING_SEVERITY_MARKER, "").trim();
  return stripped || finding.title;
}

/** Project one finding into its triage view model (severity + location + id). */
export function toFindingView(
  finding: Finding,
  index: number
): AuditFindingView {
  return {
    id: findingId(finding, index),
    severity: deriveSeverity(finding),
    displayTitle: deriveDisplayTitle(finding),
    location: deriveLocation(finding),
    finding,
  };
}

/**
 * Group findings by derived severity in display order, omitting empty buckets.
 * Findings keep their source order within a group so the reviewer's emission
 * order is preserved.
 */
export function groupFindingsBySeverity(
  findings: readonly Finding[]
): AuditFindingGroup[] {
  const views = findings.map((finding, index) => toFindingView(finding, index));
  const groups: AuditFindingGroup[] = [];
  for (const severity of AUDIT_SEVERITY_ORDER) {
    const bucket = views.filter((view) => view.severity === severity);
    if (bucket.length > 0) {
      groups.push({ severity, findings: bucket });
    }
  }
  return groups;
}
