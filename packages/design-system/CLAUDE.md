# @closedloop-ai/design-system

Generic component library (Shadcn/Tailwind), consumed as `@repo/design-system`
by the web apps and as `@closedloop-ai/design-system` (workspace dist) by the
desktop renderer.

## Scope rule (IMPORTANT)

**Generic, domain-agnostic components only** — primitives and patterns that
could be dropped into any project unchanged: `GridTable`, `Chip`,
`TableFilterMenu`, `TablePagination`, dialogs, inputs, charts, layout shells.

**No Closedloop domain concepts.** A component that knows about branches,
sessions, documents, loops, projects, or any other domain entity — or that
imports domain types, status configs, or domain sample data — does **not**
belong here. It goes in the owning feature slice of `packages/app`
(`@repo/app/<feature>/components/`), composing this package's primitives.
`@repo/app` is consumed by both web and desktop, so placement there keeps the
component shared across surfaces.

Litmus test: could another company ship this component unmodified? If not,
it's domain code → `packages/app`.

The session/agent/tool/pack domain components have migrated to their feature
slices in `packages/app` (PR A2): sessions tables/cards/controls, agent and
event views, tool blocks, pack cards/dialogs, and the session/agent/harness
status badges now live under `@repo/app/agents/components/**` and
`@repo/app/packs/components/**`. `primitives/status-badge` now holds only the
generic `ToneBadge`; the domain `SessionStatusBadge` / `AgentStatusBadge` /
`HarnessBadge` moved to `@repo/app/agents/components/session-status-badges`.

One pre-existing exception remains: the domain types in `components/ui/types.ts`.
The domain sample data (`mock-data.ts`) moved in PR A1, and the canonical import
path for the types is `@repo/app/agents/lib/session-types`, but the type
*definitions* still live here. They can't move without introducing a forbidden
`design-system → packages/app` import: generic types that legitimately stay here
(e.g. `ConversationTranscript`) reference domain types (e.g. `AgentStatus`), so
`@repo/app/agents/lib/session-types` re-exports them from this file rather than
the reverse. Don't add new domain types or new domain components here.

## Adding a module

Every new module needs, in the same change:
1. An entry in `tsup.config.ts` (the desktop resolves built `dist/` output).
2. An `exports` block in `package.json` (copy an existing
   import/require/default triple).
3. A Storybook story in `apps/storybook/stories/`.
