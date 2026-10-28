/**
 * ISS-8462 — a desktop-originated PR must stay reconcilable after its first
 * successful refresh.
 *
 * Against a real Postgres, because the defect is a SQL predicate: the tier-2
 * stub arm keyed on `fetch_mechanism`, which `writeReconciledPullRequest`
 * overwrites to `graphql` on every success, so the row that had just been
 * refreshed no longer matched the arm it arrived on and was never offered
 * again. A mocked `$queryRaw` cannot see that — it returns whatever the test
 * hands it, whatever the predicate says.
 *
 * The desktop row here is created by the real ingest, not seeded, so the
 * production write of the durable marker is under test too.
 */

import { mapPullRequestsByNumberResponse } from "@repo/api/src/github-pull-requests-by-number";
import { CollaboratorArtifactType } from "@repo/api/src/types/artifact-collaborators";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { BranchPersonProvider } from "@repo/api/src/types/branch-identity";
import {
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  GitHubFetchMechanism,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ExternalCommentProvider, withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import { artifactCollaboratorsService } from "@/app/artifacts/collaborators/service";
import { RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS } from "@/app/cron/reconcile-pull-requests/constants";
import { writeReconciledPullRequest } from "@/app/cron/reconcile-pull-requests/reconcile-projection-write";
import { selectSessionLinkedPullRequestTargets } from "@/app/cron/reconcile-pull-requests/session-linked-targets";
import { joinAmbientTransactionForSessionSyncWrites } from "../utils/db-helpers";
import {
  baseFixture,
  branchRef,
  findBranch,
  findPrByBranchNumber,
  pullRequestRef,
  syncSession,
} from "./agent-session-pr-sync-helpers";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REPOSITORY = "acme/widgets";
const NORMALIZED = normalizeRepoFullName(REPOSITORY);
const BRANCH_NAME = "feature/iss8462";
const DESKTOP_PR = 42;
const PROVIDER_PR = 99;
const UNVERIFIED_PEER_PR = 77;
const RECONCILE_AT = new Date("2026-07-11T12:00:00.000Z");
const AFTER_DEBOUNCE = new Date(
  RECONCILE_AT.getTime() + RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS + 60_000
);
const TX_BUDGET = { maxWait: 5000, timeout: 20_000 };

function reconciledReadModel(): GitHubReadModelPullRequest {
  return {
    githubId: "PR_iss8462_desktop",
    number: DESKTOP_PR,
    title: "Desktop-originated PR",
    htmlUrl: `https://github.com/${NORMALIZED}/pull/${DESKTOP_PR}`,
    headBranch: BRANCH_NAME,
    baseBranch: "main",
    headSha: "head-sha-42",
    state: GitHubPRState.Open,
    isDraft: false,
    additions: 120,
    deletions: 8,
    changedFiles: 5,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-07-10T10:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: "2026-07-10T11:30:00.000Z",
    author: "octocat",
    source: GitHubReadModelSource.Provider,
  };
}

function selectAt(organizationId: string, now: Date) {
  return selectSessionLinkedPullRequestTargets({
    organizationId,
    repositoryId: null,
    repositoryFullName: REPOSITORY,
    now,
  });
}

function selectedNumbers(
  targets: Awaited<ReturnType<typeof selectSessionLinkedPullRequestTargets>>
) {
  return targets.map((target) => target.number).sort((a, b) => a - b);
}

/**
 * Reduce the session's evidence to the branch push alone, which is the state
 * the tier-2 stub arm exists to rescue: a PR row the desktop produced whose
 * session carries no command-derived PR link to admit it through the first arm.
 * Leaving the PR link in place would let that first arm satisfy every
 * assertion below without the stub arm ever being consulted.
 */
async function reduceToBranchPushEvidence(
  organizationId: string,
  branchArtifactId: string
): Promise<void> {
  const links = await withDb((db) =>
    db.artifactLink.findMany({
      where: { organizationId, targetId: branchArtifactId },
      select: { id: true, metadata: true },
    })
  );
  for (const link of links) {
    const metadata = (link.metadata ?? {}) as Record<string, unknown>;
    await withDb((db) =>
      db.artifactLink.update({
        where: { id: link.id },
        data: {
          metadata: {
            ...metadata,
            linkKind: SessionArtifactLinkKind.SessionBranch,
            linkKinds: [SessionArtifactLinkKind.SessionBranch],
            prNumber: null,
            prRefs: [],
          },
        },
      })
    );
  }
}

/**
 * A second PR on the SAME branch, so it shares the branch-push evidence the
 * stub arm requires and differs from the desktop row only in origin. Without
 * it "the desktop row is selected" would also hold for a selector that ignored
 * origin entirely.
 */
function seedProviderOwnedPeer(
  organizationId: string,
  branchArtifactId: string
) {
  return withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId,
        repositoryId: null,
        repositoryFullName: NORMALIZED,
        number: PROVIDER_PR,
        htmlUrl: `https://github.com/${NORMALIZED}/pull/${PROVIDER_PR}`,
        prState: GitHubPRState.Open,
        fetchMechanism: GitHubFetchMechanism.Graphql,
      },
      select: { id: true, desktopOriginated: true },
    })
  );
}

describeIfDb("ISS-8462 desktop-origin reconcile selector", () => {
  it("turns an unmeasured Desktop PR into one immutable unlinked collaborator after the bounded provider refresh", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const refs = [
        branchRef(REPOSITORY, BRANCH_NAME),
        pullRequestRef({
          repositoryFullName: REPOSITORY,
          prNumber: DESKTOP_PR,
          branchName: BRANCH_NAME,
          state: GitHubPRState.Open,
        }),
      ];
      await syncSession({ ...fx, artifactRefs: refs });
      const branch = await findBranch(
        fx.organizationId,
        NORMALIZED,
        BRANCH_NAME
      );
      const branchId = branch?.artifactId;
      expect(branchId).toBeDefined();
      if (!branchId) {
        throw new Error("Desktop ingest failed to materialize its Branch");
      }
      const readAuthor = () =>
        withDb((db) =>
          db.pullRequestDetail.findFirstOrThrow({
            where: {
              organizationId: fx.organizationId,
              branchArtifactId: branchId,
              number: DESKTOP_PR,
            },
            select: { authorProviderUserId: true, authorActorType: true },
          })
        );
      expect(await readAuthor()).toEqual({
        authorProviderUserId: null,
        authorActorType: null,
      });
      const fetched = mapPullRequestsByNumberResponse({
        repository: {
          pr_42: {
            id: "PR_42",
            databaseId: 42,
            number: DESKTOP_PR,
            url: `https://github.com/${NORMALIZED}/pull/${DESKTOP_PR}`,
            state: "OPEN",
            headRefName: BRANCH_NAME,
            baseRefName: "main",
            updatedAt: "2026-07-10T11:30:00.000Z",
            author: {
              login: "provider-author",
              databaseId: 123_456,
              __typename: "User",
            },
          },
        },
      }).pullRequests[0];
      if (!fetched) {
        throw new Error(
          "Bounded provider acquisition omitted its requested PR"
        );
      }
      expect(
        await writeReconciledPullRequest(fetched, {
          organizationId: fx.organizationId,
          repositoryId: null,
          repositoryFullName: REPOSITORY,
          credentialKind: GitHubCredentialKind.OauthUser,
          credentialOwnerId: null,
          now: RECONCILE_AT,
        })
      ).toBe(true);
      await syncSession({ ...fx, artifactRefs: refs });
      expect(await readAuthor()).toEqual({
        authorProviderUserId: "123456",
        authorActorType: GitHubActorType.User,
      });
      const external = await withDb((db) =>
        db.externalCommentAuthor.findUniqueOrThrow({
          where: {
            organizationId_provider_providerUserId: {
              organizationId: fx.organizationId,
              provider: ExternalCommentProvider.GITHUB,
              providerUserId: "123456",
            },
          },
          select: { userId: true, user: { select: { active: true } } },
        })
      );
      expect(external.user.active).toBe(false);
      const result = await artifactCollaboratorsService.readBatch(
        fx.organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [branchId],
        }
      );
      expect(
        result.results[0]?.collaborators.people.filter(
          (person) => person.id === "123456"
        )
      ).toEqual([
        expect.objectContaining({
          provider: BranchPersonProvider.GitHub,
          id: "123456",
          userId: external.userId,
          actorType: GitHubActorType.User,
        }),
      ]);
    }, TX_BUDGET);
  });

  it("keeps refreshing a desktop-originated PR after a successful reconcile, without re-selecting it every tick", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();

      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(REPOSITORY, BRANCH_NAME),
          pullRequestRef({
            repositoryFullName: REPOSITORY,
            prNumber: DESKTOP_PR,
            branchName: BRANCH_NAME,
            title: "Desktop-originated PR",
            state: GitHubPRState.Open,
          }),
        ],
      });

      const branch = await findBranch(
        fx.organizationId,
        NORMALIZED,
        BRANCH_NAME
      );
      expect(branch).not.toBeNull();
      const branchArtifactId = branch?.artifactId as string;

      const ingested = await findPrByBranchNumber(branchArtifactId, DESKTOP_PR);
      // The desktop ingest itself must stamp the durable marker; nothing else
      // ever sets it, so a selector keyed on it would be dead without this.
      expect(ingested?.desktopOriginated).toBe(true);
      expect(ingested?.fetchMechanism).toBe(GitHubFetchMechanism.DesktopSync);

      const peer = await seedProviderOwnedPeer(
        fx.organizationId,
        branchArtifactId
      );
      expect(peer.desktopOriginated).toBe(false);

      await reduceToBranchPushEvidence(fx.organizationId, branchArtifactId);

      // The row is reachable through the stub arm before any reconcile, and the
      // provider-owned peer on the same branch is not. Without this positive
      // half the debounce assertion below would pass on a selector that never
      // returned anything at all.
      expect(
        selectedNumbers(await selectAt(fx.organizationId, RECONCILE_AT))
      ).toEqual([DESKTOP_PR]);

      const wrote = await writeReconciledPullRequest(reconciledReadModel(), {
        organizationId: fx.organizationId,
        repositoryId: null,
        repositoryFullName: REPOSITORY,
        credentialKind: GitHubCredentialKind.OauthUser,
        credentialOwnerId: null,
        now: RECONCILE_AT,
      });
      expect(wrote).toBe(true);

      const reconciled = await findPrByBranchNumber(
        branchArtifactId,
        DESKTOP_PR
      );
      // The precondition for the freeze actually occurred: the reconciler
      // relabelled the row's last writer, and the origin marker survived it.
      expect(reconciled?.fetchMechanism).toBe(GitHubFetchMechanism.Graphql);
      expect(reconciled?.desktopOriginated).toBe(true);
      expect(reconciled?.lastVerifiedAt).toEqual(RECONCILE_AT);

      // Debounce: the same tick must not offer the row again. Paired with the
      // selection above, this is the half that keeps a durable-origin arm from
      // becoming the every-15-minutes starvation loop ISS-8423 rejected.
      expect(
        selectedNumbers(await selectAt(fx.organizationId, RECONCILE_AT))
      ).toEqual([]);

      // Past the debounce window the row is offered again. Keyed on
      // `fetch_mechanism` this returns [] forever, which is the defect.
      expect(
        selectedNumbers(await selectAt(fx.organizationId, AFTER_DEBOUNCE))
      ).toEqual([DESKTOP_PR]);
    }, TX_BUDGET);
  });

  // The durable marker never clears, so a reconciled row stays in the arm
  // forever. That is the fix, and it is also the thing that could re-create
  // ISS-8423's starvation — so pin that such a row takes its place by staleness
  // rather than jumping ahead of a peer that has never been verified at all.
  it("orders a reconciled desktop row behind a never-verified peer rather than ahead of it", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();

      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(REPOSITORY, BRANCH_NAME),
          pullRequestRef({
            repositoryFullName: REPOSITORY,
            prNumber: DESKTOP_PR,
            branchName: BRANCH_NAME,
            title: "Desktop-originated PR",
            state: GitHubPRState.Open,
          }),
        ],
      });
      const branch = await findBranch(
        fx.organizationId,
        NORMALIZED,
        BRANCH_NAME
      );
      const branchArtifactId = branch?.artifactId as string;
      await reduceToBranchPushEvidence(fx.organizationId, branchArtifactId);

      await writeReconciledPullRequest(reconciledReadModel(), {
        organizationId: fx.organizationId,
        repositoryId: null,
        repositoryFullName: REPOSITORY,
        credentialKind: GitHubCredentialKind.OauthUser,
        credentialOwnerId: null,
        now: RECONCILE_AT,
      });

      // A never-attempted, never-verified desktop peer: the ordinary arm admits
      // it on `last_refresh_attempt_at IS NULL`, and a NULL cannot satisfy the
      // stub cohort's `<` comparison, so both rows land in the same batch and
      // `last_verified_at ASC NULLS FIRST` alone decides the order.
      await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId: fx.organizationId,
            branchArtifactId,
            repositoryId: null,
            repositoryFullName: NORMALIZED,
            number: UNVERIFIED_PEER_PR,
            htmlUrl: `https://github.com/${NORMALIZED}/pull/${UNVERIFIED_PEER_PR}`,
            prState: GitHubPRState.Open,
            fetchMechanism: GitHubFetchMechanism.DesktopSync,
            desktopOriginated: true,
            lastVerifiedAt: null,
            lastRefreshAttemptAt: null,
          },
        })
      );

      const targets = await selectAt(fx.organizationId, AFTER_DEBOUNCE);

      // Both are offered — the reconciled row is not dropped — but the
      // never-verified one is served first.
      expect(targets.map((target) => target.number)).toEqual([
        UNVERIFIED_PEER_PR,
        DESKTOP_PR,
      ]);
    }, TX_BUDGET);
  });

  /**
   * chatgpt-codex-connector on #6214: cloud migrations run in the database
   * package's build-time `prebuild`, so the PREVIOUS API deployment is still
   * writing while the column lands. A `desktop_sync` row it inserts after the
   * migration has taken its snapshot carries `desktop_originated = false`, and
   * a selector keyed on the column alone drops it on the first tick after the
   * new build activates — permanently, if that session never syncs again.
   *
   * The compatibility shim in the arm is what admits it. This case builds
   * exactly that row: desktop last-writer, marker never stamped.
   */
  it("still admits a desktop_sync row an old writer left unmarked during the rollout window", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();

      await syncSession({
        ...fx,
        artifactRefs: [branchRef(REPOSITORY, BRANCH_NAME)],
      });
      const branch = await findBranch(
        fx.organizationId,
        NORMALIZED,
        BRANCH_NAME
      );
      const branchArtifactId = branch?.artifactId as string;
      await reduceToBranchPushEvidence(fx.organizationId, branchArtifactId);

      const skewed = await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId: fx.organizationId,
            branchArtifactId,
            repositoryId: null,
            repositoryFullName: NORMALIZED,
            number: DESKTOP_PR,
            htmlUrl: `https://github.com/${NORMALIZED}/pull/${DESKTOP_PR}`,
            prState: GitHubPRState.Open,
            fetchMechanism: GitHubFetchMechanism.DesktopSync,
            desktopOriginated: false,
          },
          select: { desktopOriginated: true },
        })
      );
      // The premise of the hazard, not an incidental detail: if this were true
      // the row would be admitted by the durable marker and the shim untested.
      expect(skewed.desktopOriginated).toBe(false);

      // A provider-owned peer on the same branch, so "the row is selected" is
      // not also true of a selector that ignored origin altogether.
      await seedProviderOwnedPeer(fx.organizationId, branchArtifactId);

      expect(
        selectedNumbers(await selectAt(fx.organizationId, RECONCILE_AT))
      ).toEqual([DESKTOP_PR]);
    }, TX_BUDGET);
  });

  it("marks a pre-existing unowned stub the desktop adopts, not only rows it inserts", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();

      await syncSession({
        ...fx,
        artifactRefs: [branchRef(REPOSITORY, BRANCH_NAME)],
      });
      const branch = await findBranch(
        fx.organizationId,
        NORMALIZED,
        BRANCH_NAME
      );
      const branchArtifactId = branch?.artifactId as string;

      // No provenance and no githubId: webhook-wins leaves this row to the
      // desktop, so the next sync takes the UPDATE path rather than the insert.
      const adopted = await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId: fx.organizationId,
            branchArtifactId,
            repositoryId: null,
            repositoryFullName: NORMALIZED,
            number: DESKTOP_PR,
            htmlUrl: `https://github.com/${NORMALIZED}/pull/${DESKTOP_PR}`,
            prState: GitHubPRState.Open,
          },
          select: { id: true, desktopOriginated: true },
        })
      );
      expect(adopted.desktopOriginated).toBe(false);

      await syncSession({
        ...fx,
        externalSessionId: "ext-pr-session-adopt",
        artifactRefs: [
          branchRef(REPOSITORY, BRANCH_NAME),
          pullRequestRef({
            repositoryFullName: REPOSITORY,
            prNumber: DESKTOP_PR,
            branchName: BRANCH_NAME,
            state: GitHubPRState.Open,
          }),
        ],
      });

      const updated = await withDb((db) =>
        db.pullRequestDetail.findUnique({
          where: { id: adopted.id },
          select: { desktopOriginated: true, fetchMechanism: true },
        })
      );
      expect(updated?.fetchMechanism).toBe(GitHubFetchMechanism.DesktopSync);
      expect(updated?.desktopOriginated).toBe(true);
    }, TX_BUDGET);
  });
});
