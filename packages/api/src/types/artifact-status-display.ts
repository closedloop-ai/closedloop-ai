/**
 * @file artifact-status-display.ts
 * @description The user-facing COPY for the normalized artifact-status
 * vocabulary (PRD-714 / ISS-9432): one label per displayed root, one per
 * detail key, and the sentence a render shows beside `unknown`. Split from
 * `artifact-status-mapping.ts` the way `session-status-display.ts` is split
 * from `session-status.ts`: this module imports only `artifact-status`, so a
 * `"use client"` surface that wants a label does not pull zod in through the
 * vocabulary modules.
 *
 * Not the same map as `ARTIFACT_STATUS_LABELS` in
 * `packages/app/projects/lib/project-constants.ts`. That one is keyed by the
 * RAW `DocumentStatus | IssueStatus` union (the `ArtifactStatus` type in
 * `./document.ts`) and stays where it is (ISS-9560). These maps are keyed by
 * the normalized root and detail vocabularies and nothing else.
 *
 * It also owns the UNKNOWN case for those RAW vocabularies (ISS-9560) — the
 * word, the sentence, the accessible name, and the label-map lookup the
 * surfaces resolve through. That copy is one piece with the `unknown` root's
 * label above, so it belongs beside it rather than in a feature slice:
 * `packages/app/AGENTS.md` -> Dependency Direction forbids `shared/*` importing
 * a feature slice, and `shared/components/status-badge.tsx` is one of its
 * readers. `apps/app/lib/og-metadata.ts` is another, from a SERVER module with
 * no React at all — which is why the lookup helpers here are pure and the flag
 * read lives in `@repo/app/shared/hooks/use-artifact-status-display`.
 */

import type {
  ArtifactStatusDetail,
  DisplayedArtifactStatus,
} from "./artifact-status.js";
import {
  ARTIFACT_STATUS_DETAIL,
  DISPLAYED_ARTIFACT_STATUS,
} from "./artifact-status.ts";

export const ARTIFACT_STATUS_DISPLAY_LABELS: Readonly<
  Record<DisplayedArtifactStatus, string>
> = Object.freeze({
  [DISPLAYED_ARTIFACT_STATUS.Todo]: "Todo",
  [DISPLAYED_ARTIFACT_STATUS.InProgress]: "In progress",
  [DISPLAYED_ARTIFACT_STATUS.InReview]: "In review",
  [DISPLAYED_ARTIFACT_STATUS.Done]: "Done",
  [DISPLAYED_ARTIFACT_STATUS.Canceled]: "Canceled",
  [DISPLAYED_ARTIFACT_STATUS.Unknown]: "Unknown",
});

export const ARTIFACT_STATUS_DETAIL_LABELS: Readonly<
  Record<ArtifactStatusDetail, string>
> = Object.freeze({
  [ARTIFACT_STATUS_DETAIL.DocumentDrafting]: "Drafting",
  [ARTIFACT_STATUS_DETAIL.DocumentChangesRequested]: "Changes requested",
  [ARTIFACT_STATUS_DETAIL.DocumentApproved]: "Approved",
  [ARTIFACT_STATUS_DETAIL.DocumentExecuted]: "Executed",
  [ARTIFACT_STATUS_DETAIL.DocumentSuperseded]: "Superseded",
  [ARTIFACT_STATUS_DETAIL.IssueTriage]: "Triage",
  [ARTIFACT_STATUS_DETAIL.IssueBacklog]: "Backlog",
  [ARTIFACT_STATUS_DETAIL.IssueBlocked]: "Blocked",
  [ARTIFACT_STATUS_DETAIL.BranchDraft]: "Draft",
  // Not "PR open". `toBranchStatus` returns `Open` for a branch with NO PR
  // evidence at all — Kerensa ruled 2026-08-31 (ISS-8422) that Open is a statement
  // about the BRANCH, not a claim about a PR — so labelling this row "PR open"
  // would assert a PR that may not exist (codex review, PR #6835). The detail
  // KEY stays `branch.pr_open`: it is ruled verbatim in the ISS-9432 table.
  [ARTIFACT_STATUS_DETAIL.BranchPrOpen]: "Open",
  [ARTIFACT_STATUS_DETAIL.BranchReview]: "Review",
  [ARTIFACT_STATUS_DETAIL.BranchChangesRequested]: "Changes requested",
  [ARTIFACT_STATUS_DETAIL.BranchMerged]: "Merged",
  [ARTIFACT_STATUS_DETAIL.BranchClosedWithoutMerge]: "Closed without merge",
  [ARTIFACT_STATUS_DETAIL.ProjectArchived]: "Archived",
  [ARTIFACT_STATUS_DETAIL.SessionRunning]: "Running",
  [ARTIFACT_STATUS_DETAIL.SessionCompleted]: "Completed",
  [ARTIFACT_STATUS_DETAIL.SessionFailed]: "Failed",
});

export const ARTIFACT_STATUS_UNKNOWN_TOOLTIP =
  "This app version does not recognize this artifact's status. The work may still be in progress.";

/**
 * The visible word for a status this build cannot read. Reads as the absence of
 * a claim, not as an outcome — and it is read back out of the map above rather
 * than re-typed, so the raw vocabularies' unknown word and the normalized
 * `unknown` root's label cannot drift into two different words.
 */
export const ARTIFACT_STATUS_UNKNOWN_LABEL =
  ARTIFACT_STATUS_DISPLAY_LABELS[DISPLAYED_ARTIFACT_STATUS.Unknown];

/** The word plus the sentence explaining it, for a surface that renders both. */
export type ArtifactStatusDisplay = {
  label: string;
  tooltip: string;
  /**
   * `${label}, ${tooltip}` — the visible word FIRST, per WCAG 2.5.3 Label in
   * Name. For an icon-only control, whose accessible name is its only statement
   * of the value and which has nowhere to hover a tooltip.
   */
  accessibleName: string;
};

export const UNKNOWN_ARTIFACT_STATUS_DISPLAY: ArtifactStatusDisplay =
  Object.freeze({
    label: ARTIFACT_STATUS_UNKNOWN_LABEL,
    tooltip: ARTIFACT_STATUS_UNKNOWN_TOOLTIP,
    accessibleName: `${ARTIFACT_STATUS_UNKNOWN_LABEL}, ${ARTIFACT_STATUS_UNKNOWN_TOOLTIP}`,
  });

/**
 * The accessible name the two per-type status icons gave an unrecognized status
 * BEFORE ISS-9560 — the literal word "Status", which names the field rather
 * than its value. Declared once rather than twice in the two icons so the
 * flag-off arm has one home; it goes away with the flag.
 */
export const LEGACY_UNKNOWN_STATUS_ICON_LABEL = "Status";

/**
 * The label `labels` gives `status`, or `undefined` when it has none.
 *
 * `Object.hasOwn` rather than a bare index: these maps are object literals and
 * `Artifact.status` is a freeform column, so a status string of `"toString"` or
 * `"constructor"` indexes into `Object.prototype` and yields a FUNCTION where
 * the caller expects a label. The per-type status icons already guard their
 * appearance lookups this way for the same reason.
 */
export function lookupStatusLabel(
  labels: Readonly<Record<string, string>>,
  status: string | null | undefined
): string | undefined {
  if (!status) {
    return undefined;
  }
  return Object.hasOwn(labels, status) ? labels[status] : undefined;
}

/**
 * What a surface renders for `status`: its own label, else the honest unknown
 * word once `unknownStatus` is non-null, else the raw value.
 *
 * The PRECEDENCE is why this is a helper and not four hand-written chains —
 * inverting the first two clauses hides a label the build does have behind
 * "Unknown", and dropping the middle one keeps printing the wire token the gate
 * was opened to remove. Pure: the caller owns the flag read, so a server module
 * can call it too.
 */
export function resolveStatusLabel(
  labels: Readonly<Record<string, string>>,
  status: string,
  unknownStatus: ArtifactStatusDisplay | null
): string {
  return lookupStatusLabel(labels, status) ?? unknownStatus?.label ?? status;
}
