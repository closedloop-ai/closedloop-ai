#!/usr/bin/env tsx
/**
 * Seed script for MCP server testing (LOCAL DEVELOPMENT ONLY).
 * Creates:
 * - 2 API keys: full-access + read-only (for scope-filtering tests)
 * - 2 Projects with different priorities
 * - 2 Workstreams across projects
 * - 5 Artifacts (PRD, Plan, Template) with versions
 * - 3 Features across projects/workstreams
 * - 2 Loops (one completed, one running)
 * - Entity links between artifacts
 * - External links on workstreams
 *
 * Run: cd packages/database && tsx scripts/seed-mcp.ts
 *
 * After running, use these API keys with the MCP server:
 *   Full access:  sk_live_mcp_test_seed_key_0123456789abcdef
 *   Read-only:    sk_live_mcp_test_readonly_key_abcdef0123
 */

import { createHash } from "node:crypto";
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../generated/client";

// Fixed plaintext keys for local dev testing
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
  console.log("Starting MCP seed...\n");

  const prisma = getClient();

  try {
    // 1. Find existing user (must sign in via app first)
    const existingUser = await prisma.user.findFirst({
      include: { organization: true },
    });

    if (!existingUser) {
      console.log("No user found in database.\n");
      console.log("To seed the database, you must first sign in via the app:");
      console.log("  1. Start the dev server: pnpm dev");
      console.log("  2. Open http://localhost:3000 and sign in with Clerk");
      console.log(
        "  3. Then run: cd packages/database && tsx scripts/seed-mcp.ts\n"
      );
      process.exit(1);
    }

    const organizationId = existingUser.organizationId;
    const userId = existingUser.id;
    console.log(`Using user: ${existingUser.email}`);
    console.log(
      `Organization: ${existingUser.organization.name} (${organizationId})\n`
    );

    // 2. Create API key
    console.log("--- API Key ---");
    const existingKey = await prisma.apiKey.findFirst({
      where: { keyHash: MCP_TEST_KEY_HASH },
    });

    if (existingKey) {
      // Ensure existing seeded key remains usable and fully scoped.
      await prisma.apiKey.update({
        where: { id: existingKey.id },
        data: {
          organizationId,
          userId,
          revokedAt: null,
          expiresAt: null,
          scopes: [...MCP_TEST_KEY_SCOPES],
        },
      });
      console.log(
        `API key exists (reset revoked/expired/scopes): ${existingKey.keyPrefix}...`
      );
    } else {
      await prisma.apiKey.create({
        data: {
          organizationId,
          userId,
          name: "MCP Test Key",
          scopes: [...MCP_TEST_KEY_SCOPES],
          keyHash: MCP_TEST_KEY_HASH,
          keyPrefix: "sk_live_",
          expiresAt: null,
        },
      });
      console.log("API key created: sk_live_...");
    }

    // 2b. Create read-only API key (for scope-filtering tests)
    console.log("\n--- Read-Only API Key ---");
    const existingReadonlyKey = await prisma.apiKey.findFirst({
      where: { keyHash: MCP_READONLY_KEY_HASH },
    });

    if (existingReadonlyKey) {
      await prisma.apiKey.update({
        where: { id: existingReadonlyKey.id },
        data: {
          organizationId,
          userId,
          revokedAt: null,
          expiresAt: null,
          scopes: [...MCP_READONLY_KEY_SCOPES],
        },
      });
      console.log(
        `Read-only API key exists (reset): ${existingReadonlyKey.keyPrefix}...`
      );
    } else {
      await prisma.apiKey.create({
        data: {
          organizationId,
          userId,
          name: "MCP Test Key (Read-Only)",
          scopes: [...MCP_READONLY_KEY_SCOPES],
          keyHash: MCP_READONLY_KEY_HASH,
          keyPrefix: "sk_live_",
          expiresAt: null,
        },
      });
      console.log("Read-only API key created: sk_live_...");
    }

    // 3. Create projects
    console.log("\n--- Projects ---");

    let project1 = await prisma.project.findFirst({
      where: { organizationId, name: "MCP Test: Payment System" },
    });
    project1 ??= await prisma.project.create({
      data: {
        organizationId,
        name: "MCP Test: Payment System",
        description:
          "Stripe-based payment processing with subscriptions and invoicing",
        priority: "HIGH",
        assigneeId: userId,
        createdById: userId,
        targetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    console.log(`Project: ${project1.name} (${project1.id})`);

    let project2 = await prisma.project.findFirst({
      where: { organizationId, name: "MCP Test: Notification Service" },
    });
    project2 ??= await prisma.project.create({
      data: {
        organizationId,
        name: "MCP Test: Notification Service",
        description:
          "Multi-channel notification system (email, push, in-app, SMS)",
        priority: "MEDIUM",
        assigneeId: userId,
        createdById: userId,
        targetDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      },
    });
    console.log(`Project: ${project2.name} (${project2.id})`);

    // 4. Create workstreams
    console.log("\n--- Workstreams ---");

    let ws1 = await prisma.workstream.findFirst({
      where: { projectId: project1.id, title: "Stripe Checkout Integration" },
    });
    ws1 ??= await prisma.workstream.create({
      data: {
        organizationId,
        projectId: project1.id,
        title: "Stripe Checkout Integration",
        description:
          "Implement Stripe Checkout for one-time and subscription payments",
        type: "FEATURE_DELIVERY",
        state: "IMPLEMENTATION_IN_PROGRESS",
        createdById: userId,
        hasUIChanges: true,
      },
    });
    console.log(`Workstream: ${ws1.title} (${ws1.id})`);

    let ws2 = await prisma.workstream.findFirst({
      where: { projectId: project2.id, title: "Email Notification Pipeline" },
    });
    ws2 ??= await prisma.workstream.create({
      data: {
        organizationId,
        projectId: project2.id,
        title: "Email Notification Pipeline",
        description:
          "Build the email delivery pipeline with templates and scheduling",
        type: "FEATURE_DELIVERY",
        state: "REQUIREMENTS_PENDING_APPROVAL",
        createdById: userId,
        hasUIChanges: false,
      },
    });
    console.log(`Workstream: ${ws2.title} (${ws2.id})`);

    // 5. Create artifacts with versions
    console.log("\n--- Artifacts ---");

    async function upsertArtifactWithVersions(data: {
      slug: string;
      title: string;
      type: "PRD" | "IMPLEMENTATION_PLAN" | "TEMPLATE";
      projectId: string;
      workstreamId?: string;
      status: "DRAFT" | "IN_REVIEW" | "APPROVED" | "OBSOLETE";
      contents: string[]; // one per version
    }) {
      let doc = await prisma.document.findFirst({
        where: { organizationId, slug: data.slug },
      });

      if (doc) {
        console.log(`  Document exists: ${data.slug} (${doc.id})`);
        return doc;
      }

      doc = await prisma.document.create({
        data: {
          organizationId,
          projectId: data.projectId,
          workstreamId: data.workstreamId,
          type: data.type,
          title: data.title,
          slug: data.slug,
          status: data.status,
          assigneeId: userId,
          createdById: userId,
          latestVersion: data.contents.length,
        },
      });

      for (let i = 0; i < data.contents.length; i++) {
        await prisma.documentVersion.create({
          data: {
            documentId: doc.id,
            version: i + 1,
            content: data.contents[i],
            createdById: userId,
          },
        });
      }

      console.log(
        `  Document: ${data.slug} (${doc.id}) - ${data.contents.length} version(s)`
      );
      return doc;
    }

    const prd1 = await upsertArtifactWithVersions({
      slug: "mcp-test-payment-prd",
      title: "Payment System PRD",
      type: "PRD",
      projectId: project1.id,
      workstreamId: ws1.id,
      status: "APPROVED",
      contents: [
        "# Payment System PRD v1\n\n## Goals\n- Accept credit card payments\n- Support subscriptions\n\n## User Stories\n- US-1: Customer can pay with credit card\n- US-2: Customer can subscribe to a plan",
        "# Payment System PRD v2\n\n## Goals\n- Accept credit card payments via Stripe\n- Support subscriptions with trial periods\n- Handle refunds and disputes\n\n## User Stories\n- US-1: Customer can pay with credit card\n- US-2: Customer can subscribe to a plan\n- US-3: Admin can issue refunds\n- US-4: System handles webhook events",
      ],
    });

    const plan1 = await upsertArtifactWithVersions({
      slug: "mcp-test-payment-plan",
      title: "Payment System Implementation Plan",
      type: "IMPLEMENTATION_PLAN",
      projectId: project1.id,
      workstreamId: ws1.id,
      status: "IN_REVIEW",
      contents: [
        "# Payment System Implementation Plan\n\n## Phase 1: Stripe Setup\n- Configure Stripe SDK\n- Create customer portal\n- Set up webhook endpoints\n\n## Phase 2: Checkout Flow\n- Build checkout page\n- Implement payment intent creation\n- Add success/failure handling\n\n## Phase 3: Subscriptions\n- Implement plan selection\n- Handle recurring billing\n- Add upgrade/downgrade logic",
      ],
    });

    const prd2 = await upsertArtifactWithVersions({
      slug: "mcp-test-notification-prd",
      title: "Notification Service PRD",
      type: "PRD",
      projectId: project2.id,
      workstreamId: ws2.id,
      status: "DRAFT",
      contents: [
        "# Notification Service PRD\n\n## Goals\n- Send transactional emails via SES\n- Support push notifications (iOS/Android)\n- In-app notification center\n\n## User Stories\n- US-1: User receives email on signup\n- US-2: User receives push notification for new messages\n- US-3: User can view notification history in-app",
      ],
    });

    const template1 = await upsertArtifactWithVersions({
      slug: "mcp-test-prd-template",
      title: "Standard PRD Template",
      type: "TEMPLATE",
      projectId: project1.id,
      status: "APPROVED",
      contents: [
        "# [Feature Name] - PRD\n\n## Overview\n[Brief description]\n\n## Goals\n- Goal 1\n- Goal 2\n\n## User Stories\n### US-1: [Story Title]\nAs a [role], I want [capability] so that [benefit].\n\n**Acceptance Criteria:**\n- [ ] Criterion 1\n- [ ] Criterion 2\n\n## Non-Functional Requirements\n- Performance: ...\n- Security: ...",
      ],
    });

    const plan2 = await upsertArtifactWithVersions({
      slug: "mcp-test-notification-plan",
      title: "Notification Service Implementation Plan",
      type: "IMPLEMENTATION_PLAN",
      projectId: project2.id,
      workstreamId: ws2.id,
      status: "DRAFT",
      contents: [
        "# Notification Service Plan\n\n## Phase 1: Email Pipeline\n- SES configuration\n- Template engine\n- Queue-based sending\n\n## Phase 2: Push Notifications\n- Firebase Cloud Messaging setup\n- Device token management\n- Notification payload builder",
      ],
    });

    // 6. Create features
    console.log("\n--- Features ---");

    async function upsertFeature(data: {
      slug: string;
      title: string;
      description: string;
      projectId: string;
      workstreamId?: string;
      status:
        | "DRAFT"
        | "IN_PROGRESS"
        | "IN_REVIEW"
        | "APPROVED"
        | "EXECUTED"
        | "DONE"
        | "OBSOLETE";
      priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    }) {
      let feature = await prisma.document.findFirst({
        where: { organizationId, slug: data.slug, type: "FEATURE" },
      });

      if (feature) {
        console.log(`  Feature exists: ${data.slug} (${feature.id})`);
        return feature;
      }

      feature = await prisma.document.create({
        data: {
          organizationId,
          projectId: data.projectId,
          workstreamId: data.workstreamId,
          type: "FEATURE",
          title: data.title,
          slug: data.slug,
          status: data.status,
          priority: data.priority,
          createdById: userId,
          assigneeId: userId,
          latestVersion: 1,
          versions: {
            create: {
              version: 1,
              content: data.description,
              createdById: userId,
            },
          },
        },
      });
      console.log(`  Feature: ${data.slug} (${feature.id})`);
      return feature;
    }

    const feature1 = await upsertFeature({
      slug: "mcp-test-issue-stripe-webhook",
      title: "Implement Stripe webhook handler",
      description:
        "Set up POST /webhooks/stripe to handle payment_intent.succeeded, customer.subscription.created, and invoice.payment_failed events.",
      projectId: project1.id,
      workstreamId: ws1.id,
      status: "IN_PROGRESS",
      priority: "HIGH",
    });

    const feature2 = await upsertFeature({
      slug: "mcp-test-issue-email-template",
      title: "Design email notification templates",
      description:
        "Create responsive HTML email templates for welcome, password reset, and payment confirmation emails using MJML.",
      projectId: project2.id,
      workstreamId: ws2.id,
      status: "DRAFT",
      priority: "MEDIUM",
    });

    const feature3 = await upsertFeature({
      slug: "mcp-test-issue-checkout-ui",
      title: "Build checkout page UI",
      description:
        "Create the checkout page with Stripe Elements for card input, order summary, and payment confirmation.",
      projectId: project1.id,
      workstreamId: ws1.id,
      status: "IN_REVIEW",
      priority: "URGENT",
    });

    // 7. Create loops
    console.log("\n--- Loops ---");

    let loop1 = await prisma.loop.findFirst({
      where: { organizationId, documentId: plan1.id, command: "PLAN" },
    });
    if (loop1) {
      console.log(`  Loop exists: PLAN for ${plan1.slug} (${loop1.id})`);
    } else {
      loop1 = await prisma.loop.create({
        data: {
          organizationId,
          userId,
          status: "COMPLETED",
          command: "PLAN",
          documentId: plan1.id,
          workstreamId: ws1.id,
          prompt: "Generate an implementation plan for the payment system",
          containerId: "ecs-task-arn-mock-001",
          s3StateKey: "loops/mock-001/state",
          tokensInput: 15_000,
          tokensOutput: 8500,
          estimatedCost: 0.125,
          startedAt: new Date(Date.now() - 3600 * 1000),
          completedAt: new Date(Date.now() - 3000 * 1000),
          metadata: { runtime: "v2", model: "claude-sonnet-4-20250514" },
        },
      });
      console.log(`  Loop: PLAN completed (${loop1.id})`);
    }

    let loop2 = await prisma.loop.findFirst({
      where: { organizationId, documentId: prd2.id, command: "EXPLORE" },
    });
    if (loop2) {
      console.log(`  Loop exists: EXPLORE for ${prd2.slug} (${loop2.id})`);
    } else {
      loop2 = await prisma.loop.create({
        data: {
          organizationId,
          userId,
          status: "RUNNING",
          command: "EXPLORE",
          documentId: prd2.id,
          workstreamId: ws2.id,
          prompt: "Explore notification service patterns and best practices",
          containerId: "ecs-task-arn-mock-002",
          s3StateKey: "loops/mock-002/state",
          tokensInput: 5000,
          tokensOutput: 2000,
          startedAt: new Date(Date.now() - 600 * 1000),
          metadata: { runtime: "v2", model: "claude-sonnet-4-20250514" },
        },
      });
      console.log(`  Loop: EXPLORE running (${loop2.id})`);
    }

    // 8. Create entity links
    console.log("\n--- Entity Links ---");

    async function upsertEntityLink(data: {
      sourceId: string;
      targetId: string;
      sourceType: "DOCUMENT" | "EXTERNAL_LINK";
      targetType: "DOCUMENT" | "EXTERNAL_LINK";
      linkType: "PRODUCES" | "BLOCKS" | "RELATES_TO";
    }) {
      const existing = await prisma.entityLink.findFirst({
        where: {
          organizationId,
          sourceId: data.sourceId,
          targetId: data.targetId,
          linkType: data.linkType,
        },
      });

      if (existing) {
        console.log(
          `  Link exists: ${data.sourceType} -> ${data.targetType} (${data.linkType})`
        );
        return existing;
      }

      const link = await prisma.entityLink.create({
        data: {
          organizationId,
          sourceId: data.sourceId,
          sourceType: data.sourceType,
          targetId: data.targetId,
          targetType: data.targetType,
          linkType: data.linkType,
        },
      });
      console.log(
        `  Link: ${data.sourceType} -> ${data.targetType} (${data.linkType})`
      );
      return link;
    }

    // PRD produces Plan
    await upsertEntityLink({
      sourceId: prd1.id,
      targetId: plan1.id,
      sourceType: "DOCUMENT",
      targetType: "DOCUMENT",
      linkType: "PRODUCES",
    });

    // PRD produces Plan (project 2)
    await upsertEntityLink({
      sourceId: prd2.id,
      targetId: plan2.id,
      sourceType: "DOCUMENT",
      targetType: "DOCUMENT",
      linkType: "PRODUCES",
    });

    // Feature relates to feature (features are documents with type=FEATURE)
    await upsertEntityLink({
      sourceId: feature1.id,
      targetId: feature3.id,
      sourceType: "DOCUMENT",
      targetType: "DOCUMENT",
      linkType: "RELATES_TO",
    });

    // 9. Create external links
    console.log("\n--- External Links ---");

    let extLink1 = await prisma.externalLink.findFirst({
      where: {
        workstreamId: ws1.id,
        externalUrl: "https://github.com/example/payments/pull/42",
      },
    });
    if (extLink1) {
      console.log(`  External link exists: PR #42 (${extLink1.id})`);
    } else {
      extLink1 = await prisma.externalLink.create({
        data: {
          organizationId,
          workstreamId: ws1.id,
          projectId: project1.id,
          type: "PULL_REQUEST",
          title: "feat: Stripe checkout integration",
          externalUrl: "https://github.com/example/payments/pull/42",
        },
      });
      console.log(`  External link: PR #42 (${extLink1.id})`);
    }

    let extLink2 = await prisma.externalLink.findFirst({
      where: {
        workstreamId: ws1.id,
        externalUrl: "https://figma.com/file/abc123/checkout-design",
      },
    });
    if (extLink2) {
      console.log(`  External link exists: Figma design (${extLink2.id})`);
    } else {
      extLink2 = await prisma.externalLink.create({
        data: {
          organizationId,
          workstreamId: ws1.id,
          projectId: project1.id,
          type: "FIGMA_DESIGN",
          title: "Checkout Page Design",
          externalUrl: "https://figma.com/file/abc123/checkout-design",
        },
      });
      console.log(`  External link: Figma design (${extLink2.id})`);
    }

    // Done
    console.log("\n===================================");
    console.log("MCP seed completed successfully!");
    console.log("===================================\n");
    console.log("API Keys (use with MCP server):");
    console.log(`  Full access:  ${MCP_TEST_KEY}`);
    console.log(`  Read-only:    ${MCP_READONLY_KEY}\n`);
    console.log("Test with curl:");
    console.log("  curl -X POST http://localhost:3010/mcp \\");
    console.log(`    -H "Authorization: Bearer ${MCP_TEST_KEY}" \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'\n`);
    console.log("Summary:");
    console.log("  API Keys:       full-access + read-only");
    console.log(`  Projects:       ${project1.id}, ${project2.id}`);
    console.log(`  Workstreams:    ${ws1.id}, ${ws2.id}`);
    console.log(
      `  Artifacts:      ${prd1.id}, ${plan1.id}, ${prd2.id}, ${plan2.id}, ${template1.id}`
    );
    console.log(
      `  Features:       ${feature1.id}, ${feature2.id}, ${feature3.id}`
    );
    console.log(`  Loops:          ${loop1.id}, ${loop2.id}`);
    console.log("  Entity Links:   3");
    console.log(`  External Links: ${extLink1.id}, ${extLink2.id}\n`);
  } catch (error) {
    console.error("\nSeed failed:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
