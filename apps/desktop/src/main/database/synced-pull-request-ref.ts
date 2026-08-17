import { GitHubPRState } from "@repo/api/src/types/github-status";
import type { SyncedPullRequestArtifactRef } from "@repo/api/src/types/session-artifact-link";
import { boundedNonNegativeInt, validIso } from "./db-helpers.js";
import type {
  SqliteArtifactLinkRow,
  SqlitePullRequestLifecycleRow,
} from "./db-row-types.js";

type PullRequestArtifactRefFacts = Partial<
  Pick<
    SyncedPullRequestArtifactRef,
    | "title"
    | "state"
    | "isDraft"
    | "additions"
    | "deletions"
    | "changedFiles"
    | "mergedAt"
    | "closedAt"
  >
>;

/** Return a non-empty string within its wire bound. */
export function boundedWireString(
  value: string | null,
  max: number
): string | undefined {
  return value != null && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

/** Build bounded optional PR facts without letting one bad row reject a batch. */
export function buildPullRequestArtifactRefFacts(
  link: SqliteArtifactLinkRow,
  lifecycle: SqlitePullRequestLifecycleRow | undefined
): PullRequestArtifactRefFacts {
  const facts: PullRequestArtifactRefFacts = {};
  const title = boundedWireString(link.title, 1024);
  if (title !== undefined) {
    facts.title = title;
  }
  const state = normalizePullRequestState(link.pr_state);
  if (state !== undefined) {
    facts.state = state;
  }
  if (lifecycle?.is_draft != null) {
    facts.isDraft = lifecycle.is_draft === true || lifecycle.is_draft === 1;
  }
  const additions = boundedNonNegativeInt(link.lines_added);
  if (additions !== undefined) {
    facts.additions = additions;
  }
  const deletions = boundedNonNegativeInt(link.lines_removed);
  if (deletions !== undefined) {
    facts.deletions = deletions;
  }
  const changedFiles = boundedNonNegativeInt(link.files_changed);
  if (changedFiles !== undefined) {
    facts.changedFiles = changedFiles;
  }
  const mergedAt = validTimestamp(lifecycle?.merged_at ?? null);
  if (mergedAt !== undefined) {
    facts.mergedAt = mergedAt;
  }
  const closedAt = validTimestamp(lifecycle?.closed_at ?? null);
  if (closedAt !== undefined) {
    facts.closedAt = closedAt;
  }
  return facts;
}

function normalizePullRequestState(
  value: string | null
): GitHubPRState | undefined {
  if (!value) {
    return undefined;
  }
  const upper = value.trim().toUpperCase();
  return upper === GitHubPRState.Open ||
    upper === GitHubPRState.Merged ||
    upper === GitHubPRState.Closed
    ? (upper as GitHubPRState)
    : undefined;
}

function validTimestamp(value: string | null): string | undefined {
  return validIso(value) ?? undefined;
}
