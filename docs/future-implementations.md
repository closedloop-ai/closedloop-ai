# Future Implementations

This document tracks backend hygiene and security improvements. ✅ = Implemented

## 1. Authentication Implementation ✅

**Status: IMPLEMENTED**

Authentication is now enforced on all API routes using Clerk integration.

### Implementation
- `getAuthContext()` in `apps/api/lib/route-utils.ts` extracts user context from Clerk session
- All routes call `getAuthContext()` and return 401 if unauthenticated
- User's `clerkUserId` is stored in the database and used for lookup

### Key Files
- `apps/api/lib/route-utils.ts` - Auth utilities (`getAuthContext`, `unauthorizedResponse`)
- `packages/database/prisma/schema.prisma` - User model has `clerkUserId` field

---

## 2. Org-Level Data Access Verification ✅

**Status: IMPLEMENTED**

All routes now verify that users can only access data belonging to their own organization.

### Implementation
- Shared verification utilities in `apps/api/lib/route-utils.ts`:
  - `verifyProjectAccess(projectId, organizationId)`
  - `verifyWorkstreamAccess(workstreamId, organizationId)`
  - `verifyArtifactAccess(artifactId, organizationId)`
  - `verifyUserAccess(userId, organizationId)`
- All routes return 403 Forbidden for cross-organization access attempts
- List endpoints filter by user's organization automatically

### Security Pattern
```typescript
export async function GET(request: Request, { params }: RouteParams) {
  const authContext = await getAuthContext();
  if (!authContext) { return unauthorizedResponse(); }

  const { exists, hasAccess } = await verifyProjectAccess(id, authContext.organizationId);
  if (!exists) { return notFoundResponse("Project"); }
  if (!hasAccess) { return forbiddenResponse(); }

  // Proceed with authorized access
}
```

---

## 3. Duplicate Artifact Versioning Logic ✅

**Status: IMPLEMENTED**

Multiple documents of the same type can now exist in one workstream using `documentSlug` for grouping.

### Implementation
- Added `documentSlug` field to Artifact model in Prisma schema
- Added `@@index([workstreamId, type, documentSlug])` for efficient queries
- Artifact creation and duplication now use `documentSlug` in version scope
- Backward compatible: null `documentSlug` works as before

### Usage
```typescript
// Create a new PRD document in a workstream
POST /api/artifacts
{
  "workstreamId": "...",
  "type": "PRD",
  "title": "Feature PRD",
  "documentSlug": "feature-requirements"  // Groups versions
}

// Create another PRD in the same workstream (different document group)
POST /api/artifacts
{
  "workstreamId": "...",
  "type": "PRD",
  "title": "Technical PRD",
  "documentSlug": "technical-spec"  // Different group
}
```

### Key Files
- `packages/database/prisma/schema.prisma` - `documentSlug` field and index
- `packages/api/src/schemas/organization.ts` - `documentSlug` in create schema
- `apps/api/app/api/artifacts/route.ts` - Uses documentSlug in versioning
- `apps/api/app/api/artifacts/[id]/duplicate/route.ts` - Preserves documentSlug
- `apps/api/app/api/workstreams/[id]/artifacts/route.ts` - Uses documentSlug

---

## All Items Complete ✅

All planned backend hygiene improvements have been implemented.
