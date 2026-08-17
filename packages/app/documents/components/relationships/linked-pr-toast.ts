import {
  type PullRequestLabelSyncResult,
  PullRequestLabelSyncStatus,
} from "@repo/api/src/types/pull-request-label-sync-status";

/**
 * ISS-4764: the confirmation shown after linking a pull request has to describe
 * what actually happened to the labels.
 *
 * It previously read "Linked PR #N" whether the tags landed, were refused, or
 * the GitHub call quietly failed — the link succeeded either way, so the message
 * was true about the link and silent about the half the dialog had just promised
 * ("Tags on this feature are applied ... as GitHub labels").
 *
 * Two rules the first pass got wrong and this module encodes instead:
 *  - **A provider failure is never hidden behind the ceiling.** The over-ceiling
 *    case used to be checked first, so a 102-tag artifact whose GitHub call
 *    failed outright was reported as "two were not applied" when in truth none
 *    landed. The failure is named first, and a run that both failed AND hit the
 *    ceiling renders both facts.
 *  - **Failures do not go out as a success toast.** The tone is part of the
 *    outcome, so the dialog picks `toast.warning` for anything the user has to
 *    act on — the same split `move-entity-dialog.tsx` already uses for a partial
 *    batch move.
 *
 * Presentational and dependency-free so it can be unit-tested directly rather
 * than through the dialog it feeds.
 */

export const LinkedPullRequestToastTone = {
  Success: "success",
  Warning: "warning",
} as const;
export type LinkedPullRequestToastTone =
  (typeof LinkedPullRequestToastTone)[keyof typeof LinkedPullRequestToastTone];

export type LinkedPullRequestToast = {
  tone: LinkedPullRequestToastTone;
  message: string;
};

/** How many refused tag names the message spells out before summarising. */
const MAX_NAMED_DROPPED_LABELS = 2;

/**
 * Build the toast for a completed link.
 *
 * An older API omits `labelSync` entirely; that means "not reported", so the
 * message stays exactly as it was rather than inventing an outcome.
 */
export function buildLinkedPullRequestToast(
  pullNumber: number,
  labelSync?: PullRequestLabelSyncResult
): LinkedPullRequestToast {
  const linked = `Linked PR #${pullNumber}`;
  if (!labelSync) {
    return { tone: LinkedPullRequestToastTone.Success, message: linked };
  }

  const sentences: string[] = [];
  const failure = labelFailureSentence(labelSync.status);
  if (failure) {
    sentences.push(failure);
  }
  if (labelSync.droppedLabels.length > 0) {
    sentences.push(droppedLabelsSentence(labelSync.droppedLabels));
  }
  if (sentences.length === 0 && labelSync.addedLabels.length > 0) {
    const count = labelSync.addedLabels.length;
    sentences.push(`Applied ${count} ${count === 1 ? "label" : "labels"}.`);
  }

  if (sentences.length === 0) {
    return { tone: LinkedPullRequestToastTone.Success, message: linked };
  }
  return {
    tone:
      failure || labelSync.droppedLabels.length > 0
        ? LinkedPullRequestToastTone.Warning
        : LinkedPullRequestToastTone.Success,
    message: [`${linked}.`, ...sentences].join(" "),
  };
}

/**
 * Name WHO refused. `Failed` and `SourceRejected` are not the same event to the
 * person reading the toast: one is GitHub saying no to a write we attempted,
 * the other is Closedloop declining to supply labels at all, and only the first
 * is worth retrying.
 */
function labelFailureSentence(
  status: PullRequestLabelSyncStatus
): string | null {
  if (status === PullRequestLabelSyncStatus.Failed) {
    return "GitHub rejected the labels.";
  }
  if (status === PullRequestLabelSyncStatus.SourceRejected) {
    return "That feature can't supply labels for this PR.";
  }
  return null;
}

/**
 * Name the tags rather than handing back a bare count — the count is the least
 * useful thing we know at that moment, and `droppedLabels` carries the actual
 * names.
 */
function droppedLabelsSentence(droppedLabels: readonly string[]): string {
  const named = droppedLabels.slice(0, MAX_NAMED_DROPPED_LABELS);
  const remainder = droppedLabels.length - named.length;
  if (remainder > 0) {
    return `Too many tags to label. ${named.join(", ")} and ${remainder} more were not applied.`;
  }
  if (named.length === 1) {
    return `Too many tags to label. ${named[0]} was not applied.`;
  }
  return `Too many tags to label. ${named.join(" and ")} were not applied.`;
}
