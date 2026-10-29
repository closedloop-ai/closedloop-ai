import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import type { JsonObject } from "@repo/api/src/types/common";
import {
  GitHubFetchCredentialType,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import type {
  CreatePrArtifactInput,
  CreatePrArtifactResponse,
  PullRequestArtifactLinkResult,
} from "@repo/api/src/types/pull-request-artifact-link";
import {
  emptyPullRequestLabelSyncResult,
  type PullRequestLabelSyncResult,
  PullRequestLabelSyncStatus,
} from "@repo/api/src/types/pull-request-label-sync-status";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { GitHubProviderResultStatus, getSinglePullRequest } from "@repo/github";
import { log } from "@repo/observability/log";
import type { BranchUpsertWrite } from "@/app/branches/branch-service";
import { upsertBranchArtifactWithAttribution } from "@/app/branches/branch-upsert-with-attribution";
import {
  createPullRequestRestAuthorityProvenance,
  toPullRequestRestAuthorityObservation,
} from "@/app/branches/pull-request-authority-producer";
import { loadProjectPrLinkRepositories } from "@/app/projects/repository-resolver";
import { acquireInstallationClient } from "@/lib/github/installation-client";
import {
  type ArtifactPullRequestLabelSyncInput,
  syncPullRequestLabelsFromArtifactTags,
} from "@/lib/github/pull-request-label-sync";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { parseGitHubPullRequestUrl } from "./pull-request-url";

type LivePullRequest = NonNullable<
  Awaited<ReturnType<typeof getSinglePullRequest>>
>;

export type CreatePullRequestArtifactError = {
  status: StatusCode;
  message: string;
  cause?: string;
  metadata?: {
    code?: string;
    details?: JsonObject;
  };
};

export const pullRequestArtifactLinkService = {
  /**
   * Validate a browser-selected GitHub PR against the project's allowed
   * repositories and live GitHub state, then materialize it as branch-owned PR
   * detail through the branch service.
   */
  async createPullRequestArtifact(
    input: {
      body: CreatePrArtifactInput;
      createdById: string;
      organizationId: string;
    },
    recordWritten?: RecordWriteInTransaction<BranchUpsertWrite>
  ): Promise<Result<CreatePrArtifactResponse, CreatePullRequestArtifactError>> {
    const project = await withDb((db) =>
      db.project.findUnique({
        where: {
          id: input.body.projectId,
          organizationId: input.organizationId,
        },
        select: { id: true, name: true, settings: true },
      })
    );
    if (!project) {
      return serviceError(Status.NotFound, "Project not found");
    }

    const allowedRepositories = await loadProjectPrLinkRepositories({
      projectId: project.id,
      organizationId: input.organizationId,
      projectSettings: (project.settings ?? {}) as JsonObject,
    });
    if (allowedRepositories.length === 0) {
      // ISS-10169: the bare sentence named neither the project nor a remedy, so
      // a caller holding several projects could not tell WHICH one was
      // unconfigured, nor what to do about it.
      return serviceError(
        Status.BadRequest,
        `Project "${project.name}" (${project.id}) has no primary repository configured. Add a repository to one of the project's teams and mark it primary in the project's repository settings, then retry.`,
        { code: "project_primary_repository_missing" }
      );
    }

    const validated = await validateSelectedPullRequest({
      allowedRepositories,
      body: input.body,
      organizationId: input.organizationId,
    });
    if (!validated.ok) {
      return validated;
    }

    const { livePullRequest, repository } = validated.value;
    const headAuthority = livePullRequest.headRepository;
    if (!headAuthority) {
      return serviceError(
        Status.BadRequest,
        "Pull request head repository authority is unavailable",
        { code: "pull_request_head_repository_unavailable" }
      );
    }
    const headMatchesBase =
      headAuthority.repository.providerRepositoryId ===
        repository.githubRepoId &&
      normalizeRepoFullName(headAuthority.repository.fullName) ===
        normalizeRepoFullName(repository.fullName);
    const result = await upsertBranchArtifactWithAttribution(
      {
        organizationId: input.organizationId,
        repositoryId: headMatchesBase ? repository.id : null,
        repositoryFullName: headAuthority.repository.fullName,
        branchName: livePullRequest.headBranch,
        repositoryDefaultObservation: { authority: headAuthority },
        pullRequestRepositoryId: repository.id,
        pullRequestBaseRepositoryFullName: repository.fullName,
        baseBranch: livePullRequest.baseBranch,
        baseBranchSource: BranchBaseBranchSource.PullRequestBase,
        headSha: livePullRequest.headSha,
        headShaSource: BranchHeadShaSource.PullRequestWebhook,
        projectId: input.body.projectId,
        createdById: input.createdById,
        // ISS-4759: the PRODUCES link is written INSIDE this transaction, by the
        // path that already validates the owner (org + project + DOCUMENT +
        // allowed subtype + repo-snapshot scope). Previously the branch upsert
        // ran without it and the client wrote the link in a SECOND request, so a
        // failure there left GitHub labelled against no committed relationship.
        sourceArtifactId: input.body.linkSourceArtifactId ?? null,
        pullRequest: {
          githubId: livePullRequest.githubId,
          number: livePullRequest.number,
          title: livePullRequest.title,
          htmlUrl: livePullRequest.htmlUrl,
          state: livePullRequest.state,
          isDraft: livePullRequest.isDraft,
          authorLogin: livePullRequest.authorLogin,
          authorProviderUserId: livePullRequest.authorProviderUserId,
          authorActorType: livePullRequest.authorActorType,
          // FEA-3552: GitHub PR createdAt — anchors the rail's "PR opened" dot.
          githubCreatedAt: dateOrNull(livePullRequest.createdAt),
          closedAt: dateOrNull(livePullRequest.closedAt),
          mergedAt: dateOrNull(livePullRequest.mergedAt),
          mergeCommitSha: livePullRequest.mergeCommitSha,
          headRepositoryObservation: { authority: headAuthority },
        },
      },
      recordWritten
    );

    if (!result.ok) {
      return branchArtifactServiceError(result.error);
    }
    const { linkedArtifacts } = result.value;
    if (input.body.linkSourceArtifactId && linkedArtifacts.length === 0) {
      // ISS-10169: the branch transaction committed but reported no edge for an
      // owner the caller asked to link. Unreachable while `writeBranchSourceLink`
      // holds its contract (it returns empty only when nothing was requested),
      // which is exactly why it is a guard: a regression there would otherwise
      // surface as a 200 claiming a link nobody wrote — the defect this ticket
      // is about — rather than as a failure.
      return serviceError(
        Status.Error,
        "Pull request was linked to its branch, but the requested produces-relationship was not written",
        { code: "pull_request_source_link_not_written" }
      );
    }

    // ISS-4664: the PR now implements `sourceArtifactId`, so carry that
    // artifact's tags onto the PR as GitHub labels AT LINK TIME — the same
    // reconciliation the `pull_request` webhook runs, invoked here so a link
    // does not have to wait for a later edit/reopen to pick the tags up.
    //
    // ISS-4759: strictly AFTER the branch transaction committed above. The
    // early return on `!result.ok` is what guarantees a rolled-back link never
    // reaches GitHub, and the tag source itself is validated inside the sync.
    //
    // Awaited (never fire-and-forget in a serverless route) but non-fatal:
    // the branch artifact is already committed above, so a GitHub or tag-read
    // failure must not turn a successful link into a 5xx. The helper swallows
    // its own failures; this guard is the structural one, so the contract holds
    // even if that internal handling ever regresses.
    const labelSync = input.body.sourceArtifactId
      ? await syncLabelsBestEffort({
          organizationId: input.organizationId,
          projectId: input.body.projectId,
          artifactId: input.body.sourceArtifactId,
          installationId: repository.installationId,
          owner: repository.owner,
          repo: repository.name,
          repositoryFullName: repository.fullName,
          pullNumber: input.body.number,
        })
      : undefined;

    return Result.ok({
      id: result.value.id,
      // ISS-10169: the three facts that let a caller verify this write without a
      // second request. `linkedArtifacts` is always present because its
      // EMPTINESS is the answer to "did you link anything".
      linkedArtifacts,
      branchArtifactCreated: result.value.created,
      currentPullRequest: result.value.pullRequest
        ? {
            number: result.value.pullRequest.number,
            htmlUrl: result.value.pullRequest.htmlUrl,
          }
        : null,
      // ISS-4764: report what actually happened to the labels. Omitted (never
      // `null`) when propagation was not requested, so an older client sees the
      // exact previous response shape.
      ...(labelSync ? { labelSync } : {}),
      // ISS-4759: echo the link owner ONLY when this request wrote the link, so
      // a newer client can tell whether it still has to write one itself.
      //
      // ISS-10169: taken from the WRITE's own report, not from the request. It
      // used to be `input.body.linkSourceArtifactId` echoed straight back, which
      // said only "you asked for this" while reading as "this was committed".
      ...linkedSourceArtifactEcho(linkedArtifacts, input.body),
    });
  },
};

async function validateSelectedPullRequest(input: {
  allowedRepositories: Array<{
    installationRepositoryId: string;
    fullName: string;
  }>;
  body: CreatePrArtifactInput;
  organizationId: string;
}): Promise<
  Result<
    {
      repository: {
        id: string;
        githubRepoId: string;
        fullName: string;
        owner: string;
        name: string;
        installationId: string;
      };
      livePullRequest: LivePullRequest;
    },
    CreatePullRequestArtifactError
  >
> {
  const parsedUrl = parseGitHubPullRequestUrl(input.body.externalUrl);
  if (!parsedUrl) {
    return serviceError(Status.BadRequest, "Pull request URL is invalid");
  }
  if (parsedUrl.number !== input.body.number) {
    return serviceError(
      Status.BadRequest,
      "Pull request URL number does not match"
    );
  }

  const allowed = input.allowedRepositories.find(
    (repo) =>
      normalizeRepoFullName(repo.fullName) ===
      normalizeRepoFullName(parsedUrl.fullName)
  );
  if (!allowed) {
    return serviceError(Status.NotFound, "Pull request repository not found");
  }

  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        id: allowed.installationRepositoryId,
        fullName: allowed.fullName,
        removedAt: null,
        installation: {
          organizationId: input.organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        githubRepoId: true,
        fullName: true,
        owner: true,
        name: true,
        installation: { select: { installationId: true } },
      },
    })
  );
  if (!repository?.installation.installationId) {
    return serviceError(Status.NotFound, "Pull request repository not found");
  }

  // The read itself resolves null on failure; a failed client acquisition
  // folds into the same null so the service returns its typed BadRequest
  // instead of rejecting.
  const acquired = await acquireInstallationClient(
    repository.installation.installationId
  );
  const authorityProvenance = createPullRequestRestAuthorityProvenance({
    trigger: GitHubFetchTrigger.UserAction,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observedAt: new Date(),
  });
  const livePullRequest =
    acquired.status === GitHubProviderResultStatus.Success
      ? await getSinglePullRequest(
          acquired.value,
          repository.owner,
          repository.name,
          input.body.number,
          toPullRequestRestAuthorityObservation(authorityProvenance)
        )
      : null;
  if (!livePullRequest) {
    return serviceError(
      Status.BadRequest,
      "Pull request head SHA could not be resolved",
      { code: "pull_request_head_unavailable" }
    );
  }

  const mismatch = findAssertionMismatch(input.body, livePullRequest);
  if (mismatch) {
    // ISS-10169: a bare "did not match" cannot be acted on. The `githubId` case
    // is the one that actually bit callers — this endpoint wants the numeric
    // REST id AS A STRING, and a GraphQL node id ("PR_kwDO…") is the natural
    // thing to send — so the expected FORM travels with the failure.
    return serviceError(
      Status.BadRequest,
      `Pull request assertions did not match: ${mismatch}. ${assertionFieldExpectation(mismatch)}`,
      {
        code: "pull_request_assertion_mismatch",
        details: { field: mismatch },
      }
    );
  }

  return Result.ok({
    repository: {
      id: repository.id,
      githubRepoId: repository.githubRepoId,
      fullName: repository.fullName,
      owner: repository.owner,
      name: repository.name,
      installationId: repository.installation.installationId,
    },
    livePullRequest,
  });
}

function branchArtifactServiceError(
  status: StatusCode
): Result<CreatePrArtifactResponse, CreatePullRequestArtifactError> {
  switch (status) {
    case Status.BadRequest:
      return serviceError(status, "Pull request artifact input is invalid");
    case Status.Forbidden:
      return serviceError(status, "Forbidden", {
        code: "branch_artifact_forbidden",
      });
    case Status.Conflict:
      return serviceError(
        status,
        "Pull request artifact conflicts with current branch state"
      );
    case Status.NotFound:
      return serviceError(status, "Branch artifact not found");
    default:
      return serviceError(
        Status.Error,
        "Failed to create pull request artifact",
        undefined,
        `Branch artifact service returned ${status}`
      );
  }
}

export function findAssertionMismatch(
  body: CreatePrArtifactInput,
  livePullRequest: LivePullRequest
): PullRequestAssertionField | null {
  const requiredAssertions: [PullRequestAssertionField, unknown, unknown][] = [
    [
      PullRequestAssertionField.GithubId,
      body.githubId,
      livePullRequest.githubId,
    ],
    [PullRequestAssertionField.Number, body.number, livePullRequest.number],
    [PullRequestAssertionField.State, body.state, livePullRequest.state],
  ];
  for (const [field, expected, actual] of requiredAssertions) {
    if (expected !== actual) {
      return field;
    }
  }

  const optionalAssertions: [PullRequestAssertionField, unknown, unknown][] = [
    [PullRequestAssertionField.HeadSha, body.headSha, livePullRequest.headSha],
    [PullRequestAssertionField.IsDraft, body.isDraft, livePullRequest.isDraft],
    [
      PullRequestAssertionField.ClosedAt,
      normalizeIsoOrNull(body.closedAt),
      normalizeIsoOrNull(livePullRequest.closedAt),
    ],
    [
      PullRequestAssertionField.MergedAt,
      normalizeIsoOrNull(body.mergedAt),
      normalizeIsoOrNull(livePullRequest.mergedAt),
    ],
    [
      PullRequestAssertionField.MergeCommitSha,
      body.mergeCommitSha,
      livePullRequest.mergeCommitSha,
    ],
  ];
  for (const [field, expected, actual] of optionalAssertions) {
    if (expected !== undefined && expected !== actual) {
      return field;
    }
  }
  return null;
}

function normalizeIsoOrNull(value: string | null | undefined) {
  return value ? new Date(value).toISOString() : value;
}

function dateOrNull(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function serviceError<T>(
  status: StatusCode,
  message: string,
  metadata?: CreatePullRequestArtifactError["metadata"],
  cause?: string
): Result<T, CreatePullRequestArtifactError> {
  return Result.err({ status, message, metadata, cause });
}

/**
 * Run the label sync without ever letting it fail an already-committed link.
 * Returns a `Failed` result instead of throwing, so the response can always say
 * something truthful about the labels rather than omitting the field and
 * letting the dialog guess.
 */
async function syncLabelsBestEffort(
  input: ArtifactPullRequestLabelSyncInput & { repositoryFullName: string }
): Promise<PullRequestLabelSyncResult> {
  try {
    return await syncPullRequestLabelsFromArtifactTags(input);
  } catch (error) {
    log.warn(
      "[pullRequestArtifactLink] Label propagation failed for linked PR",
      {
        artifactId: input.artifactId,
        repositoryFullName: input.repositoryFullName,
        pullNumber: input.pullNumber,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return emptyPullRequestLabelSyncResult(PullRequestLabelSyncStatus.Failed);
  }
}

/**
 * The fields this endpoint asserts a caller's payload against, named once.
 *
 * Backend-only (`apps/api`): the values reach the wire as the freeform
 * `details.field` of an assertion-mismatch error, never as a request field a
 * client has to construct.
 */
export const PullRequestAssertionField = {
  GithubId: "githubId",
  Number: "number",
  State: "state",
  HeadSha: "headSha",
  IsDraft: "isDraft",
  ClosedAt: "closedAt",
  MergedAt: "mergedAt",
  MergeCommitSha: "mergeCommitSha",
} as const;

export type PullRequestAssertionField =
  (typeof PullRequestAssertionField)[keyof typeof PullRequestAssertionField];

/**
 * ISS-10169: what each asserted field is expected to LOOK like.
 *
 * An exhaustive `Record`, so a field added to `findAssertionMismatch` fails
 * `tsc` here rather than silently falling back to a generic sentence — the
 * fallback is what made the original message unactionable.
 */
const ASSERTION_FIELD_EXPECTATION: Record<PullRequestAssertionField, string> = {
  [PullRequestAssertionField.GithubId]:
    'Expected the pull request\'s NUMERIC REST id as a string (e.g. "2847113905"), not the GraphQL node id ("PR_kwDO…").',
  [PullRequestAssertionField.Number]:
    "Expected the pull request number shown in its GitHub URL, as an integer.",
  [PullRequestAssertionField.State]:
    "Expected the pull request's current state as GitHub reports it right now; it may have changed since the payload was built.",
  [PullRequestAssertionField.HeadSha]:
    "Expected the pull request's current head commit sha; omit the field rather than asserting a stale one.",
  [PullRequestAssertionField.IsDraft]:
    "Expected the pull request's current draft flag; omit the field rather than asserting a stale one.",
  [PullRequestAssertionField.ClosedAt]:
    "Expected the pull request's closed timestamp as an ISO-8601 string, or null when it is open.",
  [PullRequestAssertionField.MergedAt]:
    "Expected the pull request's merged timestamp as an ISO-8601 string, or null when it is unmerged.",
  [PullRequestAssertionField.MergeCommitSha]:
    "Expected the pull request's merge commit sha, or null when it is unmerged.",
};

/** The expected form of the one field that failed, for the error message. */
function assertionFieldExpectation(field: PullRequestAssertionField): string {
  return ASSERTION_FIELD_EXPECTATION[field];
}

/**
 * The ISS-4759 link echo, derived from what the write reported.
 *
 * Spread into the response so an absent echo stays ABSENT rather than becoming
 * `null` — an older client must keep seeing exactly the previous shape.
 */
function linkedSourceArtifactEcho(
  linkedArtifacts: PullRequestArtifactLinkResult[],
  body: CreatePrArtifactInput
): { linkedSourceArtifactId?: string } {
  const written = linkedArtifacts.find(
    (link) => link.sourceArtifactId === body.linkSourceArtifactId
  );
  return written ? { linkedSourceArtifactId: written.sourceArtifactId } : {};
}
