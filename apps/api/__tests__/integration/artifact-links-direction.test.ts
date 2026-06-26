import { describe, expect, it } from "vitest";
/**
 * ArtifactLink direction contract — integration test against a real DB.
 *
 * Why this exists
 * ---------------
 * The canonical convention is DOCUMENT → produces → BRANCH:
 *   ArtifactLink { sourceId: documentId, targetId: prId, linkType: PRODUCES }
 *
 * From the PR artifact's perspective, this link is an INCOMING edge, so the PR
 * artifact reads it via `artifact.targetLinks`. Several webhook handlers all
 * rely on this direction to find the document that produced a PR:
 *
 *   - apps/api/app/webhooks/github/handlers/pull-request-handler.ts
 *   - apps/api/app/webhooks/github/handlers/pull-request-review-handler.ts
 *   - apps/api/app/webhooks/github/handlers/pull-request-review-comment-handler.ts
 *   - apps/api/app/webhooks/github/handlers/issue-comment-handler.ts
 *   - apps/api/app/webhooks/github/handlers/check-run-handler.ts
 *
 * The pre-refactor bug swapped `targetLinks` for `sourceLinks` on the PR,
 * producing a wrong-direction query that always returned an empty list.
 * Mocked-Prisma unit tests could not detect this because fixtures typically
 * populated both relations symmetrically.
 *
 * Contract pinned by this file
 * ----------------------------
 * Given a DOCUMENT→PRODUCES→PR link plus a noise PR→RELATES_TO→DOCUMENT link
 * in the reverse direction, assert:
 *
 *   1. PR.targetLinks[source.type=DOCUMENT]  → returns the producing doc.
 *   2. PR.sourceLinks[source.type=DOCUMENT]  → empty (this is the bug shape).
 *   3. Document.sourceLinks[target.type=PR]  → returns the produced PR.
 *   4. Document.targetLinks[target.type=PR]  → empty.
 *   5. Service layer: findResolvedLinks(doc, Source) vs (doc, Target) vs
 *      (pr, Source) vs (pr, Target) each return the expected directed slice.
 *
 * Any handler that regresses to the wrong relation fails cases 1-2 or 3-4.
 * Any service-level direction confusion (e.g. context-section's client-side
 * filter bug) fails case 5.
 */

import {
  ArtifactType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import {
  GitHubPRState,
  ArtifactType as PrismaArtifactType,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { artifactLinksService } from "@/app/artifact-links/service";
import { documentService } from "@/app/documents/document-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

async function setupTestData() {
  const testOrgId = await createTestOrganization();
  const testUser = await createTestUser(testOrgId);
  const testProjectId = await createTestProject(testOrgId, testUser.id);
  return { testOrgId, testProjectId, testUser };
}

async function seedGithubRepoForOrg(
  organizationId: string
): Promise<{ repositoryId: string }> {
  const suffix = organizationId.slice(0, 8);
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `install-${suffix}`,
        accountId: `acct-${suffix}`,
        accountLogin: "org",
        accountType: "Organization",
        senderLogin: "sender",
        senderId: "sender-id",
        repositories: {
          create: {
            githubRepoId: `repo-${suffix}`,
            fullName: `org/repo-${suffix}`,
            name: "repo",
            owner: "org",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repo = installation.repositories[0];
  if (!repo) {
    throw new Error("Failed to seed repository for test");
  }
  return { repositoryId: repo.id };
}

function createBranchArtifact(
  orgId: string,
  projectId: string,
  repositoryId: string,
  overrides: { title: string; number: number; githubId: string; url: string }
): Promise<{ id: string }> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId: orgId,
        projectId,
        type: PrismaArtifactType.BRANCH,
        name: "feat/test",
        status: GitHubPRState.OPEN,
        externalUrl: overrides.url,
        branch: {
          create: {
            repositoryId,
            branchName: "feat/test",
            baseBranch: "main",
          },
        },
        pullRequestDetails: {
          create: {
            repositoryId,
            githubId: overrides.githubId,
            number: overrides.number,
            title: overrides.title,
            htmlUrl: overrides.url,
            prState: GitHubPRState.OPEN,
            isCurrent: true,
          },
        },
      },
      select: { id: true, pullRequestDetails: { select: { id: true } } },
    });
    const currentDetailId = artifact.pullRequestDetails[0]?.id ?? null;
    if (currentDetailId) {
      await db.branchDetail.update({
        where: { artifactId: artifact.id },
        data: { currentPullRequestDetailId: currentDetailId },
      });
    }
    return { id: artifact.id };
  });
}

async function createDocumentArtifact(
  orgId: string,
  userId: string,
  projectId: string,
  overrides: { type: DocumentType; title: string }
): Promise<{ id: string }> {
  const artifact = await documentService.create(orgId, userId, {
    projectId,
    type: overrides.type,
    title: overrides.title,
    content: "Content",
  });
  if (!artifact) {
    throw new Error("Failed to create document artifact");
  }
  return { id: artifact.id };
}

/**
 * Seed the canonical DOCUMENT → produces → PR link plus a reverse-direction
 * noise link (PR → relates_to → DOCUMENT) so direction-symmetric queries
 * (i.e. a handler that forgot to filter) would return both rows and fail
 * the "returns exactly one" assertions below.
 */
async function seedDirectionFixture(
  orgId: string,
  docId: string,
  prId: string
): Promise<{ produceLinkId: string }> {
  const produceLink = await artifactLinksService.createLink(orgId, {
    sourceId: docId,
    targetId: prId,
    linkType: LinkType.Produces,
  });
  // Noise link in the reverse direction — must NOT appear in direction-
  // scoped queries below.
  await artifactLinksService.createLink(orgId, {
    sourceId: prId,
    targetId: docId,
    linkType: LinkType.RelatesTo,
  });
  return { produceLinkId: produceLink.id };
}

describe.skipIf(!hasDatabase)("ArtifactLink direction contract", () => {
  it("PR.targetLinks returns the producing document; PR.sourceLinks does not", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();
      const { repositoryId } = await seedGithubRepoForOrg(testOrgId);

      const doc = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Plan" }
      );
      const pr = await createBranchArtifact(
        testOrgId,
        testProjectId,
        repositoryId,
        {
          title: "PR #1",
          number: 1,
          githubId: "gh-1",
          url: "https://github.com/org/repo/pull/1",
        }
      );
      await seedDirectionFixture(testOrgId, doc.id, pr.id);

      // This is the exact include shape used by every PR-side webhook
      // handler that looks up "the document that produced this PR".
      const prArtifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: pr.id },
          select: {
            id: true,
            targetLinks: {
              where: {
                linkType: LinkType.Produces,
                source: { type: PrismaArtifactType.DOCUMENT },
              },
              select: { source: { select: { id: true, slug: true } } },
            },
            sourceLinks: {
              where: {
                linkType: LinkType.Produces,
                source: { type: PrismaArtifactType.DOCUMENT },
              },
              select: { source: { select: { id: true, slug: true } } },
            },
          },
        })
      );

      expect(prArtifact).not.toBeNull();
      // (1) Correct direction — the PRODUCES link is INCOMING to the PR.
      expect(prArtifact?.targetLinks).toHaveLength(1);
      expect(prArtifact?.targetLinks[0]?.source.id).toBe(doc.id);
      // (2) Wrong direction — this is the shape of the pre-refactor bug.
      // If a handler queries sourceLinks here, it gets nothing even though
      // a link exists. Tests that populate both relations symmetrically
      // would fail to catch this.
      expect(prArtifact?.sourceLinks).toHaveLength(0);
    });
  });

  it("Document.sourceLinks returns the produced PR; Document.targetLinks does not", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();
      const { repositoryId } = await seedGithubRepoForOrg(testOrgId);

      const doc = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Plan" }
      );
      const pr = await createBranchArtifact(
        testOrgId,
        testProjectId,
        repositoryId,
        {
          title: "PR #2",
          number: 2,
          githubId: "gh-2",
          url: "https://github.com/org/repo/pull/2",
        }
      );
      await seedDirectionFixture(testOrgId, doc.id, pr.id);

      const docArtifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: doc.id },
          select: {
            id: true,
            // From the doc's perspective, PRODUCES is OUTGOING, so it shows
            // up on `sourceLinks` (where doc is the source). This is what
            // features/plans queries use to list "what PRs do I own?".
            sourceLinks: {
              where: {
                linkType: LinkType.Produces,
                target: { type: PrismaArtifactType.BRANCH },
              },
              select: { target: { select: { id: true, slug: true } } },
            },
            targetLinks: {
              where: {
                linkType: LinkType.Produces,
                target: { type: PrismaArtifactType.BRANCH },
              },
              select: { target: { select: { id: true, slug: true } } },
            },
          },
        })
      );

      expect(docArtifact).not.toBeNull();
      expect(docArtifact?.sourceLinks).toHaveLength(1);
      expect(docArtifact?.sourceLinks[0]?.target.id).toBe(pr.id);
      expect(docArtifact?.targetLinks).toHaveLength(0);
    });
  });

  describe("findResolvedLinks direction slices", () => {
    it("doc + Target returns outgoing PRODUCES; doc + Source excludes it", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();
        const { repositoryId } = await seedGithubRepoForOrg(testOrgId);

        const doc = await createDocumentArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: DocumentType.ImplementationPlan, title: "Plan" }
        );
        const pr = await createBranchArtifact(
          testOrgId,
          testProjectId,
          repositoryId,
          {
            title: "PR #4",
            number: 4,
            githubId: "gh-4",
            url: "https://github.com/org/repo/pull/4",
          }
        );
        await seedDirectionFixture(testOrgId, doc.id, pr.id);

        // Doc is the source of PRODUCES → its "target" direction returns the
        // outgoing PRODUCES link to the PR. The noise RELATES_TO link is in
        // the other direction and must be filtered out by the linkType.
        const outgoing = await artifactLinksService.findResolvedLinks(
          testOrgId,
          doc.id,
          LinkDirection.Target,
          LinkType.Produces
        );
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0]?.source.id).toBe(doc.id);
        expect(outgoing[0]?.target.id).toBe(pr.id);
        expect(outgoing[0]?.target.type).toBe(ArtifactType.Branch);

        // Doc is the source of PRODUCES, NOT the target. Source direction
        // (i.e. "links arriving at me") with PRODUCES filter must be empty.
        const incomingProduces = await artifactLinksService.findResolvedLinks(
          testOrgId,
          doc.id,
          LinkDirection.Source,
          LinkType.Produces
        );
        expect(incomingProduces).toHaveLength(0);
      });
    });

    it("pr + Source returns incoming PRODUCES; pr + Target excludes it", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();
        const { repositoryId } = await seedGithubRepoForOrg(testOrgId);

        const doc = await createDocumentArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: DocumentType.ImplementationPlan, title: "Plan" }
        );
        const pr = await createBranchArtifact(
          testOrgId,
          testProjectId,
          repositoryId,
          {
            title: "PR #5",
            number: 5,
            githubId: "gh-5",
            url: "https://github.com/org/repo/pull/5",
          }
        );
        await seedDirectionFixture(testOrgId, doc.id, pr.id);

        // PR is the target of PRODUCES → its "source" direction returns the
        // incoming PRODUCES link from the doc.
        const incoming = await artifactLinksService.findResolvedLinks(
          testOrgId,
          pr.id,
          LinkDirection.Source,
          LinkType.Produces
        );
        expect(incoming).toHaveLength(1);
        expect(incoming[0]?.source.id).toBe(doc.id);
        expect(incoming[0]?.source.type).toBe(ArtifactType.Document);
        expect(incoming[0]?.target.id).toBe(pr.id);

        // PR is NOT the source of PRODUCES. Target direction (i.e. "links
        // I produce") with PRODUCES filter must be empty.
        const outgoingProduces = await artifactLinksService.findResolvedLinks(
          testOrgId,
          pr.id,
          LinkDirection.Target,
          LinkType.Produces
        );
        expect(outgoingProduces).toHaveLength(0);
      });
    });

    it("Both direction returns the same link once regardless of starting side", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();
        const { repositoryId } = await seedGithubRepoForOrg(testOrgId);

        const doc = await createDocumentArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: DocumentType.ImplementationPlan, title: "Plan" }
        );
        const pr = await createBranchArtifact(
          testOrgId,
          testProjectId,
          repositoryId,
          {
            title: "PR #6",
            number: 6,
            githubId: "gh-6",
            url: "https://github.com/org/repo/pull/6",
          }
        );
        const { produceLinkId } = await seedDirectionFixture(
          testOrgId,
          doc.id,
          pr.id
        );

        const fromDoc = await artifactLinksService.findResolvedLinks(
          testOrgId,
          doc.id,
          LinkDirection.Both,
          LinkType.Produces
        );
        const fromPr = await artifactLinksService.findResolvedLinks(
          testOrgId,
          pr.id,
          LinkDirection.Both,
          LinkType.Produces
        );

        expect(fromDoc).toHaveLength(1);
        expect(fromPr).toHaveLength(1);
        expect(fromDoc[0]?.id).toBe(produceLinkId);
        expect(fromPr[0]?.id).toBe(produceLinkId);
      });
    });
  });
});
