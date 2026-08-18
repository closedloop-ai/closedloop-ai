# @closedloop-ai/design-system

Generic component library (Shadcn/Tailwind), consumed as `@closedloop-ai/design-system`
from source — transpiled by Next in the web apps and bundled by Vite in the
desktop renderer. There is no build step (no `tsup`, no `dist`).

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

## Enforced boundary

`@repo/app`, `@repo/database`, `@repo/api`, and `@closedloop-ai/loops-api` imports are **gated** here — by the `noRestrictedImports` override on `packages/design-system/**` in `biome.jsonc`, plus `scripts/lint/check-design-system-domain-imports.ts`, which scans the whole package. Their failure messages carry the contract. `LOOPS_API_EXCEPTIONS` in that scanner is a named, **shrink-only** two-file list — never add an entry to make an import pass, and don't add new domain types or domain components to the listed files. The two entries are waiting on relocation work: ISS-5859 (a leaf that must not import `@repo/app`) and ISS-5860 (giving the other a neutral home outside this React package).

## Adding a module

The package is consumed from source and has no `exports` map, so a new module is
importable at its source path as soon as the file exists — e.g.
`@closedloop-ai/design-system/components/ui/<name>` resolves to
`components/ui/<name>.tsx`. No `tsup.config.ts` entry and no `package.json`
`exports` block are needed. The only companion a new module still needs in the
same change:
1. A Storybook story in `apps/storybook/stories/` — this package is **not** a Storybook scan glob, so a co-located story here is never picked up.

## Adding a variant to an existing component

Every new visual mode needs its states rendered in the existing story, not only asserted in a test. A new legend rendering, a new tone map, or a new semantic fill that no story mounts is invisible to review — and a consumer test that mocks the component away to assert the props it receives proves nothing about what it draws. Where a mode only executes on one branch (a dot inheriting `bg-current` inside a pill vs. taking its `tone` path standalone), the story must mount the branch that actually exercises the new code.

## Shared render boundaries

- **Reject non-finite numbers before deriving sentiment or formatting.** `NaN > 0` is false, so an unguarded comparison renders a confident wrong verdict (a down arrow, `NaN%`, and a green "better"). Typing a prop as `number` does not constrain callers at runtime; treat non-finite as "no comparison" at the shared boundary and cover `NaN`/`±Infinity`.
- **Every column needs an accessible name.** Promoting descriptors to `role="columnheader"` leaves blank-label columns unnamed; require a visible label or `ariaLabel` and guard blank-label columns so they cannot ship without one. A labeled header takes its name from *every* descendant, so nested control names fold into the announcement — name the header explicitly rather than letting it be derived.
- **Check fixed-height hosts before raising a minimum.** A new label floor that pushes a card's minimum vertical stack past a consumer's pinned height (e.g. Insights KPI tiles at 156px) drops the footer into the grid gutter. Scope the reservation away from that consumer or raise its persisted minimum, and cover the fixed-height host.
- **Parsers must reject grammar they cannot measure.** Grabbing the first `px` value anywhere in a CSS track treats `minmax(auto, 300px)` as a 300px *minimum*; decline track forms outside the grammar the code actually handles rather than silently claiming a result the browser will not produce.
