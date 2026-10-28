import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
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
import {
  ArtifactType,
  GitHubInstallationStatus,
  Prisma,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import { cloudBranchAuthorityEligibleIdsSql } from "./cloud-branch-authority-eligibility";
import { cloudBranchEligibilitySql } from "./cloud-branch-eligibility";

/**
 * ISS-11589: `cloudBranchAuthorityEligibleIdsSql` is the set-based form of
 * `cloudBranchEligibilitySql`. The correlated form is the oracle: a seeded
 * random organization of branches and repository authority evidence, with the
 * shapes the decision has to fail closed on, must be admitted or refused
 * identically by both, branch by branch.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const REPOSITORY_COUNT = 8;
const REMOVED_REPOSITORY_COUNT = 2;
const BRANCH_COUNT = 360;
const SEED = 20_261_009;
const MINUTE = 60_000;
const T0 = Date.parse("2026-08-10T09:00:00.000Z");
const INSTANT_CHOICES = [null, 0, 1, 1, 2].map((offset) =>
  offset === null ? null : new Date(T0 + offset * MINUTE)
);

type Authority = {
  defaultBranchName: string | null;
  defaultBranchAvailability: string | null;
  defaultBranchCompleteness: string | null;
  defaultBranchReason: string | null;
  defaultBranchSource: string | null;
  defaultBranchMechanism: string | null;
  defaultBranchTrigger: string | null;
  defaultBranchCredentialType: string | null;
  defaultBranchObservationKey: string | null;
  defaultBranchObservedAt: Date | null;
  defaultBranchEventAt: Date | null;
};

type Random = {
  next: () => number;
  chance: (probability: number) => boolean;
  pick: <Value>(values: readonly Value[]) => Value;
};

const LCG_MODULUS = 4_294_967_296;

function createRandom(seed: number): Random {
  let state = seed % LCG_MODULUS;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) % LCG_MODULUS;
    return state / LCG_MODULUS;
  };
  return {
    next,
    chance: (probability) => next() < probability,
    pick: (values) => values[Math.floor(next() * values.length)],
  };
}

const EMPTY_GROUP: Authority = {
  defaultBranchName: null,
  defaultBranchAvailability: null,
  defaultBranchCompleteness: null,
  defaultBranchReason: null,
  defaultBranchSource: null,
  defaultBranchMechanism: null,
  defaultBranchTrigger: null,
  defaultBranchCredentialType: null,
  defaultBranchObservationKey: null,
  defaultBranchObservedAt: null,
  defaultBranchEventAt: null,
};

function validAuthority(random: Random): Authority {
  return {
    defaultBranchName: random.pick(["main", "main", "trunk"]),
    defaultBranchAvailability: RepositoryDefaultAvailability.Available,
    defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
    defaultBranchReason: null,
    defaultBranchSource: RepositoryDefaultSource.PushWebhook,
    defaultBranchMechanism: GitHubFetchMechanism.Webhook,
    defaultBranchTrigger: GitHubFetchTrigger.Webhook,
    defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
    defaultBranchObservationKey: "key",
    defaultBranchObservedAt: new Date(T0 + random.pick([0, 1, 2]) * MINUTE),
    defaultBranchEventAt: random.pick(INSTANT_CHOICES),
  };
}

/** Mostly sound evidence, sometimes one field spoiled, sometimes the whole group absent. */
function randomAuthority(random: Random): Authority {
  if (random.chance(0.1)) {
    return EMPTY_GROUP;
  }
  const authority = validAuthority(random);
  if (random.chance(0.35)) {
    const spoilers: ((value: Authority) => Authority)[] = [
      (value) => ({ ...value, defaultBranchName: null }),
      (value) => ({ ...value, defaultBranchName: "  " }),
      (value) => ({ ...value, defaultBranchAvailability: "unavailable" }),
      (value) => ({ ...value, defaultBranchCompleteness: "incomplete" }),
      (value) => ({ ...value, defaultBranchReason: "rate_limited" }),
      (value) => ({ ...value, defaultBranchSource: "unknown" }),
      (value) => ({ ...value, defaultBranchMechanism: "unknown" }),
      (value) => ({ ...value, defaultBranchTrigger: "unknown" }),
      (value) => ({ ...value, defaultBranchCredentialType: "unknown" }),
      (value) => ({ ...value, defaultBranchObservationKey: null }),
      (value) => ({ ...value, defaultBranchObservationKey: " " }),
      (value) => ({ ...value, defaultBranchObservedAt: null }),
    ];
    return random.pick(spoilers)(authority);
  }
  return authority;
}

type RepositorySeed = {
  fullName: string;
  githubRepoId: string;
  installationRepositoryId: string | null;
};

type SeedOptions = {
  installationStatus: GitHubInstallationStatus;
  /** Owns the installation some repository rows hang off, which the branch's organization must not trust. */
  foreignOrganizationId: string;
};

async function seedOrganization(
  organizationId: string,
  random: Random,
  options: SeedOptions
): Promise<void> {
  const [installation, foreignInstallation] = await Promise.all(
    [
      { owner: organizationId, status: options.installationStatus },
      {
        owner: options.foreignOrganizationId,
        status: GitHubInstallationStatus.ACTIVE,
      },
    ].map(({ owner, status }) =>
      withDb((db) =>
        db.gitHubInstallation.create({
          data: {
            organizationId: owner,
            installationId: `installation-${owner}`,
            accountId: `account-${owner}`,
            accountLogin: "acme",
            accountType: "Organization",
            senderLogin: "sender",
            senderId: "sender-1",
            status,
          },
          select: { id: true },
        })
      )
    )
  );
  const repositories: RepositorySeed[] = [];
  for (let index = 0; index < REPOSITORY_COUNT; index += 1) {
    const fullName = `acme/repo-${index}`;
    const githubRepoId = `gh-${index}`;
    const removedRepository =
      index >= REPOSITORY_COUNT - REMOVED_REPOSITORY_COUNT;
    let installationRepositoryId: string | null = null;
    if (removedRepository || random.chance(0.75)) {
      const row = await withDb((db) =>
        db.gitHubInstallationRepository.create({
          data: {
            installationId:
              !removedRepository && random.chance(0.12)
                ? foreignInstallation.id
                : installation.id,
            githubRepoId:
              !removedRepository && random.chance(0.1)
                ? `gh-other-${index}`
                : githubRepoId,
            fullName: random.chance(0.1) ? fullName.toUpperCase() : fullName,
            name: `repo-${index}`,
            owner: "acme",
            private: false,
            removedAt:
              removedRepository || random.chance(0.1) ? new Date(T0) : null,
            ...(removedRepository
              ? validAuthority(random)
              : randomAuthority(random)),
          },
          select: { id: true },
        })
      );
      installationRepositoryId = row.id;
    }
    if (!removedRepository && random.chance(0.35)) {
      await withDb((db) =>
        db.publicRepository.create({
          data: {
            organizationId,
            githubRepoId: random.chance(0.15)
              ? `gh-public-${index}`
              : githubRepoId,
            fullName,
            owner: "acme",
            name: `repo-${index}`,
            htmlUrl: `https://github.com/${fullName}`,
            ...randomAuthority(random),
          },
          select: { id: true },
        })
      );
    }
    if (!removedRepository && random.chance(0.4)) {
      await withDb((db) =>
        db.gitHubObservedRepository.create({
          data: {
            organizationId,
            repositoryFullName: fullName,
            verificationState: random.chance(0.85)
              ? GitHubObservedRepositoryVerificationState.Verified
              : "pending",
            githubRepoId: random.chance(0.15) ? null : githubRepoId,
            ...randomAuthority(random),
          },
          select: { id: true },
        })
      );
    }
    repositories.push({ fullName, githubRepoId, installationRepositoryId });
  }
  await seedBranches(organizationId, random, repositories);
}

async function seedBranches(
  organizationId: string,
  random: Random,
  repositories: readonly RepositorySeed[]
): Promise<void> {
  const pullRequestIdsByRepository = new Map<string, string[]>();
  const usedBranchKeys = new Set<string>();
  let pullRequestNumber = 0;
  for (let index = 0; index < BRANCH_COUNT; index += 1) {
    const repository = random.pick(repositories);
    const branchName = uniqueBranchName(
      usedBranchKeys,
      repository.fullName,
      random.pick(["main", "trunk", "feature/a", "feature/b"]),
      index
    );
    const installationRepositoryIds = repositories.flatMap((candidate) =>
      candidate.installationRepositoryId === null
        ? []
        : [candidate.installationRepositoryId]
    );
    const linkedRepositoryId = chooseLinkedRepositoryId(
      random,
      repository,
      installationRepositoryIds
    );
    const branchId = await withDb(async (db) => {
      const artifact = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.BRANCH,
          name: `branch-${index}`,
          status: BranchStatus.Open,
        },
        select: { id: true },
      });
      await db.branchDetail.create({
        data: {
          artifactId: artifact.id,
          organizationId,
          repositoryFullName: repository.fullName,
          repositoryId: linkedRepositoryId,
          branchName,
          firstPushedAt: new Date(T0),
          pushSource: BranchPushSource.Session,
        },
        select: { artifactId: true },
      });
      return artifact.id;
    });
    if (random.chance(0.6)) {
      pullRequestNumber += 1;
      const headName = random.pick([
        repository.fullName,
        repository.fullName,
        repository.fullName.toUpperCase(),
        "acme/fork-repo",
        null,
      ]);
      const pullRequest = await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId,
            branchArtifactId: branchId,
            number: pullRequestNumber,
            prState: GitHubPRState.Open,
            repositoryFullName: `${repository.fullName}-pr`,
            headRepositoryFullName: headName,
            headRepositoryGithubId: random.pick([
              repository.githubRepoId,
              repository.githubRepoId,
              "gh-fork",
              null,
            ]),
            ...prAuthority(
              random.chance(0.3) ? EMPTY_GROUP : randomAuthority(random)
            ),
          },
          select: { id: true },
        })
      );
      const sameRepository =
        pullRequestIdsByRepository.get(repository.fullName) ?? [];
      const pointAtOtherBranch =
        random.chance(0.2) && sameRepository.length > 0;
      sameRepository.push(pullRequest.id);
      pullRequestIdsByRepository.set(repository.fullName, sameRepository);
      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: branchId },
          data: {
            currentPullRequestDetailId: pointAtOtherBranch
              ? random.pick(sameRepository.slice(0, -1))
              : pullRequest.id,
          },
          select: { artifactId: true },
        })
      );
    }
  }
}

/** Mostly the branch's own repository row, sometimes none, sometimes another repository's. */
function chooseLinkedRepositoryId(
  random: Random,
  repository: RepositorySeed,
  installationRepositoryIds: readonly string[]
): string | null {
  if (random.chance(0.12) && installationRepositoryIds.length > 0) {
    return random.pick(installationRepositoryIds);
  }
  if (repository.installationRepositoryId !== null && random.chance(0.65)) {
    return repository.installationRepositoryId;
  }
  return null;
}

/** Keeps the default-branch names on the first use per repository; later draws get a suffix. */
function uniqueBranchName(
  used: Set<string>,
  repositoryFullName: string,
  preferred: string,
  index: number
): string {
  const preferredKey = `${repositoryFullName}#${preferred}`;
  if (!used.has(preferredKey)) {
    used.add(preferredKey);
    return preferred;
  }
  return `${preferred}-${index}`;
}

function prAuthority(authority: Authority) {
  return {
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
    headRepositoryDefaultBranchObservationKey:
      authority.defaultBranchObservationKey,
    headRepositoryDefaultBranchObservedAt: authority.defaultBranchObservedAt,
    headRepositoryDefaultBranchEventAt: authority.defaultBranchEventAt,
  };
}

async function correlatedEligibleIds(
  organizationId: string
): Promise<string[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT a.id
      FROM artifacts a
      INNER JOIN branch_detail b ON b.artifact_id = a.id
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
        AND ${cloudBranchEligibilitySql()}
      ORDER BY a.id
    `)
  );
  return rows.map((row) => row.id);
}

async function setBasedEligibleIds(
  organizationId: string,
  branchIds?: readonly string[]
): Promise<string[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ branch_id: string }[]>(Prisma.sql`
      SELECT eligible.branch_id
      FROM (${cloudBranchAuthorityEligibleIdsSql(organizationId, branchIds)}) eligible
      ORDER BY eligible.branch_id
    `)
  );
  return rows.map((row) => row.branch_id);
}

describeIfDb("cloudBranchAuthorityEligibleIdsSql (ISS-11589)", () => {
  it("admits exactly the branches the correlated predicate admits", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      await seedOrganization(organizationId, createRandom(SEED), {
        installationStatus: GitHubInstallationStatus.ACTIVE,
        foreignOrganizationId: await committedOrganizations.create(),
      });

      const oracle = await correlatedEligibleIds(organizationId);
      const setBased = await setBasedEligibleIds(organizationId);

      // A fixture that admits all or none would let a wrong predicate agree.
      expect(oracle.length).toBeGreaterThan(BRANCH_COUNT * 0.05);
      expect(oracle.length).toBeLessThan(BRANCH_COUNT * 0.95);
      expect(setBased).toEqual(oracle);
    });
  }, 20_000);

  it("limits the pass to the branch ids it is given", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      await seedOrganization(organizationId, createRandom(SEED + 1), {
        installationStatus: GitHubInstallationStatus.ACTIVE,
        foreignOrganizationId: await committedOrganizations.create(),
      });
      const oracle = await correlatedEligibleIds(organizationId);
      const subset = oracle.filter((_, index) => index % 3 === 0);

      const restricted = await setBasedEligibleIds(organizationId, subset);

      expect(restricted).toEqual(subset);
    });
  }, 20_000);

  it("admits no installation-backed authority once the installation is not active", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      await seedOrganization(organizationId, createRandom(SEED + 2), {
        installationStatus: GitHubInstallationStatus.SUSPENDED,
        foreignOrganizationId: await committedOrganizations.create(),
      });

      const oracle = await correlatedEligibleIds(organizationId);
      const setBased = await setBasedEligibleIds(organizationId);

      expect(setBased).toEqual(oracle);
    });
  }, 20_000);
});
