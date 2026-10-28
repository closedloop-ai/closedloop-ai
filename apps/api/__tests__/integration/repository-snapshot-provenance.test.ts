import { randomUUID } from "node:crypto";
import {
  artifactRepositorySnapshotSchema,
  DocumentType,
  isPrimaryRepoObserved,
} from "@repo/api/src/types/document";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import { documentService } from "@/app/documents/document-service";
import { persistedGitHubRepositoryAuthority } from "../fixtures/repository-default-authority";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

/**
 * ISS-8164: `repository_snapshot` used to stamp a project-level guess and keep
 * it forever, so repo-scoped rollups read a repository the work never touched
 * as a measured fact. This case reads the STORED column back after the
 * production write path runs — a helper returning the right object proves
 * nothing about what the row ends up holding.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL);

type SeededRepository = { repositoryId: string; repositoryFullName: string };

/**
 * One org holds at most one GitHub installation, so every repository a case
 * needs is seeded under the same installation.
 */
async function seedRepositories(
  organizationId: string,
  count: number
): Promise<SeededRepository[]> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const names = Array.from({ length: count }, (_unused, index) => ({
    name: `repo-${index}-${suffix}`,
    fullName: `closedloop-ai/repo-${index}-${suffix}`,
  }));
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `install-${suffix}`,
        accountId: `acct-${suffix}`,
        accountLogin: "closedloop-ai",
        accountType: "Organization",
        senderLogin: "sender",
        senderId: "sender-id",
        status: GitHubInstallationStatus.ACTIVE,
        repositories: {
          create: names.map((repo) => ({
            ...persistedGitHubRepositoryAuthority({
              githubRepoId: repo.name,
              fullName: repo.fullName,
            }),
            name: repo.name,
            owner: "closedloop-ai",
            private: false,
          })),
        },
      },
      include: { repositories: true },
    })
  );
  return names.map((repo) => {
    const persisted = installation.repositories.find(
      (candidate) => candidate.fullName === repo.fullName
    );
    if (!persisted) {
      throw new Error(`Failed to seed repository ${repo.fullName}`);
    }
    return {
      repositoryId: persisted.id,
      repositoryFullName: persisted.fullName,
    };
  });
}

async function curateProjectPrimaryRepository(input: {
  organizationId: string;
  projectId: string;
  installationRepositoryId: string;
}): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  await withDb((db) =>
    db.team.create({
      data: {
        organizationId: input.organizationId,
        name: `Team ${suffix}`,
        slug: `team-${suffix}`,
        repositories: {
          create: {
            installationRepositoryId: input.installationRepositoryId,
            isDefaultSelected: true,
            isPrimary: true,
          },
        },
        projects: { create: { projectId: input.projectId } },
      },
    })
  );
}

async function readStoredSnapshot(artifactId: string) {
  const detail = await withDb((db) =>
    db.documentDetail.findFirst({
      where: { artifactId },
      select: { repositorySnapshot: true },
    })
  );
  const parsed = artifactRepositorySnapshotSchema.safeParse(
    detail?.repositorySnapshot
  );
  if (!parsed.success) {
    throw new Error("Stored repository_snapshot did not parse");
  }
  return parsed.data;
}

describe.skipIf(!hasDatabase)(
  "repository snapshot provenance (ISS-8164)",
  () => {
    it("marks a never-linked document's project-default repositories unobserved", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const [defaulted] = await seedRepositories(organizationId, 1);
        await curateProjectPrimaryRepository({
          organizationId,
          projectId,
          installationRepositoryId: defaulted.repositoryId,
        });
        const created = await documentService.create(organizationId, user.id, {
          projectId,
          type: DocumentType.Prd,
          title: "ISS-8164 never-linked",
          content: "No branch will ever link to this artifact.",
        });
        expect(created).not.toBeNull();
        if (!created) {
          throw new Error("Expected the document create to return a record");
        }

        const stored = await readStoredSnapshot(created.id);
        expect(stored.repositories.map((repo) => repo.fullName)).toEqual([
          defaulted.repositoryFullName,
        ]);
        expect(stored.source).toBe("project_defaults");
        // AC-5: the marking is what stops a repo-scoped rollup counting this
        // guess as measured.
        expect(isPrimaryRepoObserved(stored.source)).toBe(false);
      });
    });
  }
);
