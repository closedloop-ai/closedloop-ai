// biome-ignore-all lint/suspicious/noMisplacedAssertion: Exported assertion helpers run only from test bodies.
/**
 * Request builders, webhook-payload builders, and DB seeding shared by the
 * branch-artifact integration suites. These are the parts of the suite setup
 * that touch no module mock, so they live here rather than inside a single
 * suite file.
 */

import {
  BranchBaseBranchSource,
  BranchFileCacheStatus,
  BranchHeadShaSource,
  BranchSyncStatus,
  LinkType,
} from "@repo/api/src/types/artifact";
import {
  BranchViewLoadErrorCode,
  type BranchViewLoadErrorCode as BranchViewLoadErrorCodeType,
} from "@repo/api/src/types/branch-view";
import { GitHubPRState as ApiGitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  ArtifactType,
  ChecksStatus,
  ReviewDecision as DbReviewDecision,
  GitHubPRState,
  withDb,
} from "@repo/database";
import { NextRequest } from "next/server";
import { expect } from "vitest";
import type { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import { handlePush as handlePushHandler } from "@/app/webhooks/github/handlers/push-handler";
import { persistedGitHubRepositoryAuthority } from "../fixtures/repository-default-authority";
import type { TestContext } from "./branch-artifact-test-helpers";

export function pullRequestEvent(
  ctx: TestContext,
  input: {
    branchName: string;
    number?: number;
    id?: number;
    title?: string;
    htmlUrl?: string;
    headSha?: string;
    createdAt?: string;
  }
) {
  const number = input.number ?? 42;
  const id = input.id ?? 4200;
  return {
    action: "opened",
    repository: {
      id: ctx.githubRepoId,
      full_name: ctx.repositoryFullName,
    },
    installation: { id: Number(ctx.installationId.replace(/\D/g, "") || 1) },
    pull_request: {
      id,
      number,
      title: input.title ?? "FEA-1116 branch artifact PR",
      body: null,
      state: "open",
      draft: false,
      merged: false,
      created_at: input.createdAt ?? "2026-08-11T08:00:00.000Z",
      updated_at: input.createdAt ?? "2026-08-11T08:00:00.000Z",
      closed_at: null,
      merged_at: null,
      merge_commit_sha: null,
      html_url:
        input.htmlUrl ??
        `https://github.com/${ctx.repositoryFullName}/pull/${number}`,
      head: {
        ref: input.branchName,
        sha: input.headSha ?? "pr-head-sha",
        repo: {
          id: ctx.githubRepoId,
          full_name: ctx.repositoryFullName,
          default_branch: "main",
        },
      },
      base: {
        ref: "main",
        repo: { default_branch: "main" },
      },
    },
  } as Parameters<typeof handlePullRequest>[0];
}

export function freshPullRequest(
  ctx: TestContext,
  input: { branchName: string; headSha: string; number: number; title: string }
) {
  return {
    githubId: `github-pr-${input.number}`,
    number: input.number,
    title: input.title,
    htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/${input.number}`,
    headBranch: input.branchName,
    baseBranch: "main",
    state: ApiGitHubPRState.Open,
    mergedAt: null,
    closedAt: null,
    authorLogin: "octocat",
    isDraft: false,
    headSha: input.headSha,
    baseSha: "base-sha",
    mergeCommitSha: null,
    headRepository: {
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: String(ctx.githubRepoId),
        fullName: ctx.repositoryFullName,
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch: "main",
      },
      provenance: {
        source: RepositoryDefaultSource.PullRequestRest,
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.UserAction,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: `fixture-pr-${input.number}`,
        observedAt: "2026-08-11T09:00:00.000Z",
      },
    },
  };
}

export function branchViewRequest(externalLinkId: string) {
  return new NextRequest(
    `https://api.example.test/branch-view/${externalLinkId}`
  );
}

export function branchViewSyncRequest(externalLinkId: string) {
  return new NextRequest(
    `https://api.example.test/branch-view/${externalLinkId}/sync`,
    { method: "POST" }
  );
}

export function loopBranchArtifactRequest(loopId: string, body: unknown) {
  return new Request(
    `https://api.example.test/api/loops/${loopId}/branch-artifact`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer runner-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
}

export function routeContext<TParams extends Record<string, string>>(
  params: TParams
) {
  return { params: Promise.resolve(params) };
}

let pushDeliverySequence = 0;

export function handlePushWithTestObservation(
  event: Parameters<typeof handlePushHandler>[0]
) {
  pushDeliverySequence += 1;
  return handlePushHandler(event, {
    deliveryId: `branch-artifact-flow-${pushDeliverySequence}`,
    observedAt: new Date("2026-08-11T09:00:00.000Z"),
  });
}

export async function flushPendingPromises(pending: Promise<unknown>[]) {
  await Promise.all(pending.splice(0));
}

export function withFixtureHeadAuthority(result: any, ctx?: TestContext) {
  if (
    !result ||
    result.headRepository ||
    result.headRepositoryUnavailable ||
    !ctx
  ) {
    return result;
  }
  return {
    ...result,
    headRepository: freshPullRequest(ctx, {
      branchName: result.headBranch,
      headSha: result.headSha,
      number: result.number,
      title: result.title,
    }).headRepository,
  };
}

export function persistedSidecarAuthority(ctx: TestContext, fullName: string) {
  return persistedGitHubRepositoryAuthority({
    githubRepoId: `${ctx.githubRepoId}-sidecar`,
    fullName,
  });
}

export async function expectSuccess<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  return body.data as T;
}

export async function expectBranchViewUnavailable(
  response: Response,
  code: BranchViewLoadErrorCodeType = BranchViewLoadErrorCode.PullRequestUnavailable
) {
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body).toMatchObject({ success: false, code });
  return body;
}

export async function seedBranchWithCurrentPr(
  ctx: TestContext,
  input: {
    branchName: string;
    githubId?: string;
    lastRefreshAttemptAt?: Date | null;
    lastVerifiedAt?: Date | null;
    prNumber?: number;
    title?: string;
  }
) {
  const branchName = input.branchName;
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        type: ArtifactType.BRANCH,
        name: branchName,
        status: GitHubPRState.OPEN,
        externalUrl: `https://github.com/${ctx.repositoryFullName}/tree/${encodeURIComponent(
          branchName
        )}`,
        branch: {
          create: {
            organizationId: ctx.organizationId,
            repositoryFullName: ctx.repositoryFullName,
            repositoryId: ctx.repositoryId,
            branchName,
            baseBranch: "main",
            baseBranchSource: BranchBaseBranchSource.MigrationPrBase,
            headSha: "migrated-head",
            headShaSource: BranchHeadShaSource.MigrationPrHead,
            headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
            checksStatus: ChecksStatus.PASSING,
            fileCacheStatus: BranchFileCacheStatus.Fresh,
            fileCacheHeadSha: "migrated-head",
            fileCacheFileCount: 1,
            fileCachePatchBytes: 12,
            fileCacheUpdatedAt: new Date("2026-05-15T00:01:00Z"),
            syncStatus: BranchSyncStatus.Fresh,
          },
        },
      },
      select: { id: true },
    })
  );
  const prDetail = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId: ctx.organizationId,
        branchArtifactId: artifact.id,
        repositoryId: ctx.repositoryId,
        githubId: input.githubId ?? `${input.prNumber ?? 87_000}`,
        number: input.prNumber ?? 87,
        title: input.title ?? "Migrated PR title",
        htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/${
          input.prNumber ?? 87
        }`,
        prState: GitHubPRState.OPEN,
        isCurrent: true,
        reviewDecision: DbReviewDecision.APPROVED,
        lastVerifiedAt:
          input.lastVerifiedAt === undefined
            ? new Date()
            : input.lastVerifiedAt,
        lastRefreshAttemptAt:
          input.lastRefreshAttemptAt === undefined
            ? null
            : input.lastRefreshAttemptAt,
        ...persistedPullRequestHeadAuthority(ctx),
      },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.branchDetail.update({
      where: { artifactId: artifact.id },
      data: { currentPullRequestDetailId: prDetail.id },
    })
  );
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId: ctx.organizationId,
        sourceId: ctx.sourceArtifactId,
        targetId: artifact.id,
        linkType: LinkType.Produces,
      },
    })
  );
  await withDb((db) =>
    db.branchFileChange.create({
      data: {
        branchArtifactId: artifact.id,
        headSha: "migrated-head",
        path: "src/migrated.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        changes: 3,
        patch: "@@ migrated",
        patchBytes: 12,
        isBinary: false,
      },
    })
  );
  return { artifactId: artifact.id, prDetailId: prDetail.id };
}

function persistedPullRequestHeadAuthority(ctx: TestContext) {
  const authority = persistedGitHubRepositoryAuthority({
    githubRepoId: String(ctx.githubRepoId),
    fullName: ctx.repositoryFullName,
  });
  return {
    headRepositoryGithubId: authority.githubRepoId,
    headRepositoryFullName: authority.fullName,
    headRepositoryDefaultBranchName: authority.defaultBranchName,
    headRepositoryDefaultBranchAvailability:
      authority.defaultBranchAvailability,
    headRepositoryDefaultBranchCompleteness:
      authority.defaultBranchCompleteness,
    headRepositoryDefaultBranchReason: authority.defaultBranchReason,
    headRepositoryDefaultBranchSource: authority.defaultBranchSource,
    headRepositoryDefaultBranchMechanism: authority.defaultBranchMechanism,
    headRepositoryDefaultBranchTrigger: authority.defaultBranchTrigger,
    headRepositoryDefaultBranchCredentialType:
      authority.defaultBranchCredentialType,
    headRepositoryDefaultBranchCredentialOwnerId:
      authority.defaultBranchCredentialOwnerId,
    headRepositoryDefaultBranchObservationKey:
      authority.defaultBranchObservationKey,
    headRepositoryDefaultBranchObservedAt: authority.defaultBranchObservedAt,
    headRepositoryDefaultBranchEventAt: authority.defaultBranchEventAt,
  };
}
