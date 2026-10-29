/**
 * Shared seeding for the delivery cross-surface integration suites (ISS-8151,
 * ISS-8265).
 *
 * Extracted so the ISS-8265 reused-branch scenarios live in their own sibling
 * spec instead of pushing the invariant suite past the file-size ceiling. One
 * copy of the seeders is also what keeps the two suites describing the SAME
 * corpus: a second, drifting `seedBranch` would let one spec's "reused branch"
 * mean something the other's does not.
 */
import { randomUUID } from "node:crypto";
import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import type { GitHubPRState } from "@repo/api/src/types/github";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactType,
  GitHubInstallationStatus,
  type Prisma,
  withDb,
} from "@repo/database";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import { linkValidSessionToBranch } from "@/__tests__/utils/db-helpers";

/**
 * The selected reporting range every seeded branch is stamped inside, so the
 * branch-population window resolves off pinned instants (the linked session's
 * last activity, the shared Last-active fallback since ISS-11915) — no part of
 * these suites reads the real clock.
 */
export const WINDOW_START = new Date("2026-07-01T00:00:00.000Z");
export const WINDOW_END = new Date("2026-07-31T23:59:59.999Z");
export const LAST_ACTIVITY_AT = new Date("2026-07-15T09:00:00.000Z");
export const IN_WINDOW_MERGED_AT = new Date("2026-07-15T12:00:00.000Z");
export const BEFORE_WINDOW_MERGED_AT = new Date("2026-06-01T12:00:00.000Z");
export const AFTER_WINDOW_MERGED_AT = new Date("2026-08-15T12:00:00.000Z");
export const VERIFIED_AT = new Date("2026-07-15T11:00:00.000Z");

export const REPO_FULL_NAME = "acme/delivery";
export const DEFAULT_BRANCH = "main";

export type SeedBranchInput = {
  organizationId: string;
  /** Author of the branch artifact — the profile headline counts on this. */
  userId: string;
  repositoryId: string;
  githubRepoId: string;
  branchName: string;
  /** Distinct per branch so the PRs keep separate projected identities. */
  prNumber: number;
  /** Omit for a branch with no pull request at all. */
  pr?: SeedPrInput;
  /** Superseded same-branch PR row; admitted only by exact PR metadata. */
  historicalPr?: SeedPrInput & { prNumber: number };
  /** Exact PR numbers written into session→PR metadata. */
  linkedPrNumbers?: readonly number[];
  /**
   * Verbatim session-link metadata, for the reused-branch identity fixtures
   * whose whole subject is a metadata SHAPE {@link sessionPrLinkMetadata}
   * cannot express — a legacy scalar identity, a malformed `prRefs` element, a
   * prose-derived ref. Wins over `linkedPrNumbers` when both are supplied.
   */
  linkMetadata?: Prisma.InputJsonObject;
  /**
   * ISS-8153: seed the PR row WITHOUT installing it as the branch pointer —
   * the tier-2 heal-window shape the canonical fallback exists for.
   */
  withoutPointer?: boolean;
  /**
   * ISS-8153: skip the session link — the retired-genesis shape. Together
   * with `unverified`, this row must fall out of the org-merged population.
   */
  unlinked?: boolean;
};

export type SeedPrInput = {
  prState: GitHubPRState;
  mergedAt: Date | null;
  additions: number | null;
  deletions: number | null;
  /**
   * Normalized `owner/name` written on the PR ROW. `projectedPrIdentity` keys on
   * it ahead of the installation-repo surrogate, so two rows carrying the same
   * value and the same `number` are two projections of ONE pull request.
   */
  repositoryFullName?: string;
  /** GitHub node id; only the App/webhook path writes one. */
  githubId?: string;
  /**
   * ISS-8153: leave `lastVerifiedAt` NULL — the retired-genesis shape. A row
   * no producer verified is outside the org-merged population's session arm.
   */
  unverified?: boolean;
  /**
   * Omit the installation-repo link, as a repo-less (non-App) projection has.
   * Also what keeps the twin legal: `@@unique([repositoryId, number])` would
   * reject a second row on the same repo and number, and a NULL repo does not
   * collide.
   */
  repoless?: boolean;
};

/**
 * Seeds one branch artifact, its detail row, its optional current pull request,
 * and a valid session→PR link.
 *
 * Deliberately writes NO `fileChanges` cache: an un-enriched branch is what
 * forces the branch card's displayed LOC to resolve through the merged-PR
 * backfill, which is the reader half the invariant is about.
 */
export async function seedBranch(input: SeedBranchInput): Promise<string> {
  const { organizationId, branchName } = input;
  const branchArtifactId = await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: `branch-${branchName}`,
        status: BranchStatus.Open,
        createdById: input.userId,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryId: input.repositoryId,
        repositoryFullName: REPO_FULL_NAME,
        branchName,
        // Push evidence, so corpus membership never depends on the PR pointer
        // the surfaces under test disagree about.
        firstPushedAt: LAST_ACTIVITY_AT,
        pushSource: BranchPushSource.Session,
        lastActivityAt: LAST_ACTIVITY_AT,
      },
      select: { artifactId: true },
    });
    if (input.historicalPr) {
      await db.pullRequestDetail.create({
        data: {
          organizationId,
          branchArtifactId: artifact.id,
          number: input.historicalPr.prNumber,
          repositoryId: input.repositoryId,
          prState: input.historicalPr.prState,
          mergedAt: input.historicalPr.mergedAt,
          additions: input.historicalPr.additions,
          deletions: input.historicalPr.deletions,
          // Superseded: never current, never the branch's pointer.
          isCurrent: false,
          lastVerifiedAt: VERIFIED_AT,
          headRefName: branchName,
          headRefOid: "b".repeat(40),
          ...prHeadRepositoryAuthority(input.githubRepoId),
        },
        select: { id: true },
      });
    }
    if (input.pr) {
      const pr = await db.pullRequestDetail.create({
        data: {
          organizationId,
          branchArtifactId: artifact.id,
          number: input.prNumber,
          repositoryId: input.pr.repoless ? null : input.repositoryId,
          repositoryFullName: input.pr.repositoryFullName ?? null,
          githubId: input.pr.githubId ?? null,
          prState: input.pr.prState,
          mergedAt: input.pr.mergedAt,
          additions: input.pr.additions,
          deletions: input.pr.deletions,
          isCurrent: !input.withoutPointer,
          lastVerifiedAt: input.pr.unverified ? null : VERIFIED_AT,
          headRefName: branchName,
          headRefOid: "a".repeat(40),
          ...prHeadRepositoryAuthority(input.githubRepoId),
        },
        select: { id: true },
      });
      if (!input.withoutPointer) {
        await db.branchDetail.update({
          where: { artifactId: artifact.id },
          data: { currentPullRequestDetailId: pr.id },
          select: { artifactId: true },
        });
      }
    }
    return artifact.id;
  });
  if (!input.unlinked) {
    await linkValidSessionToBranch({
      organizationId,
      userId: input.userId,
      branchArtifactId,
      label: branchName,
      sessionTimestamp: LAST_ACTIVITY_AT,
      linkKind: SessionArtifactLinkKind.SessionPr,
      metadata: input.linkMetadata ?? sessionPrLinkMetadata(input),
    });
  }
  return branchArtifactId;
}

/**
 * One App-installed repository carrying complete default-branch authority.
 *
 * Every seeded branch lives on it: the Product corpus gate requires a single
 * consistent repository authority per branch, so a per-branch repo would make
 * the branch list empty and quietly void the LOC half of the invariant.
 */
export async function seedRepository(
  organizationId: string
): Promise<{ repositoryId: string; githubRepoId: string }> {
  const githubRepoId = `repo-${randomUUID().slice(0, 8)}`;
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: randomUUID(),
        accountId: "acct-delivery",
        accountLogin: "acme",
        accountType: "Organization",
        status: GitHubInstallationStatus.ACTIVE,
        senderLogin: "sender",
        senderId: "sender-delivery",
        repositories: {
          create: {
            ...persistedGitHubRepositoryAuthority({
              githubRepoId,
              fullName: REPO_FULL_NAME,
              defaultBranch: DEFAULT_BRANCH,
            }),
            name: "delivery",
            owner: "acme",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repository = installation.repositories[0];
  if (!repository) {
    throw new Error("delivery invariant: failed to seed repository");
  }
  return { repositoryId: repository.id, githubRepoId };
}

function sessionPrLinkMetadata(input: SeedBranchInput): Prisma.InputJsonObject {
  const prNumbers = input.linkedPrNumbers ?? seededPrNumbers(input);
  if (prNumbers.length === 0) {
    return { linkKind: SessionArtifactLinkKind.SessionPr };
  }
  const linkKind =
    prNumbers.length > 1
      ? SessionArtifactLinkKind.SessionBranch
      : SessionArtifactLinkKind.SessionPr;
  return {
    linkKind,
    ...(prNumbers.length > 1
      ? {
          linkKinds: [
            SessionArtifactLinkKind.SessionBranch,
            SessionArtifactLinkKind.SessionPrSet,
          ],
        }
      : {}),
    prRefs: prNumbers.map((prNumber) => ({
      repositoryFullName: REPO_FULL_NAME,
      prNumber,
      relationTypes: [SessionPrRelationType.Created],
    })),
  };
}

function seededPrNumbers(input: SeedBranchInput): number[] {
  return [
    ...(input.historicalPr ? [input.historicalPr.prNumber] : []),
    ...(input.pr ? [input.prNumber] : []),
  ];
}

/**
 * The provider-authoritative head-repository snapshot a current PR must carry.
 *
 * The Product corpus gate folds the current PR's head-repository columns into
 * the SAME repository-authority set as the installation row and then requires
 * EVERY member to be complete and to agree. A PR carrying a partial group
 * therefore makes its branch ineligible — the fixture would silently assert
 * against an empty branch list — so this mirrors
 * {@link persistedGitHubRepositoryAuthority} field for field.
 */
function prHeadRepositoryAuthority(githubRepoId: string) {
  const authority = persistedGitHubRepositoryAuthority({
    githubRepoId,
    fullName: REPO_FULL_NAME,
    defaultBranch: DEFAULT_BRANCH,
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
