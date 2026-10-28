import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { SyncedPullRequestArtifactRef } from "@repo/api/src/types/session-artifact-link";
import { log } from "@repo/observability/log";
import type { DesktopPullRequestDetailData } from "@/lib/desktop-pull-request-facts";
import { createdPullRequestBaseRef } from "./pull-request-base-branch";

/** Map a `pull_request` ref's optional facts onto PullRequestDetail columns. */
export function pullRequestRefDetailData(
  ref: SyncedPullRequestArtifactRef
): DesktopPullRequestDetailData {
  const data: DesktopPullRequestDetailData = {};
  if (ref.state !== undefined) {
    data.prState = ref.state;
  }
  if (ref.isDraft !== undefined) {
    data.isDraft = ref.isDraft;
  }
  if (ref.title !== undefined) {
    data.title = ref.title;
  }
  // Derive the href server-side so a compromised producer cannot plant an arbitrary PR URL.
  data.htmlUrl = `https://github.com/${normalizeRepoFullName(ref.repositoryFullName)}/pull/${ref.prNumber}`;
  if (ref.additions !== undefined) {
    data.additions = ref.additions;
  }
  if (ref.deletions !== undefined) {
    data.deletions = ref.deletions;
  }
  if (ref.changedFiles !== undefined) {
    data.changedFiles = ref.changedFiles;
  }
  if (ref.mergedAt !== undefined) {
    data.mergedAt = new Date(ref.mergedAt);
  }
  if (ref.closedAt !== undefined) {
    data.closedAt = new Date(ref.closedAt);
  }
  reportTerminalStateWithoutTimestamp(ref, data);
  const baseRef = createdPullRequestBaseRef(ref);
  if (baseRef !== undefined) {
    data.baseRefName = baseRef;
  }
  return data;
}

function reportTerminalStateWithoutTimestamp(
  ref: SyncedPullRequestArtifactRef,
  data: DesktopPullRequestDetailData
): void {
  // This event tells operators the producer saw a terminal PR state but did not supply the matching terminal timestamp.
  const missing =
    data.prState === GitHubPRState.Merged && data.mergedAt === undefined;
  if (!missing) {
    return;
  }
  log.warn("session.artifact_ref.terminal_state_without_timestamp", {
    event: "session.artifact_ref.terminal_state_without_timestamp",
    prState: data.prState,
    repositoryFullName: normalizeRepoFullName(ref.repositoryFullName),
    prNumber: ref.prNumber,
  });
}
