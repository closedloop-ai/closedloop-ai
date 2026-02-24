# apps/app — Main Application

Authenticated Next.js app (App Router). Port 3000. For Server Component vs Client Component vs Server Action mental model, see `SERVER_CLIENT.md`.

## Data Access Pattern

**Do NOT import `@repo/database`.** All DB access via TanStack Query hooks → `apps/api` → services → database.

## TanStack Query Conventions

All data fetching in `hooks/queries/use-*.ts`:
- Export `entityKeys` factory: `.all`, `.lists()`, `.list(filters)`, `.detail(id)`
- Query hooks: `queryKey` + `queryFn` + `enabled` + `...options` spread
- Mutations: invalidate relevant caches in `onSuccess`
- `useApiClient()` provides the HTTP client (throws `ApiError`)
- Only `staleTime` acceptable as default; omit gcTime, refetchOnMount, refetchOnWindowFocus
- Use `refetchInterval` for polling (e.g., generation status)

## File Organization

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
- **[pattern]**: New hooks: queryKey + queryFn + enabled + `...options` spread. Export `queryKeys` factory (.all, .detail(id)). Cache invalidation in mutations. Only `staleTime` acceptable as default.
- **[pattern]**: `queryClient.clear()` for org switching is correct when: (1) routes use withAuth() with orgId from JWT, (2) services filter by organizationId, (3) frontend uses authenticated API client.

### Tables & Sorting
- **[pattern]**: Sort nested object fields via SortConfig accessor function. `sortItems()` handles nulls-last.
- **[pattern]**: Multiple sortable tables on same page: each `useSortParams` needs unique `paramPrefix`.

### React & Components
- **[pattern]**: Clerk client components (UserButton, OrganizationSwitcher) need mounted state hydration guard.
- **[insight]**: Check existing component props before adding new ones — data may already be available.
- **[pattern]**: Radix Dialog `modal={false}` still fires onInteractOutside. Non-modal panels: `e.preventDefault()` on both events.
- **[pattern]**: Multi-provider AI context injection must be provider-aware. Skip client-side formatting for non-target providers — use server-side.
- **[convention]**: Async cancellation in useEffect: `let cancelled = false` + cleanup return, NOT AbortController/useRef.

### UI Patterns
- **[pattern]**: Collapsible sections in artifact sidebar: PropertiesPanel pattern with CollapsibleTrigger/Content, ChevronUp/Down, default collapsed.
- **[pattern]**: Convert tabs to collapsible: MetadataPanel + space-y-6 + separate useState(bool) per section + Collapsible components.
- **[pattern]**: Artifact metadata panels (PRD, Issue, Plan) follow identical TabbedMetadataPanel structure in `app/(authenticated)/{artifact}/[slug]/components/`.
- **[pattern]**: Check artifact categories via `artifact.type === ArtifactType.DOCUMENT` not subtype enumeration.
- **[mistake]**: Route lookups use `artifact.subtype` not `artifact.type`. Type = broad category, subtype = specific. `ARTIFACT_TYPE_ROUTES` keyed by subtype.

### Testing
- **[pattern]**: After adding required props, run typecheck to find test files with outdated mock/defaultProps.
- **[mistake]**: Mocking `next/navigation` in Vitest: must provide useRouter, usePathname, AND useSearchParams.

### CSS & Animations
- **[mistake]**: Tailwind v4 `translate-x-[-50%]` compiles to individual CSS `translate`, not `transform`. Don't put translate in `transform` keyframes — use getBoundingClientRect() pixel deltas.
- **[pattern]**: Animation destinations: use `querySelector` + `getBoundingClientRect()`, never hardcode pixel offsets.

### Liveblocks
- **[mistake]**: RoomProvider needs LiveblocksProvider ancestor. When Provider is conditional on user loading, mount minimal Provider during loading states.
- **[mistake]**: Loading/bootstrap LiveblocksProvider needs LiveblocksErrorBoundary for auth/runtime errors.
- **[pattern]**: Nesting LiveblocksErrorBoundary with manual LiveblocksAvailabilityContext.Provider: place manual override inside error boundary.
- **[mistake]**: Room metadata: read keys must match write keys. Creation stores `artifactSubtype` in room-utils.ts.

### OAuth Integrations
- **[pattern]**: Three-part architecture: (1) Frontend OAuth routes handle PKCE/state/redirect, (2) Callback validates state + calls API for token storage, (3) TanStack Query hooks for status/disconnect/mutations. Reference: Linear integration.

### Engineer Feature Debugging
- **[insight]**: `codex review` outputs `session id:` in startup banner. Capture to `codex-chat.json` for `codex exec resume`.
- **[pattern]**: Claude CLI stream handlers must: capture session_id for ALL results (including errors), check `is_error` before `subtype`, fire `onResultEvent` for all types, enqueue terminal event in every path. Else branch for unrecognized subtypes.
- **[mistake]**: Codex review route: `sessionIdHolder.value` and regex must be assigned BEFORE any `await` — data handler reads on same event tick.
- **[pattern]**: ReviewChatPane resolveFullPath returns `string | 'ambiguous' | null`. Keep no-file findings, exclude ambiguous. Cache result.
- **[insight]**: Investigate full call chain before choosing fix location. Filter-level fix may be simpler than handler-level.
- **[insight]**: `claudeProcess` set to null before stdout flushes. `if (!proc) return` guard in makeResultKillTimer is required — prevents useless timer.
- **[insight]**: Auto-start cleanup must execute. Broken guard → useCommentChat sees old messages → skips init.
- **[pattern]**: Kill-timer: use `makeResultKillTimer(getProcess, label)` factory from `lib/engineer/stream-events.ts`. Codex review route uses separate inline pattern.
