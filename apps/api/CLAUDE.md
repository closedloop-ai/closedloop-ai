# apps/api - BFF API Server

This is the Backend-for-Frontend API server. It handles all database operations and external service integrations.

## Architecture: Routes vs Services

**Routes are thin. Services are where the work happens.**

### Routes (`app/*/route.ts`)

Routes handle HTTP concerns ONLY:
- Authentication via `withAuth()` wrapper
- Request parameter/body parsing
- Calling service methods
- Returning `NextResponse.json()` responses

```typescript
// GOOD: Thin route that delegates to service
export const GET = withAuth<ResponseType, "/path">(
  async ({ user }, request, params) => {
    const { id } = await params;
    const result = await myService.findById(id, user.organizationId);

    if (!result) {
      return notFoundResponse("Resource");
    }
    return NextResponse.json(success(result));
  }
);

// BAD: Route with database operations
export const GET = withAuth(...)(async ({ user }, request, params) => {
  const { id } = await params;
  // DON'T DO THIS - database access belongs in service
  const result = await withDb((db) => db.thing.findUnique({ where: { id } }));
  return NextResponse.json(success(result));
});
```

### Services (`app/*/service.ts`)

Services contain business logic and database operations:
- Import `@repo/database` here
- Validation and business rules
- Database queries via `withDb()`
- External API calls
- Complex operations and transactions

```typescript
// app/things/service.ts
import { withDb } from "@repo/database";

export const thingsService = {
  async findById(id: string, organizationId: string) {
    return withDb((db) =>
      db.thing.findUnique({
        where: { id, organizationId },
      })
    );
  },

  async create(organizationId: string, input: CreateInput) {
    // Validation, business logic, then DB operation
    return withDb((db) =>
      db.thing.create({
        data: { ...input, organizationId },
      })
    );
  },
};
```

## Common Patterns

### Authentication

Three authentication wrappers are available in `@/lib/auth/`:

| Wrapper | Import | When to use |
|---------|--------|-------------|
| `withAuth` | `@/lib/auth/with-auth` | Clerk session only (browser clients) |
| `withApiKeyAuth` | `@/lib/auth/with-api-key-auth` | API key only (`sk_live_*` tokens) |
| `withAnyAuth` | `@/lib/auth/with-any-auth` | Both — tries API key first, falls back to Clerk session |

Use `withAnyAuth` for routes that should accept both programmatic (MCP, CLI) and browser clients:

```typescript
import { withAuth } from "@/lib/auth/with-auth";
import { withAnyAuth } from "@/lib/auth/with-any-auth";

// Session-only (browser UI routes)
export const GET = withAuth<ResponseType, "/path/[id]">(
  async ({ user }, request, params) => {
    // user.organizationId is always available
    // user.id is the authenticated user
  }
);

// Both API key and session (routes also called by MCP/CLI)
export const POST = withAnyAuth<ResponseType, "/path">(
  async ({ user }, request) => {
    // Same AuthContext shape regardless of auth method
    // orgRole is undefined for API key sessions
  }
);
```

### Response Helpers

```typescript
import { success } from "@repo/api/src/types/common";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";

// Success
return NextResponse.json(success(data));

// Not found
return notFoundResponse("Artifact");

// Error
return errorResponse("Failed to process", error);
```

### Database Transactions

For operations that need atomicity:

```typescript
import { withDb } from "@repo/database";

return withDb.tx(async (tx) => {
  const first = await tx.thing.create({ data: {...} });
  const second = await tx.other.create({ data: { thingId: first.id } });
  return { first, second };
});
```

## File Organization

```
apps/api/app/
├── artifacts/
│   ├── route.ts           # GET /artifacts, POST /artifacts
│   ├── service.ts         # artifactsService with all business logic
│   ├── artifact-utils.ts  # Helper functions used by service
│   └── [id]/
│       ├── route.ts       # GET/PUT/DELETE /artifacts/:id
│       └── execute/
│           └── route.ts   # POST /artifacts/:id/execute
├── workstreams/
│   ├── route.ts
│   └── service.ts
└── lib/
    ├── auth/              # Authentication utilities
    └── route-utils.ts     # Response helpers
```

## Shared Types

API request/response types live in `packages/api/src/types/`:

```typescript
// packages/api/src/types/artifact.ts
export type Artifact = { ... };
export type CreateArtifactInput = { ... };

// apps/api/app/artifacts/route.ts
import type { Artifact, CreateArtifactInput } from "@repo/api/src/types/artifact";
```

This ensures frontend (`apps/app`) and backend share the same type definitions.
