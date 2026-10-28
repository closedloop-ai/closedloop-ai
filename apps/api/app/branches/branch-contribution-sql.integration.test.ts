import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { FileChangeStatus } from "@repo/api/src/types/branch-view";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  appendBranchCandidateLocRangePredicate,
  branchContributorExistsSql,
  branchHasLinkedSession,
} from "@/app/branches/branch-contribution-sql";

/**
 * ISS-6661 — the raw-SQL branch contribution predicates, asserted against ROWS
 * a real Postgres returned, never against generated SQL text. A string snapshot
 * pins the query the code BUILT; it stays green while the predicate selects the
 * wrong branches, which is the only failure that matters here —
 * `branchContributorExistsSql` decides which branches a named contributor is
 * shown (`artifacts/project-tree-service.ts`) and
 * `branchLinkedSessionExistsSql` gates the list corpus
 * (`branches/branch-candidate-read.ts`) and detail eligibility
 * (`branchHasCloudEligibility` in `branches/cloud-branch-eligibility.ts`).
 *
 * `branchHasLinkedSession` currently has NO production caller — several
 * comments elsewhere name it as the by-id detail gate, but that gate is
 * `branchHasCloudEligibility`, which composes the same predicate with
 * `deleted_at IS NULL` and the cloud-eligibility clause. It is covered here as
 * the exported single-row form of the predicate, not as a live read path.
 *
 * Every case therefore seeds at least one branch the predicate must EXCLUDE
 * alongside the one it must include, so an assertion cannot pass by the
 * predicate simply matching everything.
 *
 * Runs inside `autoRollbackTransaction`; nothing persists.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const SEEDED_AT = new Date("2026-07-01T00:00:00.000Z");

/** How a seeded session→branch link classifies for the contribution predicates. */
const SeedLink = {
  /** Explicit `wrote` over a session that HAS a SessionDetail row. */
  Wrote: "wrote",
  /** Explicit `reviewed` — a real contribution, but not a WRITE. */
  Reviewed: "reviewed",
  /** Legacy `null` participation whose metadata derives reviewed-only. */
  LegacyReviewedDerived: "legacyReviewedDerived",
  /** Legacy `null` participation whose metadata derives a write. */
  LegacyWriteDerived: "legacyWriteDerived",
  /** Active-write link whose source SESSION has no SessionDetail row. */
  OrphanedWrote: "orphanedWrote",
  /** No session link at all. */
  None: "none",
} as const;
type SeedLink = (typeof SeedLink)[keyof typeof SeedLink];

describeIfDb("branchContributorExistsSql", () => {
  it("selects the branches a user WROTE and excludes the ones they only reviewed", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const author = await createTestUser(organizationId);

      const wrote = await seedBranch(organizationId, {
        branchName: "authored",
        link: SeedLink.Wrote,
        userId: author.id,
      });
      // MUST be excluded: the same user, a real link, but reviewing is not
      // writing. Without this row the test passes against a predicate that
      // ignores participation entirely.
      const reviewed = await seedBranch(organizationId, {
        branchName: "reviewed-only",
        link: SeedLink.Reviewed,
        userId: author.id,
      });
      const unlinked = await seedBranch(organizationId, {
        branchName: "unlinked",
        link: SeedLink.None,
      });

      const selected = await selectContributorBranches(
        organizationId,
        author.id
      );

      expect(selected).toContain(wrote);
      expect(selected).not.toContain(reviewed);
      expect(selected).not.toContain(unlinked);
    });
  });

  it("scopes to the named contributor, so one user's branches never surface under another", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const author = await createTestUser(organizationId);
      const other = await createTestUser(organizationId);

      const mine = await seedBranch(organizationId, {
        branchName: "mine",
        link: SeedLink.Wrote,
        userId: author.id,
      });
      // MUST be excluded: an identical write link owned by someone else. This
      // predicate gates a per-contributor view, so a leak here shows one
      // person another person's work.
      const theirs = await seedBranch(organizationId, {
        branchName: "theirs",
        link: SeedLink.Wrote,
        userId: other.id,
      });

      const selected = await selectContributorBranches(
        organizationId,
        author.id
      );

      expect(selected).toContain(mine);
      expect(selected).not.toContain(theirs);
      expect(await selectContributorBranches(organizationId, other.id)).toEqual(
        [theirs]
      );
    });
  });

  it("keeps a legacy null-participation write link active but drops a reviewed-derived one", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const author = await createTestUser(organizationId);

      // Pre-backfill rows carry `branch_participation IS NULL`; the metadata
      // is the only evidence. A write-derived one stays a contribution.
      const legacyWrite = await seedBranch(organizationId, {
        branchName: "legacy-write",
        link: SeedLink.LegacyWriteDerived,
        userId: author.id,
      });
      // MUST be excluded: same null participation, metadata derives review.
      const legacyReview = await seedBranch(organizationId, {
        branchName: "legacy-review",
        link: SeedLink.LegacyReviewedDerived,
        userId: author.id,
      });

      const selected = await selectContributorBranches(
        organizationId,
        author.id
      );

      expect(selected).toContain(legacyWrite);
      expect(selected).not.toContain(legacyReview);
    });
  });
});

describeIfDb("branchContributorExistsSql person (ISS-12251 D-4)", () => {
  it("names the session's creator the contributor, not its recorder or its Owner", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const [creator, recorder, owner] = await Promise.all([
        createTestUser(organizationId),
        createTestUser(organizationId),
        createTestUser(organizationId),
      ]);
      const branch = await seedBranch(organizationId, {
        branchName: "creator-recorder-owner",
        link: SeedLink.Wrote,
        userId: recorder.id,
        createdById: creator.id,
        assigneeId: owner.id,
      });

      expect(
        await selectContributorBranches(organizationId, creator.id)
      ).toEqual([branch]);
      expect(
        await selectContributorBranches(organizationId, recorder.id)
      ).toEqual([]);
      expect(await selectContributorBranches(organizationId, owner.id)).toEqual(
        []
      );
    });
  });
});

describeIfDb("branchHasLinkedSession", () => {
  it("returns false, not an error, for a branch with no linked session", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const unlinked = await seedBranch(organizationId, {
        branchName: "no-sessions",
        link: SeedLink.None,
      });

      await expect(
        withDb((db) => branchHasLinkedSession(db, organizationId, unlinked))
      ).resolves.toBe(false);
    });
  });

  it("admits a written branch and rejects a half-synced orphaned link", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const author = await createTestUser(organizationId);
      const linked = await seedBranch(organizationId, {
        branchName: "linked",
        link: SeedLink.Wrote,
        userId: author.id,
      });
      // A write link whose source session never hydrated a SessionDetail row.
      // Admitting it opens a detail page for a branch the list does not carry.
      const orphaned = await seedBranch(organizationId, {
        branchName: "orphaned",
        link: SeedLink.OrphanedWrote,
      });

      await withDb(async (db) => {
        expect(await branchHasLinkedSession(db, organizationId, linked)).toBe(
          true
        );
        expect(await branchHasLinkedSession(db, organizationId, orphaned)).toBe(
          false
        );
      });
    });
  });

  it("refuses a branch belonging to another organization", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const otherOrganizationId = await createTestOrganization();
      const author = await createTestUser(organizationId);
      const linked = await seedBranch(organizationId, {
        branchName: "org-scoped",
        link: SeedLink.Wrote,
        userId: author.id,
      });

      await withDb(async (db) => {
        expect(
          await branchHasLinkedSession(db, otherOrganizationId, linked)
        ).toBe(false);
      });
    });
  });
});

describeIfDb("appendBranchCandidateLocRangePredicate", () => {
  it("appends nothing for an unbounded range, so branches with unavailable LOC stay in the corpus", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const withLoc = await seedBranch(organizationId, {
        branchName: "with-loc",
        link: SeedLink.None,
        fileChanges: [[10, 5]],
      });
      // No file-change rows at all: LOC is UNAVAILABLE, not zero. A predicate
      // wrongly emitted for an unbounded range gates on EXISTS and silently
      // drops this branch from every unfiltered list.
      const withoutLoc = await seedBranch(organizationId, {
        branchName: "without-loc",
        link: SeedLink.None,
      });

      const predicates: Prisma.Sql[] = [];
      appendBranchCandidateLocRangePredicate(predicates, undefined, undefined);

      expect(predicates).toHaveLength(0);
      const selected = await selectBranchesMatching(organizationId, predicates);
      expect(selected).toContain(withLoc);
      expect(selected).toContain(withoutLoc);
    });
  });

  it("narrows to branches whose summed LOC falls inside the bounds", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const inRange = await seedBranch(organizationId, {
        branchName: "in-range",
        link: SeedLink.None,
        // 14 + 6 = 20 lines changed. Neither row reaches the lower bound of 15
        // on its own, so a SUM that folded only a subset of a branch's
        // file-change rows would drop this branch instead of selecting it.
        fileChanges: [
          [10, 4],
          [4, 2],
        ],
      });
      const aboveRange = await seedBranch(organizationId, {
        branchName: "above-range",
        link: SeedLink.None,
        fileChanges: [[500, 0]],
      });
      const belowRange = await seedBranch(organizationId, {
        branchName: "below-range",
        link: SeedLink.None,
        fileChanges: [[1, 1]],
      });

      const predicates: Prisma.Sql[] = [];
      appendBranchCandidateLocRangePredicate(predicates, 15, 25);

      expect(predicates).toHaveLength(1);
      const selected = await selectBranchesMatching(organizationId, predicates);
      expect(selected).toEqual([inRange]);
      expect(selected).not.toContain(aboveRange);
      expect(selected).not.toContain(belowRange);
    });
  });

  it("excludes a branch whose LOC is UNAVAILABLE while keeping one whose LOC is a known zero", async () => {
    // The bound deliberately starts at 0 so the numeric comparison alone
    // admits both branches: `SUM(...)` COALESCEs a branch with no file-change
    // rows to 0, which satisfies `>= 0`. Only the EXISTS gate tells the two
    // apart, so a range whose lower bound is above 0 cannot test this at all.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const knownZero = await seedBranch(organizationId, {
        branchName: "known-zero-loc",
        link: SeedLink.None,
        fileChanges: [[0, 0]],
      });
      const unavailable = await seedBranch(organizationId, {
        branchName: "loc-unavailable",
        link: SeedLink.None,
      });

      const predicates: Prisma.Sql[] = [];
      appendBranchCandidateLocRangePredicate(predicates, 0, 25);

      const selected = await selectBranchesMatching(organizationId, predicates);
      expect(selected).toEqual([knownZero]);
      expect(selected).not.toContain(unavailable);
    });
  });
});

/** Run the contributor predicate exactly as `project-tree-service` does. */
async function selectContributorBranches(
  organizationId: string,
  contributorUserId: string
): Promise<string[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT a.id
      FROM artifacts a
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
        AND ${branchContributorExistsSql(contributorUserId)}
    `)
  );
  return rows.map((row) => row.id);
}

/** Run candidate predicates over the org's branches, as the list read does. */
async function selectBranchesMatching(
  organizationId: string,
  predicates: readonly Prisma.Sql[]
): Promise<string[]> {
  const clauses = [
    Prisma.sql`a.organization_id = ${organizationId}::uuid`,
    Prisma.sql`a.type = ${ArtifactType.BRANCH}::"ArtifactType"`,
    ...predicates,
  ];
  const rows = await withDb((db) =>
    db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT a.id
      FROM artifacts a
      WHERE ${Prisma.join(clauses, " AND ")}
    `)
  );
  return rows.map((row) => row.id);
}

type SeedBranchInput = {
  branchName: string;
  link: SeedLink;
  /** Recording user of the SessionDetail a valid session needs. */
  userId?: string;
  /**
   * The session's Created by and Owner. Default to `userId`, as the ingest
   * create arm sets both (ISS-12251).
   */
  createdById?: string;
  assigneeId?: string;
  /** Per-file `[additions, deletions]`; empty means LOC is unavailable. */
  fileChanges?: [number, number][];
};

async function seedBranch(
  organizationId: string,
  input: SeedBranchInput
): Promise<string> {
  return await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: input.branchName,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryFullName: `acme/${input.branchName}`,
        branchName: input.branchName,
        firstPushedAt: SEEDED_AT,
        pushSource: BranchPushSource.Session,
        lastActivityAt: SEEDED_AT,
      },
      select: { artifactId: true },
    });
    if (input.fileChanges?.length) {
      await db.branchFileChange.createMany({
        data: input.fileChanges.map(([additions, deletions], index) => ({
          branchArtifactId: artifact.id,
          headSha: "sha-1",
          path: `src/file-${index}.ts`,
          status: FileChangeStatus.Modified,
          additions,
          deletions,
        })),
      });
    }
    if (input.link !== SeedLink.None) {
      await seedSessionLink(db, organizationId, artifact.id, input);
    }
    return artifact.id;
  });
}

async function seedSessionLink(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  branchArtifactId: string,
  input: SeedBranchInput
): Promise<void> {
  const session = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.SESSION,
      name: `session-for-${input.branchName}`,
      status: SESSION_STATUS.ACTIVE,
      createdById: input.createdById ?? input.userId,
      assigneeId: input.assigneeId ?? input.userId,
    },
    select: { id: true },
  });
  // Every link except the deliberately orphaned one models a VALID session, so
  // it carries the SessionDetail row the predicates INNER JOIN on.
  if (input.link !== SeedLink.OrphanedWrote) {
    if (!input.userId) {
      throw new Error(`seedSessionLink: ${input.link} requires a userId`);
    }
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: input.userId,
        machineName: `machine-${input.branchName}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.sessionDetail.create({
      data: {
        artifactId: session.id,
        computeTargetId: computeTarget.id,
        externalSessionId: `ext-${input.branchName}`,
        harness: "claude",
        sessionStartedAt: SEEDED_AT,
        sessionUpdatedAt: SEEDED_AT,
        lastActivityAt: SEEDED_AT,
      },
      select: { artifactId: true },
    });
  }
  await db.artifactLink.create({
    data: {
      organizationId,
      sourceId: session.id,
      targetId: branchArtifactId,
      linkType: LinkType.RelatesTo,
      branchParticipation: participationFor(input.link),
      metadata: metadataFor(input.link),
    },
    select: { id: true },
  });
}

function participationFor(link: SeedLink): BranchParticipationKind | null {
  if (link === SeedLink.Wrote || link === SeedLink.OrphanedWrote) {
    return BranchParticipationKind.Wrote;
  }
  if (link === SeedLink.Reviewed) {
    return BranchParticipationKind.Reviewed;
  }
  return null;
}

function metadataFor(link: SeedLink): Prisma.InputJsonValue {
  if (link === SeedLink.LegacyReviewedDerived) {
    return {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Reviewed],
    };
  }
  if (link === SeedLink.LegacyWriteDerived) {
    return {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
    };
  }
  return { linkKind: SessionArtifactLinkKind.SessionBranch };
}
