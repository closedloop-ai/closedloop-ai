/**
 * @file artifact-status-mapping.ts
 * @description The raw-to-normalized mapping tables (PRD-714 / ISS-9432), one
 * exhaustive `Record` per persisted or displayed vocabulary, plus the folds
 * that read them. Each table is keyed by the vocabulary's const members, so
 * adding a member to `DocumentStatus`, `IssueStatus`, `BranchStatus`,
 * `ProjectStatus` or `DISPLAYED_SESSION_STATUS` fails `tsc` here (TS2741) until
 * it is deliberately mapped. The rows are the ruled table in ISS-9432
 * ("Groomed 2026-09-08"); ISS-6251's profile where it speaks, Tamsin's ruling
 * where it does not.
 *
 * `DocumentStatus` and `IssueStatus` are imported from `@closedloop-ai/loops-api/document`
 * because that module also owns `isIssueLifecycleSubtype`, which the
 * packages/api document shim does not re-export. The shim re-exports the same
 * two const objects by identity, so this is not a second source.
 *
 * ## Every fold fails CLOSED
 *
 * Nullish or unrecognized input returns {@link UNKNOWN_ARTIFACT_STATUS}, by
 * identity, from every fold. A real root is never fabricated. That is why
 * {@link toArtifactStatusFromSession} does NOT call `foldToDisplayedSessionStatus`
 * or `normalizeSessionStatus` from `./session-status.ts`: both fail OPEN to
 * `active` for an unrecognized string (the ISS-4997 write-path policy), which
 * this render contract must not inherit. Raw session input that reaches a
 * render is already a member of `DISPLAYED_SESSION_STATUS`, so a guarded lookup
 * on {@link SESSION_STATUS_MAPPING} answers `unknown` for anything that isn't,
 * rather than fail-opening to a false "in progress".
 *
 * ## The session table is PROVISIONAL
 *
 * Per ISS-6251 discussion point 6. Its four deferred tickets (ISS-6551,
 * ISS-6553, ISS-6554, ISS-6555) are all CANCELED, so nothing live blocks it,
 * but the rows may still move when session semantics are settled. ISS-10364
 * retired the `waiting`/`stale`/`unknown` rows this table used to carry; an
 * unrecognized raw value now answers `unknown` through the guarded `lookup`
 * fallback rather than a table row. A stored legacy `waiting` is the one
 * spelling that keeps its old answer, through an explicit arm in
 * {@link toArtifactStatusFromSession} — see that function for why.
 *
 * ## What this module does not do
 *
 * It does not define "terminal" (`TERMINAL_*` sets are ISS-9559's), does not
 * rank (`statusDisplayRank` in packages/app is the one rank derivation for raw
 * values, and `./artifact-status-rank.ts` the one for roots), and does not
 * replace `fallbackStatusForSubtype`, `normalizeSessionStatus` or
 * `toRenderStatus`. No Inbox or Prototype table exists because neither has a
 * production surface on main (D-07).
 *
 * ## The PR-state fold is a COMPOSITION, not a sixth table
 *
 * ISS-9437 needed a branch row in a MIXED table to fold, and such a row carries
 * the raw GitHub PR state in `Artifact.status` rather than a `BranchStatus` —
 * so {@link toArtifactStatusFromBranch} misses it and returns `unknown`.
 * {@link toArtifactStatusFromPullRequestState} closes that without adding a
 * `Record<GitHubPRState, …>`: a second table over the same semantics could
 * drift from {@link BRANCH_STATUS_MAPPING}, and `toBranchStatus`
 * (`./branch-status-derivation.ts`) already calls itself the ONE
 * `GitHubPRState`-to-`BranchStatus` derivation, for the same reason. The fold
 * composes through it, so a branch root has exactly one home.
 */

import {
  DocumentStatus,
  IssueStatus,
  isIssueLifecycleSubtype,
} from "@closedloop-ai/loops-api/document";
import type { NormalizedArtifactStatus } from "./artifact-status.js";
import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
  UNKNOWN_ARTIFACT_STATUS,
} from "./artifact-status.ts";
import { BranchStatus } from "./branch.ts";
import { deriveBranchMergedState } from "./branch-merged-state.ts";
import { toBranchStatus } from "./branch-status-derivation.ts";
import type { GitHubPRState } from "./github-status.js";
import { ProjectStatus } from "./project.ts";
import type { DisplayedSessionStatus } from "./session-status.js";
import {
  DISPLAYED_SESSION_STATUS,
  LEGACY_WAITING_WIRE_STATUS,
} from "./session-status.ts";

export const DOCUMENT_STATUS_MAPPING = freezeTable<DocumentStatus>({
  [DocumentStatus.Draft]: {
    root: ARTIFACT_STATUS_ROOT.InProgress,
    detail: ARTIFACT_STATUS_DETAIL.DocumentDrafting,
  },
  [DocumentStatus.InReview]: { root: ARTIFACT_STATUS_ROOT.InReview },
  [DocumentStatus.ChangesRequested]: {
    root: ARTIFACT_STATUS_ROOT.InReview,
    detail: ARTIFACT_STATUS_DETAIL.DocumentChangesRequested,
  },
  [DocumentStatus.Approved]: {
    root: ARTIFACT_STATUS_ROOT.Done,
    detail: ARTIFACT_STATUS_DETAIL.DocumentApproved,
  },
  [DocumentStatus.Executed]: {
    root: ARTIFACT_STATUS_ROOT.Done,
    detail: ARTIFACT_STATUS_DETAIL.DocumentExecuted,
  },
  [DocumentStatus.Obsolete]: {
    root: ARTIFACT_STATUS_ROOT.Canceled,
    detail: ARTIFACT_STATUS_DETAIL.DocumentSuperseded,
  },
});

export const ISSUE_STATUS_MAPPING = freezeTable<IssueStatus>({
  [IssueStatus.Triage]: {
    root: ARTIFACT_STATUS_ROOT.Todo,
    detail: ARTIFACT_STATUS_DETAIL.IssueTriage,
  },
  [IssueStatus.Backlog]: {
    root: ARTIFACT_STATUS_ROOT.Todo,
    detail: ARTIFACT_STATUS_DETAIL.IssueBacklog,
  },
  [IssueStatus.Todo]: { root: ARTIFACT_STATUS_ROOT.Todo },
  [IssueStatus.InProgress]: { root: ARTIFACT_STATUS_ROOT.InProgress },
  [IssueStatus.InReview]: { root: ARTIFACT_STATUS_ROOT.InReview },
  [IssueStatus.Blocked]: {
    root: ARTIFACT_STATUS_ROOT.InProgress,
    detail: ARTIFACT_STATUS_DETAIL.IssueBlocked,
  },
  [IssueStatus.Done]: { root: ARTIFACT_STATUS_ROOT.Done },
  [IssueStatus.Canceled]: { root: ARTIFACT_STATUS_ROOT.Canceled },
});

export const BRANCH_STATUS_MAPPING = freezeTable<BranchStatus>({
  [BranchStatus.Draft]: {
    root: ARTIFACT_STATUS_ROOT.InProgress,
    detail: ARTIFACT_STATUS_DETAIL.BranchDraft,
  },
  [BranchStatus.Open]: {
    root: ARTIFACT_STATUS_ROOT.InReview,
    detail: ARTIFACT_STATUS_DETAIL.BranchPrOpen,
  },
  [BranchStatus.Review]: {
    root: ARTIFACT_STATUS_ROOT.InReview,
    detail: ARTIFACT_STATUS_DETAIL.BranchReview,
  },
  [BranchStatus.Blocked]: {
    root: ARTIFACT_STATUS_ROOT.InReview,
    detail: ARTIFACT_STATUS_DETAIL.BranchChangesRequested,
  },
  [BranchStatus.Merged]: {
    root: ARTIFACT_STATUS_ROOT.Done,
    detail: ARTIFACT_STATUS_DETAIL.BranchMerged,
  },
  [BranchStatus.Closed]: {
    root: ARTIFACT_STATUS_ROOT.Canceled,
    detail: ARTIFACT_STATUS_DETAIL.BranchClosedWithoutMerge,
  },
});

export const PROJECT_STATUS_MAPPING = freezeTable<ProjectStatus>({
  [ProjectStatus.NotStarted]: { root: ARTIFACT_STATUS_ROOT.Todo },
  [ProjectStatus.InProgress]: { root: ARTIFACT_STATUS_ROOT.InProgress },
  [ProjectStatus.Completed]: { root: ARTIFACT_STATUS_ROOT.Done },
  [ProjectStatus.Archived]: {
    root: ARTIFACT_STATUS_ROOT.Done,
    detail: ARTIFACT_STATUS_DETAIL.ProjectArchived,
  },
});

/**
 * PROVISIONAL — see the file header.
 *
 * ISS-10364 (operator ruling, 2026-09-23/24) retired `waiting`/`stale`/`unknown`
 * from {@link DisplayedSessionStatus}, so the three rows that used to map them
 * are gone. `ARTIFACT_STATUS_DETAIL.SessionWaiting`/`SessionStale` went with
 * them — the `emits exactly the declared detail set` test proved they were
 * genuinely orphaned once no table emitted either — so they, their labels
 * (`artifact-status-display.ts`), and their appearances
 * (`artifact-status-appearance.ts`) are all deleted rather than left standing.
 */
export const SESSION_STATUS_MAPPING = freezeTable<DisplayedSessionStatus>({
  [DISPLAYED_SESSION_STATUS.ACTIVE]: {
    root: ARTIFACT_STATUS_ROOT.InProgress,
    detail: ARTIFACT_STATUS_DETAIL.SessionRunning,
  },
  [DISPLAYED_SESSION_STATUS.INACTIVE]: {
    root: ARTIFACT_STATUS_ROOT.Done,
    detail: ARTIFACT_STATUS_DETAIL.SessionCompleted,
  },
  [DISPLAYED_SESSION_STATUS.ERROR]: {
    root: ARTIFACT_STATUS_ROOT.Canceled,
    detail: ARTIFACT_STATUS_DETAIL.SessionFailed,
  },
});

export function toArtifactStatusFromDocument(
  raw: string | null | undefined
): NormalizedArtifactStatus {
  return lookup(DOCUMENT_STATUS_MAPPING, raw);
}

export function toArtifactStatusFromIssue(
  raw: string | null | undefined
): NormalizedArtifactStatus {
  return lookup(ISSUE_STATUS_MAPPING, raw);
}

export function toArtifactStatusFromBranch(
  raw: string | null | undefined
): NormalizedArtifactStatus {
  return lookup(BRANCH_STATUS_MAPPING, raw);
}

export function toArtifactStatusFromProject(
  raw: string | null | undefined
): NormalizedArtifactStatus {
  return lookup(PROJECT_STATUS_MAPPING, raw);
}

/**
 * Folds a session status already in the DISPLAYED vocabulary. Does not call the
 * session-status normalizers: see the file header for why.
 *
 * {@link LEGACY_WAITING_WIRE_STATUS} is the one exception, and it is a
 * compatibility path rather than a normalizer. `artifacts.status` is freeform
 * and ISS-5981's backfill was waived, so cloud rows literally storing `waiting`
 * still exist; before ISS-10364 this table had a `waiting` row mapping them to
 * In progress. Without this arm the retirement would move those rows to
 * Unknown — a louder claim about a row whose lifecycle fold is `active`. The
 * other two retired spellings get no arm: neither was ever persistable, and the
 * rows this table used to carry already answered the unknown root for both, so
 * the retirement changes nothing for them.
 */
export function toArtifactStatusFromSession(
  raw: string | null | undefined
): NormalizedArtifactStatus {
  if (raw === LEGACY_WAITING_WIRE_STATUS) {
    return SESSION_STATUS_MAPPING[DISPLAYED_SESSION_STATUS.ACTIVE];
  }
  return lookup(SESSION_STATUS_MAPPING, raw);
}

/**
 * Folds the `Artifact.status` column of a DOCUMENT-typed artifact. The subtype
 * picks the vocabulary the same way `statusOptionsForSubtype` does: a FEATURE
 * (or a stray canonical ISSUE) row reads the Issue table, every other subtype,
 * including an unrecognized one from a version-skewed client, reads the
 * Document table.
 *
 * Documents only. Branch and session rows that share a mixed table carry
 * statuses in neither vocabulary and must go through their own fold; passing
 * `open` or `active` here returns `unknown` by design.
 */
export function toDisplayedArtifactStatus(
  subtype: string | null | undefined,
  raw: string | null | undefined
): NormalizedArtifactStatus {
  if (isIssueLifecycleSubtype(subtype)) {
    return lookup(ISSUE_STATUS_MAPPING, raw);
  }
  return lookup(DOCUMENT_STATUS_MAPPING, raw);
}

/**
 * Folds the raw GitHub PR state a BRANCH ROW carries in a mixed artifact table.
 *
 * That column is a `GitHubPRState` (`OPEN`/`MERGED`/`CLOSED`), not a
 * {@link BranchStatus}, so {@link toArtifactStatusFromBranch} returns `unknown`
 * for it — measured, not assumed. Recognizing the raw string is the CALLER's
 * job: `normalizeBranchStatus` in
 * `packages/app/documents/components/table/row-type-registry.ts` is the
 * recognizer the row's own icon and label already use, and reusing it is what
 * stops the fold and the render disagreeing about what a row is.
 *
 * The two derived arguments are the row's own evidence restated, not invented.
 * `isDraft` is `false` because a mixed-table branch row reports no draftness at
 * all — the column holds one PR state and nothing else — so `false` states that
 * absence rather than guessing. The merged state goes through
 * {@link deriveBranchMergedState}, which reads exactly this column
 * (`localArtifactStatus`), so it is a restatement of the same input rather than
 * a second opinion about it.
 */
export function toArtifactStatusFromPullRequestState(
  prState: GitHubPRState | null | undefined
): NormalizedArtifactStatus {
  if (prState == null) {
    return UNKNOWN_ARTIFACT_STATUS;
  }
  const branchStatus = toBranchStatus(
    null,
    prState,
    false,
    deriveBranchMergedState({ localArtifactStatus: prState })
  );
  return BRANCH_STATUS_MAPPING[branchStatus];
}

function freezeTable<K extends string>(
  table: Record<K, NormalizedArtifactStatus>
): Readonly<Record<K, NormalizedArtifactStatus>> {
  for (const value of Object.values<NormalizedArtifactStatus>(table)) {
    Object.freeze(value);
  }
  return Object.freeze(table);
}

function lookup<K extends string>(
  table: Readonly<Record<K, NormalizedArtifactStatus>>,
  raw: string | null | undefined
): NormalizedArtifactStatus {
  if (raw != null && Object.hasOwn(table, raw)) {
    return table[raw as K];
  }
  return UNKNOWN_ARTIFACT_STATUS;
}
