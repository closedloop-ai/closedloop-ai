# apps/app — Main Application

Authenticated Next.js app (App Router). Port 3000. For Server Component vs Client Component vs Server Action mental model, see `SERVER_CLIENT.md`.

> **Agents:** also read `AGENTS.md` in this directory for coding patterns, security rules, and domain conventions.

## File Organization

```
hooks/
├── queries/
│   ├── use-documents.ts    # documentKeys + useDocument, useCreateDocument, etc.
│   ├── use-loops.ts        # loopKeys + useRunLoop, etc.
│   └── use-*.ts            # remaining query hooks not yet migrated
├── use-api-client.ts       # deprecated re-export of the @repo/app transport port
└── use-*.ts                # Other non-query hooks
```

**Migration note (PLN-810 Phase 3):** surface-agnostic query hooks are moving
into `@repo/app/<feature>/hooks/` (e.g. `@repo/app/projects/hooks/use-projects`,
`@repo/app/teams/hooks/use-teams`, `@repo/app/judges-analytics/hooks/use-judges`).
New portable hooks go there, not here. Hooks that import `@repo/auth`, crypto, or
the engineer/run-loop-launcher seam stay in `apps/app` until those ports land.
