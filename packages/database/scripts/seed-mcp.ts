#!/usr/bin/env tsx
/**
 * Seed script for MCP server testing (LOCAL DEVELOPMENT ONLY).
 *
 * Scoped to the fixtures the MCP test tooling exercises against the new
 * (post-PLN-321) Artifact schema:
 *   - Organization + user + API keys (full-access and read-only)
 *   - Project
 *   - PRD DOCUMENT artifact (with DocumentDetail + DocumentVersion)
 *   - TEMPLATE DOCUMENT artifact scoped to the Templates sentinel project
 *
 * Run: pnpm --filter=@repo/database exec tsx scripts/seed-mcp.ts
 *
 * API keys (stable; used by MCP test tooling):
 *   Full access:  sk_live_mcp_test_seed_key_0123456789abcdef
 *   Read-only:    sk_live_mcp_test_readonly_key_abcdef0123
 */

import { createHash } from "node:crypto";
import "dotenv/config";
import { ArtifactSubtype, ArtifactType, withDb } from "../index";

const MCP_TEST_KEY = "sk_live_mcp_test_seed_key_0123456789abcdef";
const MCP_TEST_KEY_SCOPES = ["read", "write", "delete", "admin"] as const;
const MCP_TEST_KEY_HASH = createHash("sha256")
  .update(MCP_TEST_KEY)
  .digest("hex");

const MCP_READONLY_KEY = "sk_live_mcp_test_readonly_key_abcdef0123";
const MCP_READONLY_KEY_SCOPES = ["read"] as const;
const MCP_READONLY_KEY_HASH = createHash("sha256")
  .update(MCP_READONLY_KEY)
  .digest("hex");

const ORG_CLERK_ID = "org_seed_mcp";
const ORG_SLUG = "seed-mcp";
const ORG_NAME = "MCP Seed Org";
const USER_CLERK_ID = "user_seed_mcp";
const USER_EMAIL = "mcp-seed@local.dev";
const PROJECT_SLUG = "seed-mcp-project";
const PROJECT_NAME = "MCP Seed Project";
const TEMPLATES_SENTINEL_NAME = "Templates";
const PRD_SLUG = "seed-mcp-prd";
const TEMPLATE_SLUG = "seed-mcp-prd-template";

const PRD_BODY = `# MCP Seed PRD

Minimal PRD fixture exercised by MCP test tooling (get-document, list-documents).
`;

const TEMPLATE_BODY = `# Standard PRD Template

## Overview
[Brief description]

## Goals
- Goal 1
- Goal 2

## User Stories
- US-1: As a [role], I want [capability] so that [benefit].
`;

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  log("Seeding MCP test fixtures...");

  const summary = await withDb.tx(async (tx) => {
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
        firstName: "MCP",
        lastName: "Seed",
      },
    });

    // Full-access API key
    const existingFullKey = await tx.apiKey.findUnique({
      where: { keyHash: MCP_TEST_KEY_HASH },
    });
    if (existingFullKey) {
      await tx.apiKey.update({
        where: { id: existingFullKey.id },
        data: {
          organizationId: organization.id,
          userId: user.id,
          revokedAt: null,
          expiresAt: null,
          scopes: [...MCP_TEST_KEY_SCOPES],
        },
      });
    } else {
      await tx.apiKey.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          name: "MCP Test Key",
          scopes: [...MCP_TEST_KEY_SCOPES],
          keyHash: MCP_TEST_KEY_HASH,
          keyPrefix: "sk_live_",
        },
      });
    }

    // Read-only API key
    const existingReadonlyKey = await tx.apiKey.findUnique({
      where: { keyHash: MCP_READONLY_KEY_HASH },
    });
    if (existingReadonlyKey) {
      await tx.apiKey.update({
        where: { id: existingReadonlyKey.id },
        data: {
          organizationId: organization.id,
          userId: user.id,
          revokedAt: null,
          expiresAt: null,
          scopes: [...MCP_READONLY_KEY_SCOPES],
        },
      });
    } else {
      await tx.apiKey.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          name: "MCP Test Key (Read-Only)",
          scopes: [...MCP_READONLY_KEY_SCOPES],
          keyHash: MCP_READONLY_KEY_HASH,
          keyPrefix: "sk_live_",
        },
      });
    }

    // Regular project
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
        description: "Fixture project for MCP server test tooling",
        createdById: user.id,
        assigneeId: user.id,
      },
    });

    // Templates sentinel project (host for the TEMPLATE artifact below)
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

    // PRD artifact + version
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
          name: "MCP Seed PRD",
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
      where: { artifactId: prd.id },
      update: {},
      create: { artifactId: prd.id, latestVersion: 1 },
    });

    // Template artifact (subtype TEMPLATE; lives on the sentinel project)
    const existingTemplate = await tx.artifact.findFirst({
      where: {
        organizationId: organization.id,
        slug: TEMPLATE_SLUG,
        type: ArtifactType.DOCUMENT,
      },
    });
    const template =
      existingTemplate ??
      (await tx.artifact.create({
        data: {
          organizationId: organization.id,
          projectId: sentinel.id,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.TEMPLATE,
          name: "Standard PRD Template",
          slug: TEMPLATE_SLUG,
          status: "APPROVED",
          createdById: user.id,
          document: {
            create: {
              latestVersion: 1,
              templateForType: ArtifactSubtype.PRD,
              versions: {
                create: {
                  version: 1,
                  content: TEMPLATE_BODY,
                  createdById: user.id,
                },
              },
            },
          },
        },
      }));
    await tx.documentDetail.upsert({
      where: { artifactId: template.id },
      update: { templateForType: ArtifactSubtype.PRD },
      create: {
        artifactId: template.id,
        latestVersion: 1,
        templateForType: ArtifactSubtype.PRD,
      },
    });

    return {
      organizationId: organization.id,
      userId: user.id,
      projectId: project.id,
      sentinelProjectId: sentinel.id,
      prdArtifactId: prd.id,
      templateArtifactId: template.id,
    };
  });

  log(`  organization: ${summary.organizationId}`);
  log(`  user: ${summary.userId}`);
  log(`  project: ${summary.projectId}`);
  log(`  templates sentinel project: ${summary.sentinelProjectId}`);
  log(`  PRD artifact: ${summary.prdArtifactId}`);
  log(`  Template artifact: ${summary.templateArtifactId}`);
  log("");
  log(`  API key (full):     ${MCP_TEST_KEY}`);
  log(`  API key (readonly): ${MCP_READONLY_KEY}`);
  log("MCP seed completed.");
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
