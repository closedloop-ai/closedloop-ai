import type { PullRequest } from "@octokit/webhooks-types";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import type { TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPullRequest,
  createRepository,
} from "@/__tests__/fixtures/github-webhook-fixtures";
import { asTx } from "@/__tests__/utils/db-helpers";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import {
  buildWebhookHeadRepositoryObservation,
  persistCreatedWebhookPullRequestAuthority,
  type WebhookPullRequestProjectionTarget,
  writeExistingWebhookPullRequestProjection,
} from "./pull-request-projection";

const { logError, persistHeadAuthority, writeBranchProjection } = vi.hoisted(
  () => ({
    logError: vi.fn(),
    persistHeadAuthority: vi.fn(),
    writeBranchProjection: vi.fn(),
  })
);

vi.mock("@repo/observability/log", () => ({
  log: { error: logError },
}));

// Only the two durable writers are replaced. `BranchProjectionMode` and the
// observation types stay real so the routing under test is never re-declared
// here, and the real repository-default mapper still runs.
vi.mock("@/app/branches/github-projection-writer", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/branches/github-projection-writer")
  >()),
  writeExistingBranchPullRequestProjection: writeBranchProjection,
}));

vi.mock(
  "@/app/branches/pull-request-head-authority",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/branches/pull-request-head-authority")
    >()),
    persistPullRequestHeadRepositoryAuthority: persistHeadAuthority,
  })
);

const context = {
  deliveryId: "delivery-5826",
  observedAt: new Date("2026-08-10T20:00:00.000Z"),
};

const findFirst = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
  writeBranchProjection.mockResolvedValue({ id: PULL_REQUEST_DETAIL_ID });
  persistHeadAuthority.mockResolvedValue(true);
});

describe("buildWebhookHeadRepositoryObservation", () => {
  it("maps the fork head identity and custom default independently", () => {
    const pullRequest = headPullRequest(CANONICAL_HEAD_FULL_NAME);

    const observation = buildWebhookHeadRepositoryObservation(
      pullRequest,
      context
    );

    expect(observation?.authority).toMatchObject({
      repository: {
        providerRepositoryId: String(HEAD_REPOSITORY_ID),
        fullName: CANONICAL_HEAD_FULL_NAME,
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        defaultBranch: HEAD_DEFAULT_BRANCH,
      },
      provenance: {
        source: RepositoryDefaultSource.PullRequestWebhook,
        observationKey: context.deliveryId,
      },
    });
  });

  it("represents an inaccessible head without substituting the base", () => {
    const pullRequest = headlessPullRequest();

    const observation = buildWebhookHeadRepositoryObservation(
      pullRequest,
      context
    );

    expect(observation).toEqual({
      unavailable: {
        reason: RepositoryDefaultReason.NotReported,
        provenance: expect.objectContaining({
          source: RepositoryDefaultSource.PullRequestWebhook,
          observationKey: context.deliveryId,
        }),
      },
    });
    expect(observation).not.toHaveProperty("authority.repository.fullName");
  });

  it("preserves omission when delivery provenance is absent", () => {
    const pullRequest = headPullRequest(CANONICAL_HEAD_FULL_NAME);

    expect(
      buildWebhookHeadRepositoryObservation(pullRequest, undefined)
    ).toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      MALFORMED_AUTHORITY_EVENT,
      expect.objectContaining({
        outcome: MISSING_DELIVERY_ID_OUTCOME,
        providerPullRequestId: String(pullRequest.id),
      })
    );
  });

  it("preserves omission when the head repository name is not canonical", () => {
    const pullRequest = headPullRequest(MALFORMED_HEAD_FULL_NAME);

    const observation = buildWebhookHeadRepositoryObservation(
      pullRequest,
      context
    );

    expect(observation).toBeUndefined();
    expect(logError).not.toHaveBeenCalledWith(
      MALFORMED_AUTHORITY_EVENT,
      expect.objectContaining({ outcome: MISSING_DELIVERY_ID_OUTCOME })
    );
  });

  it("keeps the three no-authority causes distinguishable", () => {
    expect(
      noAuthorityCause(headPullRequest(CANONICAL_HEAD_FULL_NAME), undefined)
    ).toEqual({
      omitted: true,
      reportedMissingDeliveryId: true,
      typedUnavailable: false,
    });
    expect(noAuthorityCause(headlessPullRequest(), context)).toEqual({
      omitted: false,
      reportedMissingDeliveryId: false,
      typedUnavailable: true,
    });
    expect(
      noAuthorityCause(headPullRequest(MALFORMED_HEAD_FULL_NAME), context)
    ).toEqual({
      omitted: true,
      reportedMissingDeliveryId: false,
      typedUnavailable: false,
    });
  });
});

describe("writeExistingWebhookPullRequestProjection", () => {
  it("routes a branch-backed target to the branch projection writer", async () => {
    await writeExistingWebhookPullRequestProjection(
      transactionClient(),
      { ...projectionTarget(), hasBranchArtifact: true },
      headlessPullRequest(),
      "opened",
      context
    );

    expect(writeBranchProjection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ branchArtifactId: BRANCH_ARTIFACT_ID }),
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        authorLogin: "test-user",
        authorProviderUserId: "1",
        authorActorType: GitHubActorType.User,
      })
    );
  });

  it("persists head authority for a detail-only target", async () => {
    const pullRequest = headlessPullRequest();

    await writeExistingWebhookPullRequestProjection(
      transactionClient(),
      {
        ...projectionTarget(),
        hasBranchArtifact: false,
        pullRequestDetailId: PULL_REQUEST_DETAIL_ID,
      },
      pullRequest,
      "opened",
      context
    );

    expect(persistHeadAuthority).toHaveBeenCalledWith(
      expect.anything(),
      {
        organizationId: ORGANIZATION_ID,
        pullRequestDetailId: PULL_REQUEST_DETAIL_ID,
      },
      expect.objectContaining({
        unavailable: expect.objectContaining({
          reason: RepositoryDefaultReason.NotReported,
        }),
      }),
      { name: pullRequest.head.ref, oid: pullRequest.head.sha }
    );
    expect(writeBranchProjection).not.toHaveBeenCalled();
  });

  it("writes nothing for a target with neither a branch artifact nor a pull request detail", async () => {
    await expect(
      writeExistingWebhookPullRequestProjection(
        transactionClient(),
        {
          ...projectionTarget(),
          hasBranchArtifact: false,
          pullRequestDetailId: null,
        },
        headlessPullRequest(),
        "opened",
        context
      )
    ).resolves.toBeUndefined();

    expect(writeBranchProjection).not.toHaveBeenCalled();
    expect(persistHeadAuthority).not.toHaveBeenCalled();
  });
});

describe("persistCreatedWebhookPullRequestAuthority", () => {
  it("persists authority against the created row matched by provider id", async () => {
    const pullRequest = headlessPullRequest();
    findFirst.mockResolvedValue({ id: PULL_REQUEST_DETAIL_ID });

    await persistCreatedWebhookPullRequestAuthority(
      transactionClient(),
      ORGANIZATION_ID,
      pullRequest,
      context
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          githubId: String(pullRequest.id),
          organizationId: ORGANIZATION_ID,
        },
      })
    );
    expect(persistHeadAuthority).toHaveBeenCalledWith(
      expect.anything(),
      {
        organizationId: ORGANIZATION_ID,
        pullRequestDetailId: PULL_REQUEST_DETAIL_ID,
      },
      expect.anything(),
      { name: pullRequest.head.ref, oid: pullRequest.head.sha }
    );
  });

  it("writes no authority when no created row matches the provider id", async () => {
    findFirst.mockResolvedValue(null);

    await persistCreatedWebhookPullRequestAuthority(
      transactionClient(),
      ORGANIZATION_ID,
      headlessPullRequest(),
      context
    );

    expect(persistHeadAuthority).not.toHaveBeenCalled();
  });
});

const MALFORMED_AUTHORITY_EVENT =
  "github_repository_default_authority_malformed";
const MISSING_DELIVERY_ID_OUTCOME = "missing_delivery_id";
const CANONICAL_HEAD_FULL_NAME = "fork-owner/test-repo";
/** Non-canonical: no slash, so the identity refinement rejects the authority. */
const MALFORMED_HEAD_FULL_NAME = "malformed-no-slash";
const HEAD_DEFAULT_BRANCH = "trunk";
const HEAD_REPOSITORY_ID = 5826;
const BRANCH_ARTIFACT_ID = "branch-artifact-1";
const ORGANIZATION_ID = "org-1";
const PULL_REQUEST_DETAIL_ID = "pr-detail-1";

function headPullRequest(fullName: string): PullRequest {
  return createPullRequest({
    head: {
      repo: createRepository(HEAD_REPOSITORY_ID, {
        full_name: fullName,
        default_branch: HEAD_DEFAULT_BRANCH,
      }),
    },
  });
}

function headlessPullRequest(): PullRequest {
  return createPullRequest({ head: { repo: null } });
}

/**
 * The discriminators that separate the three no-authority causes. Two of them
 * return the same `undefined`, so the reported outcome is what tells them apart.
 */
function noAuthorityCause(
  pullRequest: PullRequest,
  observationContext: GitHubWebhookObservationContext | undefined
) {
  logError.mockClear();
  const observation = buildWebhookHeadRepositoryObservation(
    pullRequest,
    observationContext
  );
  return {
    omitted: observation === undefined,
    reportedMissingDeliveryId: logError.mock.calls.some(
      ([event, payload]) =>
        event === MALFORMED_AUTHORITY_EVENT &&
        payload?.outcome === MISSING_DELIVERY_ID_OUTCOME
    ),
    typedUnavailable:
      observation?.unavailable?.reason === RepositoryDefaultReason.NotReported,
  };
}

function projectionTarget(): WebhookPullRequestProjectionTarget {
  return {
    branchArtifactId: BRANCH_ARTIFACT_ID,
    checksStatus: undefined,
    currentHeadSha: null,
    organizationId: ORGANIZATION_ID,
    pullRequestDetailId: null,
    repositoryId: "repo-1",
    repositoryFullName: CANONICAL_HEAD_FULL_NAME,
  };
}

function transactionClient(): TransactionClient {
  return asTx({ pullRequestDetail: { findFirst } });
}
