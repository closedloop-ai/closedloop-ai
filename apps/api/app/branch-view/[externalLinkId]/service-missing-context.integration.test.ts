import { randomUUID } from "node:crypto";
import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchViewLoadErrorCode } from "@repo/api/src/types/branch-view";
import { Status } from "@repo/api/src/types/result";
import {
  ArtifactType,
  GitHubInstallationStatus,
  GitHubPRState,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { resolveBranchViewMissingContextFailure } from "@/app/branch-view/[externalLinkId]/service";
import {
  BranchViewContextCredentialMode,
  resolvePrContext,
} from "@/lib/resolve-pr-context";

/**
 * DB-backed coverage for the Branch View's MISSING-CONTEXT lane — what the BFF
 * returns when the primary PR resolver cannot produce a renderable context.
 *
 * This is the degraded path, so the thing worth pinning is that it degrades
 * HONESTLY: a wrong-org resource must collapse to a generic not-found rather
 * than leaking that the branch exists, and a branch the App cannot see must come
 * back as `PullRequestUnavailable` carrying whatever identity it legitimately
 * has, never a fabricated owner/repo.
 *
 * DB-backed rather than mocked on purpose. `resolveBranchViewMissingContextFailure`
 * reads through one `findFirst` with a three-level include
 * (branch -> repository -> installation), and every mapper below consumes that
 * exact row shape. A mocked `withDb` would let the include and the mappers drift
 * apart while every assertion still passed — which is precisely the failure this
 * lane cannot afford, because it only ever runs when something is already wrong.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REPOSITORY_FULL_NAME = "acme/widgets";
const BRANCH_PULL_NUMBER = 7;
const BRANCH_PULL_REQUEST_URL = "https://github.com/acme/widgets/pull/7";
/**
 * A PR that is NOT this branch's. Deliberately a different number so a url built
 * from it is distinguishable from the branch artifact's own `externalUrl`.
 */
const FOREIGN_PULL_NUMBER = 99;
const FOREIGN_PULL_REQUEST_URL = "https://github.com/acme/widgets/pull/99";

/**
 * Which `repositoryId` the branch's OWN current PR row carries, seeded
 * independently of the branch's. `PullRequestDetail.repositoryId` is nullable
 * enrichment (PRD-510 D2) that only an ACTIVE App installation populates, so a
 * repo-less PR row hanging off a branch that still carries an installation-repo
 * id is an ordinary production shape, not a corruption.
 */
const CurrentPullRequestRepository = {
  /** The branch's own installation-repo — the fully enriched row. */
  Branch: "branch",
  /** No installation-repo: the enrichment never ran, or ran while suspended. */
  None: "none",
  /** A different, non-null installation-repo — a genuine identity mismatch. */
  Other: "other",
} as const;
type CurrentPullRequestRepository =
  (typeof CurrentPullRequestRepository)[keyof typeof CurrentPullRequestRepository];

type BranchSeed = {
  /** Omit the BranchDetail row entirely (artifact with no branch). */
  withoutBranch?: boolean;
  /** Attach an installation-repo, and with it an installation. */
  repository?: {
    fullName: string;
    installationStatus?: GitHubInstallationStatus;
    /** `undefined` keeps the installation on the seeded org. */
    installationOrganizationId?: string | null;
  };
  /** Attach a current PR detail and point the branch at it. */
  currentPullRequest?: boolean;
  /**
   * `repositoryId` for that current PR row, independent of the branch's.
   * Defaults to the branch's own. Only read with `currentPullRequest`.
   */
  currentPullRequestRepository?: CurrentPullRequestRepository;
  /**
   * Point `currentPullRequestDetailId` at a PR row owned by a DIFFERENT branch
   * artifact — the cross-branch leak the relation guard exists to block.
   * `branchArtifactId` is the whole ownership key, so that is the only way to
   * seed a genuinely foreign PR. Mutually exclusive with `currentPullRequest`.
   */
  foreignCurrentPullRequest?: boolean;
};

type Seeded = {
  organizationId: string;
  externalLinkId: string;
};

async function createInstallationRepository(
  db: TransactionClient,
  input: {
    organizationId: string | null;
    unique: string;
    fullName: string;
    status: GitHubInstallationStatus;
  }
): Promise<string> {
  const installation = await db.gitHubInstallation.create({
    data: {
      organizationId: input.organizationId,
      installationId: `inst-${input.unique}`,
      accountId: `acct-${input.unique}`,
      accountLogin: `acct-${input.unique}`,
      accountType: "Organization",
      senderLogin: `sender-${input.unique}`,
      senderId: `sender-${input.unique}`,
      status: input.status,
    },
    select: { id: true },
  });
  const repository = await db.gitHubInstallationRepository.create({
    data: {
      installationId: installation.id,
      githubRepoId: `repo-${input.unique}`,
      fullName: input.fullName,
      name: "widgets",
      owner: "acme",
      private: false,
    },
    select: { id: true },
  });
  return repository.id;
}

/**
 * Resolve the `repositoryId` to store on the branch's own current PR row. The
 * `Other` case mints a fresh unclaimed installation-repo so the mismatch is
 * between two genuine, non-null ids rather than between an id and a fabricated
 * uuid the FK would reject.
 */
async function resolveCurrentPullRequestRepositoryId(
  db: TransactionClient,
  input: {
    kind: CurrentPullRequestRepository;
    branchRepositoryId: string | null;
    unique: string;
  }
): Promise<string | null> {
  if (input.kind === CurrentPullRequestRepository.None) {
    return null;
  }
  if (input.kind === CurrentPullRequestRepository.Other) {
    return await createInstallationRepository(db, {
      organizationId: null,
      unique: `${input.unique}-pr-repo`,
      fullName: REPOSITORY_FULL_NAME,
      status: GitHubInstallationStatus.ACTIVE,
    });
  }
  return input.branchRepositoryId;
}

async function seedForeignCurrentPullRequest(
  db: TransactionClient,
  input: {
    organizationId: string;
    branchArtifactId: string;
    repositoryId: string | null;
    createdById: string;
    unique: string;
  }
): Promise<void> {
  // A second branch artifact in the same org owns the PR. It shares the branch's
  // own repositoryId deliberately: same repo, different branch is the ordinary
  // production shape, so the guard has to reject it on `branchArtifactId` alone.
  const foreignBranchArtifact = await db.artifact.create({
    data: {
      organizationId: input.organizationId,
      type: ArtifactType.BRANCH,
      name: `branch-${input.unique}-foreign`,
      status: BranchStatus.Open,
      externalUrl: FOREIGN_PULL_REQUEST_URL,
      createdById: input.createdById,
    },
    select: { id: true },
  });

  const foreignPr = await db.pullRequestDetail.create({
    data: {
      branchArtifactId: foreignBranchArtifact.id,
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      repositoryFullName: REPOSITORY_FULL_NAME,
      githubId: `gh-${input.unique}-foreign`,
      number: FOREIGN_PULL_NUMBER,
      title: "Someone else's PR",
      htmlUrl: FOREIGN_PULL_REQUEST_URL,
      prState: GitHubPRState.OPEN,
    },
    select: { id: true },
  });
  await db.branchDetail.update({
    where: { artifactId: input.branchArtifactId },
    data: { currentPullRequestDetailId: foreignPr.id },
  });
}

async function seedBranchArtifact(seed: BranchSeed = {}): Promise<Seeded> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const unique = randomUUID().slice(0, 8);

  return await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: `branch-${unique}`,
        // `Artifact.status` is a freeform column carrying several disjoint
        // vocabularies (PRD-495); this lane never reads it. Mirrors the sibling
        // fixture in `db-helpers.linkValidSessionToBranch`.
        status: BranchStatus.Open,
        externalUrl: BRANCH_PULL_REQUEST_URL,
        createdById: user.id,
      },
      select: { id: true },
    });

    if (seed.withoutBranch) {
      return { organizationId, externalLinkId: artifact.id };
    }

    let repositoryId: string | null = null;
    if (seed.repository) {
      repositoryId = await createInstallationRepository(db, {
        // `undefined` means "this org"; an explicit `null` seeds the
        // unclaimed-installation case the org guard treats as non-disclosing.
        organizationId:
          seed.repository.installationOrganizationId === undefined
            ? organizationId
            : seed.repository.installationOrganizationId,
        unique,
        fullName: seed.repository.fullName,
        status:
          seed.repository.installationStatus ?? GitHubInstallationStatus.ACTIVE,
      });
    }

    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryId,
        repositoryFullName: REPOSITORY_FULL_NAME,
        branchName: `feat/${unique}`,
        baseBranch: "main",
        headSha: "a".repeat(40),
      },
    });

    if (seed.currentPullRequest) {
      const currentPullRequestRepositoryId =
        await resolveCurrentPullRequestRepositoryId(db, {
          kind:
            seed.currentPullRequestRepository ??
            CurrentPullRequestRepository.Branch,
          branchRepositoryId: repositoryId,
          unique,
        });
      const pr = await db.pullRequestDetail.create({
        data: {
          branchArtifactId: artifact.id,
          organizationId,
          repositoryId: currentPullRequestRepositoryId,
          repositoryFullName: REPOSITORY_FULL_NAME,
          githubId: `gh-${unique}`,
          number: BRANCH_PULL_NUMBER,
          title: "Add widgets",
          htmlUrl: BRANCH_PULL_REQUEST_URL,
          prState: GitHubPRState.OPEN,
        },
        select: { id: true },
      });
      await db.branchDetail.update({
        where: { artifactId: artifact.id },
        data: { currentPullRequestDetailId: pr.id },
      });
    }

    if (seed.foreignCurrentPullRequest) {
      await seedForeignCurrentPullRequest(db, {
        organizationId,
        branchArtifactId: artifact.id,
        repositoryId,
        createdById: user.id,
        unique,
      });
    }

    return { organizationId, externalLinkId: artifact.id };
  });
}

describeIfDb("resolveBranchViewMissingContextFailure — not-found lane", () => {
  it("returns LinkNotFound for an id that does not exist", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();

      const failure = await resolveBranchViewMissingContextFailure(
        randomUUID(),
        organizationId
      );

      expect(failure.code).toBe(BranchViewLoadErrorCode.LinkNotFound);
      expect(failure.status).toBe(Status.NotFound);
      // A not-found carries no details: there is nothing this caller is
      // entitled to learn about a resource it cannot see.
      expect(failure.details).toBeUndefined();
    });
  });

  it("collapses a branch owned by another organization to the same LinkNotFound", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedBranchArtifact();
      const otherOrganizationId = await createTestOrganization();

      const failure = await resolveBranchViewMissingContextFailure(
        seeded.externalLinkId,
        otherOrganizationId
      );

      // Byte-identical to the never-existed case above. A distinguishable
      // response here would confirm the branch exists to a caller outside its
      // org, which is the whole reason the lookup is org-scoped.
      expect(failure.code).toBe(BranchViewLoadErrorCode.LinkNotFound);
      expect(failure.details).toBeUndefined();
    });
  });

  it("returns LinkNotFound when the repository's installation belongs to another organization", async () => {
    await autoRollbackTransaction(async () => {
      const foreignOrganizationId = await createTestOrganization();
      const seeded = await seedBranchArtifact({
        repository: {
          fullName: REPOSITORY_FULL_NAME,
          installationOrganizationId: foreignOrganizationId,
        },
      });

      const failure = await resolveBranchViewMissingContextFailure(
        seeded.externalLinkId,
        seeded.organizationId
      );

      // The artifact IS in the caller's org, but its repository is installed to
      // a different one — a cross-org join that must not render.
      expect(failure.code).toBe(BranchViewLoadErrorCode.LinkNotFound);
      // The route serializes `details` onto the 404 body, so any foreign
      // installation metadata leaking here would make this response
      // distinguishable from a link that never existed.
      expect(failure.details).toBeUndefined();
    });
  });

  it("does NOT treat an unclaimed installation as cross-org", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedBranchArtifact({
        repository: {
          fullName: REPOSITORY_FULL_NAME,
          installationOrganizationId: null,
        },
      });

      const failure = await resolveBranchViewMissingContextFailure(
        seeded.externalLinkId,
        seeded.organizationId
      );

      // A null installation org is "not yet claimed", not "someone else's". The
      // guard tests `!== null` first for exactly this row, so a null must fall
      // through to the unavailable lane rather than 404.
      expect(failure.code).toBe(BranchViewLoadErrorCode.PullRequestUnavailable);
    });
  });
});

describeIfDb(
  "resolveBranchViewMissingContextFailure — unavailable lane",
  () => {
    it("reports PullRequestUnavailable for an artifact with no branch row", async () => {
      await autoRollbackTransaction(async () => {
        const seeded = await seedBranchArtifact({ withoutBranch: true });

        const failure = await resolveBranchViewMissingContextFailure(
          seeded.externalLinkId,
          seeded.organizationId
        );

        expect(failure.code).toBe(
          BranchViewLoadErrorCode.PullRequestUnavailable
        );
        expect(failure.status).toBe(Status.NotFound);
      });
    });

    it("reports PullRequestUnavailable for a non-App branch with no installation repo", async () => {
      await autoRollbackTransaction(async () => {
        const seeded = await seedBranchArtifact();

        const failure = await resolveBranchViewMissingContextFailure(
          seeded.externalLinkId,
          seeded.organizationId
        );

        // PRD-510 D2/FR8: a desktop-produced branch in a non-App repo has no
        // installation identity at all, so there is no owner/repo to build a
        // GitHub-backed context from — and none may be invented.
        expect(failure.code).toBe(
          BranchViewLoadErrorCode.PullRequestUnavailable
        );
        expect(failure.details?.githubPullRequestUrl).toBeUndefined();
      });
    });

    it("surfaces the canonical PR url for a branch the primary resolver cannot resolve", async () => {
      await autoRollbackTransaction(async () => {
        // An unclaimed installation (null org) with a current PR. The route only
        // reaches this helper when `resolvePrContext` returns null, so the seed
        // has to be a shape that actually resolves to null — an ACTIVE, same-org
        // installation would be served by the primary path and never get here.
        const seeded = await seedBranchArtifact({
          repository: {
            fullName: REPOSITORY_FULL_NAME,
            installationOrganizationId: null,
          },
          currentPullRequest: true,
        });

        // Pinned with the route's own credential mode: this is the assertion
        // that keeps the fixture reachable rather than hypothetical.
        const primaryContext = await resolvePrContext(
          seeded.externalLinkId,
          seeded.organizationId,
          { credentialMode: BranchViewContextCredentialMode.RenderRead }
        );
        expect(primaryContext).toBeNull();

        const failure = await resolveBranchViewMissingContextFailure(
          seeded.externalLinkId,
          seeded.organizationId
        );

        expect(failure.code).toBe(
          BranchViewLoadErrorCode.PullRequestUnavailable
        );
        // The details exist to give the user somewhere to go when the app
        // itself cannot render the PR, so the link is the payload that matters.
        expect(failure.details?.githubPullRequestUrl).toBe(
          BRANCH_PULL_REQUEST_URL
        );
      });
    });

    it("still reports unavailable, without a url, when the App repo has no current PR", async () => {
      await autoRollbackTransaction(async () => {
        const seeded = await seedBranchArtifact({
          repository: { fullName: REPOSITORY_FULL_NAME },
        });

        const failure = await resolveBranchViewMissingContextFailure(
          seeded.externalLinkId,
          seeded.organizationId
        );

        expect(failure.code).toBe(
          BranchViewLoadErrorCode.PullRequestUnavailable
        );
        // No PR number means no canonical url can be built. The absent field is
        // the honest answer; a repo-root url would imply a PR that isn't there.
        expect(failure.details?.githubPullRequestUrl).toBeUndefined();
      });
    });

    it("falls back to an identity-less context when the repository full name is unparseable", async () => {
      await autoRollbackTransaction(async () => {
        const seeded = await seedBranchArtifact({
          // Three segments: `parseBranchViewRepositoryFullName` rejects anything
          // that is not exactly `owner/repo`.
          repository: { fullName: "acme/widgets/extra" },
          currentPullRequest: true,
        });

        const failure = await resolveBranchViewMissingContextFailure(
          seeded.externalLinkId,
          seeded.organizationId
        );

        expect(failure.code).toBe(
          BranchViewLoadErrorCode.PullRequestUnavailable
        );
        // Owner/repo stay empty rather than being guessed from a malformed
        // value, so no url is derivable even though a PR number exists.
        expect(failure.details?.githubPullRequestUrl).toBeUndefined();
      });
    });

    it.each([
      GitHubInstallationStatus.SUSPENDED,
      GitHubInstallationStatus.UNINSTALLED,
      GitHubInstallationStatus.PENDING_CLAIM,
    ])("still builds the fallback context from a %s installation", async (installationStatus) => {
      await autoRollbackTransaction(async () => {
        const seeded = await seedBranchArtifact({
          repository: { fullName: REPOSITORY_FULL_NAME, installationStatus },
          currentPullRequest: true,
        });

        const failure = await resolveBranchViewMissingContextFailure(
          seeded.externalLinkId,
          seeded.organizationId
        );

        expect(failure.code).toBe(
          BranchViewLoadErrorCode.PullRequestUnavailable
        );
        // A non-ACTIVE installation cannot be READ through, but the stored
        // identity is still true — so the deep-link survives losing API
        // access. That is the difference between "we can't fetch this" and
        // "this doesn't exist", and the lane must not conflate them.
        expect(failure.details?.githubPullRequestUrl).toBe(
          BRANCH_PULL_REQUEST_URL
        );
      });
    });

    it("refuses to build a url from a current PR owned by another branch", async () => {
      await autoRollbackTransaction(async () => {
        // `BranchDetail.currentPullRequestDetailId` is an unconstrained FK, so
        // it can name a PR belonging to a different branch. The primary
        // resolver rejects that mismatch; with a SUSPENDED installation the
        // primary resolver is out of the picture entirely and this fallback is
        // the only thing standing between the user and a deep-link to someone
        // else's PR.
        const seeded = await seedBranchArtifact({
          repository: {
            fullName: REPOSITORY_FULL_NAME,
            installationStatus: GitHubInstallationStatus.SUSPENDED,
          },
          foreignCurrentPullRequest: true,
        });

        const primaryContext = await resolvePrContext(
          seeded.externalLinkId,
          seeded.organizationId,
          { credentialMode: BranchViewContextCredentialMode.RenderRead }
        );
        expect(primaryContext).toBeNull();

        const failure = await resolveBranchViewMissingContextFailure(
          seeded.externalLinkId,
          seeded.organizationId
        );

        expect(failure.code).toBe(
          BranchViewLoadErrorCode.PullRequestUnavailable
        );
        // The unrelated PR's number is the only pull number in play, so a url
        // here could only have come from it.
        expect(failure.details?.githubPullRequestUrl).not.toBe(
          FOREIGN_PULL_REQUEST_URL
        );
        expect(failure.details?.githubPullRequestUrl).toBeUndefined();
      });
    });
  }
);

/**
 * `PullRequestDetail.repositoryId` is nullable enrichment, not identity
 * (schema.prisma: "PR identity keys on repositoryFullName (repo-less) or
 * repositoryId (App); never on both"), and the query that populates it filters
 * on an ACTIVE installation. So the branch and its own PR row can legitimately
 * disagree about it — and this lane is exactly where they do, because it only
 * runs once the installation has stopped being ACTIVE.
 */
describeIfDb(
  "resolveBranchViewMissingContextFailure — nullable repositoryId enrichment",
  () => {
    it("surfaces the PR url when the branch carries a repositoryId and its own PR row does not", async () => {
      await autoRollbackTransaction(async () => {
        // The installation went SUSPENDED, desktop then synced a new PR for the
        // branch, and the enrichment lookup that fills
        // `PullRequestDetail.repositoryId` only resolves through an ACTIVE
        // installation — so the PR row lands repo-less while the branch, adopted
        // back when the install was ACTIVE, keeps its id forever.
        const seeded = await seedBranchArtifact({
          repository: {
            fullName: REPOSITORY_FULL_NAME,
            installationStatus: GitHubInstallationStatus.SUSPENDED,
          },
          currentPullRequest: true,
          currentPullRequestRepository: CurrentPullRequestRepository.None,
        });

        const primaryContext = await resolvePrContext(
          seeded.externalLinkId,
          seeded.organizationId,
          { credentialMode: BranchViewContextCredentialMode.RenderRead }
        );
        expect(primaryContext).toBeNull();

        const failure = await resolveBranchViewMissingContextFailure(
          seeded.externalLinkId,
          seeded.organizationId
        );

        expect(failure.code).toBe(
          BranchViewLoadErrorCode.PullRequestUnavailable
        );
        // The PR names this branch, so it IS this branch's PR. Rejecting it on
        // the nullable half would hand the user a bare "unavailable" in the one
        // lane where the deep-link is the entire value of the response.
        expect(failure.details?.githubPullRequestUrl).toBe(
          BRANCH_PULL_REQUEST_URL
        );
      });
    });

    it("surfaces the PR url for the branch's own PR when both sides carry DIFFERENT repositoryIds", async () => {
      await autoRollbackTransaction(async () => {
        // The App-reinstall shape. `GitHubInstallationRepository` is unique on
        // (installationId, githubRepoId), so a reinstall mints a NEW id for the
        // same GitHub repo, and the branch and its own PR row are re-homed onto
        // it by different, independently gated writers — the branch eagerly, the
        // PR not at all, because `upsertCurrentPullRequestDetail` keys on the
        // reinstall-stable `githubId` and omits `repositoryId` from its update.
        // The row still names this branch, so it IS this branch's PR; rejecting
        // it here would hand the user a bare "unavailable" for a live PR.
        const seeded = await seedBranchArtifact({
          repository: {
            fullName: REPOSITORY_FULL_NAME,
            installationStatus: GitHubInstallationStatus.SUSPENDED,
          },
          currentPullRequest: true,
          currentPullRequestRepository: CurrentPullRequestRepository.Other,
        });

        const failure = await resolveBranchViewMissingContextFailure(
          seeded.externalLinkId,
          seeded.organizationId
        );

        expect(failure.code).toBe(
          BranchViewLoadErrorCode.PullRequestUnavailable
        );
        // The seeded PR carries this branch's own number, so this url could only
        // have come from the accepted relation.
        expect(failure.details?.githubPullRequestUrl).toBe(
          BRANCH_PULL_REQUEST_URL
        );
      });
    });

    it("reports unavailable without a url for a repo-less branch whose PR row was App-adopted", async () => {
      await autoRollbackTransaction(async () => {
        // The reverse asymmetry: a non-App branch (`repositoryId` null, hence no
        // installation-repo relation at all) whose PR row a later App
        // installation adopted. `isCurrentPullRequestRelationValid` accepts that
        // pair — see the truth table in `lib/resolve-pr-context.test.ts` — but
        // the mapper never gets to ask, because a branch with no
        // installation-repo has no owner/repo to build ANY url from (PRD-510
        // D2/FR8) and returns first. Pinned so a change that reroutes this shape
        // has to say what it intends.
        const seeded = await seedBranchArtifact({
          currentPullRequest: true,
          currentPullRequestRepository: CurrentPullRequestRepository.Other,
        });

        const failure = await resolveBranchViewMissingContextFailure(
          seeded.externalLinkId,
          seeded.organizationId
        );

        expect(failure.code).toBe(
          BranchViewLoadErrorCode.PullRequestUnavailable
        );
        expect(failure.details?.githubPullRequestUrl).toBeUndefined();
      });
    });
  }
);

/**
 * The PRIMARY path, through an ACTIVE installation the resolver can read. A
 * branch and its own current PR row disagreeing about `repositoryId` is ordinary
 * here too — the id is a per-installation surrogate and the two sides are
 * re-homed by different writers — and rejecting the relation on it does not
 * degrade gracefully: `classifyBranchViewUnavailable` turns the whole Branch View
 * into a 404 and the sync preflight returns `CurrentPullRequestStale` before it
 * can ever reach the relink that would repoint the branch.
 */
describeIfDb(
  "resolvePrContext — current PR relation on the primary path",
  () => {
    it.each([
      CurrentPullRequestRepository.None,
      CurrentPullRequestRepository.Other,
    ])("resolves the branch's own current PR when its repositoryId is %s", async (currentPullRequestRepository) => {
      await autoRollbackTransaction(async () => {
        const seeded = await seedBranchArtifact({
          repository: {
            fullName: REPOSITORY_FULL_NAME,
            installationStatus: GitHubInstallationStatus.ACTIVE,
          },
          currentPullRequest: true,
          currentPullRequestRepository,
        });

        const context = await resolvePrContext(
          seeded.externalLinkId,
          seeded.organizationId
        );

        expect(context).not.toBeNull();
        expect(context?.pullNumber).toBe(BRANCH_PULL_NUMBER);
        expect(context?.gitHubPullRequest?.number).toBe(BRANCH_PULL_NUMBER);
        expect(context?.gitHubPullRequest?.htmlUrl).toBe(
          BRANCH_PULL_REQUEST_URL
        );
        expect(context?.prMetadata?.number).toBe(BRANCH_PULL_NUMBER);
        // The relation was accepted, so the branch projection must not carry the
        // dropped-relation marker and must keep the FK it resolved through.
        expect(
          context?.branch?.invalidCurrentPullRequestRelation
        ).toBeUndefined();
        expect(context?.branch?.currentPullRequestDetailId).not.toBeNull();
      });
    });

    it("drops a current PR owned by another branch on the primary path too", async () => {
      await autoRollbackTransaction(async () => {
        const seeded = await seedBranchArtifact({
          repository: {
            fullName: REPOSITORY_FULL_NAME,
            installationStatus: GitHubInstallationStatus.ACTIVE,
          },
          foreignCurrentPullRequest: true,
        });

        const context = await resolvePrContext(
          seeded.externalLinkId,
          seeded.organizationId
        );

        // The branch itself still resolves — only the foreign relation is dropped,
        // and it is dropped visibly rather than silently.
        expect(context).not.toBeNull();
        expect(context?.pullNumber).toBeNull();
        expect(context?.gitHubPullRequest).toBeNull();
        expect(context?.prMetadata).toBeNull();
        expect(context?.branch?.invalidCurrentPullRequestRelation).toBe(true);
        expect(context?.branch?.currentPullRequestDetailId).toBeNull();
      });
    });
  }
);
