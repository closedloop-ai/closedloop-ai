#!/usr/bin/env tsx
/**
 * Seed script for LOCAL DEVELOPMENT ONLY.
 * Creates:
 * - 2 Teams
 * - 1 Project per team
 * - PRD and Implementation Plan artifacts for each project
 * - Connects everything to the existing user
 *
 * Run: pnpm seed (from packages/database)
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../generated/client";

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
  console.log("🌱 Starting seed...\n");

  const prisma = getClient();

  try {
    // 1. Find or create organization and user for local dev
    const existingUser = await prisma.user.findFirst({
      include: { organization: true },
    });

    if (!existingUser) {
      console.log("❌ No user found in database.\n");
      console.log("To seed the database, you must first sign in via the app:");
      console.log("  1. Start the dev server: pnpm dev");
      console.log("  2. Open http://localhost:3000 and sign in with Clerk");
      console.log("  3. This will sync your Clerk user to the database");
      console.log("  4. Then run: pnpm seed\n");
      process.exit(1);
    }

    console.log(`✓ Using user: ${existingUser.email}`);
    const organizationId = existingUser.organizationId;
    const userId = existingUser.id;

    // 2. Create teams
    console.log("\n📁 Creating teams...");

    const team1 = await prisma.team.upsert({
      where: {
        organizationId_slug: {
          organizationId,
          slug: "engineering",
        },
      },
      update: {},
      create: {
        organizationId,
        name: "Engineering",
        slug: "engineering",
      },
    });
    console.log(`   ✓ Team: ${team1.name}`);

    const team2 = await prisma.team.upsert({
      where: {
        organizationId_slug: {
          organizationId,
          slug: "product",
        },
      },
      update: {},
      create: {
        organizationId,
        name: "Product",
        slug: "product",
      },
    });
    console.log(`   ✓ Team: ${team2.name}`);

    // 3. Add user as OWNER to both teams
    console.log("\n👤 Adding user to teams...");

    await prisma.teamMember.upsert({
      where: {
        teamId_userId: {
          teamId: team1.id,
          userId,
        },
      },
      update: { role: "OWNER" },
      create: {
        teamId: team1.id,
        userId,
        role: "OWNER",
      },
    });
    console.log(`   ✓ Added to ${team1.name} as OWNER`);

    await prisma.teamMember.upsert({
      where: {
        teamId_userId: {
          teamId: team2.id,
          userId,
        },
      },
      update: { role: "OWNER" },
      create: {
        teamId: team2.id,
        userId,
        role: "OWNER",
      },
    });
    console.log(`   ✓ Added to ${team2.name} as OWNER`);

    // 4. Create projects
    console.log("\n📂 Creating projects...");

    // Check if projects already exist
    let project1 = await prisma.project.findFirst({
      where: {
        organizationId,
        name: "User Authentication System",
      },
    });

    project1 ??= await prisma.project.create({
      data: {
        organizationId,
        name: "User Authentication System",
        description:
          "Implement secure authentication with OAuth2, MFA, and session management",
        priority: "HIGH",
        ownerId: userId,
        targetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      },
    });
    console.log(`   ✓ Project: ${project1.name}`);

    let project2 = await prisma.project.findFirst({
      where: {
        organizationId,
        name: "Analytics Dashboard",
      },
    });

    project2 ??= await prisma.project.create({
      data: {
        organizationId,
        name: "Analytics Dashboard",
        description:
          "Build a real-time analytics dashboard with customizable widgets",
        priority: "MEDIUM",
        ownerId: userId,
        targetDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days from now
      },
    });
    console.log(`   ✓ Project: ${project2.name}`);

    // 5. Link projects to teams
    console.log("\n🔗 Linking projects to teams...");

    await prisma.projectTeam.upsert({
      where: {
        projectId_teamId: {
          projectId: project1.id,
          teamId: team1.id,
        },
      },
      update: {},
      create: {
        projectId: project1.id,
        teamId: team1.id,
      },
    });
    console.log(`   ✓ ${project1.name} → ${team1.name}`);

    await prisma.projectTeam.upsert({
      where: {
        projectId_teamId: {
          projectId: project2.id,
          teamId: team2.id,
        },
      },
      update: {},
      create: {
        projectId: project2.id,
        teamId: team2.id,
      },
    });
    console.log(`   ✓ ${project2.name} → ${team2.name}`);

    // 6. Create artifacts (PRD and Implementation Plan for each project)
    console.log("\n📄 Creating artifacts...");

    // Project 1 artifacts
    const prd1Content = `# User Authentication System - Product Requirements Document

## Overview
This document outlines the requirements for implementing a secure user authentication system.

## Goals
- Implement secure OAuth2-based authentication
- Support multi-factor authentication (MFA)
- Provide seamless session management

## User Stories

### US-1: User Sign Up
As a new user, I want to create an account using my email or social login so that I can access the platform.

**Acceptance Criteria:**
- Users can sign up with email/password
- Users can sign up with Google, GitHub, or Microsoft
- Email verification is required
- Password must meet security requirements (8+ chars, mixed case, numbers)

### US-2: User Sign In
As a registered user, I want to sign in securely so that I can access my account.

**Acceptance Criteria:**
- Support email/password login
- Support social login
- Implement rate limiting for failed attempts
- Show helpful error messages

### US-3: Multi-Factor Authentication
As a security-conscious user, I want to enable MFA so that my account is more secure.

**Acceptance Criteria:**
- Support TOTP-based MFA (Google Authenticator, etc.)
- Support SMS-based MFA as backup
- Allow users to enable/disable MFA
- Provide recovery codes

## Non-Functional Requirements
- Authentication response time < 500ms
- Support 10,000 concurrent sessions
- 99.9% uptime SLA
- GDPR and SOC2 compliant`;

    const implPlan1Content = `# User Authentication System - Implementation Plan

## Phase 1: Foundation (Week 1-2)

### Task 1.1: Database Schema
- Create users table with auth fields
- Create sessions table
- Create MFA tokens table
- Set up migrations

### Task 1.2: Auth Service Setup
- Initialize auth service module
- Configure Clerk/Auth0 integration
- Set up JWT token handling

## Phase 2: Core Authentication (Week 3-4)

### Task 2.1: Email/Password Auth
- Implement registration endpoint
- Implement login endpoint
- Add password hashing with bcrypt
- Email verification flow

### Task 2.2: Social Login
- Google OAuth integration
- GitHub OAuth integration
- Microsoft OAuth integration
- Account linking logic

## Phase 3: MFA Implementation (Week 5-6)

### Task 3.1: TOTP Setup
- TOTP secret generation
- QR code generation for authenticator apps
- Verification logic
- Recovery codes generation

### Task 3.2: Session Management
- Secure session tokens
- Session invalidation
- Concurrent session handling
- Remember me functionality

## Technical Decisions
- Use Clerk for managed auth
- JWT for session tokens
- Redis for session storage
- bcrypt for password hashing

## Testing Strategy
- Unit tests for all auth functions
- Integration tests for OAuth flows
- Load testing for 10k concurrent users
- Security penetration testing`;

    // Helper to upsert artifact (can't use prisma.upsert with nullable field in composite unique)
    async function upsertArtifact(data: {
      projectId: string;
      type: "PRD" | "IMPLEMENTATION_PLAN";
      title: string;
      content: string;
    }) {
      const existing = await prisma.artifact.findFirst({
        where: {
          projectId: data.projectId,
          type: data.type,
          documentSlug: "main",
          isLatest: true,
        },
      });

      if (existing) {
        await prisma.artifact.update({
          where: { id: existing.id },
          data: { content: data.content, updatedAt: new Date() },
        });
      } else {
        await prisma.artifact.create({
          data: {
            organizationId,
            projectId: data.projectId,
            type: data.type,
            title: data.title,
            status: "APPROVED",
            content: data.content,
            documentSlug: "main",
            version: 1,
            isLatest: true,
          },
        });
      }
    }

    await upsertArtifact({
      projectId: project1.id,
      type: "PRD",
      title: "User Authentication System PRD",
      content: prd1Content,
    });
    console.log(`   ✓ PRD for ${project1.name}`);

    await upsertArtifact({
      projectId: project1.id,
      type: "IMPLEMENTATION_PLAN",
      title: "User Authentication System Implementation Plan",
      content: implPlan1Content,
    });
    console.log(`   ✓ Implementation Plan for ${project1.name}`);

    // Project 2 artifacts
    const prd2Content = `# Analytics Dashboard - Product Requirements Document

## Overview
Build a real-time analytics dashboard that provides actionable insights through customizable widgets.

## Goals
- Display real-time metrics and KPIs
- Support customizable dashboard layouts
- Enable data export and reporting

## User Stories

### US-1: Dashboard View
As a user, I want to view my analytics dashboard so that I can monitor key metrics at a glance.

**Acceptance Criteria:**
- Display configurable widgets
- Real-time data updates (< 5 second refresh)
- Responsive design for all screen sizes
- Dark/light mode support

### US-2: Widget Customization
As a power user, I want to customize my dashboard widgets so that I see the most relevant data.

**Acceptance Criteria:**
- Drag-and-drop widget arrangement
- Resize widgets
- Configure data sources per widget
- Save dashboard layouts

### US-3: Data Export
As an analyst, I want to export dashboard data so that I can perform deeper analysis.

**Acceptance Criteria:**
- Export to CSV, Excel, PDF
- Schedule recurring exports
- Email delivery option
- Custom date range selection

## Non-Functional Requirements
- Page load time < 2 seconds
- Support 1000 concurrent dashboard views
- Data accuracy within 5 second delay
- Mobile-responsive design`;

    const implPlan2Content = `# Analytics Dashboard - Implementation Plan

## Phase 1: Infrastructure (Week 1-2)

### Task 1.1: Data Pipeline
- Set up event streaming infrastructure
- Configure data aggregation jobs
- Create materialized views for fast queries

### Task 1.2: API Layer
- Design GraphQL schema for dashboard queries
- Implement real-time subscriptions
- Add caching layer

## Phase 2: Dashboard Core (Week 3-4)

### Task 2.1: Widget System
- Create widget component architecture
- Implement base widget types:
  - Line chart
  - Bar chart
  - Pie chart
  - Number card
  - Table
- Add widget configuration UI

### Task 2.2: Layout Engine
- Implement grid-based layout system
- Drag-and-drop functionality
- Widget resizing
- Layout persistence

## Phase 3: Features (Week 5-6)

### Task 3.1: Real-time Updates
- WebSocket connection management
- Incremental data updates
- Optimistic UI updates
- Connection recovery

### Task 3.2: Export System
- CSV/Excel generation
- PDF report generation
- Scheduled export jobs
- Email delivery integration

## Technical Stack
- React with TanStack Query for data fetching
- Recharts for visualizations
- react-grid-layout for dashboard layouts
- WebSocket for real-time updates
- Node.js workers for export jobs

## Testing Strategy
- Component tests for all widgets
- E2E tests for user flows
- Performance testing for 1000 concurrent users
- Visual regression testing`;

    await upsertArtifact({
      projectId: project2.id,
      type: "PRD",
      title: "Analytics Dashboard PRD",
      content: prd2Content,
    });
    console.log(`   ✓ PRD for ${project2.name}`);

    await upsertArtifact({
      projectId: project2.id,
      type: "IMPLEMENTATION_PLAN",
      title: "Analytics Dashboard Implementation Plan",
      content: implPlan2Content,
    });
    console.log(`   ✓ Implementation Plan for ${project2.name}`);

    console.log("\n✅ Seed completed successfully!\n");
    console.log("Summary:");
    console.log(`   • 2 Teams: ${team1.name}, ${team2.name}`);
    console.log(`   • 2 Projects: ${project1.name}, ${project2.name}`);
    console.log("   • 4 Artifacts: 2 PRDs, 2 Implementation Plans");
    console.log(`   • All connected to user: ${existingUser.email}\n`);
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
