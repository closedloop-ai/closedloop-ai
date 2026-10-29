/**
 * PLN-1775 M0-M5 (ISS-7403) — the whole installation-free lane, end to end
 * against Postgres.
 *
 * Every unit suite behind this chain mocks its neighbours, so each one stays
 * green while the HANDOFF between two of them is broken — which is exactly the
 * shape of the bug this plan exists to fix: each half worked, and the org still
 * saw zeroes. Only GitHub itself is faked here. Ingest, observation, credential
 * verification, tier discovery, branch authority, targeted PR enrichment, and
 * the delivery KPI read are all the real thing, against the real schema.
 *
 * Reverting ANY of M0-M5 fails this: no table (M0), no observation (M1), no
 * verified identity (M2), no tier-2 target candidate (M3), no branch to hang
 * the PR on (M4), no session-linked PullRequestDetail row for targeted
 * enrichment (M5).
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
} from "@repo/api/src/types/agent-session";
import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import {
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";
import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  BRANCH_PUSH_METHOD_VALUES,
} from "@repo/api/src/types/session-artifact-link";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  queryBundledPullRequestsWithProviderResult: vi.fn(),
}));

vi.mock("@repo/github/pull-request-point-read", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/github/pull-request-point-read")
  >()),
  getRepositoryPullRequestsByNumberWithProviderResult: vi.fn(),
}));

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: vi.fn(),
}));

import {
  GitHubProviderResultStatus,
  queryBundledPullRequestsWithProviderResult,
} from "@repo/github";
import { getRepositoryPullRequestsByNumberWithProviderResult } from "@repo/github/pull-request-point-read";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { branchReadService } from "@/app/branches/branch-read-service";
import { runObservedRepositoryVerification } from "@/app/cron/bootstrap-repo-sync-states/verify-phase";
import { githubPullRequestReconcilerService } from "@/app/cron/reconcile-pull-requests/service";
import { selectSessionLinkedPullRequestTargets } from "@/app/cron/reconcile-pull-requests/session-linked-targets";
import { insightsService } from "@/app/insights/service";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import { GitHubRepoSyncTier } from "@/lib/github/github-repo-sync-state";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const mockGetClient = getGitHubSyncClient as unknown as ReturnType<
  typeof vi.fn
>;
const mockBundledQuery =
  queryBundledPullRequestsWithProviderResult as unknown as ReturnType<
    typeof vi.fn
  >;
const mockPointRead =
  getRepositoryPullRequestsByNumberWithProviderResult as unknown as ReturnType<
    typeof vi.fn
  >;

const NOW = new Date("2026-08-21T12:00:00.000Z");
const STARTED_AT = new Date("2026-08-20T10:00:00.000Z");
const UPDATED_AT = new Date("2026-08-20T11:00:00.000Z");
const MERGED_AT = new Date("2026-08-20T12:00:00.000Z");
const REPOSITORY = "acme/oauth-only";
const HEAD_BRANCH = "feat/installation-free";
const PROVIDER_REPO_ID = "606060";

function syncClient() {
  return {
    octokit: {
      rest: {
        repos: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: Number(PROVIDER_REPO_ID),
              full_name: REPOSITORY,
              name: "oauth-only",
              owner: { login: "acme" },
              html_url: `https://github.com/${REPOSITORY}`,
              private: true,
              default_branch: "main",
              pushed_at: UPDATED_AT.toISOString(),
            },
          }),
        },
      },
    },
    kind: GitHubCredentialKind.OauthUser,
    actingAs: { githubUserId: "gh-1", login: "octocat" },
    credentialOwnerId: null,
    rateLimitTier: null,
    recordRateLimit: vi.fn().mockResolvedValue(undefined),
    recordRepoAccess: vi.fn().mockResolvedValue(undefined),
  };
}

function mergedPullRequest() {
  return {
    githubId: "PR_installation_free_1",
    number: 7,
    title: "Ship the installation-free lane",
    htmlUrl: `https://github.com/${REPOSITORY}/pull/7`,
    headBranch: HEAD_BRANCH,
    baseBranch: "main",
    headSha: "head-sha-7",
    state: GitHubPRState.Merged,
    isDraft: false,
    additions: 900,
    deletions: 100,
    changedFiles: 12,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: STARTED_AT.toISOString(),
    closedAt: MERGED_AT.toISOString(),
    mergedAt: MERGED_AT.toISOString(),
    mergeCommitSha: "merge-sha-7",
    updatedAt: MERGED_AT.toISOString(),
    author: "octocat",
    source: "provider",
    headRepository: {
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: PROVIDER_REPO_ID,
        fullName: REPOSITORY,
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch: "main",
      },
      provenance: {
        source: RepositoryDefaultSource.PullRequestGraphql,
        mechanism: GitHubFetchMechanism.Graphql,
        trigger: GitHubFetchTrigger.Backfill,
        credentialType: GitHubFetchCredentialType.UserOAuth,
        observationKey: "point-read-pr-7",
        observedAt: NOW.toISOString(),
      },
    },
  };
}

function desktopPayload(
  options: {
    batchId?: string;
    externalSessionId?: string;
    prMethod?: ArtifactRefMethod;
    prNumber?: number;
    prRelation?: ArtifactRefRelation;
  } = {}
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: options.batchId ?? "7c9f0b71-5f4e-4a1d-9b7e-0f5a1c2d3e4c",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId:
          options.externalSessionId ?? "ext-installation-free-1",
        name: "Installation-free session",
        status: "active",
        harness: "claude",
        cwd: "/tmp/worktree",
        model: "claude-opus",
        startedAt: STARTED_AT.toISOString(),
        updatedAt: UPDATED_AT.toISOString(),
        agents: [],
        events: [],
        tokenUsageByModel: [],
        artifactRefs: [
          {
            kind: ArtifactRefTargetKind.Branch,
            repositoryFullName: REPOSITORY,
            branchName: HEAD_BRANCH,
            method: BRANCH_PUSH_METHOD_VALUES[0],
            relation: ArtifactRefRelation.Created,
            observedAt: UPDATED_AT.toISOString(),
          },
          {
            kind: ArtifactRefTargetKind.PullRequest,
            repositoryFullName: REPOSITORY,
            prNumber: options.prNumber ?? 7,
            branchName: HEAD_BRANCH,
            method: options.prMethod ?? ArtifactRefMethod.PrCreateOutput,
            relation: options.prRelation ?? ArtifactRefRelation.Created,
            observedAt: UPDATED_AT.toISOString(),
          },
        ],
      },
    ],
  };
}

async function seedRepoScopedConnection(
  organizationId: string,
  userId: string
): Promise<void> {
  await withDb((db) =>
    db.gitHubUserConnection.create({
      data: {
        organizationId,
        userId,
        githubUserId: "gh-1",
        login: "octocat",
        normalizedLogin: "octocat",
        scopes: [GITHUB_REPO_SCOPE],
      },
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClient.mockImplementation(() =>
    Promise.resolve({ ok: true, value: syncClient() })
  );
  mockBundledQuery.mockRejectedValue(
    new Error("tier-2 targeted sync must not call the bundled sweep reader")
  );
  mockPointRead.mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: {
      pullRequests: [mergedPullRequest()],
      rateLimit: {
        cost: 1,
        remaining: 4999,
        resetAt: "2026-08-21T13:00:00.000Z",
        state: GitHubProviderBudgetState.Available,
      },
      pageInfo: { hasNextPage: false, endCursor: null },
      hasMore: false,
      truncated: false,
      nextCursor: null,
      fetchedPages: 1,
      stopReason: GitHubBundledPullRequestsStopReason.Complete,
      targetNumbers: [7],
      missingTargetNumbers: [],
      attemptedNumbers: [7],
      missingNumbers: [],
      unattemptedNumbers: [],
    },
  });
});

describeIfDb(
  "installation-free org reaches delivery KPIs from a cold start",
  () => {
    it("turns a desktop-observed repository into merged-PR KPIs with no App installation", async () => {
      await committedOrganizations.run(async () => {
        const organizationId = await committedOrganizations.create();
        const user = await createTestUser(organizationId);
        const computeTarget = await withDb((db) =>
          db.computeTarget.create({
            data: {
              organizationId,
              userId: user.id,
              machineName: "installation-free-machine",
              platform: "darwin",
            },
            select: { id: true },
          })
        );
        await seedRepoScopedConnection(organizationId, user.id);

        // M1 — the desktop names a repository the server has no record of.
        await agentSessionsService.upsertSessions(
          {
            organizationId,
            userId: user.id,
            computeTargetId: computeTarget.id,
          },
          desktopPayload()
        );

        // M2 + M3 — the cron verifies it with the org's own credential and
        // turns the verified row into a tier-2 targeted-sync candidate.
        const verification = await runObservedRepositoryVerification({
          now: NOW,
        });
        expect(verification.repositoriesVerified).toBeGreaterThan(0);

        // The desktop syncs again, which is what actually happens: the first
        // sync above named a repository nothing had verified yet, so the
        // branch ref could not materialize and no session contribution was
        // recorded. Verification is what unblocks it, and only a sync AFTER
        // verification carries the session's authorship onto the branch —
        // which is what every Product surface's "Wrote" gate reads (#5551).
        await agentSessionsService.upsertSessions(
          {
            organizationId,
            userId: user.id,
            computeTargetId: computeTarget.id,
          },
          desktopPayload()
        );

        const observed = await withDb((db) =>
          db.gitHubObservedRepository.findFirst({
            where: { organizationId, repositoryFullName: REPOSITORY },
            select: { verificationState: true, githubRepoId: true },
          })
        );
        expect(observed).toEqual({
          verificationState: GitHubObservedRepositoryVerificationState.Verified,
          githubRepoId: PROVIDER_REPO_ID,
        });

        const syncState = await withDb((db) =>
          db.gitHubRepoSyncState.findFirst({
            where: { organizationId, repositoryFullName: REPOSITORY },
            select: { tier: true },
          })
        );
        expect(syncState?.tier).toBe(GitHubRepoSyncTier.UserToken);
        await expect(
          selectSessionLinkedPullRequestTargets({
            organizationId,
            repositoryId: null,
            repositoryFullName: REPOSITORY,
            now: NOW,
          })
        ).resolves.toEqual([
          expect.objectContaining({
            number: 7,
          }),
        ]);

        // M4 + M5 — the targeted sweep fetches the session-linked stub by PR
        // number, without falling back to repository history.
        const sweep =
          await githubPullRequestReconcilerService.runForOrganization(
            organizationId,
            {
              limit: 10,
              now: NOW,
            }
          );
        expect(sweep.pullRequestsWritten).toBeGreaterThan(0);
        expect(mockPointRead).toHaveBeenCalledWith(
          expect.anything(),
          "acme",
          "oauth-only",
          [7],
          expect.any(Function),
          expect.objectContaining({
            credentialType: GitHubFetchCredentialType.UserOAuth,
            mechanism: GitHubFetchMechanism.Graphql,
            trigger: GitHubFetchTrigger.Backfill,
          })
        );
        expect(mockBundledQuery).not.toHaveBeenCalled();

        const pullRequests = await withDb((db) =>
          db.pullRequestDetail.findMany({
            where: { organizationId },
            select: {
              number: true,
              repositoryId: true,
              repositoryFullName: true,
              prState: true,
              additions: true,
              deletions: true,
              mergedAt: true,
              isCurrent: true,
              lastVerifiedAt: true,
            },
          })
        );
        expect(pullRequests).toEqual([
          {
            number: 7,
            // No installation exists, so there is no surrogate repository id —
            // the row lives under the partial repo-less unique.
            repositoryId: null,
            repositoryFullName: REPOSITORY,
            prState: "MERGED",
            additions: 900,
            deletions: 100,
            mergedAt: MERGED_AT,
            // The targeted reconciler verifies the session-linked stub and
            // leaves the branch pointing at verified provider truth.
            isCurrent: true,
            lastVerifiedAt: NOW,
          },
        ]);

        const branches = await withDb((db) =>
          db.branchDetail.findMany({
            where: { organizationId },
            select: {
              repositoryFullName: true,
              branchName: true,
              currentPullRequestDetailId: true,
            },
          })
        );
        expect(branches).toMatchObject([
          {
            repositoryFullName: REPOSITORY,
            branchName: HEAD_BRANCH,
            currentPullRequestDetailId: expect.any(String),
          },
        ]);

        // A row in `branch_detail` is not a visible branch. Every Product
        // surface gates on `cloudBranchProductEligibilitySql`, the SQL twin of
        // the write-side `isCloudBranchEligible`, and the raw table read above
        // bypasses it entirely — so the two gates can read different authority
        // source sets and nothing here would notice.
        //
        // For THIS org the verified observation is the only authority that
        // exists: no active installation and no `public_repositories` row.
        const [branchArtifact] = await withDb((db) =>
          db.branchDetail.findMany({
            where: { organizationId },
            select: { artifactId: true },
          })
        );
        const branchArtifactId = branchArtifact?.artifactId ?? "";
        const eligibility = await branchProductEligibilityService.findByIds(
          organizationId,
          [branchArtifactId]
        );
        expect(eligibility.get(branchArtifactId)).toBe(
          BranchProductEligibility.Eligible
        );

        const branchList = await branchReadService.listBranches(
          organizationId,
          { limit: 10, offset: 0 }
        );
        expect(branchList.items).toEqual([
          expect.objectContaining({
            branchName: HEAD_BRANCH,
            prNumber: 7,
            prTitle: "Ship the installation-free lane",
          }),
        ]);

        // The acceptance criterion the whole plan exists for.
        const delivery = await insightsService.getDelivery(
          {
            organizationId,
            userId: user.id,
            scope: InsightsScope.Org,
          },
          InsightsPeriod.Quarter,
          NOW
        );
        const mergedCount = delivery.kpis.find(
          (kpi) => kpi.key === "mergedCount"
        );
        const kloc = delivery.kpis.find((kpi) => kpi.key === "kloc");
        expect(mergedCount?.value).toBe(1);
        // 900 + 100 lines over one merged PR — a real number, not the null the
        // org saw for every one of these before the lane existed.
        expect(kloc?.value).toBe(1);
      });
    });

    it("does not make a PR row that lacks command-derived session PR identity a session-linked target", async () => {
      await committedOrganizations.run(async () => {
        const organizationId = await committedOrganizations.create();
        const user = await createTestUser(organizationId);
        const computeTarget = await withDb((db) =>
          db.computeTarget.create({
            data: {
              organizationId,
              userId: user.id,
              machineName: "installation-free-prose-machine",
              platform: "darwin",
            },
            select: { id: true },
          })
        );
        await seedRepoScopedConnection(organizationId, user.id);
        const payload = desktopPayload({
          batchId: "3b981c82-7656-44be-bd40-ff8654f9c39a",
          externalSessionId: "ext-installation-free-prose",
          prMethod: ArtifactRefMethod.PrMentionInProse,
          prNumber: 17,
          prRelation: ArtifactRefRelation.Referenced,
        });

        await agentSessionsService.upsertSessions(
          {
            organizationId,
            userId: user.id,
            computeTargetId: computeTarget.id,
          },
          payload
        );
        await runObservedRepositoryVerification({ now: NOW });
        await agentSessionsService.upsertSessions(
          {
            organizationId,
            userId: user.id,
            computeTargetId: computeTarget.id,
          },
          payload
        );

        const branch = await withDb((db) =>
          db.branchDetail.findFirstOrThrow({
            where: {
              organizationId,
              repositoryFullName: REPOSITORY,
              branchName: HEAD_BRANCH,
            },
            select: { artifactId: true },
          })
        );
        const pullRequest = await withDb(async (db) => {
          const existing = await db.pullRequestDetail.findFirst({
            where: {
              organizationId,
              repositoryId: null,
              repositoryFullName: REPOSITORY,
              number: 17,
            },
            select: { id: true },
          });
          if (existing) {
            return existing;
          }
          return db.pullRequestDetail.create({
            data: {
              organizationId,
              branchArtifactId: branch.artifactId,
              repositoryId: null,
              repositoryFullName: REPOSITORY,
              number: 17,
              title: "Prose-only PR reference",
              htmlUrl: `https://github.com/${REPOSITORY}/pull/17`,
            },
            select: { id: true },
          });
        });
        // ISS-12292 (Perrin's ruling, 2026-10-09): the reconcile sweep now
        // point-reads an OPEN row with no qualifying session link through the
        // unlinked-open arm, so this row IS read. What stays pinned is that a
        // prose mention does not make it a session-linked target.
        const targets = await selectSessionLinkedPullRequestTargets({
          organizationId,
          repositoryId: null,
          repositoryFullName: REPOSITORY,
          now: NOW,
        });
        expect(
          targets.map((target) => target.pullRequestDetailId)
        ).not.toContain(pullRequest.id);
      });
    });
  }
);
