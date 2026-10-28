/**
 * ISS-12552: implementation evidence against a real Postgres.
 */
import { randomInt } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  AttributionRelationshipKind,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  type OperationClaim,
  OperationClaimSource,
} from "@repo/api/src/types/operation-claims";
import {
  ArtifactSubtype,
  ArtifactType,
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactLinksService } from "@/app/artifact-links/service";
import { emitBranchDetailsChanged } from "@/app/branches/branch-detail-signal";
import { writeBranchSourceLink } from "@/app/branches/branch-source-link";
import { generateSlug } from "@/app/documents/document-utils";
import { readPullRequestAttributionEvidence } from "@/app/webhooks/github/handlers/pull-request-attribution-read";
import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import { readAttributionEvidenceForRequest } from "@/lib/attribution-evidence-policy-feature";
import { runAttributionBackfill } from "./attribution-backfill";
import {
  deriveCommittedImplementationEvidence,
  IMPLEMENTATION_EVIDENCE_DERIVE_FAILED_EVENT,
} from "./derive-committed-implementation-evidence";
import { deriveImplementationEvidence } from "./derive-implementation-evidence";
import { persistSessionOperationEvidence } from "./persist-operation-evidence";

/** PRD-800: the flag is on for every organization not listed here. */
const flag = vi.hoisted(() => ({ offClerkOrganizationIds: new Set<string>() }));
vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/feature-flags/server-feature-flag-evaluation")
    >()),
    evaluateServerFeatureFlagForOrganization: vi.fn(
      (_flag: unknown, clerkOrganizationId: string) =>
        Promise.resolve(!flag.offClerkOrganizationIds.has(clerkOrganizationId))
    ),
  })
);

/** Implementation rows visible to the signal's transaction when it was emitted. */
const signalled = vi.hoisted(() => ({ rowsAtSignal: [] as number[] }));
vi.mock("@/app/branches/branch-detail-signal", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/app/branches/branch-detail-signal")
    >();
  return {
    ...actual,
    emitBranchDetailsChanged: vi.fn(
      async (
        tx: TransactionClient,
        organizationId: string,
        branchIds: readonly string[]
      ) => {
        signalled.rowsAtSignal.push(
          await tx.agentSessionOperationEvidence.count({
            where: { organizationId },
          })
        );
        await actual.emitBranchDetailsChanged(tx, organizationId, branchIds);
      }
    ),
  };
});
vi.mock("./derive-implementation-evidence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./derive-implementation-evidence")>();
  return {
    ...actual,
    deriveImplementationEvidence: vi.fn(actual.deriveImplementationEvidence),
  };
});

const tracker = createCommittedTestOrganizationTracker();
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 20_000 };

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 implementation evidence",
  () => {
    afterEach(async () => {
      flag.offClerkOrganizationIds.clear();
      signalled.rowsAtSignal.splice(0);
      vi.mocked(emitBranchDetailsChanged).mockClear();
      vi.restoreAllMocks();
      await tracker.cleanup();
    });

    it("records a session that wrote to an issue's branch as implementing it, once per head ref", async () => {
      const fixture = await seed();
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await sessionLink(fixture, fixture.reader, null);

      await withDb.tx(
        (tx) =>
          deriveImplementationEvidence(tx, {
            organizationId: fixture.organizationId,
            sessionIds: [fixture.writer, fixture.reader],
          }),
        TRANSACTION_OPTIONS
      );

      expect(await implementationRows(fixture)).toEqual([
        {
          agentSessionId: fixture.writer,
          targetArtifactId: fixture.branchId,
          relationshipKind: AttributionRelationshipKind.Implementation,
          source: OperationSource.Repository,
          anchors: {
            associatedArtifactIds: [fixture.issueId],
            repositoryOutput: { repository: "acme/app", headRef: "feat/x" },
          },
        },
      ]);
    });

    it("derives it when the issue-to-branch link is written after the session synced, only where the flag is on", async () => {
      const off = await seed({ linkIssue: false, flagOn: false });
      const on = await seed({ linkIssue: false });
      for (const fixture of [off, on]) {
        await sessionLink(
          fixture,
          fixture.writer,
          BranchParticipationKind.Wrote
        );
        await runWithAttributionEvidenceGate(async () => {
          await readAttributionEvidenceForRequest(fixture.organizationId);
          await withDb.tx(
            (tx) =>
              writeBranchSourceLink(tx, {
                organizationId: fixture.organizationId,
                sourceArtifactId: fixture.issueId,
                branchArtifactId: fixture.branchId,
              }),
            TRANSACTION_OPTIONS
          );
        });
      }

      expect(await implementationRows(off)).toEqual([]);
      expect(
        (await implementationRows(on)).map((row) => row.agentSessionId)
      ).toEqual([on.writer]);
    });

    it("derives a pull_request webhook's source link only where the repository's organization has the flag on", async () => {
      const off = await seed({ linkIssue: false, flagOn: false });
      const on = await seed({ linkIssue: false });
      for (const [index, fixture] of [off, on].entries()) {
        await sessionLink(
          fixture,
          fixture.writer,
          BranchParticipationKind.Wrote
        );
        const delivery = await seedInstallationRepository(fixture, index);
        await runWithAttributionEvidenceGate(async () => {
          await readPullRequestAttributionEvidence(
            delivery.repository,
            delivery.installationId
          );
          await withDb.tx(
            (tx) =>
              writeBranchSourceLink(tx, {
                organizationId: fixture.organizationId,
                sourceArtifactId: fixture.issueId,
                branchArtifactId: fixture.branchId,
              }),
            TRANSACTION_OPTIONS
          );
        });
      }

      expect(await implementationRows(off)).toEqual([]);
      expect(
        (await implementationRows(on)).map((row) => row.agentSessionId)
      ).toEqual([on.writer]);
    });

    it("derives nothing for a source link whose request never read the flag", async () => {
      const fixture = await seed({ linkIssue: false });
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);

      await withDb.tx(
        (tx) =>
          writeBranchSourceLink(tx, {
            organizationId: fixture.organizationId,
            sourceArtifactId: fixture.issueId,
            branchArtifactId: fixture.branchId,
          }),
        TRANSACTION_OPTIONS
      );

      expect(await implementationRows(fixture)).toEqual([]);
    });

    it("signals the session's branches again from the post-commit derivation, once its rows exist", async () => {
      const fixture = await seed();
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);

      await deriveCommittedImplementationEvidence(fixture.organizationId, [
        fixture.writer,
      ]);

      expect(emitBranchDetailsChanged).toHaveBeenCalledWith(
        expect.anything(),
        fixture.organizationId,
        [fixture.branchId]
      );
      expect(signalled.rowsAtSignal).toEqual([1]);
    });

    it("logs a failed post-commit derivation with its organization and branches", async () => {
      const fixture = await seed();
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      const warn = vi.spyOn(log, "warn");
      vi.mocked(deriveImplementationEvidence).mockRejectedValueOnce(
        new Error("derive failed")
      );

      await deriveCommittedImplementationEvidence(fixture.organizationId, [
        fixture.writer,
      ]);

      expect(warn).toHaveBeenCalledWith(
        IMPLEMENTATION_EVIDENCE_DERIVE_FAILED_EVENT,
        expect.objectContaining({
          level: "warn",
          status: "warn",
          organizationId: fixture.organizationId,
          branchIds: [fixture.branchId],
        })
      );
      expect(await implementationRows(fixture)).toEqual([]);
    });

    it("derives it for a session that synced before, when the historical backfill runs", async () => {
      const fixture = await seed();
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      expect(await implementationRows(fixture)).toEqual([]);

      await runAttributionBackfill({ organizationId: fixture.organizationId });
      const derived = await implementationRows(fixture);
      await runAttributionBackfill({ organizationId: fixture.organizationId });

      expect(derived).toEqual([
        expect.objectContaining({
          agentSessionId: fixture.writer,
          targetArtifactId: fixture.branchId,
          relationshipKind: AttributionRelationshipKind.Implementation,
        }),
      ]);
      expect(await implementationRows(fixture)).toEqual(derived);
      await withDb((db) =>
        db.attributionBackfillRun.deleteMany({
          where: { organizationId: fixture.organizationId },
        })
      );
    });

    it("leaves implementation evidence alone when the links service writes a link where the flag is off", async () => {
      const fixture = await seed({ linkIssue: false, flagOn: false });
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);

      const created = await artifactLinksService.createLink(
        fixture.organizationId,
        {
          sourceId: fixture.issueId,
          targetId: fixture.branchId,
          linkType: LinkType.Produces,
        }
      );
      if (!created.ok) {
        throw new Error("expected the issue-to-branch link to be created");
      }
      expect(await implementationRows(fixture)).toEqual([]);

      await derive(fixture);
      const derived = await implementationRows(fixture);
      await artifactLinksService.deleteLink(
        created.value.id,
        fixture.organizationId
      );

      expect(derived).toHaveLength(1);
      expect(await implementationRows(fixture)).toEqual(derived);
    });

    it("associates the issue when the links service creates the issue-to-branch link, and drops the association when the link is deleted", async () => {
      const fixture = await seed({ linkIssue: false });
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await sessionLink(fixture, fixture.reader, null);

      const created = await artifactLinksService.createLink(
        fixture.organizationId,
        {
          sourceId: fixture.issueId,
          targetId: fixture.branchId,
          linkType: LinkType.Produces,
        }
      );
      if (!created.ok) {
        throw new Error("expected the issue-to-branch link to be created");
      }

      expect(
        (await implementationRows(fixture)).map((row) => row.agentSessionId)
      ).toEqual([fixture.writer]);

      expect((await implementationRows(fixture))[0]?.anchors).toEqual(
        expect.objectContaining({ associatedArtifactIds: [fixture.issueId] })
      );

      await artifactLinksService.deleteLink(
        created.value.id,
        fixture.organizationId
      );

      // The session still wrote to the branch: its row stays, with
      // nothing producing the branch to associate.
      expect(await implementationRows(fixture)).toEqual([
        expect.objectContaining({
          agentSessionId: fixture.writer,
          anchors: expect.objectContaining({ associatedArtifactIds: [] }),
        }),
      ]);
    });

    it("drops the session's implementation row when the links service deletes its link to the branch", async () => {
      const fixture = await seed();
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await derive(fixture);
      expect(await implementationRows(fixture)).toHaveLength(1);

      await artifactLinksService.deleteLink(
        await sessionLinkId(fixture),
        fixture.organizationId
      );

      expect(await implementationRows(fixture)).toEqual([]);
    });

    it("leaves the session's implementation row alone when its branch link is deleted where the flag is off", async () => {
      const fixture = await seed({ flagOn: false });
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await derive(fixture);
      const derived = await implementationRows(fixture);

      await artifactLinksService.deleteLink(
        await sessionLinkId(fixture),
        fixture.organizationId
      );

      expect(derived).toHaveLength(1);
      expect(await implementationRows(fixture)).toEqual(derived);
    });

    it("names the requests the Desktop's join placed on the branch, and keeps join claims off the evidence rows", async () => {
      const fixture = await seed();
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await persist(fixture, OPERATION_EVIDENCE_EXTRACTOR_VERSION, [
        join("feat/x", ["req-c", "req-w"]),
        join("feat/other", ["req-other"]),
      ]);

      await derive(fixture);

      expect(await implementationRows(fixture)).toEqual([
        expect.objectContaining({
          agentSessionId: fixture.writer,
          source: OperationSource.Repository,
          anchors: {
            associatedArtifactIds: [fixture.issueId],
            repositoryOutput: { repository: "acme/app", headRef: "feat/x" },
            requestKeys: ["req-c", "req-w"],
          },
        }),
      ]);
    });

    it("writes an empty join when the session's Desktop joined nothing to the branch", async () => {
      const fixture = await seed();
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await persist(fixture, OPERATION_EVIDENCE_EXTRACTOR_VERSION, [
        join("feat/other", ["req-other"]),
      ]);

      await derive(fixture);

      expect((await implementationRows(fixture))[0]?.anchors).toEqual(
        expect.objectContaining({ requestKeys: [] })
      );
    });

    it("leaves the join absent for a snapshot from a Desktop that predates the join", async () => {
      const fixture = await seed();
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await persist(fixture, 1, []);

      await derive(fixture);

      expect((await implementationRows(fixture))[0]?.anchors).toEqual({
        associatedArtifactIds: [fixture.issueId],
        repositoryOutput: { repository: "acme/app", headRef: "feat/x" },
      });
    });

    it("gives the join's requests only to the branch in the session's own repository when two repositories share its name", async () => {
      const fixture = await seed();
      const other = await sameNamedBranch(fixture, "acme/other");
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await sessionLink(
        { ...fixture, branchId: other },
        fixture.writer,
        BranchParticipationKind.Wrote
      );
      await sessionRepository(fixture, "Acme/App");
      await persist(fixture, OPERATION_EVIDENCE_EXTRACTOR_VERSION, [
        join("feat/x", ["req-w"]),
      ]);

      await derive(fixture);

      expect(await requestKeysByBranch(fixture)).toEqual(
        new Map([
          [fixture.branchId, ["req-w"]],
          [other, []],
        ])
      );
    });

    it("keeps the branch-name match for a session whose repository is not recorded", async () => {
      const fixture = await seed();
      const other = await sameNamedBranch(fixture, "acme/other");
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await sessionLink(
        { ...fixture, branchId: other },
        fixture.writer,
        BranchParticipationKind.Wrote
      );
      await sessionRepository(fixture, null);
      await persist(fixture, OPERATION_EVIDENCE_EXTRACTOR_VERSION, [
        join("feat/x", ["req-w"]),
      ]);

      await derive(fixture);

      expect(await requestKeysByBranch(fixture)).toEqual(
        new Map([
          [fixture.branchId, ["req-w"]],
          [other, ["req-w"]],
        ])
      );
    });

    it("records a session that wrote to a branch a plan produced as implementing it, with the plan associated and no issue", async () => {
      const fixture = await seed({ linkIssue: false });
      const planId = await producingDocument(
        fixture,
        ArtifactSubtype.IMPLEMENTATION_PLAN
      );
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);

      await derive(fixture);

      expect(await implementationRows(fixture)).toEqual([
        expect.objectContaining({
          agentSessionId: fixture.writer,
          targetArtifactId: fixture.branchId,
          relationshipKind: AttributionRelationshipKind.Implementation,
          anchors: expect.objectContaining({
            associatedArtifactIds: [planId],
          }),
        }),
      ]);
    });

    it("records a session that wrote to a branch nothing produced, with no associated artifact", async () => {
      const fixture = await seed({ linkIssue: false });
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await sessionLink(fixture, fixture.reader, null);

      await derive(fixture);

      expect(await implementationRows(fixture)).toEqual([
        expect.objectContaining({
          agentSessionId: fixture.writer,
          targetArtifactId: fixture.branchId,
          anchors: expect.objectContaining({ associatedArtifactIds: [] }),
        }),
      ]);
    });

    it("removes the row once the session no longer wrote to the branch", async () => {
      const fixture = await seed();
      await sessionLink(fixture, fixture.writer, BranchParticipationKind.Wrote);
      await derive(fixture);
      expect(await implementationRows(fixture)).toHaveLength(1);

      await withDb((db) =>
        db.artifactLink.updateMany({
          where: { sourceId: fixture.writer, targetId: fixture.branchId },
          data: { branchParticipation: null },
        })
      );
      await derive(fixture);

      expect(await implementationRows(fixture)).toEqual([]);
    });
  }
);

async function persist(
  fixture: Fixture,
  extractorVersion: number,
  claims: OperationClaim[]
): Promise<void> {
  await withDb.tx(
    (tx) =>
      persistSessionOperationEvidence(tx, {
        organizationId: fixture.organizationId,
        agentSessionId: fixture.writer,
        fresh: true,
        evidence: {
          extractorVersion,
          digest: "a".repeat(64),
          coverage: {
            harness: "claude",
            evidencePathSupported: true,
            closedloopMcpCalls: 0,
            shellCallsWithOperationIds: 0,
            directApiShellCommands: 0,
            unsupportedToolNames: {},
            claimsDroppedByCap: 0,
          },
          claims,
        },
      }),
    TRANSACTION_OPTIONS
  );
}

function join(branch: string, requestKeys: string[]): OperationClaim {
  return {
    claimKey: `claude:implementation:${branch}`,
    source: OperationClaimSource.ImplementationJoin,
    branch,
    requestKeys,
  };
}

function derive(fixture: Fixture): Promise<void> {
  return withDb.tx(
    (tx) =>
      deriveImplementationEvidence(tx, {
        organizationId: fixture.organizationId,
        sessionIds: [fixture.writer],
      }),
    TRANSACTION_OPTIONS
  );
}

type Fixture = {
  organizationId: string;
  writer: string;
  reader: string;
  branchId: string;
  issueId: string;
};

async function seed(
  options: { linkIssue?: boolean; flagOn?: boolean } = {}
): Promise<Fixture> {
  const organizationId = await tracker.create();
  if (options.flagOn === false) {
    const organization = await withDb((db) =>
      db.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { clerkId: true },
      })
    );
    flag.offClerkOrganizationIds.add(organization.clerkId);
  }
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const writer = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "writer",
  });
  const reader = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "reader",
  });
  const { branchId, issueId } = await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: "branch-feat-x",
        status: BranchStatus.Open,
        createdById: user.id,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryFullName: "acme/app",
        branchName: "feat/x",
      },
      select: { artifactId: true },
    });
    const issue = await db.artifact.create({
      data: {
        name: "Issue",
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        status: DocumentStatus.Draft,
        organizationId,
        createdById: user.id,
        projectId,
      },
      select: { id: true },
    });
    return { branchId: branch.id, issueId: issue.id };
  });
  if (options.linkIssue !== false) {
    await withDb((db) =>
      db.artifactLink.create({
        data: {
          organizationId,
          sourceId: issueId,
          targetId: branchId,
          linkType: LinkType.Produces,
        },
      })
    );
  }
  return { organizationId, writer, reader, branchId, issueId };
}

async function sessionLink(
  fixture: Fixture,
  sessionId: string,
  participation: BranchParticipationKind | null
): Promise<void> {
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId: fixture.organizationId,
        sourceId: sessionId,
        targetId: fixture.branchId,
        linkType: LinkType.RelatesTo,
        branchParticipation: participation,
        metadata: {},
      },
    })
  );
}

function implementationRows(fixture: Fixture) {
  return withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: { organizationId: fixture.organizationId },
      orderBy: { agentSessionId: "asc" },
      select: {
        agentSessionId: true,
        targetArtifactId: true,
        relationshipKind: true,
        source: true,
        anchors: true,
      },
    })
  );
}

/**
 * An active installation of the fixture's organization holding one
 * repository, and the pull_request delivery fields that name it.
 */
async function seedInstallationRepository(
  fixture: Fixture,
  index: number
): Promise<{
  installationId: number;
  repository: { id: number; full_name: string };
}> {
  const installationId = 12_552_000_000 + randomInt(1_000_000) * 10 + index;
  const githubRepoId = installationId + 1;
  await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId: fixture.organizationId,
        installationId: String(installationId),
        accountId: `acct-${installationId}`,
        accountLogin: "acme",
        accountType: "Organization",
        status: GitHubInstallationStatus.ACTIVE,
        senderLogin: "sender",
        senderId: `sender-${installationId}`,
        repositories: {
          create: {
            ...persistedGitHubRepositoryAuthority({
              githubRepoId: String(githubRepoId),
              fullName: "acme/app",
            }),
            name: "app",
            owner: "acme",
            private: false,
          },
        },
      },
      select: { id: true },
    })
  );
  return {
    installationId,
    repository: { id: githubRepoId, full_name: "acme/app" },
  };
}

/** A branch with the fixture branch's name in another repository, produced by its issue. */
async function sameNamedBranch(
  fixture: Fixture,
  repositoryFullName: string
): Promise<string> {
  return await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId: fixture.organizationId,
        type: ArtifactType.BRANCH,
        name: `branch-feat-x-${repositoryFullName}`,
        status: BranchStatus.Open,
        createdById: (
          await db.artifact.findUniqueOrThrow({
            where: { id: fixture.issueId },
            select: { createdById: true },
          })
        ).createdById,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId: fixture.organizationId,
        repositoryFullName,
        branchName: "feat/x",
      },
      select: { artifactId: true },
    });
    await db.artifactLink.create({
      data: {
        organizationId: fixture.organizationId,
        sourceId: fixture.issueId,
        targetId: branch.id,
        linkType: LinkType.Produces,
      },
      select: { id: true },
    });
    return branch.id;
  });
}

/** The repository the writer session ran in, as its sync recorded it. */
async function sessionRepository(
  fixture: Fixture,
  repositoryFullName: string | null
): Promise<void> {
  await withDb((db) =>
    db.sessionDetail.update({
      where: { artifactId: fixture.writer },
      data: { repositoryFullName },
      select: { artifactId: true },
    })
  );
}

async function requestKeysByBranch(
  fixture: Fixture
): Promise<Map<string | null, unknown>> {
  const rows = await implementationRows(fixture);
  return new Map(
    rows.map((row) => [
      row.targetArtifactId,
      z.object({ requestKeys: z.unknown() }).loose().parse(row.anchors)
        .requestKeys,
    ])
  );
}

/** The writer session's link to the fixture branch. */
async function sessionLinkId(fixture: Fixture): Promise<string> {
  const link = await withDb((db) =>
    db.artifactLink.findFirstOrThrow({
      where: {
        organizationId: fixture.organizationId,
        sourceId: fixture.writer,
        targetId: fixture.branchId,
        linkType: LinkType.RelatesTo,
      },
      select: { id: true },
    })
  );
  return link.id;
}

/** A document of the given kind that produced the fixture branch. */
async function producingDocument(
  fixture: Fixture,
  subtype: ArtifactSubtype
): Promise<string> {
  return await withDb(async (db) => {
    const issue = await db.artifact.findUniqueOrThrow({
      where: { id: fixture.issueId },
      select: { createdById: true, projectId: true },
    });
    const document = await db.artifact.create({
      data: {
        name: "Producer",
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype,
        status: DocumentStatus.Draft,
        organizationId: fixture.organizationId,
        createdById: issue.createdById,
        projectId: issue.projectId,
      },
      select: { id: true },
    });
    await db.artifactLink.create({
      data: {
        organizationId: fixture.organizationId,
        sourceId: document.id,
        targetId: fixture.branchId,
        linkType: LinkType.Produces,
      },
      select: { id: true },
    });
    return document.id;
  });
}
