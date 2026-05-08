#!/usr/bin/env tsx
/**
 * One-off QA seed for the PR rating feature (LOCAL DEVELOPMENT ONLY).
 *
 * Seeds the Artifact-shaped fixtures required to open the PR-rating UI:
 *   - Organization + user + project + workstream
 *   - GitHubInstallation + GitHubInstallationRepository
 *   - DOCUMENT artifact (PRD) with a DocumentVersion
 *   - PULL_REQUEST artifact + PullRequestDetail
 *   - ArtifactRating row (score=4, comment="nice work", artifactVersion=null)
 *   - ArtifactLink PRD -> PR via PRODUCES
 *
 * Run: pnpm --filter=@repo/database exec tsx scripts/seed-pr-rating.ts
 */

import "dotenv/config";
import { ArtifactSubtype, ArtifactType, LinkType, withDb } from "../index";

const ORG_CLERK_ID = "org_seed_pr_rating";
const ORG_SLUG = "seed-pr-rating";
const ORG_NAME = "PR Rating QA Org";
const USER_CLERK_ID = "user_seed_pr_rating";
const USER_EMAIL = "pr-rating-qa@local.dev";
const PROJECT_SLUG = "seed-pr-rating-project";
const PROJECT_NAME = "PR Rating QA Project";
const WORKSTREAM_SLUG = "seed-pr-rating-workstream";
const INSTALLATION_ID = "999999";
const REPO_GITHUB_ID = "999999";
const REPO_OWNER = "symphony-test";
const REPO_NAME = "pr-rating-qa";
const REPO_FULL_NAME = `${REPO_OWNER}/${REPO_NAME}`;
const PRD_SLUG = "seed-pr-rating-prd";
const PR_GITHUB_ID = "12345";
const PR_NUMBER = 1;
const PR_SLUG = "seed-pr-rating-pr";
const PR_HTML_URL = `https://github.com/${REPO_FULL_NAME}/pull/${PR_NUMBER}`;
const PR_HEAD_BRANCH = "feature/pr-rating-qa";
const PR_BASE_BRANCH = "main";

const PRD_BODY = `# PR Rating QA PRD

Minimal PRD fixture so the linked PR has a rating target.
`;

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  log("Seeding PR rating QA fixtures...");

  const counts = await withDb.tx(async (tx) => {
    const organization = await tx.organization.upsert({
      where: { clerkId: ORG_CLERK_ID },
      update: {},
      create: {
        clerkId: ORG_CLERK_ID,
        name: ORG_NAME,
        slug: ORG_SLUG,
      },
    });

    const user = await tx.user.upsert({
      where: {
        organizationId_email: {
          organizationId: organization.id,
          email: USER_EMAIL,
        },
      },
      update: {},
      create: {
        clerkId: USER_CLERK_ID,
        organizationId: organization.id,
        email: USER_EMAIL,
        firstName: "PR Rating",
        lastName: "QA",
      },
    });

    const project = await tx.project.upsert({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug: PROJECT_SLUG,
        },
      },
      update: {},
      create: {
        organizationId: organization.id,
        name: PROJECT_NAME,
        slug: PROJECT_SLUG,
        description: "PR rating QA fixture project",
        createdById: user.id,
        assigneeId: user.id,
      },
    });

    const existingWorkstream = await tx.workstream.findUnique({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug: WORKSTREAM_SLUG,
        },
      },
    });
    const workstream =
      existingWorkstream ??
      (await tx.workstream.create({
        data: {
          organizationId: organization.id,
          projectId: project.id,
          title: "PR Rating QA Workstream",
          slug: WORKSTREAM_SLUG,
          state: "IMPLEMENTATION_IN_PROGRESS",
          createdById: user.id,
          assigneeId: user.id,
        },
      }));

    // GitHub install + repository
    const installation = await tx.gitHubInstallation.upsert({
      where: { installationId: INSTALLATION_ID },
      update: {
        organizationId: organization.id,
        status: "ACTIVE",
      },
      create: {
        organizationId: organization.id,
        installationId: INSTALLATION_ID,
        accountId: "999999",
        accountLogin: REPO_OWNER,
        accountType: "Organization",
        senderLogin: "pr-rating-qa-seed",
        senderId: "1",
        status: "ACTIVE",
      },
    });

    const repository = await tx.gitHubInstallationRepository.upsert({
      where: {
        installationId_githubRepoId: {
          installationId: installation.id,
          githubRepoId: REPO_GITHUB_ID,
        },
      },
      update: {},
      create: {
        installationId: installation.id,
        githubRepoId: REPO_GITHUB_ID,
        owner: REPO_OWNER,
        name: REPO_NAME,
        fullName: REPO_FULL_NAME,
        private: false,
      },
    });

    // PRD artifact + version
    const existingPrd = await tx.artifact.findFirst({
      where: {
        organizationId: organization.id,
        slug: PRD_SLUG,
        type: ArtifactType.DOCUMENT,
      },
    });
    const prdArtifact =
      existingPrd ??
      (await tx.artifact.create({
        data: {
          organizationId: organization.id,
          projectId: project.id,
          workstreamId: workstream.id,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.PRD,
          name: "PR Rating QA PRD",
          slug: PRD_SLUG,
          status: "APPROVED",
          createdById: user.id,
          assigneeId: user.id,
          document: {
            create: {
              latestVersion: 1,
              versions: {
                create: {
                  version: 1,
                  content: PRD_BODY,
                  createdById: user.id,
                },
              },
            },
          },
        },
      }));
    await tx.documentDetail.upsert({
      where: { artifactId: prdArtifact.id },
      update: {},
      create: { artifactId: prdArtifact.id, latestVersion: 1 },
    });

    // PR artifact + pull-request detail
    const existingPr = await tx.artifact.findFirst({
      where: {
        organizationId: organization.id,
        slug: PR_SLUG,
        type: ArtifactType.PULL_REQUEST,
      },
    });
    const prArtifact =
      existingPr ??
      (await tx.artifact.create({
        data: {
          organizationId: organization.id,
          projectId: project.id,
          workstreamId: workstream.id,
          type: ArtifactType.PULL_REQUEST,
          name: "feat: PR Rating QA mock PR",
          slug: PR_SLUG,
          status: "OPEN",
          externalUrl: PR_HTML_URL,
          createdById: user.id,
          pullRequest: {
            create: {
              repositoryId: repository.id,
              githubId: PR_GITHUB_ID,
              number: PR_NUMBER,
              headBranch: PR_HEAD_BRANCH,
              baseBranch: PR_BASE_BRANCH,
              prState: "OPEN",
              isDraft: false,
            },
          },
        },
      }));

    // If the PR artifact existed without a detail row, ensure one is present.
    const existingDetail = await tx.pullRequestDetail.findUnique({
      where: { artifactId: prArtifact.id },
    });
    if (!existingDetail) {
      await tx.pullRequestDetail.create({
        data: {
          artifactId: prArtifact.id,
          repositoryId: repository.id,
          githubId: PR_GITHUB_ID,
          number: PR_NUMBER,
          headBranch: PR_HEAD_BRANCH,
          baseBranch: PR_BASE_BRANCH,
          prState: "OPEN",
          isDraft: false,
        },
      });
    }

    // ArtifactLink: PRD PRODUCES PR
    await tx.artifactLink.upsert({
      where: {
        sourceId_targetId_linkType: {
          sourceId: prdArtifact.id,
          targetId: prArtifact.id,
          linkType: LinkType.PRODUCES,
        },
      },
      update: {},
      create: {
        organizationId: organization.id,
        sourceId: prdArtifact.id,
        targetId: prArtifact.id,
        linkType: LinkType.PRODUCES,
      },
    });

    // ArtifactRating: score=4, comment="nice work", artifactVersion=null
    await tx.artifactRating.upsert({
      where: {
        artifactId_userId_organizationId: {
          artifactId: prArtifact.id,
          userId: user.id,
          organizationId: organization.id,
        },
      },
      update: {
        score: 4,
        comment: "nice work",
        artifactVersion: null,
      },
      create: {
        artifactId: prArtifact.id,
        userId: user.id,
        organizationId: organization.id,
        score: 4,
        comment: "nice work",
        artifactVersion: null,
      },
    });

    const artifactCount = await tx.artifact.count({
      where: { organizationId: organization.id },
    });
    const ratingCount = await tx.artifactRating.count({
      where: { organizationId: organization.id },
    });
    const linkCount = await tx.artifactLink.count({
      where: { organizationId: organization.id },
    });

    return {
      organizationId: organization.id,
      userId: user.id,
      projectId: project.id,
      workstreamId: workstream.id,
      prdArtifactId: prdArtifact.id,
      prArtifactId: prArtifact.id,
      artifactCount,
      ratingCount,
      linkCount,
    };
  });

  log(`  organization: ${counts.organizationId}`);
  log(`  user: ${counts.userId}`);
  log(`  project: ${counts.projectId}`);
  log(`  workstream: ${counts.workstreamId}`);
  log(`  PRD artifact: ${counts.prdArtifactId}`);
  log(`  PR artifact: ${counts.prArtifactId}`);
  log(`  artifact count (org): ${counts.artifactCount}`);
  log(`  artifact ratings (org): ${counts.ratingCount}`);
  log(`  artifact links (org): ${counts.linkCount}`);
  log("PR rating QA seed completed.");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      `Seed failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    if (error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exit(1);
  });
