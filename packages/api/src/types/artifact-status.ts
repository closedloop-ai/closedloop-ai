/**
 * @file artifact-status.ts
 * @description The normalized artifact-status vocabulary (PRD-714 / ISS-9432):
 * the five roots every artifact surface folds onto, the render-only `unknown`
 * value, and the namespaced `detail` keys that preserve the raw domain state
 * through an adapter. This module carries VALUES only; the per-vocabulary
 * mapping tables live in `artifact-status-mapping.ts` and the user-facing copy
 * in `artifact-status-display.ts`, so a bundle-sensitive client can import a
 * root without pulling in zod through the vocabulary modules.
 *
 * These exports are forward contracts. ISS-9432 lands the vocabulary and the
 * tables; ISS-9301 / ISS-9433 / ISS-9435 / ISS-9437 / ISS-9438 import them and
 * ISS-9560 renders the `unknown` value. Nothing in this repo consumes them yet,
 * by design, and nothing downstream may re-declare a root or a mapping.
 *
 * Not to be confused with the `ArtifactStatus` TYPE in `./document.ts`. That is
 * the RAW persisted `DocumentStatus | IssueStatus` union a row stores; this
 * module is the normalized root plus detail a render speaks.
 *
 * ## Root order
 *
 * The declaration order of {@link ARTIFACT_STATUS_ROOT} is the ruled semantic
 * order (D-01, Tamsin 2026-09-08): todo, in_progress, in_review, done,
 * canceled. Nothing here derives a numeric rank from it. `statusDisplayRank`
 * (`./artifact-status-display-order.ts`, ISS-9669) remains the one rank
 * derivation for raw values, and ISS-9437 decides how roots and raw values
 * order against each other in a mixed table.
 *
 * ## Roots are not persisted
 *
 * No column stores a root. {@link DISPLAYED_ARTIFACT_STATUS} adds `unknown` for
 * the render path only, mirroring `SESSION_STATUS` vs `DISPLAYED_SESSION_STATUS`
 * in `./session-status.ts`: a fold that cannot classify its input says so with
 * `unknown` and never with a real root.
 */

/**
 * The five normalized roots, verbatim from ISS-6251, in the ruled semantic
 * order. ISS-6251 conforms to this declaration, not the reverse.
 */
export const ARTIFACT_STATUS_ROOT = {
  Todo: "todo",
  InProgress: "in_progress",
  InReview: "in_review",
  Done: "done",
  Canceled: "canceled",
} as const;
export type ArtifactStatusRoot =
  (typeof ARTIFACT_STATUS_ROOT)[keyof typeof ARTIFACT_STATUS_ROOT];

/**
 * What a RENDER speaks: the roots plus `unknown`, which no fold table maps a
 * recognized value onto except the session `stale`/`unknown` rows, and which
 * every fold returns for input it does not recognize. Render-time only; never
 * written.
 */
export const DISPLAYED_ARTIFACT_STATUS = {
  ...ARTIFACT_STATUS_ROOT,
  Unknown: "unknown",
} as const;
export type DisplayedArtifactStatus =
  (typeof DISPLAYED_ARTIFACT_STATUS)[keyof typeof DISPLAYED_ARTIFACT_STATUS];

/**
 * The raw domain state a mapping preserves alongside its root, namespaced by
 * the vocabulary that produced it. A row without a detail is one whose raw
 * value and root say the same thing (`TODO` → `todo`).
 */
export const ARTIFACT_STATUS_DETAIL = {
  DocumentDrafting: "document.drafting",
  DocumentChangesRequested: "document.changes_requested",
  DocumentApproved: "document.approved",
  DocumentExecuted: "document.executed",
  DocumentSuperseded: "document.superseded",
  IssueTriage: "issue.triage",
  IssueBacklog: "issue.backlog",
  IssueBlocked: "issue.blocked",
  BranchDraft: "branch.draft",
  BranchPrOpen: "branch.pr_open",
  BranchReview: "branch.review",
  BranchChangesRequested: "branch.changes_requested",
  BranchMerged: "branch.merged",
  BranchClosedWithoutMerge: "branch.closed_without_merge",
  ProjectArchived: "project.archived",
  SessionRunning: "session.running",
  SessionCompleted: "session.completed",
  SessionFailed: "session.failed",
} as const;
export type ArtifactStatusDetail =
  (typeof ARTIFACT_STATUS_DETAIL)[keyof typeof ARTIFACT_STATUS_DETAIL];

export type NormalizedArtifactStatus = Readonly<{
  root: DisplayedArtifactStatus;
  detail?: ArtifactStatusDetail;
}>;

/**
 * The one value every fold returns for nullish or unrecognized input. A
 * singleton, so a caller can test a miss by identity.
 */
export const UNKNOWN_ARTIFACT_STATUS: NormalizedArtifactStatus = Object.freeze({
  root: DISPLAYED_ARTIFACT_STATUS.Unknown,
});

const ARTIFACT_STATUS_ROOT_VALUES: ReadonlySet<string> = new Set(
  Object.values(ARTIFACT_STATUS_ROOT)
);

export function isArtifactStatusRoot(
  value: string | null | undefined
): value is ArtifactStatusRoot {
  return value != null && ARTIFACT_STATUS_ROOT_VALUES.has(value);
}
