# apps/app/app/(authenticated) — authenticated product routes

Web shell routes. Domain UI shared with desktop belongs in `packages/app` — start at `packages/app/AGENTS.md`, which carries the cross-feature rules (loading vs. unavailable vs. real-zero, derived-arithmetic reconciliation, cross-surface parity, story placement) that apply to Sessions, Branches, and Insights alike. Feature-specific rules live in the owning sibling node: `packages/app/agents/AGENTS.md`, `packages/app/branches/AGENTS.md`, `packages/app/insights/AGENTS.md`.

## Storybook does NOT scan this directory

See `apps/app/AGENTS.md`. A component earning an isolated story belongs in `packages/app/<feature>/components/` (domain-shared) or `packages/design-system/components/` (generic).

## Widget semantics (Insights and any data surface)

- Loading, unavailable, not-applicable, and real zero are four distinct truths and must read differently. An unavailable trend rendering flat reads as a good week. `$0.00` must never mean "not computed"; a dash and a real `$0.00` must be visibly distinct.
- Never silently swap a denominator. Substituting an on-screen row sum for a class total when a rollup is missing changes what every percentage means with nothing on screen saying so — say it changed, or mark the widget unavailable.
- Derived arithmetic must self-reconcile: segments sum to the stated total (round-then-reconcile), clamped differences pin their degenerate cases (zero-width band, absent bucket, unavailable ≠ `$0`).
- Every widget fires and loads independently — its own query/loading/empty/error state — so one slow or failing widget never blanks the others. Fan reads out through a bounded concurrency cap so peak backend load stays flat as widgets are added.
- Reject non-finite numbers before deriving sentiment or formatting. `NaN > 0` is false, so an unguarded comparison renders a confident wrong verdict.

## Sorting and interaction

A sortable table's sort handler is usually its only interaction and is routinely the untested part. Cover column change and direction change, plus the description/empty/unavailable branches, or a later refactor collapses them silently.
