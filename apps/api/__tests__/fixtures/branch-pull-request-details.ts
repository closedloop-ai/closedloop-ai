/** Resolves mock current PR detail rows using the branch services' fallback order. */
export function resolveMockPullRequestDetails<Detail>(
  overrides: { pullRequestDetails?: Detail[] },
  currentPullRequestDetail: Detail | null
): Detail[] {
  if ("pullRequestDetails" in overrides) {
    return overrides.pullRequestDetails ?? [];
  }
  return currentPullRequestDetail ? [currentPullRequestDetail] : [];
}
