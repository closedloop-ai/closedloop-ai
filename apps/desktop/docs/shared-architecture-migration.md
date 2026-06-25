# Shared-Architecture Migration Path — Desktop Renderer

**Source:** [FEA-1516](https://app.closedloop.ai/closedloop-ai/features/FEA-1516) · [PLN-848](https://app.closedloop.ai/closedloop-ai/implementation-plans/PLN-848) · [PRD-430 FR6](https://app.closedloop.ai/closedloop-ai/prds/PRD-430) (US-090, AC-090.1)
**Workspace commit at initial categorization:** `2b16f47a6b5f2c3eb52a15a0db58d3607c92a069`
**Doc lifecycle:** Living document. Updated by feature PRs whenever a renderer route adopts (or deliberately defers) shared `@closedloop-ai/design-system` components.

---

## What this is

A per-route inventory of the desktop renderer's adoption of shared components from `@closedloop-ai/design-system` (workspace dep), with a sequencing rationale for which routes adopt first vs. later.

The desktop renderer (`apps/desktop/src/renderer/`) and the web app (`apps/app/`) share UI primitives through `@closedloop-ai/design-system` as a workspace package. This doc identifies which renderer routes have started adoption, which should follow next, and which are deferred until upstream work lands.

The static parity-drift detector (`apps/desktop/scripts/check-design-system-drift.mjs`, run in CI) reports which design-system exports are not yet consumed by the renderer. Read the detector report alongside this doc for the per-export view; read this doc for the per-route narrative.

## Foundations already in place

- `apps/desktop/src/renderer/main.tsx` wraps the app in `DesignSystemProvider` from `@closedloop-ai/design-system`.
- `apps/desktop/vite.renderer.config.ts` chunks `@closedloop-ai/design-system` as `vendor-ds`.
- The Turbo task graph (`turbo.json`) declares `desktop#build` / `desktop#test` / `desktop#typecheck` with `dependsOn: ["@closedloop-ai/design-system#build", ...]` — a change in the design-system invalidates desktop tasks via the standard `--filter=...[origin/main]` pattern.
- Tailwind tokens are wired through the shared package; the renderer's `globals.css` consumes `@closedloop-ai/design-system/styles/globals.css`.

These foundations mean per-route adoption is a matter of swapping local primitives for shared ones, not standing up new infrastructure.

## Categorization legend

- **early**: Active migration target. Route already consumes one or more design-system components and should keep absorbing primitives as they become useful. New work in this route should default to shared components.
- **deferred**: Route does not currently consume design-system components. Migration is sensible but not yet sequenced — typically because the route is a stub, the feature is pre-product, or the primitives aren't designed for this surface yet. (None today; every lazy-loaded route consumes at least one primitive.)
- **out-of-scope**: Route is desktop-specific and not a meaningful candidate for shared adoption. (None today; included for completeness if a future route emerges.)

## Route inventory

The route IDs match the `pageId` cases in `apps/desktop/src/renderer/App.tsx`. Each route's component is a `lazy()`-loaded React module. Files referenced are relative to `apps/desktop/src/renderer/`.

| Route ID | Component | Status | Current design-system specifiers | Notes |
|---|---|---|---|---|
| `dashboard` | `components/dashboard/DashboardPage.tsx` | early | `components/ui/primitives/metric-card` (MetricCard) | Adopt additional KPI tile primitives as the dashboard fills out. |
| `kanban` | `components/kanban/KanbanView.tsx` | early | `components/ui/button` (Button), `components/ui/layout/kanban-board` (KanbanBoard*) | Already on the shared layout primitive. Next: card primitives once they stabilize. |
| `activity` | `components/feed/ActivityFeedView.tsx` | early | `components/ui/badge`, `button`, `empty-state`, `input`, `primitives/metric-card`, `select` | Broad adoption already. Carry into related sub-views. |
| `analytics` | `components/analytics/AnalyticsView.tsx` (+ `AnalyticsDetails.tsx`) | early | `components/ui/primitives/metric-card` (view); sibling `AnalyticsDetails.tsx` uses more (~5) | Chart primitives (`donut-chart`, `line-chart`, `ranked-bar`, `sankey-graph`, `segmented-bar`) are obvious next adoptions if/when desktop adds richer charts. |
| `workflows` | `components/workflows/WorkflowsView.tsx` | early | `composites/agent-collaboration-network`, `composites/orchestration-dag`, `primitives/ranked-bar`, `primitives/sankey-graph`, `primitives/workflow-stat-tile`, `components/ui/badge`, `table` | Heaviest design-system consumer today. Reference implementation for other routes. |
| `packs` | `components/features/CoreFeaturesView.tsx#PacksView` (re-exports `PacksCatalog.tsx`) | early | via `PacksCatalog.tsx`: badge, button, empty-state, input, select, table (6) | Adoption is at the child catalog level. The `PacksView` re-export itself is a thin wrapper. |
| `skills` | `components/features/CoreFeaturesView.tsx#SkillsView` | early | badge, empty-state, primitives/metric-card, table | Implemented inline in `CoreFeaturesView` (no standalone `SkillsView.tsx` file) — shares the four design-system primitives with the Tools/SubAgents views. |
| `tools` | `components/features/CoreFeaturesView.tsx#ToolsView` | early | badge, empty-state, primitives/metric-card, table | Same implementation shape as `skills`. |
| `subagents` | `components/features/CoreFeaturesView.tsx#SubAgentsView` | early | badge, empty-state, primitives/metric-card, table | Same implementation shape as `skills`. |
| `plans` | `components/features/CoreFeaturesView.tsx#PlansView` (re-exports `PlansView.tsx`) | early | badge, button, empty-state | Continue with card + table as plan-management UI grows. |
| `pull-requests` | `components/features/CoreFeaturesView.tsx#PullRequestsView` (re-exports `PullRequestsView.tsx`) | early | badge, button, empty-state, primitives/metric-card, table, tabs | Broad adoption. Composite primitives (`composites/session-table`) are worth evaluating. |
| `approvals` | `components/approvals/ApprovalsPanel.tsx` | early | badge, button, card | Continue with table + dialog primitives once approval-detail views land. |
| `requests` (a.k.a. activity) | `components/activity/ActivityPanel.tsx` | early | badge, button, card, checkbox | Adopt drawer or dialog primitives when request detail UI matures. |
| `diagnostics` | `components/diagnostics/LogsPanel.tsx` | early | button, card | Logs viewer is intentionally compact; adopt code-block, scroll-area, or empty-state primitives as the surface grows. |
| `settings` | `components/settings/SettingsPanel.tsx` | early | badge, button, card, input, switch, tabs | Most complete adoption. Reference implementation for form-shaped routes. |
| `(session-detail)` | `components/sessions/SessionDetailView.tsx` (non-nav route, opened on session click) | early | badge, button, card | Composite `composites/session-table` already used by sibling `SessionsView.tsx`. Evaluate `conversation-message` / `conversation-transcript` primitives for the message view. |

## Sequencing rationale

1. **`early` routes proceed via opportunistic adoption.** When a feature PR touches one of these routes, replace any local primitive with the shared counterpart if one exists. No big-bang refactor required; the parity-drift detector reports the unconsumed surface so reviewers can suggest adoption inside the PR being reviewed.
2. **No routes are currently `deferred`.** All 16 lazy-loaded routes consume at least one design-system primitive. If a future route is added in a pre-product state (e.g. an `EmptyState`-only stub page), categorize it `deferred` and re-evaluate when acceptance criteria land.
3. **Heaviest consumers (`workflows`, `settings`, `pull-requests`) anchor the patterns.** When a new route needs a complex layout, table, or chart, look at these three first for the canonical adoption pattern.
4. **Composite components > primitives > local UI.** Prefer `composites/*` (e.g. `session-table`, `agent-collaboration-network`) when one matches the use case, fall back to `primitives/*` when not, and only build a local component when neither exists.
5. **Treat the detector's drift list as a backlog, not a blocker.** The minimum-fidelity detector reports every unconsumed export. Many will stay unconsumed forever (web-only abstractions, components designed for the agent dashboard, etc.). Use it to surface adoption opportunities, not to chase 100% coverage.

## Updating this doc

This is a living document. When a renderer-route PR adopts a new design-system component:

1. Update the relevant row's "Current design-system specifiers" cell with the new specifier(s).
2. If a route moves from `deferred` to `early` (i.e. it adopts its first shared component), update the Status column and tighten the Notes cell.
3. Re-stamp the **Workspace commit at initial categorization** line at the top **only** if you are doing a full re-baseline; otherwise leave it as the historical anchor and reviewers can `git blame` rows for per-row freshness.
4. The drift detector runs in CI on every PR and posts to `$GITHUB_STEP_SUMMARY` — use its output to sanity-check that your edit reflects the actual workspace state.

## What this doc deliberately does not cover

- **Coverage- or Storybook-based usage signal** — tracked in [FEA-1568](https://app.closedloop.ai/closedloop-ai/features/FEA-1568). The minimum-fidelity drift detector only sees static `import` statements; it does not know which components are actually rendered at runtime.
- **Cross-surface merge-blocking CI gate** for shared-component changes — tracked in [FEA-1567](https://app.closedloop.ai/closedloop-ai/features/FEA-1567). The Turbo task graph already invalidates `desktop#build`/`#test` on `@closedloop-ai/design-system` changes via `--filter=...[origin/main]`; this doc is not the place for that mechanic.
- **Operating-mode (local-gateway vs. cloud-relay) abstractions** — out of scope for FEA-1516; no filed FEA owns this today.
- **A componentization policy for the web app (`apps/app/`)** — symmetric work for the web side is not covered here; this doc is desktop-renderer-only.
