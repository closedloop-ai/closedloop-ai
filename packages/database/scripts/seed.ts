#!/usr/bin/env tsx
/**
 * Seed script for LOCAL DEVELOPMENT ONLY.
 *
 * Seeds an Artifact-shaped fixture set against the new (post-PLN-321) schema:
 *   - Test organization + user + project
 *   - Templates sentinel project (isTemplatesSentinel: true)
 *   - PRD-typed DOCUMENT artifact (+ DocumentDetail + DocumentVersion)
 *   - Implementation-Plan DOCUMENT artifact, linked to the PRD via ArtifactLink.PRODUCES
 *   - Feature DOCUMENT artifact, linked to the PRD via ArtifactLink.PRODUCES
 *
 * Run: pnpm --filter=@repo/database exec tsx scripts/seed.ts
 */

import "dotenv/config";
import { ArtifactSubtype, ArtifactType, LinkType, withDb } from "../index";

const SEED_ORG_SLUG = "seed-org";
const SEED_ORG_NAME = "Seed Org";
const SEED_ORG_CLERK_ID = "org_seed_local_dev";
const SEED_USER_EMAIL = "seed-user@local.dev";
const SEED_USER_CLERK_ID = "user_seed_local_dev";
const SEED_PROJECT_SLUG = "seed-project";
const SEED_PROJECT_NAME = "Seed Project";
const TEMPLATES_SENTINEL_NAME = "Templates";
const PRD_SLUG = "seed-prd";
const PLAN_SLUG = "seed-implementation-plan";
const FEATURE_SLUG = "seed-feature";

const PRD_BODY = `# Seed PRD

## Overview
Minimal PRD fixture for local development. Demonstrates an Artifact-shaped
DOCUMENT with subtype=PRD and a first DocumentVersion.

## Goals
- Exercise the Artifact + DocumentDetail + DocumentVersion write path.
- Provide a stable link target for the seeded Implementation Plan and Feature.

## User Stories
1. As a developer running the app locally, I want seeded PRD/plan/feature
   artifacts so that I can hit document pages without manual authoring.

## Out of Scope
- Production-realistic content. This body exists only to make the seed
  artifact navigable in the UI.
`;

const PLAN_BODY = `# Seed Implementation Plan

## Phase 1
- Boot the app locally.
- Confirm the seeded PRD and Plan load.

## Phase 2
- Follow the PRODUCES link back to the PRD.
- Confirm the Feature artifact is linked off the same PRD.
`;

const FEATURE_BODY = `# Seed Feature

Minimal feature artifact linked off the seed PRD.
`;

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  log("Seeding local dev fixtures...");

  await withDb.tx(async (tx) => {
    // Organization -----------------------------------------------------------
    const organization = await tx.organization.upsert({
      where: { clerkId: SEED_ORG_CLERK_ID },
      update: {},
      create: {
        clerkId: SEED_ORG_CLERK_ID,
        name: SEED_ORG_NAME,
        slug: SEED_ORG_SLUG,
      },
    });
    log(`  organization: ${organization.name} (${organization.id})`);

    // User -------------------------------------------------------------------
    const user = await tx.user.upsert({
      where: {
        organizationId_email: {
          organizationId: organization.id,
          email: SEED_USER_EMAIL,
        },
      },
      update: {},
      create: {
        clerkId: SEED_USER_CLERK_ID,
        organizationId: organization.id,
        email: SEED_USER_EMAIL,
        firstName: "Seed",
        lastName: "User",
      },
    });
    log(`  user: ${user.email} (${user.id})`);

    // Primary project --------------------------------------------------------
    const project = await tx.project.upsert({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug: SEED_PROJECT_SLUG,
        },
      },
      update: {},
      create: {
        organizationId: organization.id,
        name: SEED_PROJECT_NAME,
        slug: SEED_PROJECT_SLUG,
        description: "Local dev seed project",
        createdById: user.id,
        assigneeId: user.id,
      },
    });
    log(`  project: ${project.name} (${project.id})`);

    // Templates sentinel project --------------------------------------------
    const existingSentinel = await tx.project.findFirst({
      where: { organizationId: organization.id, isTemplatesSentinel: true },
    });
    const sentinel =
      existingSentinel ??
      (await tx.project.create({
        data: {
          organizationId: organization.id,
          name: TEMPLATES_SENTINEL_NAME,
          slug: `templates-${organization.id.slice(0, 8)}`,
          createdById: user.id,
          isTemplatesSentinel: true,
        },
      }));
    log(`  templates sentinel project: ${sentinel.id}`);

    // PRD artifact -----------------------------------------------------------
    const existingPrd = await tx.artifact.findFirst({
      where: {
        organizationId: organization.id,
        slug: PRD_SLUG,
        type: ArtifactType.DOCUMENT,
      },
    });
    const prd =
      existingPrd ??
      (await tx.artifact.create({
        data: {
          organizationId: organization.id,
          projectId: project.id,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.PRD,
          name: "Seed PRD",
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
    log(`  PRD artifact: ${prd.id}`);

    // If the PRD already existed, make sure it has a DocumentDetail + v1
    // version row (idempotency for older partial seeds).
    await tx.documentDetail.upsert({
      where: { artifactId: prd.id },
      update: {},
      create: { artifactId: prd.id, latestVersion: 1 },
    });
    const existingPrdVersion = await tx.documentVersion.findUnique({
      where: { documentId_version: { documentId: prd.id, version: 1 } },
    });
    if (!existingPrdVersion) {
      await tx.documentVersion.create({
        data: {
          documentId: prd.id,
          version: 1,
          content: PRD_BODY,
          createdById: user.id,
        },
      });
    }

    // Implementation Plan artifact ------------------------------------------
    const existingPlan = await tx.artifact.findFirst({
      where: {
        organizationId: organization.id,
        slug: PLAN_SLUG,
        type: ArtifactType.DOCUMENT,
      },
    });
    const plan =
      existingPlan ??
      (await tx.artifact.create({
        data: {
          organizationId: organization.id,
          projectId: project.id,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
          name: "Seed Implementation Plan",
          slug: PLAN_SLUG,
          status: "DRAFT",
          createdById: user.id,
          assigneeId: user.id,
          document: {
            create: {
              latestVersion: 1,
              versions: {
                create: {
                  version: 1,
                  content: PLAN_BODY,
                  createdById: user.id,
                },
              },
            },
          },
        },
      }));
    log(`  Implementation Plan artifact: ${plan.id}`);
    await tx.documentDetail.upsert({
      where: { artifactId: plan.id },
      update: {},
      create: { artifactId: plan.id, latestVersion: 1 },
    });

    // Feature artifact -------------------------------------------------------
    const existingFeature = await tx.artifact.findFirst({
      where: {
        organizationId: organization.id,
        slug: FEATURE_SLUG,
        type: ArtifactType.DOCUMENT,
      },
    });
    const feature =
      existingFeature ??
      (await tx.artifact.create({
        data: {
          organizationId: organization.id,
          projectId: project.id,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.FEATURE,
          name: "Seed Feature",
          slug: FEATURE_SLUG,
          status: "DRAFT",
          createdById: user.id,
          assigneeId: user.id,
          document: {
            create: {
              latestVersion: 1,
              versions: {
                create: {
                  version: 1,
                  content: FEATURE_BODY,
                  createdById: user.id,
                },
              },
            },
          },
        },
      }));
    log(`  Feature artifact: ${feature.id}`);
    await tx.documentDetail.upsert({
      where: { artifactId: feature.id },
      update: {},
      create: { artifactId: feature.id, latestVersion: 1 },
    });

    // ArtifactLinks (PRD -> Plan, PRD -> Feature) ----------------------------
    await tx.artifactLink.upsert({
      where: {
        sourceId_targetId_linkType: {
          sourceId: prd.id,
          targetId: plan.id,
          linkType: LinkType.PRODUCES,
        },
      },
      update: {},
      create: {
        organizationId: organization.id,
        sourceId: prd.id,
        targetId: plan.id,
        linkType: "PRODUCES",
      },
    });
    log("  ArtifactLink: PRD -> Plan (PRODUCES)");

    await tx.artifactLink.upsert({
      where: {
        sourceId_targetId_linkType: {
          sourceId: prd.id,
          targetId: feature.id,
          linkType: LinkType.PRODUCES,
        },
      },
      update: {},
      create: {
        organizationId: organization.id,
        sourceId: prd.id,
        targetId: feature.id,
        linkType: "PRODUCES",
      },
    });
    log("  ArtifactLink: PRD -> Feature (PRODUCES)");
  });

  log("Seed completed.");
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
