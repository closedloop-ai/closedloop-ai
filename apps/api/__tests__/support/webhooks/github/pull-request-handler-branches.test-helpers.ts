import { DocumentType } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import {
  type ArtifactReference,
  MatchSource,
  MatchType,
} from "@repo/github/artifact-reference-parser";
import {
  createHandledPullRequestEvent,
  createPullRequestForAction,
  createRepository,
} from "@/__tests__/fixtures/github-webhook-fixtures";
import type { PullRequestWebhookTx } from "@/__tests__/support/webhooks/github/pull-request-handler.test-mocks";
import { makePrDetailRow } from "@/__tests__/utils/pr-detail-helpers";
import type { HandledPullRequestEvent } from "@/app/webhooks/github/handlers/pull-request-action-application";

export const ORG_ID = "org-pr-branches";
export const REPO_ID = "repo-pr-branches";
export const REPO_FULL_NAME = "owner/test-repo";
/** `createPullRequest`'s default `updated_at`. */
export const INCOMING_UPDATED_AT = new Date("2026-02-10T00:00:00Z");
/** `createPullRequest`'s default `id` and `head.sha`. */
export const INCOMING_GITHUB_ID = "1";
export const INCOMING_HEAD_SHA = "abc123";
export const INCOMING_HEAD_REF = "feature-branch";
export const PR_NUMBER = 808;

export function buildEvent(action: HandledPullRequestEvent["action"]) {
  return createHandledPullRequestEvent(
    action,
    createPullRequestForAction(action, { number: PR_NUMBER }),
    { repository: createRepository(555) }
  );
}

export function stubRepository(
  tx: PullRequestWebhookTx,
  organizationId: string | null
) {
  tx.gitHubInstallationRepository.findFirst.mockResolvedValue({
    id: REPO_ID,
    fullName: REPO_FULL_NAME,
    installation: { organizationId, installationId: "99" },
  });
}

/**
 * Answers `pullRequestDetail.findUnique` only for this repository's PR number:
 * those lookups return `byNumber` in order (the last entry repeats). Any other
 * key — including the `githubId` lookup in `createLinkageRecords` — finds
 * nothing, so a lookup against the wrong repository or number reads as absent.
 */
export function stubPrDetailLookups(
  tx: PullRequestWebhookTx,
  byNumber: unknown[]
) {
  let index = 0;
  tx.pullRequestDetail.findUnique.mockImplementation(
    (args: {
      where: { repositoryId_number?: { repositoryId: string; number: number } };
    }) => {
      const key = args.where.repositoryId_number;
      if (!(key?.repositoryId === REPO_ID && key.number === PR_NUMBER)) {
        return Promise.resolve(null);
      }
      const row = byNumber[Math.min(index, byNumber.length - 1)];
      index += 1;
      return Promise.resolve(row);
    }
  );
}

/** Answers `branchDetail.findFirst` only for this repository's head branch. */
export function stubBranchRow(tx: PullRequestWebhookTx, row: unknown) {
  tx.branchDetail.findFirst.mockImplementation(
    (args: { where: { repositoryId?: string; branchName?: string } }) =>
      Promise.resolve(
        args.where.repositoryId === REPO_ID &&
          args.where.branchName === INCOMING_HEAD_REF
          ? row
          : null
      )
  );
}

export function prDetailRow(overrides: {
  id?: string;
  githubId?: string | null;
  githubUpdatedAt?: Date | null;
  headRefName?: string | null;
  prState?: string;
  currentPullRequestDetailId?: string;
}) {
  const id = overrides.id ?? "detail-current";
  return {
    ...makePrDetailRow({
      id,
      artifactId: "branch-artifact-1",
      organizationId: ORG_ID,
      prState: overrides.prState ?? GitHubPRState.Open,
      headSha: INCOMING_HEAD_SHA,
      currentPullRequestDetailId: overrides.currentPullRequestDetailId ?? id,
    }),
    githubId: overrides.githubId ?? INCOMING_GITHUB_ID,
    githubUpdatedAt: overrides.githubUpdatedAt ?? null,
    headRefName: overrides.headRefName ?? null,
  };
}

export function planReference(): ArtifactReference {
  return {
    slug: "PLN-5",
    prefix: SlugPrefix.Plan,
    docType: DocumentType.ImplementationPlan,
    matchType: MatchType.Slug,
    source: MatchSource.Title,
  };
}
