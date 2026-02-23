# apps/app - Main Application

This is the authenticated Next.js application (App Router).

## Server vs Client: Mental Model

The directives `"use client"` and `"use server"` tell you **where the code runs**:

### Three Server-Side Concepts

| Concept | What it is | Infrastructure |
|---------|------------|----------------|
| **Server Components** | React components that render on the server, send back HTML/JS | Vercel Edge/Node runtime |
| **Server Actions** | RPC endpoints for mutations (like AWS Lambda) | Vercel Serverless Functions |
| **API Routes** | Traditional HTTP endpoints, part of our BFF | `apps/api` on Vercel |

### Default: Server Components
In Next.js App Router, all components are **Server Components by default**. They:
- Render on the server and stream HTML/JS to the client
- Can directly fetch data, access environment variables, and use server-only code
- Cannot use React hooks (`useState`, `useEffect`, etc.) or browser APIs
- Are NOT sent to the client bundle (smaller JS payload)

### `"use client"` - Client Components
Add `"use client"` at the top of a file to make it a Client Component:
```tsx
"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0); // Hooks work here
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
```
Client Components:
- Run in the browser (and once on server for initial HTML)
- Can use hooks, event handlers, browser APIs
- Are included in the client JS bundle
- Can import other client components, but NOT server components

### `"use server"` - Server Actions
Server Actions are **RPC calls** - think of them like serverless functions (AWS Lambda). They run on Vercel infrastructure, not in the browser.

```tsx
"use server";

export async function createItem(formData: FormData) {
  // This is an RPC endpoint - runs on Vercel serverless infra
  // Safe to use secrets, call APIs, etc.
}
```
Server Actions:
- Are RPC endpoints that execute on Vercel's serverless infrastructure
- Can be called from `<form action={serverAction}>` or directly `await serverAction()`
- Useful for mutations, form submissions, and secure operations
- Different from Server Components (which produce UI)

### Quick Reference

| Directive | Where it runs | What it produces |
|-----------|---------------|------------------|
| (none - default) | Server | HTML/JS (UI) - Server Component |
| `"use client"` | Browser | Interactive UI - Client Component |
| `"use server"` | Vercel serverless | RPC response (data) - Server Action |

### Common Patterns

**Fetching data in Server Components:**
```tsx
// app/items/page.tsx (Server Component - no directive needed)
export default async function ItemsPage() {
  const items = await fetchItems(); // Runs on server
  return <ItemList items={items} />;
}
```

**Interactive wrapper around server data:**
```tsx
// components/item-list.tsx
"use client";

export function ItemList({ items }: { items: Item[] }) {
  const [filter, setFilter] = useState("");
  // Interactive filtering on pre-fetched server data
}
```

**Form with Server Action:**
```tsx
// actions/items.ts
"use server";

export async function createItem(formData: FormData) {
  // Secure server-side mutation
}

// components/item-form.tsx
"use client";

import { createItem } from "@/actions/items";

export function ItemForm() {
  return <form action={createItem}>...</form>;
}
```

## Data Access Pattern

**Do NOT import `@repo/database` in this app.**

All database operations go through the BFF API (`apps/api`) via TanStack Query:

```
TanStack Query Hook (hooks/queries/use-*.ts)
    ↓ uses
useApiClient() hook
    ↓ HTTP request to
API Route (apps/api/app/*/route.ts)
    ↓ delegates to
Service (apps/api/app/*/service.ts)
    ↓ queries
Database (@repo/database)
```

## Data Fetching with TanStack Query

All data fetching uses TanStack Query hooks in `hooks/queries/`.

### Query Hooks (`hooks/queries/use-*.ts`)

```typescript
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query key factory - keeps cache keys organized
export const artifactKeys = {
  all: ["artifacts"] as const,
  lists: () => [...artifactKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) => [...artifactKeys.lists(), filters] as const,
  detail: (id: string) => [...artifactKeys.all, "detail", id] as const,
};

// Query hook - for reading data
export function useArtifact(id: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactKeys.detail(id),
    queryFn: () => apiClient.get<Artifact>(`/artifacts/${id}`),
    enabled: !!id,
  });
}

// Mutation hook - for creating/updating/deleting
export function useUpdateArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateArtifactInput) => {
      const { id, ...body } = input;
      return apiClient.put<Artifact>(`/artifacts/${id}`, body);
    },
    onSuccess: (_, { id }) => {
      // Invalidate relevant caches
      queryClient.invalidateQueries({ queryKey: artifactKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: artifactKeys.lists() });
    },
  });
}
```

### Using in Components

```typescript
"use client";

import { useArtifact, useUpdateArtifact } from "@/hooks/queries/use-artifacts";

export function ArtifactEditor({ id }: { id: string }) {
  const { data: artifact, isLoading, error } = useArtifact(id);
  const updateArtifact = useUpdateArtifact();

  if (isLoading) return <Spinner />;
  if (error) return <Error message={error.message} />;

  const handleSave = () => {
    updateArtifact.mutate({ id, title: "New Title" });
  };

  return <div>...</div>;
}
```

### Key Patterns

| Pattern | Description |
|---------|-------------|
| **Query keys** | Use factory pattern (`entityKeys.detail(id)`) for consistent cache management |
| **useApiClient()** | Client-side HTTP hook that throws `ApiError` on failures |
| **Cache invalidation** | Always invalidate relevant queries in mutation `onSuccess` |
| **enabled** | Use to conditionally run queries (`enabled: !!id`) |
| **Polling** | Use `refetchInterval` for real-time updates (e.g., generation status) |

### File Organization

```
hooks/
├── queries/
│   ├── use-artifacts.ts    # artifactKeys + useArtifact, useCreateArtifact, etc.
│   ├── use-projects.ts     # projectKeys + useProject, useCreateProject, etc.
│   ├── use-workstreams.ts
│   ├── use-teams.ts
│   ├── use-users.ts
│   └── use-organizations.ts
├── use-api-client.ts       # HTTP client hook used by all query hooks
└── use-*.ts                # Other non-query hooks
```

## Learned Patterns

### TanStack Query
- **[pattern]**: New hooks in `hooks/queries/` must follow: queryKey + queryFn + enabled + `...options` spread. Export a `queryKeys` factory with `.all` and `.detail(id)`. Add cache invalidation to related mutations. Only `staleTime` is acceptable as a default; omit gcTime, refetchOnMount, refetchOnWindowFocus. (context: tanstack-query|hooks|patterns)
- **[pattern]**: When reviewing `queryClient.clear()` calls in organization switching code, verify the entire auth chain: (1) API routes use withAuth() extracting orgId from JWT, (2) service methods filter by organizationId, (3) frontend queries use authenticated API client. If all three hold, `queryClient.clear()` is correct for org switching. (context: tanstack-query|org-switching|auth|cache-invalidation)

### Tables & Sorting
- **[pattern]**: When sorting by nested object fields using SortConfig, use the accessor function to extract the comparable value (e.g., `accessor: (p) => p.owner ? getUserDisplayName(p.owner) : null`). The `sortItems()` utility handles nulls-last automatically. (context: tables|sorting|SortConfig|accessor)
- **[pattern]**: When rendering multiple sortable tables on the same page, each `useSortParams` call must use a unique `paramPrefix` to prevent URL sort param collision. (context: tables|sorting|useSortParams|paramPrefix)

### React & Components
- **[pattern]**: All Clerk client components (UserButton, OrganizationSwitcher) need the mounted state hydration guard pattern - check for existing mounted state variable before adding new Clerk components. (context: clerk|hydration|mounted-guard)
- **[insight]**: Before adding new props to existing components, check what's already available. Components often already receive props that contain the data you need. (context: react-props|component-api|over-engineering)
- **[pattern]**: Radix Dialog with `modal={false}` still fires `onInteractOutside`/`onPointerDownOutside` on outside clicks. Non-modal floating panels must call `e.preventDefault()` on both events to stay open. (context: radix-ui|dialog|modal|floating-panels)
- **[pattern]**: When a component supports multiple AI providers (e.g., Claude vs Codex), context injection must be provider-aware. Client-side prompt formatting designed for one provider should be skipped for others — use server-side injection. (context: multi-provider|context-injection|provider-routing)
- **[convention]**: The established pattern for async cancellation in useEffect is `let cancelled = false` + cleanup return, NOT AbortController or useRef. Check all effects in a file for consistent usage. (context: react|useEffect|cancelled-flag|cleanup|code-consistency)

### UI Patterns
- **[pattern]**: For collapsible sections in artifact editor sidebar, use PropertiesPanel pattern: CollapsibleTrigger with 'rounded-lg p-3 font-medium text-sm hover:bg-accent' styling, ChevronUp/Down icons, and CollapsibleContent with 'space-y-4 px-3 pb-3' spacing. Default to collapsed (useState(false)). (context: react|components|collapsible|artifact-editor|ui-patterns)
- **[pattern]**: When converting metadata panels from tabs to collapsible sections: (1) Replace TabbedMetadataPanel with MetadataPanel, (2) Wrap in space-y-6, (3) Use separate useState(bool) per section, (4) Import Collapsible components + ChevronUp/Down icons, (5) Follow PropertiesPanel pattern. (context: react|refactoring|metadata-panel|collapsible)
- **[pattern]**: Artifact metadata panels (PRD, Issue, Plan) follow identical TabbedMetadataPanel structure in `app/(authenticated)/{artifact}/[slug]/components/*-metadata-panel.tsx`. (context: architecture|metadata-panel|artifact-editor)
- **[pattern]**: When checking artifact categories (Document vs Workflow vs Branch), use `artifact.type === ArtifactType.DOCUMENT` instead of enumerating subtypes. The `type` field is the canonical categorization after the type/subtype split. (context: artifact-types|schema-design|categorization)
- **[mistake]**: When looking up route prefixes or navigation paths, use `artifact.subtype` not `artifact.type`. Type is the broad category (DOCUMENT/WORKFLOW/BRANCH), subtype is specific (PRD/ISSUE/etc). Route maps like `ARTIFACT_TYPE_ROUTES` are keyed by subtype values. (context: artifact|routing|type-subtype|navigation)

### Testing
- **[pattern]**: After adding required props to a component, run typecheck to find test files with outdated mock/defaultProps objects. Test fixtures must be kept in sync with component prop types. (context: testing|react|component-props|test-fixtures|typecheck)
- **[mistake]**: When mocking `next/navigation` in Vitest, always provide all three navigation hooks: `useRouter`, `usePathname`, and `useSearchParams`. Missing any one causes failures. (context: testing|vitest|next/navigation|mocking)

### CSS & Animations
- **[mistake]**: Tailwind v4 compiles `translate-x-[-50%]` / `translate-y-[-50%]` to the individual CSS `translate` property, NOT the `transform` shorthand. When animating with Web Animations API, do NOT put translate values in `transform` keyframes — they will double-up. Compute pixel deltas via `getBoundingClientRect()` instead. (context: tailwind-v4|css-transforms|waapi|individual-properties)
- **[pattern]**: When targeting a specific on-screen element as an animation destination, query with `document.querySelector` and use `getBoundingClientRect()` for position — never hardcode pixel offsets. (context: css-animations|waapi|dom-position|robust-targeting)

### Liveblocks
- **[mistake]**: RoomProvider requires a LiveblocksProvider ancestor. When LiveblocksProvider is conditionally mounted based on user data loading, and artifact data resolves first, RoomProvider descendants crash. Always mount at least a minimal LiveblocksProvider during loading states. (context: liveblocks|RoomProvider|react-providers|loading-state)
- **[mistake]**: When mounting LiveblocksProvider in loading/bootstrap branches, must include LiveblocksErrorBoundary to contain auth/runtime errors. (context: liveblocks|error-boundary|bootstrap|error-handling)
- **[pattern]**: When nesting LiveblocksErrorBoundary with a manual LiveblocksAvailabilityContext.Provider, place the manual override inside the error boundary. The inner provider wins. (context: react-context|error-boundaries|liveblocks|context-nesting)
- **[mistake]**: When reading Liveblocks room metadata, must use the same key that was stored at room creation. Room creation stores `artifactSubtype` in `room-utils.ts` but room resolution was reading `artifactType` — always verify read keys match write keys. (context: liveblocks|room-metadata|metadata-keys|consistency)

### OAuth Integrations
- **[pattern]**: OAuth integrations follow a consistent three-part architecture: (1) Frontend OAuth routes in `app/api/integrations/{provider}/` handle PKCE generation, state cookies, and provider redirect, (2) Callback route validates state with timing-safe comparison and calls API endpoint for token storage, (3) TanStack Query hooks provide status/disconnect/action mutations. Follow Linear integration as reference. (context: oauth|architecture|integration-patterns|pkce)

### Engineer Feature Debugging
- **[insight]**: `codex review` outputs a `session id:` in its startup banner. Capture it and save to `codex-chat.json` so `codex exec resume` can continue the review session. The review route parses the session ID from plain-text stdout (not JSON events like Claude). (context: codex|session-management|review-vs-exec)
- **[pattern]**: In Claude CLI stream handlers (`processStreamEvent`, `processClaudeStreamLine`), result events must: (1) capture session_id for ALL results including errors, (2) check `is_error` independently before `subtype`, (3) fire `onResultEvent` for ALL result types, (4) enqueue a client-side terminal event in EVERY result code path. Include an else branch for unrecognized subtypes with `console.warn`. (context: claude-cli|stream-events|control-flow|processStreamEvent)
- **[mistake]**: In the codex review route's stdout data handler, `sessionIdHolder.value` and the session ID regex must be assigned BEFORE any `await`. The `createCodexStream` synchronous data handler reads `sessionIdHolder.value` on the same event tick. (context: codex|async-await|event-loop|race-condition|session-id)
- **[pattern]**: In ReviewChatPane's reviewSplit filter, `resolveFullPath` returns `string | 'ambiguous' | null`. Findings with no file should be kept, but ambiguous findings must be excluded — `classifyFindings` routes ambiguous paths to general comments. Check for both `!== null` AND `!== 'ambiguous'`; cache result to avoid calling twice. (context: engineer-feature|code-review|resolveFullPath|filter-alignment)
- **[insight]**: When Codex proposes a more complex alternative fix, investigate the full call chain before deciding. In the ambiguous-path case, fixing at the submit handler would waste GitHub API calls — the filter-level fix was simpler and equally correct. (context: codex|cross-model-debate|code-review|fix-location)
- **[insight]**: In engineer chat routes, `claudeProcess` is set to null before buffered stdout fully flushes. The `if (!proc) return` guard in `makeResultKillTimer` is a correctness requirement — without it, a useless 30s SIGTERM timer with no process to kill would be created. (context: engineer-feature|kill-timer|makeResultKillTimer|null-guard)
- **[insight]**: When clearing stale history before auto-starting a chat, ensure cleanup actually executes. If the guard condition is broken, the auto-start effect in `useCommentChat.ts` sees old messages and skips initialization. (context: engineer-feature|comment-chat|auto-start|history|cache-invalidation)
- **[pattern]**: The kill-timer `onResultEvent` callback has been extracted into `makeResultKillTimer(getProcess, label)` in `lib/engineer/stream-events.ts`. New engineer chat routes should use this factory. The `codex/review` route uses a structurally different inline pattern and is NOT covered by the factory. (context: engineer-feature|DRY|kill-timer|stream-events|factory-pattern)
