#!/usr/bin/env tsx
/**
 * One-off QA seed script for PR rating feature (LOCAL DEVELOPMENT ONLY).
 * Creates a mock PRD, Implementation Plan, and GitHubPullRequest so you can
 * open /implementation-plans/qa-pr-rating-plan and assign a rating to the PR.
 *
 * Run: cd packages/database && tsx scripts/seed-pr-rating.ts
 *
 * Requires an existing user (sign in via the app first). Self-contained; no
 * changes to the codebase outside this file.
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../generated/client";

const PR_RATING_QA = {
  teamSlug: "qa-pr-rating",
  teamName: "QA PR Rating",
  projectName: "PR Rating QA Test Project",
  prdSlug: "qa-pr-rating-prd",
  prdTitle: "PR Rating QA PRD",
  planSlug: "qa-pr-rating-plan",
  planTitle: "PR Rating QA Implementation Plan",
  repoOwner: "symphony-test",
  repoName: "pr-rating-qa",
  repoFullName: "symphony-test/pr-rating-qa",
  repoGitHubId: "999999",
  prNumber: 1,
  prGitHubId: "12345",
  prTitle: "feat: PR Rating QA mock PR",
  prHeadBranch: "feature/pr-rating-qa",
  prBaseBranch: "main",
  prHtmlUrl: "https://github.com/symphony-test/pr-rating-qa/pull/1",
};

function getClient(): InstanceType<typeof PrismaClient> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");

  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl: false,
  });

  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

async function main() {
  console.log("🌱 PR Rating QA seed...\n");

  const prisma = getClient();

  try {
    const existingUser = await prisma.user.findFirst({
      include: { organization: true },
    });

    if (!existingUser) {
      console.log("❌ No user found in database.\n");
      console.log(
        "Sign in via the app first (e.g. pnpm dev, then http://localhost:3000), then run this script again.\n"
      );
      process.exit(1);
    }

    const organizationId = existingUser.organizationId;
    const userId = existingUser.id;
    console.log(`✓ Using user: ${existingUser.email} (${userId})`);
    console.log(
      `✓ Organization: ${existingUser.organization.name} (${organizationId})\n`
    );

    // 1. Mock Team
    const team = await prisma.team.upsert({
      where: {
        organizationId_slug: {
          organizationId,
          slug: PR_RATING_QA.teamSlug,
        },
      },
      update: {},
      create: {
        organizationId,
        name: PR_RATING_QA.teamName,
        slug: PR_RATING_QA.teamSlug,
      },
    });
    console.log(`✓ Team: ${team.name} (${team.id})`);

    // 2. Add user as OWNER to team
    await prisma.teamMember.upsert({
      where: {
        teamId_userId: { teamId: team.id, userId },
      },
      update: { role: "OWNER" },
      create: {
        teamId: team.id,
        userId,
        role: "OWNER",
      },
    });
    console.log(`✓ User added to ${team.name} as OWNER`);

    // 3. Project
    let project = await prisma.project.findFirst({
      where: { organizationId, name: PR_RATING_QA.projectName },
    });
    if (project) {
      console.log(`✓ Project exists: ${project.name} (${project.id})`);
    } else {
      project = await prisma.project.create({
        data: {
          organizationId,
          name: PR_RATING_QA.projectName,
          description: "QA project for PR rating feature",
          assigneeId: userId,
          createdById: userId,
        },
      });
      console.log(`✓ Project created: ${project.name} (${project.id})`);
    }

    // 4. Link project to team
    await prisma.projectTeam.upsert({
      where: {
        projectId_teamId: { projectId: project.id, teamId: team.id },
      },
      update: {},
      create: {
        projectId: project.id,
        teamId: team.id,
      },
    });
    console.log(`✓ Project linked to ${team.name}`);

    // 5. Workstream
    let workstream = await prisma.workstream.findFirst({
      where: { projectId: project.id, organizationId },
    });
    if (workstream) {
      console.log(`✓ Workstream exists: ${workstream.id}`);
    } else {
      workstream = await prisma.workstream.create({
        data: {
          organizationId,
          projectId: project.id,
          title: "PR Rating QA Workstream",
          state: "IMPLEMENTATION_IN_PROGRESS",
          createdById: userId,
        },
      });
      console.log(`✓ Workstream created: ${workstream.id}`);
    }

    // 6. GitHubInstallation + GitHubInstallationRepository (mock; upsert for idempotency)
    const installation = await prisma.gitHubInstallation.upsert({
      where: { organizationId },
      update: {},
      create: {
        organizationId,
        installationId: "999999",
        accountId: "999999",
        accountLogin: PR_RATING_QA.repoOwner,
        accountType: "Organization",
        senderLogin: "qa-seed",
        senderId: "1",
        status: "ACTIVE",
      },
    });

    const repository = await prisma.gitHubInstallationRepository.upsert({
      where: {
        installationId_githubRepoId: {
          installationId: installation.id,
          githubRepoId: PR_RATING_QA.repoGitHubId,
        },
      },
      update: {},
      create: {
        installationId: installation.id,
        githubRepoId: PR_RATING_QA.repoGitHubId,
        owner: PR_RATING_QA.repoOwner,
        name: PR_RATING_QA.repoName,
        fullName: PR_RATING_QA.repoFullName,
        private: false,
      },
    });
    console.log(`✓ Repository: ${repository.fullName} (${repository.id})`);

    // 7. PRD Artifact + version
    const prdContent = `# PR Rating QA PRD

Minimal PRD for testing the PR rating UI.

## Goal
Verify that users can rate pull requests from the Implementation Plan page.
`;

    const prdDocument = await prisma.document.upsert({
      where: {
        organizationId_slug: { organizationId, slug: PR_RATING_QA.prdSlug },
      },
      update: {},
      create: {
        organizationId,
        projectId: project.id,
        type: "PRD",
        title: PR_RATING_QA.prdTitle,
        slug: PR_RATING_QA.prdSlug,
        status: "APPROVED",
        createdById: userId,
        latestVersion: 1,
      },
    });

    await prisma.documentVersion.upsert({
      where: {
        documentId_version: { documentId: prdDocument.id, version: 1 },
      },
      update: { content: prdContent },
      create: {
        documentId: prdDocument.id,
        version: 1,
        content: prdContent,
      },
    });
    console.log(`✓ PRD artifact: ${prdDocument.slug} (${prdDocument.id})`);

    // 8. Implementation Plan Artifact + version (must have workstreamId so getArtifactPullRequest finds the PR)
    const planContent = `# PR Rating QA Implementation Plan

Minimal plan for QA. Open this artifact in the UI to see the linked PR and rate it.

## Tasks
1. Verify PR rating widget appears in the sidebar.
2. Submit a rating (1–5 stars) and optional comment.
3. Confirm rating is persisted and aggregate stats update.
`;

    const planDocument = await prisma.document.upsert({
      where: {
        organizationId_slug: { organizationId, slug: PR_RATING_QA.planSlug },
      },
      update: { workstreamId: workstream.id, projectId: project.id },
      create: {
        organizationId,
        workstreamId: workstream.id,
        projectId: project.id,
        type: "IMPLEMENTATION_PLAN",
        title: PR_RATING_QA.planTitle,
        slug: PR_RATING_QA.planSlug,
        status: "APPROVED",
        createdById: userId,
        latestVersion: 1,
      },
    });

    await prisma.documentVersion.upsert({
      where: {
        documentId_version: { documentId: planDocument.id, version: 1 },
      },
      update: { content: planContent },
      create: {
        documentId: planDocument.id,
        version: 1,
        content: planContent,
      },
    });
    console.log(
      `✓ Implementation Plan artifact: ${planDocument.slug} (${planDocument.id})`
    );

    // 9. EntityLink: PRD PRODUCES Plan
    const existingLink = await prisma.entityLink.findFirst({
      where: {
        organizationId,
        sourceId: prdDocument.id,
        sourceType: "DOCUMENT",
        targetId: planDocument.id,
        targetType: "DOCUMENT",
        linkType: "PRODUCES",
      },
    });
    if (existingLink) {
      console.log("✓ EntityLink already exists: PRD → Plan");
    } else {
      await prisma.entityLink.create({
        data: {
          organizationId,
          sourceId: prdDocument.id,
          sourceType: "DOCUMENT",
          sourceVersion: 1,
          targetId: planDocument.id,
          targetType: "DOCUMENT",
          targetVersion: 1,
          linkType: "PRODUCES",
        },
      });
      console.log("✓ EntityLink: PRD → Plan (PRODUCES)");
    }

    // 10. GitHubPullRequest (linked to workstream, repository, and implementation plan artifact)
    let pullRequest = await prisma.gitHubPullRequest.findFirst({
      where: {
        workstreamId: workstream.id,
        repositoryId: repository.id,
        number: PR_RATING_QA.prNumber,
      },
    });
    if (pullRequest) {
      // Ensure PR is linked to the plan artifact for rating auth
      if (pullRequest.documentId !== planDocument.id) {
        await prisma.gitHubPullRequest.update({
          where: { id: pullRequest.id },
          data: { documentId: planDocument.id },
        });
        console.log(
          `✓ GitHubPullRequest updated: documentId → ${planDocument.id}`
        );
      }
      console.log(
        `✓ GitHubPullRequest exists: #${pullRequest.number} (${pullRequest.id})`
      );
    } else {
      pullRequest = await prisma.gitHubPullRequest.create({
        data: {
          workstreamId: workstream.id,
          organizationId: workstream.organizationId,
          repositoryId: repository.id,
          documentId: planDocument.id,
          githubId: PR_RATING_QA.prGitHubId,
          number: PR_RATING_QA.prNumber,
          title: PR_RATING_QA.prTitle,
          htmlUrl: PR_RATING_QA.prHtmlUrl,
          headBranch: PR_RATING_QA.prHeadBranch,
          baseBranch: PR_RATING_QA.prBaseBranch,
          state: "OPEN",
          isDraft: false,
        },
      });
      console.log(
        `✓ GitHubPullRequest created: #${pullRequest.number} (${pullRequest.id})`
      );
    }

    console.log("\n✅ PR Rating QA seed completed.\n");
    console.log("Summary:");
    console.log(`   • Team: ${team.id} (${PR_RATING_QA.teamSlug})`);
    console.log(`   • Project: ${project.id}`);
    console.log(`   • Workstream: ${workstream.id}`);
    console.log(`   • Repository: ${repository.id}`);
    console.log(
      `   • PRD artifact: ${prdDocument.id} (slug: ${PR_RATING_QA.prdSlug})`
    );
    console.log(
      `   • Plan artifact: ${planDocument.id} (slug: ${PR_RATING_QA.planSlug})`
    );
    console.log(`   • Pull request: ${pullRequest.id}`);
    console.log("\nOpen in the UI:");
    console.log(`   /implementation-plans/${PR_RATING_QA.planSlug}\n`);
  } catch (error) {
    console.error("\n❌ Seed failed:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
