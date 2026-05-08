# Backend Requirements: Teams & Projects Restructure

This document outlines the backend changes needed to support the new Teams & Projects frontend structure. These changes should be implemented AFTER the frontend is complete with mock data.

> **Note:** This document reflects the patterns established in PR #35 (Clerk integration), including:
> - Flattened API routes (no `/api` prefix)
> - Service layer pattern for database operations
> - Auth verification at route level

---

## 1. Database Schema Changes

### 1.1 New Team Model

The `Team` model does not currently exist and needs to be created.

**Location:** `packages/database/prisma/schema.prisma`

```prisma
model Team {
  id             String   @id @default(cuid())
  organizationId String   @map("organization_id")
  name           String
  slug           String
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  // Relations
  organization Organization @relation(fields: [organizationId], references: [id])
  members      TeamMember[]
  projects     ProjectTeam[]

  @@unique([organizationId, slug])
  @@index([organizationId])
  @@map("teams")
}

model TeamMember {
  id        String   @id @default(cuid())
  teamId    String   @map("team_id")
  userId    String   @map("user_id")
  role      TeamRole @default(MEMBER)
  createdAt DateTime @default(now()) @map("created_at")

  // Relations
  team Team @relation(fields: [teamId], references: [id])
  user User @relation(fields: [userId], references: [id])

  @@unique([teamId, userId])
  @@index([userId])
  @@map("team_members")
}

// Many-to-many relationship for projects belonging to multiple teams
model ProjectTeam {
  id        String   @id @default(cuid())
  projectId String   @map("project_id")
  teamId    String   @map("team_id")
  createdAt DateTime @default(now()) @map("created_at")

  // Relations
  project Project @relation(fields: [projectId], references: [id])
  team    Team    @relation(fields: [teamId], references: [id])

  @@unique([projectId, teamId])
  @@index([teamId])
  @@map("project_teams")
}

enum TeamRole {
  OWNER
  ADMIN
  MEMBER
}
```

### 1.2 Project Model Updates

**Current fields to ADD:**

```prisma
model Project {
  // ... existing fields ...

  // NEW FIELDS
  priority     ProjectPriority @default(NOT_SET)
  ownerId      String?         @map("owner_id")
  targetDate   DateTime?       @map("target_date")

  // NEW RELATIONS
  owner        User?           @relation(fields: [ownerId], references: [id])
  teams        ProjectTeam[]
}

enum ProjectPriority {
  NOT_SET
  LOW
  MEDIUM
  HIGH
}
```

### 1.3 Organization Model Updates

**Add Team relation:**

```prisma
model Organization {
  // ... existing fields ...
  teams    Team[]
}
```

### 1.4 User Model Updates

**Add TeamMember and Project owner relations:**

```prisma
model User {
  // ... existing fields ...
  teamMemberships TeamMember[]
  ownedProjects   Project[]
}
```

---

## 2. API Endpoints

> **Pattern Note:** Following PR #35, all routes are flattened (no `/api` prefix) and each domain should have a corresponding service file for database operations.

### 2.0 Service Layer Pattern (Required)

Each API domain should have a corresponding service file that handles database operations. This keeps route handlers thin and database logic reusable.

**Example:** `apps/api/app/teams/service.ts`

```typescript
import { database } from "@repo/database";

export const teamsService = {
  /**
   * Find all teams for an organization
   */
  findByOrganization(organizationId: string) {
    return database.team.findMany({
      where: { organizationId },
      include: {
        _count: { select: { members: true, projects: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  /**
   * Find a team by ID
   */
  findById(id: string) {
    return database.team.findUnique({
      where: { id },
      include: { members: { include: { user: true } } },
    });
  },

  /**
   * Create a new team
   */
  create(input: { organizationId: string; name: string; slug: string }) {
    return database.team.create({ data: input });
  },

  // ... additional methods
};
```

**Route handler usage:**

```typescript
// apps/api/app/teams/route.ts
import { teamsService } from "./service";

export async function GET(request: Request) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return new Response("Unauthorized", { status: 401 });

  const user = await usersService.findByClerkIdAndOrg(userId, orgId);
  if (!user) return new Response("User not found", { status: 404 });

  const teams = await teamsService.findByOrganization(user.organizationId);
  return Response.json({ teams });
}
```

### 2.1 Teams API

**Route Location:** `apps/api/app/teams/`
**Service Location:** `apps/api/app/teams/service.ts`

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/teams` | List teams for current user's org | Required |
| GET | `/teams/:id` | Get single team | Required |
| POST | `/teams` | Create team | Org Owner/Admin only |
| PUT | `/teams/:id` | Update team | Team Owner/Admin only |
| DELETE | `/teams/:id` | Delete team | Team Owner only |

**GET `/teams` Response:**
```typescript
{
  teams: Array<{
    id: string;
    name: string;
    slug: string;
    memberCount: number;
    projectCount: number;
    createdAt: string;
  }>;
}
```

### 2.2 Team Members API

**Route Location:** `apps/api/app/teams/[teamId]/members/`

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/teams/:id/members` | List team members | Team member |
| POST | `/teams/:id/members` | Add member to team | Team Owner/Admin |
| PUT | `/teams/:id/members/:userId` | Update member role | Team Owner/Admin |
| DELETE | `/teams/:id/members/:userId` | Remove member | Team Owner/Admin |

### 2.3 Projects API Updates

**Existing Location:** `apps/api/app/projects/`
**Service Location:** `apps/api/app/projects/service.ts` (create new)

**Updates needed:**

| Method | Endpoint | Description | Changes |
|--------|----------|-------------|---------|
| GET | `/projects` | List projects | Add `teamId` filter param |
| GET | `/projects/:id` | Get project | Include owner, teams, priority, targetDate |
| POST | `/projects` | Create project | Add priority, ownerId, targetDate, teamIds fields |
| PUT | `/projects/:id` | Update project | Add priority, ownerId, targetDate, teamIds fields |

**GET `/projects?teamId=xxx` Response:**
```typescript
{
  projects: Array<{
    id: string;
    name: string;
    description?: string;
    priority: "NOT_SET" | "LOW" | "MEDIUM" | "HIGH";
    owner?: {
      id: string;
      name: string;
      avatarUrl?: string;
    };
    targetDate?: string;
    status: number; // calculated from artifacts
    teams: Array<{ id: string; name: string }>;
    createdAt: string;
    updatedAt: string;
  }>;
}
```

### 2.4 Project Status Calculation

**New service needed:** Calculate project status percentage based on artifact statuses.

**Logic to determine:**
- Count total artifacts for the project
- Count completed artifacts
- Calculate percentage: (completed / total) * 100
- Or use workstream states to determine progress

**Proposed calculation (TBD):**
```typescript
function calculateProjectStatus(project: ProjectWithArtifacts): number {
  const artifacts = project.artifacts;
  if (artifacts.length === 0) return 0;

  const completedCount = artifacts.filter(a =>
    a.status === "APPROVED" || a.status === "COMPLETE"
  ).length;

  return Math.round((completedCount / artifacts.length) * 100);
}
```

### 2.5 Project Activity API

**Route Location:** `apps/api/app/projects/[projectId]/activity/`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/projects/:id/activity` | Get project activity feed |

**Approach:** Use existing `WorkstreamEvent` table filtered by workstreams belonging to the project, plus artifact `createdAt`/`updatedAt` with `generatedBy` field.

**Response:**
```typescript
{
  activities: Array<{
    id: string;
    type: "ARTIFACT_CREATED" | "ARTIFACT_UPDATED" | "STATE_CHANGED" | "APPROVAL_REQUESTED" | etc;
    actor: {
      id: string;
      name: string;
      avatarUrl?: string;
    };
    description: string; // Human-readable description
    metadata?: Record<string, unknown>;
    timestamp: string;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
}
```

---

## 3. Server Actions (Frontend)

### 3.1 Teams Actions

**Location:** `apps/app/app/actions/teams/index.ts`

```typescript
// Actions needed:
export async function getTeams(): Promise<Team[]>
export async function getTeamById(id: string): Promise<Team>
export async function createTeam(data: CreateTeamInput): Promise<Team>
export async function updateTeam(id: string, data: UpdateTeamInput): Promise<Team>
export async function deleteTeam(id: string): Promise<void>
export async function addTeamMember(teamId: string, userId: string, role?: TeamRole): Promise<void>
export async function removeTeamMember(teamId: string, userId: string): Promise<void>
```

### 3.2 Projects Actions Updates

**Location:** `apps/app/app/actions/projects/index.ts`

```typescript
// Updates needed:
export async function getProjectsByTeam(teamId: string): Promise<ProjectWithDetails[]>
export async function updateProjectOwner(projectId: string, ownerId: string | null): Promise<void>
export async function updateProjectTargetDate(projectId: string, targetDate: Date | null): Promise<void>
export async function updateProjectPriority(projectId: string, priority: ProjectPriority): Promise<void>
export async function getProjectActivity(projectId: string): Promise<ActivityItem[]>
```

---

## 4. Authorization Requirements

### 4.1 Team Creation Permissions

**Who can create teams:**
- Organization Owner
- Organization Admin
- Users WITHOUT an organization (individual users)

**Implementation:**
- Check user's organization membership
- If user belongs to org: check if user role is OWNER or ADMIN
- If user has no org: allow team creation (team becomes standalone)

### 4.2 Team Management Permissions

| Action | Allowed Roles |
|--------|---------------|
| View team | Team member, Org owner/admin |
| Edit team name/settings | Team owner, Team admin |
| Add member | Team owner, Team admin, Org owner/admin |
| Remove member | Team owner, Team admin, Org owner/admin |
| Delete team | Team owner, Org owner |

### 4.3 Project Permissions

| Action | Allowed Roles |
|--------|---------------|
| View project | Team member of any associated team |
| Edit project | Project owner, Team owner/admin |
| Assign owner | Team owner/admin |
| Set target date | Project owner, Team owner/admin |

---

## 5. Migration Strategy

### 5.1 Database Migrations

1. Add `Team`, `TeamMember`, `ProjectTeam` tables
2. Add new columns to `Project` table (priority, ownerId, targetDate)
3. Create default team for existing organizations
4. Migrate existing projects to default team

### 5.2 Migration Script Pseudocode

```typescript
// For each organization:
//   1. Create default team named "General" or org name
//   2. Add all org users as team members
//   3. Associate all existing projects with default team
```

---

## 6. Shared Types

**Location:** `packages/api/src/types/`

### 6.1 New Type Files

**File:** `packages/api/src/types/teams.ts`

```typescript
export interface Team {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: string;
  userId: string;
  teamId: string;
  role: TeamRole;
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl?: string;
  };
}

export type TeamRole = "OWNER" | "ADMIN" | "MEMBER";

export interface CreateTeamRequest {
  name: string;
  slug?: string; // Auto-generated if not provided
}

export interface UpdateTeamRequest {
  name?: string;
  slug?: string;
}
```

### 6.2 Project Type Updates

**File:** `packages/api/src/types/projects.ts`

```typescript
// Add to existing types:

export type ProjectPriority = "NOT_SET" | "LOW" | "MEDIUM" | "HIGH";

export interface ProjectOwner {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface ProjectWithDetails extends Project {
  priority: ProjectPriority;
  owner?: ProjectOwner;
  targetDate?: string;
  status: number; // 0-100 percentage
  teams: Array<{ id: string; name: string }>;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  priority?: ProjectPriority;
  ownerId?: string | null;
  targetDate?: string | null;
  teamIds?: string[];
}
```

---

## 7. Open Questions

### 7.1 Activity Feed Implementation

**Question:** How should we construct the activity feed for projects?

**Options:**
1. Use existing `WorkstreamEvent` table - events are tied to workstreams, not projects directly
2. Create a new `ProjectActivity` table for project-level events
3. Combine: Query WorkstreamEvents + Artifact changes + Approval changes

**Recommendation:** Option 3 - Query multiple sources and merge into unified feed. This avoids schema changes while leveraging existing audit data.

### 7.2 Project Status Calculation

**Question:** How should project status percentage be calculated?

**Options:**
1. Based on artifact completion (APPROVED status)
2. Based on workstream states (weighted by state in lifecycle)
3. Manual percentage set by user
4. Combination with configurable weights

**Recommendation:** Start with Option 1 (artifact completion) as MVP, add configuration later.

### 7.4 Artifact Status Mapping

**Frontend uses new display statuses that need backend mapping:**

| Frontend Display | Backend Status | Notes |
|-----------------|----------------|-------|
| Won't Do | NEW (needs enum) | Artifact explicitly skipped |
| Complete | APPROVED | Artifact finished |
| Not Started | DRAFT | Artifact not begun |
| Not Published | REVIEW | Artifact in progress but not live |

**Backend changes needed:**
- Either add new `ArtifactDisplayStatus` enum for frontend
- Or map existing `ArtifactStatus` values to display strings in API response
- Recommendation: Add mapping logic in API, keep existing enum for now

### 7.3 Individual Users Without Organizations

**Question:** How do we handle users who don't belong to an organization?

**Options:**
1. Auto-create a personal organization for them
2. Allow teams without organizations
3. Require organization membership for team features

**Recommendation:** Option 1 - Auto-create personal organization on sign-up. Simpler to maintain consistent data model.

---

## 8. Implementation Checklist

### Database
- [ ] Create Team model
- [ ] Create TeamMember model
- [ ] Create ProjectTeam model
- [ ] Add priority, ownerId, targetDate to Project
- [ ] Create TeamRole enum
- [ ] Create ProjectPriority enum
- [ ] Run migrations

### API Endpoints
- [ ] Create `apps/api/app/teams/service.ts` (following usersService pattern)
- [ ] GET /teams
- [ ] GET /teams/:id
- [ ] POST /teams
- [ ] PUT /teams/:id
- [ ] DELETE /teams/:id
- [ ] GET /teams/:id/members
- [ ] POST /teams/:id/members
- [ ] DELETE /teams/:id/members/:userId
- [ ] Create `apps/api/app/projects/service.ts` (following usersService pattern)
- [ ] Update GET /projects to support teamId filter
- [ ] Update GET /projects/:id to include new fields
- [ ] Update POST /projects to accept new fields
- [ ] Update PUT /projects/:id to accept new fields
- [ ] GET /projects/:id/activity

### Server Actions
- [ ] Create teams actions file
- [ ] Update projects actions with new methods

### Authorization
- [ ] Implement team creation permission check
- [ ] Implement team management permission checks
- [ ] Implement project permission checks

### Data Migration
- [ ] Write migration script for existing data
- [ ] Test migration on staging
- [ ] Execute migration on production
