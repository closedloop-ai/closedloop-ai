import type { Octokit } from "@octokit/rest";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  type RepositoryDefaultProvenance,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
  type RepositoryDefaultUnavailableObservation,
  repositoryDefaultAuthorityValidator,
  repositoryDefaultIdentityValidator,
  repositoryDefaultUnavailableObservationValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";

/** GitHub's documented REST API version checked for ISS-5826 on 2026-08-10. */
export const GITHUB_PULL_REQUEST_REST_API_VERSION = "2026-03-10";

/**
 * Credential-agnostic Pull Request REST projection used by cloud refresh lanes.
 * Repository authority fields are additive so older callers can keep consuming
 * the established pull-request shape during version-skewed deployments.
 */
export type GitHubSinglePullRequestResult = {
  githubId: string;
  number: number;
  title: string;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  state: GitHubPRState;
  // FEA-3552: the GitHub PR createdAt — when the PR was raised. Anchors the
  // branch/PR timeline's "PR opened" lifecycle dot.
  createdAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  authorLogin: string | null;
  isDraft: boolean;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  /** Authoritative head-repository snapshot, never derived from the PR base. */
  headRepository?: RepositoryDefaultAuthority;
  /** Typed observation for deleted, inaccessible, or malformed head repositories. */
  headRepositoryUnavailable?: RepositoryDefaultUnavailableObservation;
};

/** Caller-stable acquisition metadata for one bounded Pull Request REST read. */
export type GitHubPullRequestRestAuthorityObservation = Omit<
  RepositoryDefaultProvenance,
  "source" | "mechanism" | "eventAt"
>;

type PullsGetResponseData = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["get"]>
>["data"];

/** Request options shared by every scoped Pull Request REST read. */
export const GITHUB_PULL_REQUEST_REST_HEADERS = {
  "X-GitHub-Api-Version": GITHUB_PULL_REQUEST_REST_API_VERSION,
} as const;

/** Map GitHub's Pull Request REST response without deriving repository facts. */
export function mapSinglePullRequestResponse(
  pr: PullsGetResponseData,
  authorityObservation?: GitHubPullRequestRestAuthorityObservation
): GitHubSinglePullRequestResult {
  let state: GitHubPRState = GitHubPRState.Open;
  if (pr.merged_at) {
    state = GitHubPRState.Merged;
  } else if (pr.state === "closed") {
    state = GitHubPRState.Closed;
  }

  const headRepository = mapPullRequestHeadRepository(
    pr.head.repo,
    authorityObservation
  );

  return {
    githubId: String(pr.id),
    number: pr.number,
    title: pr.title,
    htmlUrl: pr.html_url,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    state,
    createdAt: pr.created_at ?? null,
    mergedAt: pr.merged_at ?? null,
    closedAt: pr.closed_at ?? null,
    authorLogin: pr.user?.login ?? null,
    isDraft: pr.draft ?? false,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    mergeCommitSha: pr.merge_commit_sha ?? null,
    ...(pr.additions === undefined ? {} : { additions: pr.additions }),
    ...(pr.deletions === undefined ? {} : { deletions: pr.deletions }),
    ...(pr.changed_files === undefined
      ? {}
      : { changedFiles: pr.changed_files }),
    ...headRepository,
  };
}

function mapPullRequestHeadRepository(
  repository: PullsGetResponseData["head"]["repo"],
  observation: GitHubPullRequestRestAuthorityObservation | undefined
): Pick<
  GitHubSinglePullRequestResult,
  "headRepository" | "headRepositoryUnavailable"
> {
  if (!observation) {
    return {};
  }

  const provenance = toPullRequestRestProvenance(observation);
  if (!repository) {
    return {
      headRepositoryUnavailable:
        repositoryDefaultUnavailableObservationValidator.parse({
          reason: RepositoryDefaultReason.NotReported,
          provenance,
        }),
    };
  }

  const providerRepositoryId = normalizeProviderRepositoryId(repository.id);
  const identity = repositoryDefaultIdentityValidator.safeParse({
    provider: VcsProviderKind.GitHub,
    providerRepositoryId,
    fullName: repository.full_name,
  });
  if (!identity.success) {
    return {
      headRepositoryUnavailable:
        repositoryDefaultUnavailableObservationValidator.parse({
          reason: RepositoryDefaultReason.Malformed,
          provenance,
        }),
    };
  }

  const rawDefaultBranch: unknown = repository.default_branch;
  const defaultBranch =
    typeof rawDefaultBranch === "string" ? rawDefaultBranch.trim() : "";
  const evidence = defaultBranch
    ? {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch,
      }
    : {
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason:
          rawDefaultBranch === null || rawDefaultBranch === undefined
            ? RepositoryDefaultReason.NotReported
            : RepositoryDefaultReason.Malformed,
      };

  return {
    headRepository: repositoryDefaultAuthorityValidator.parse({
      repository: identity.data,
      evidence,
      provenance,
    }),
  };
}

function toPullRequestRestProvenance(
  observation: GitHubPullRequestRestAuthorityObservation
): RepositoryDefaultProvenance {
  return {
    source: RepositoryDefaultSource.PullRequestRest,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: observation.trigger,
    credentialType: observation.credentialType,
    ...(observation.credentialOwnerId === undefined
      ? {}
      : { credentialOwnerId: observation.credentialOwnerId }),
    observationKey: observation.observationKey,
    observedAt: observation.observedAt,
  };
}

function normalizeProviderRepositoryId(value: unknown): string | null {
  if (
    !(typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  ) {
    return null;
  }
  return String(value);
}
