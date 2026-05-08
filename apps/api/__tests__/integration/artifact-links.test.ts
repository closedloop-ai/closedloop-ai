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

async function createDocumentArtifact(
  orgId: string,
  userId: string,
  projectId: string,
  overrides: { type: DocumentType; title: string }
): Promise<{ id: string; type: ArtifactType }> {
  const artifact = await documentService.create(orgId, userId, {
    projectId,
    type: overrides.type,
    title: overrides.title,
    content: "Content",
  });
  if (!artifact) {
    throw new Error("Failed to create test artifact");
  }
  return { id: artifact.id, type: ArtifactType.Document };
}

/**
 * Seed a GitHubInstallation + Repository for the org so pull-request artifact
 * creation can satisfy `pull_request_detail_repository_id_fkey`.
 */
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

/**
 * Creates a PR-typed artifact directly via Prisma against a real
 * (test-seeded) GitHubInstallationRepository row.
 */
function createPullRequestArtifact(
  orgId: string,
  projectId: string,
  repositoryId: string,
  overrides: { title: string; number: number; githubId: string; url: string }
): Promise<{ id: string }> {
  return withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: orgId,
        projectId,
        type: PrismaArtifactType.PULL_REQUEST,
        name: overrides.title,
        status: GitHubPRState.OPEN,
        externalUrl: overrides.url,
        pullRequest: {
          create: {
            repositoryId,
            githubId: overrides.githubId,
            number: overrides.number,
            headBranch: "feat/test",
            baseBranch: "main",
            prState: GitHubPRState.OPEN,
          },
        },
      },
      select: { id: true },
    })
  );
}

describe.skipIf(!hasDatabase)("Artifact Links Integration", () => {
  it("creates and finds bidirectional links", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.Prd, title: "Feature PRD" }
      );
      const artifact2 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Implementation Plan" }
      );

      const link = await artifactLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        targetId: artifact2.id,
        linkType: LinkType.Produces,
      });

      expect(link.id).toBeDefined();
      expect(link.sourceId).toBe(artifact1.id);
      expect(link.targetId).toBe(artifact2.id);
      expect(link.linkType).toBe(LinkType.Produces);

      // Find bidirectional links for artifact1
      const links1 = await artifactLinksService.findLinks(
        testOrgId,
        artifact1.id
      );
      expect(links1).toHaveLength(1);
      expect(links1[0].id).toBe(link.id);

      // Find bidirectional links for artifact2
      const links2 = await artifactLinksService.findLinks(
        testOrgId,
        artifact2.id
      );
      expect(links2).toHaveLength(1);
      expect(links2[0].id).toBe(link.id);
    });
  });

  it("finds source and target links directionally", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.Prd, title: "Feature PRD" }
      );
      const artifact2 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Plan" }
      );

      await artifactLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        targetId: artifact2.id,
        linkType: LinkType.Produces,
      });

      // Source links for artifact2 (what produced it?) -> artifact1
      const sourceLinks = await artifactLinksService.findSourceLinks(
        testOrgId,
        artifact2.id,
        LinkType.Produces
      );
      expect(sourceLinks).toHaveLength(1);
      expect(sourceLinks[0].sourceId).toBe(artifact1.id);

      // Target links for artifact1 (what did it produce?) -> artifact2
      const targetLinks = await artifactLinksService.findTargetLinks(
        testOrgId,
        artifact1.id,
        LinkType.Produces
      );
      expect(targetLinks).toHaveLength(1);
      expect(targetLinks[0].targetId).toBe(artifact2.id);

      // Source links for artifact1 (what produced it?) -> nothing
      const noSourceLinks = await artifactLinksService.findSourceLinks(
        testOrgId,
        artifact1.id,
        LinkType.Produces
      );
      expect(noSourceLinks).toHaveLength(0);
    });
  });

  it("links document artifact to pull-request artifact", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();
      const { repositoryId } = await seedGithubRepoForOrg(testOrgId);

      const artifact = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Plan" }
      );

      const prArtifact = await createPullRequestArtifact(
        testOrgId,
        testProjectId,
        repositoryId,
        {
          title: "PR #42",
          number: 42,
          githubId: "gh-42",
          url: "https://github.com/org/repo/pull/42",
        }
      );

      const link = await artifactLinksService.createLink(testOrgId, {
        sourceId: artifact.id,
        targetId: prArtifact.id,
        linkType: LinkType.Produces,
      });

      // Bidirectional lookup works across artifact types
      const fromDoc = await artifactLinksService.findLinks(
        testOrgId,
        artifact.id
      );
      expect(fromDoc).toHaveLength(1);
      expect(fromDoc[0].id).toBe(link.id);

      const fromPr = await artifactLinksService.findLinks(
        testOrgId,
        prArtifact.id
      );
      expect(fromPr).toHaveLength(1);
      expect(fromPr[0].id).toBe(link.id);
    });
  });

  it("resolves link endpoints with full artifact rows", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const prd = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.Prd, title: "Feature PRD" }
      );
      const plan = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Plan" }
      );

      await artifactLinksService.createLink(testOrgId, {
        sourceId: prd.id,
        targetId: plan.id,
        linkType: LinkType.Produces,
      });

      const resolved = await artifactLinksService.findResolvedLinks(
        testOrgId,
        prd.id,
        LinkDirection.Both
      );

      expect(resolved).toHaveLength(1);
      expect(resolved[0].source.id).toBe(prd.id);
      expect(resolved[0].source.type).toBe(ArtifactType.Document);
      expect(resolved[0].target.id).toBe(plan.id);
      expect(resolved[0].target.type).toBe(ArtifactType.Document);
    });
  });

  it("deletes a single artifact link", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.Prd, title: "PRD" }
      );
      const artifact2 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Plan" }
      );

      const link = await artifactLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        targetId: artifact2.id,
        linkType: LinkType.Produces,
      });

      await artifactLinksService.deleteLink(link.id, testOrgId);

      const links = await artifactLinksService.findLinks(
        testOrgId,
        artifact1.id
      );
      expect(links).toHaveLength(0);
    });
  });

  it("deletes all links for an artifact", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.Prd, title: "PRD" }
      );
      const artifact2 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Plan" }
      );
      const artifact3 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Another Plan" }
      );

      await artifactLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        targetId: artifact2.id,
        linkType: LinkType.Produces,
      });
      await artifactLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        targetId: artifact3.id,
        linkType: LinkType.Produces,
      });

      const before = await artifactLinksService.findLinks(
        testOrgId,
        artifact1.id
      );
      expect(before).toHaveLength(2);

      await artifactLinksService.deleteAllLinks(testOrgId, artifact1.id);

      const after = await artifactLinksService.findLinks(
        testOrgId,
        artifact1.id
      );
      expect(after).toHaveLength(0);
    });
  });

  describe("findLinkTree", () => {
    it("traverses a three-artifact chain", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();

        const prd = await createDocumentArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: DocumentType.Prd, title: "PRD" }
        );
        const plan = await createDocumentArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: DocumentType.ImplementationPlan, title: "Plan" }
        );
        const strategy = await createDocumentArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: DocumentType.Prd, title: "Strategy" }
        );

        await artifactLinksService.createLink(testOrgId, {
          sourceId: prd.id,
          targetId: plan.id,
          linkType: LinkType.Produces,
        });
        await artifactLinksService.createLink(testOrgId, {
          sourceId: plan.id,
          targetId: strategy.id,
          linkType: LinkType.Produces,
        });

        const tree = await artifactLinksService.findLinkTree(
          testOrgId,
          prd.id,
          LinkDirection.Both,
          10
        );

        expect(tree).toHaveLength(2);
        expect(tree[0].fromArtifactId).toBe(prd.id);
        expect(tree[1].fromArtifactId).toBe(plan.id);
      });
    });

    it("traverses across artifact types (document → PR)", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();
        const { repositoryId } = await seedGithubRepoForOrg(testOrgId);

        const artifact = await createDocumentArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: DocumentType.Prd, title: "PRD" }
        );
        const prArtifact = await createPullRequestArtifact(
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

        await artifactLinksService.createLink(testOrgId, {
          sourceId: artifact.id,
          targetId: prArtifact.id,
          linkType: LinkType.Produces,
        });

        const tree = await artifactLinksService.findLinkTree(
          testOrgId,
          artifact.id,
          LinkDirection.Both,
          10
        );

        expect(tree).toHaveLength(1);
        expect(tree[0].link.targetId).toBe(prArtifact.id);
        expect(tree[0].fromArtifactId).toBe(artifact.id);
      });
    });

    it("respects maxDepth", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();

        const a = await createDocumentArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: DocumentType.Prd, title: "A" }
        );
        const b = await createDocumentArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: DocumentType.ImplementationPlan, title: "B" }
        );
        const c = await createDocumentArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: DocumentType.ImplementationPlan, title: "C" }
        );

        await artifactLinksService.createLink(testOrgId, {
          sourceId: a.id,
          targetId: b.id,
          linkType: LinkType.Produces,
        });
        await artifactLinksService.createLink(testOrgId, {
          sourceId: b.id,
          targetId: c.id,
          linkType: LinkType.Produces,
        });

        // maxDepth=1: only direct links from A
        const shallow = await artifactLinksService.findLinkTree(
          testOrgId,
          a.id,
          LinkDirection.Both,
          1
        );

        expect(shallow).toHaveLength(1);
        expect(shallow[0].link.sourceId).toBe(a.id);
        expect(shallow[0].link.targetId).toBe(b.id);
      });
    });
  });

  it("filters links by linkType", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.Prd, title: "PRD" }
      );
      const artifact2 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Plan" }
      );
      const artifact3 = await createDocumentArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: DocumentType.ImplementationPlan, title: "Another Plan" }
      );

      await artifactLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        targetId: artifact2.id,
        linkType: LinkType.Produces,
      });
      await artifactLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        targetId: artifact3.id,
        linkType: LinkType.RelatesTo,
      });

      // All links
      const all = await artifactLinksService.findLinks(testOrgId, artifact1.id);
      expect(all).toHaveLength(2);

      // Only PRODUCES links
      const produces = await artifactLinksService.findLinks(
        testOrgId,
        artifact1.id,
        LinkType.Produces
      );
      expect(produces).toHaveLength(1);
      expect(produces[0].linkType).toBe(LinkType.Produces);

      // Only RELATES_TO links
      const relatesTo = await artifactLinksService.findLinks(
        testOrgId,
        artifact1.id,
        LinkType.RelatesTo
      );
      expect(relatesTo).toHaveLength(1);
      expect(relatesTo[0].linkType).toBe(LinkType.RelatesTo);
    });
  });
});
