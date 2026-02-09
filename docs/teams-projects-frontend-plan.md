# Frontend Implementation Plan: Teams & Projects Restructure

This document outlines the frontend implementation for the new Teams & Projects structure based on the designs provided.

## Data Structure Overview

```
Organization
├── Teams (NEW)
│   └── Projects (existing, but restructured)
│       └── Cycles/Workstreams
│           └── Artifacts (PRD, Implementation Plan, etc.)
```

---

## Phase 1: Sidebar Restructure

### 1.1 Add "Your Teams" Section

**File:** `apps/app/app/(authenticated)/components/sidebar.tsx`

**Changes:**
- Add new "Your Teams" collapsible section below the current nav
- Each team shows as collapsible item with:
  - Projects link (navigates to `/teams/[teamId]/projects`)
  - Documents link (navigates to `/teams/[teamId]/documents`)
- Add "+" button to add team (only visible to org owner/admin OR users without an organization)

**New Components Needed:**
- `apps/app/app/(authenticated)/components/teams-nav.tsx` - Teams navigation component for sidebar

**Mock Data Structure (until backend is connected):**
```typescript
interface Team {
  id: string;
  name: string;
  slug: string;
}
```

### 1.2 Sidebar Navigation Updates

**Current nav items to keep:**
- Inbox
- Initiatives (placeholder)
- My Documents
- Members
- More

**New "Your Teams" section structure:**
```
Your Teams [+]
├── Team 1
│   ├── Projects
│   └── Documents
├── Team 2
│   ├── Projects
│   └── Documents
└── Team 3 (collapsed by default)
```

---

## Phase 2: Projects Table Page

### 2.1 Create Team Projects Page

**New Route:** `apps/app/app/(authenticated)/teams/[teamId]/projects/page.tsx`

**Features:**
- Breadcrumb: Team Name > Projects
- "Add Project" button in top right
- Projects table with columns:
  - Project Name (with icon)
  - Priority (with dropdown for "Not Set")
  - Owner (avatar with initials OR add-person icon if empty)
  - Target Date (date OR calendar icon if empty)
  - Status (hexagon progress indicator with percentage)
  - Row actions menu (...)

### 2.2 Projects Table Component

**New File:** `apps/app/app/(authenticated)/teams/[teamId]/projects/components/projects-table.tsx`

**Columns:**
| Column | Type | Behavior |
|--------|------|----------|
| Project Name | Text with icon | Click navigates to project page |
| Priority | Badge/Dropdown | "Not Set", "Low", "Medium", "High" |
| Owner | Avatar/Icon | Shows initials if set, add-person icon if empty |
| Target Date | Date/Icon | Shows date if set, calendar icon if empty |
| Status | Hexagon Progress | Shows percentage in hexagon shape |
| Actions | Menu | Edit, Delete, etc. |

### 2.3 New UI Components

**File:** `packages/design-system/components/ui/add-owner-popup.tsx`
- Popup triggered by clicking add-person icon
- Search/select user from team members
- Save button to assign owner

**File:** `packages/design-system/components/ui/add-date-popup.tsx`
- Popup triggered by clicking calendar icon
- Date picker component
- Save button to set target date

**File:** `packages/design-system/components/ui/hexagon-progress.tsx`
- SVG hexagon shape with stroke-based progress (not fill)
- Dark stroke for progress portion, light gray stroke for remaining
- Progress traces around hexagon perimeter (starting from top, clockwise)
- Percentage text displayed beside the hexagon (not inside)

**File:** `packages/design-system/components/ui/priority-badge.tsx`
- Badge component for priority display
- Options: "Not Set", "Low", "Medium", "High"
- Color coding: Not Set (gray), Low (blue), Medium (yellow), High (red)

---

## Phase 3: Project Detail Page

### 3.1 Create Project Page

**New Route:** `apps/app/app/(authenticated)/teams/[teamId]/projects/[projectId]/page.tsx`

**Layout:**
- Header: Project name, description, "Actions" dropdown button
- Main content: Artifacts table
- Right sidebar: Properties panel, Activity panel

### 3.2 Artifacts Table

**File:** `apps/app/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/artifacts-table.tsx`

**Columns:**
| Column | Type | Behavior |
|--------|------|----------|
| Artifact (with icon) | Text | Different icons per artifact type |
| Status | Dropdown badge | Allows inline status change |
| Link | URL/Text | External link if exists, "n/a" if not |
| Actions | Menu | Edit, View, Delete |

**Artifact Types with Icons:**
- Project Brief (document icon)
- PRD (document icon)
- Designs (paintbrush icon)
- Implementation Plan (clipboard icon)
- Issues (bug icon)
- Feature Branches (git branch icon)

**Status Options (per artifact type):**
- Won't Do, Complete, Not Started, Not Published

### 3.3 Properties Panel

**File:** `apps/app/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/properties-panel.tsx`

**Collapsible panel showing:**
- Priority (editable dropdown)
- Repo (list of associated repositories, editable)
- Lead/Owner (user avatar with name, editable)
- Team (team name(s), editable - can be multiple teams)
- Target Date (date picker, editable)

### 3.4 Activity Panel

**File:** `apps/app/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/activity-panel.tsx`

**Features:**
- Collapsible "Activity" section
- Chronological list of actions
- Each activity item shows:
  - User avatar
  - Action description (e.g., "Kaiti Carpenter created a new PRD called Check-ins v2 PRD 1: Time bucketed checklists")
  - Timestamp

---

## Phase 4: Create Project Modal

### 4.1 Add Project Modal

**File:** `apps/app/app/(authenticated)/teams/[teamId]/projects/components/create-project-modal.tsx`

**Fields:**
- Project Name (required)
- Description (optional)
- Priority (optional, dropdown)
- Owner (optional, user select)
- Target Date (optional, date picker)
- Team (pre-selected based on current team)

---

## Phase 5: Mock Data & State Management

### 5.1 Mock Data Files

**File:** `apps/app/lib/mock-data/teams.ts`
```typescript
export const mockTeams: Team[] = [
  { id: "1", name: "Team 1", slug: "team-1" },
  { id: "2", name: "Team 2", slug: "team-2" },
  { id: "3", name: "Team 3", slug: "team-3" },
];
```

**File:** `apps/app/lib/mock-data/projects.ts`
```typescript
export const mockProjects: Project[] = [
  {
    id: "1",
    name: "Check-ins V2",
    priority: "Not Set",
    owner: { id: "1", name: "KC", avatar: null },
    targetDate: "2026-03-12",
    status: 100, // percentage
  },
  // ... more mock data
];
```

**File:** `apps/app/lib/mock-data/artifacts.ts`
```typescript
export const mockArtifacts: ProjectArtifact[] = [
  {
    id: "1",
    name: "Project Brief",
    type: "PROJECT_BRIEF",
    status: "WONT_DO",
    link: null,
  },
  // ... more mock data
];
```

### 5.2 Type Definitions

**File:** `apps/app/types/teams.ts`
```typescript
export interface Team {
  id: string;
  name: string;
  slug: string;
  organizationId?: string;
}

export interface ProjectWithDetails {
  id: string;
  name: string;
  description?: string;
  priority: "NOT_SET" | "LOW" | "MEDIUM" | "HIGH";
  owner?: {
    id: string;
    name: string;
    avatar?: string;
  };
  targetDate?: string;
  status: number; // 0-100 percentage
  teamId: string;
  repositories?: Repository[];
}

export interface ProjectArtifact {
  id: string;
  name: string;
  type: ArtifactType;
  status: "WONT_DO" | "COMPLETE" | "NOT_STARTED" | "NOT_PUBLISHED";
  link?: string;
}

export interface ActivityItem {
  id: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  action: string;
  timestamp: string;
}
```

---

## Implementation Order

### Sprint 1: Foundation
1. [ ] Create type definitions (`apps/app/types/teams.ts`)
2. [ ] Create mock data files
3. [ ] Create hexagon progress component
4. [ ] Create priority badge component
5. [ ] Create add-owner popup component
6. [ ] Create add-date popup component

### Sprint 2: Sidebar
1. [ ] Create teams-nav component
2. [ ] Update sidebar.tsx to include "Your Teams" section
3. [ ] Add team expansion/collapse functionality
4. [ ] Add "+" button for adding teams (with permission check placeholder)

### Sprint 3: Projects Table
1. [ ] Create `/teams/[teamId]/projects` route
2. [ ] Create projects-table component
3. [ ] Implement inline owner assignment
4. [ ] Implement inline date assignment
5. [ ] Create add project modal

### Sprint 4: Project Detail
1. [ ] Create `/teams/[teamId]/projects/[projectId]` route
2. [ ] Create artifacts-table component
3. [ ] Create properties-panel component
4. [ ] Create activity-panel component
5. [ ] Wire up navigation between pages

---

## File Structure Summary

```
apps/app/
├── app/(authenticated)/
│   ├── components/
│   │   ├── sidebar.tsx (modified)
│   │   └── teams-nav.tsx (new)
│   └── teams/
│       └── [teamId]/
│           ├── projects/
│           │   ├── page.tsx
│           │   └── components/
│           │       ├── projects-table.tsx
│           │       └── create-project-modal.tsx
│           │   └── [projectId]/
│           │       ├── page.tsx
│           │       └── components/
│           │           ├── artifacts-table.tsx
│           │           ├── properties-panel.tsx
│           │           └── activity-panel.tsx
│           └── documents/
│               └── page.tsx (placeholder)
├── lib/
│   └── mock-data/
│       ├── teams.ts
│       ├── projects.ts
│       └── artifacts.ts
└── types/
    └── teams.ts

packages/design-system/components/ui/
├── add-owner-popup.tsx (new)
├── add-date-popup.tsx (new)
├── hexagon-progress.tsx (new)
└── priority-badge.tsx (new)
```

---

## Notes

- All data operations use mock data initially - backend connections are documented separately
- Components should be built with props that accept data, making backend integration straightforward
- Use existing DataTable component patterns where possible
- Follow existing design system patterns (Shadcn/UI components)
