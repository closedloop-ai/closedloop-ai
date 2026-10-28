import type {
  ArtifactLinkEndpoint,
  ArtifactLinkWithEndpoints,
  LinkType,
  PullRequestDetail,
} from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";

/** A resolved-link endpoint as `/artifact-links/resolved` hydrates it. */
export function linkEndpoint(
  overrides: Partial<ArtifactLinkEndpoint> &
    Pick<ArtifactLinkEndpoint, "id" | "type">
): ArtifactLinkEndpoint {
  return {
    assigneeId: null,
    createdAt: new Date(0),
    createdById: null,
    dueDate: null,
    externalUrl: null,
    name: `Name ${overrides.id}`,
    organizationId: "org-1",
    priority: null,
    projectId: null,
    slug: `SLUG-${overrides.id}`,
    sortOrder: null,
    status: "",
    subtype: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

export function resolvedLink(
  id: string,
  linkType: LinkType,
  source: ArtifactLinkEndpoint,
  target: ArtifactLinkEndpoint
): ArtifactLinkWithEndpoints {
  return {
    createdAt: new Date(0),
    id,
    linkType,
    metadata: null,
    organizationId: "org-1",
    source,
    sourceId: source.id,
    target,
    targetId: target.id,
  };
}

export function pullRequestDetail(
  overrides: Partial<PullRequestDetail> & Pick<PullRequestDetail, "number">
): PullRequestDetail {
  return {
    baseBranch: "main",
    body: null,
    checksStatus: null,
    closedAt: null,
    githubId: null,
    headBranch: "feat/x",
    headSha: null,
    isDraft: false,
    lastRefreshAttemptAt: null,
    lastVerifiedAt: null,
    mergeCommitSha: null,
    mergedAt: null,
    prState: GitHubPRState.Open,
    repositoryId: null,
    reviewDecision: null,
    ...overrides,
  };
}
